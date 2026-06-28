/**
 * Agent Bridge — forwards IM messages to OMP via RPC mode.
 *
 * Architecture:
 *   [IM Message] → AgentBridge.forward() → PromptQueue → RpcTransport → omp --mode rpc → JSON-line protocol → [Reply]
 *
 * The bridge is the orchestration layer: it manages session/model state,
 * circuit breaker, crash recovery, and the public API. Prompt lifecycle
 * and streaming dispatch are owned by `PromptQueue` (see `./prompt-queue.ts`).
 * Process lifecycle and the JSON-line protocol are owned by `RpcTransport`
 * (see `./agent-transport.ts`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, ImageContent, ToolCall, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type AgentEvent, RpcTransport, type RpcTransportEvent } from "./agent-transport";
import { extractPdfText } from "./channels/dingtalk-media";
import { PromptQueue } from "./prompt-queue";
import type {
	AgentResponseMeta,
	AgentResponseToolCall,
	AgentResponseToolResult,
	InboundAttachment,
	InboundMessage,
	SessionRecord,
} from "./types";

type CircuitState = "closed" | "open" | "half-open";

const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_WINDOW_LIMIT = 5;
const CIRCUIT_FAILURE_THRESHOLD = 10;
const CIRCUIT_COOLDOWN_MS = 30_000;
const CIRCUIT_OPEN_MESSAGE = "系统繁忙，请稍后再试。";

const DEFAULT_LONG_TASK_THRESHOLD_MS = 180_000;
const DEFAULT_LONG_TASK_PROGRESS_PING_MS = 300_000;

function readEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 0) {
		logger.warn(`[AgentBridge] Invalid ${name}=${raw}, using default ${fallback}`);
		return fallback;
	}
	return parsed;
}
const LONG_TASK_THRESHOLD_MS = readEnvInt("DINGTALK_LONG_TASK_THRESHOLD_MS", DEFAULT_LONG_TASK_THRESHOLD_MS);
const LONG_TASK_PROGRESS_PING_MS = readEnvInt(
	"DINGTALK_LONG_TASK_PROGRESS_PING_MS",
	DEFAULT_LONG_TASK_PROGRESS_PING_MS,
);

export const __TEST_LONG_TASK_THRESHOLD_MS = LONG_TASK_THRESHOLD_MS;
export const __TEST_LONG_TASK_PROGRESS_PING_MS = LONG_TASK_PROGRESS_PING_MS;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type AgentBridgeLifecycleState = "stopped" | "starting" | "idle" | "busy" | "restarting" | "degraded" | "error";

export interface AgentBridgeSnapshot {
	state: AgentBridgeLifecycleState;
	running: boolean;
	ready: boolean;
	pid?: number;
	activeSessionPath?: string;
	activePromptId?: string;
	pendingPrompts: number;
	pendingCommands: number;
	circuitState: CircuitState;
	circuitFailures: number;
	circuitOpenedAt?: number;
	crashCount: number;
	crashWindowCount: number;
	crashSuppressed: boolean;
	reconnecting: boolean;
	lastError?: string;
}

export interface AgentBridgeOptions {
	ompPath?: string;
	model?: string;
	timeoutMs?: number;
	cwd?: string;
	maxCrashRetries?: number;
	crashBackoffMs?: number;
	longTaskThresholdMs?: number;
	progressPingIntervalMs?: number;
	deniedTools?: string[];
}

/** Re-exported for use by PromptQueue and for backward compatibility. */
export type { ForwardStreamHandlers } from "./agent-bridge-types";
export type { AgentEvent };

import type { ForwardStreamHandlers } from "./agent-bridge-types";

export class AgentBridge {
	#transport: RpcTransport;
	#queue: PromptQueue;
	/** Set when `abort()` is called, so `forwardWithMeta` can distinguish an
	 *  abort-induced empty response from a genuine empty response.
	 *  Reset after each `forwardWithMeta` completes. */
	#abortRequested = false;
	#activeSessionPath: string | undefined;
	#pendingModelOverride: { provider: string; modelId: string } | undefined;
	#configuredModel: { provider: string; modelId: string } | undefined;
	#crashCount = 0;
	#crashTimestamps: number[] = [];
	#crashSuppressed = false;
	#circuitState: CircuitState = "closed";
	#circuitFailures = 0;
	#circuitOpenedAt = 0;
	#options: AgentBridgeOptions;
	#reconnectGuard = false;
	#lastError: string | undefined;
	#ready = false;

	constructor(options: AgentBridgeOptions = {}) {
		this.#options = options;
		if (options.model) {
			const slashIdx = options.model.indexOf("/");
			if (slashIdx !== -1) {
				this.#configuredModel = {
					provider: options.model.substring(0, slashIdx),
					modelId: options.model.substring(slashIdx + 1),
				};
			}
		}
		const thresholdMs = options.longTaskThresholdMs ?? LONG_TASK_THRESHOLD_MS;
		const pingMs = options.progressPingIntervalMs ?? LONG_TASK_PROGRESS_PING_MS;
		logger.debug("[AgentBridge] long-task watcher configured", {
			thresholdMs,
			pingMs,
			disabled: thresholdMs <= 0,
		});

		this.#transport = new RpcTransport({
			ompPath: options.ompPath,
			model: options.model,
			cwd: options.cwd,
		});
		this.#queue = new PromptQueue(this.#transport, { thresholdMs, pingMs });
		this.#transport.onEvent(event => this.#handleTransportEvent(event));
	}

	// ═══════════════════════════════════════════════════════════════
	// Transport event routing
	// ═══════════════════════════════════════════════════════════════

	#handleTransportEvent(event: RpcTransportEvent): void {
		switch (event.type) {
			case "ready":
				this.#ready = true;
				break;
			case "command_response":
				this.#queue.onCommandResponse(event.commandId, event.event);
				break;
			case "session_event":
				this.#queue.onSessionEvent(event.event);
				break;
			case "disconnected":
				this.#recordCrash();
				if (event.error) this.#lastError = event.error.message;
				break;
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// Process Lifecycle
	// ═══════════════════════════════════════════════════════════════

	async start(): Promise<void> {
		if (this.#crashSuppressed) {
			throw new Error("Agent bridge is in ERROR state after repeated crashes");
		}
		try {
			await this.#transport.start();
		} catch (err) {
			this.#recordCrash();
			this.#lastError = err instanceof Error ? err.message : String(err);
			throw err;
		}
		this.#applyDeniedTools();
		this.#runBootCheck();
	}

	#applyDeniedTools(): void {
		const denied = this.#options.deniedTools;
		if (!denied || denied.length === 0) return;

		logger.info("[AgentBridge] Applying deniedTools", { denied });
		this.setDisabledToolsets(denied)
			.then(() => {
				logger.info("[AgentBridge] deniedTools applied", { denied });
			})
			.catch(err => {
				logger.warn("[AgentBridge] Failed to apply deniedTools", {
					denied,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	#runBootCheck(): void {
		const cwd = this.#options.cwd;
		if (!cwd) return;
		const bootPath = path.join(cwd, "BOOT.md");

		Bun.file(bootPath)
			.text()
			.then(content => {
				const trimmed = content.trim();
				if (!trimmed) {
					logger.debug("[AgentBridge] BOOT.md is empty, skipping", { bootPath });
					return;
				}
				logger.info("[AgentBridge] Running BOOT.md self-check", { bootPath, length: trimmed.length });
				this.executePrompt(trimmed, { timeoutMs: 60_000 })
					.then(result => {
						logger.info("[AgentBridge] BOOT.md completed", {
							bootPath,
							preview: result.slice(0, 200),
						});
					})
					.catch(err => {
						logger.warn("[AgentBridge] BOOT.md execution failed", {
							bootPath,
							error: err instanceof Error ? err.message : String(err),
						});
					});
			})
			.catch(err => {
				if (!isEnoent(err)) {
					logger.warn("[AgentBridge] Failed to read BOOT.md", {
						bootPath,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
	}

	stop(): void {
		this.#crashCount = 0;
		this.#ready = false;
		this.#reconnectGuard = false;
		this.#crashTimestamps = [];
		this.#crashSuppressed = false;
		this.#circuitState = "closed";
		this.#circuitFailures = 0;
		this.#circuitOpenedAt = 0;
		this.#activeSessionPath = undefined;

		this.#queue.rejectAll(new Error("Agent bridge stopped"));
		this.#transport.stop();
	}

	get isRunning(): boolean {
		return this.#transport.isReady;
	}

	getSnapshot(): AgentBridgeSnapshot {
		const busy = this.#queue.hasPendingPrompts();
		const state: AgentBridgeLifecycleState = this.#getLifecycleState(busy);
		return {
			state,
			running: this.isRunning,
			ready: this.#ready,
			pid: this.#transport.pid,
			activeSessionPath: this.#activeSessionPath,
			activePromptId: this.#queue.activePromptId,
			pendingPrompts: this.#queue.pendingCount,
			pendingCommands: 0,
			circuitState: this.#circuitState,
			circuitFailures: this.#circuitFailures,
			circuitOpenedAt: this.#circuitOpenedAt || undefined,
			crashCount: this.#crashCount,
			crashWindowCount: this.#crashTimestamps.length,
			crashSuppressed: this.#crashSuppressed,
			reconnecting: this.#reconnectGuard,
			lastError: this.#lastError,
		};
	}

	#getLifecycleState(busy: boolean): AgentBridgeLifecycleState {
		if (this.#crashSuppressed) return "error";
		if (this.#reconnectGuard) return this.#transport.pid !== undefined ? "restarting" : "starting";
		if (!this.#transport.pid) return "stopped";
		if (!this.#ready) return "starting";
		if (busy) return "busy";
		if (this.#circuitState !== "closed") return "degraded";
		return "idle";
	}

	async waitForIdle(): Promise<void> {
		await this.#queue.waitForIdle();
	}

	// ═══════════════════════════════════════════════════════════════
	// Message Forwarding
	// ═══════════════════════════════════════════════════════════════

	async forward(msg: InboundMessage, session: SessionRecord): Promise<string | null> {
		const meta = await this.forwardWithMeta(msg, session);
		return meta?.text ?? null;
	}

	async forwardWithMeta(
		msg: InboundMessage,
		session: SessionRecord,
		handlers?: ForwardStreamHandlers,
	): Promise<AgentResponseMeta | null> {
		const { text, images } = await this.#extractPrompt(msg);
		if (!text.trim()) {
			logger.debug("Empty message, skipping agent");
			return null;
		}

		const startedAt = Date.now();

		return this.#queue.runExclusive(async () => {
			if (!this.#canAttemptPrompt()) {
				logger.warn("Agent bridge circuit is open", { openedAt: this.#circuitOpenedAt });
				return this.#fallbackMeta(CIRCUIT_OPEN_MESSAGE, startedAt);
			}

			if (!this.isRunning) {
				logger.warn("Agent bridge not running, attempting restart");
				try {
					await this.#restartTransport();
				} catch (err) {
					this.#recordPromptFailure();
					return this.#fallbackMeta(`系统错误：${err instanceof Error ? err.message : String(err)}`, startedAt);
				}
			}

			logger.debug("Forwarding to agent", {
				userId: msg.userId,
				conversationId: msg.conversationId,
				messageLength: text.length,
				sessionPath: session.ompSessionPath,
			});

			const timeoutMs = this.#options.timeoutMs ?? 120_000;

			try {
				if (session.ompSessionPath) {
					await this.#switchSession(session.ompSessionPath);
				}
				const modelToApply = this.#pendingModelOverride ?? this.#configuredModel;
				if (modelToApply) {
					try {
						await this.#transport.sendCommand(
							"set_model",
							{ provider: modelToApply.provider, modelId: modelToApply.modelId },
							30_000,
						);
					} catch (err) {
						logger.warn("Failed to re-apply model after switchSession", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				const { promise } = this.#queue.enqueue(text, timeoutMs, handlers, images);
				const { events, aborted } = await promise;
				const rawResponse = this.#extractAssistantText(events);

				if (!rawResponse) {
					if (this.#abortRequested) {
						logger.debug("Agent returned empty response after abort");
						return this.#fallbackMeta("（已停止）", startedAt, { aborted: true });
					}
					const agentError = this.#extractAssistantError(events);
					if (agentError) {
						logger.warn("Agent returned error", { errorMessage: agentError.errorMessage });
						return this.#fallbackMeta(`LLM 请求失败：${agentError.errorMessage}`, startedAt);
					}
					logger.warn("Agent returned empty response");
					return this.#fallbackMeta("（Agent 未返回内容）", startedAt);
				}

				const rawText = rawResponse.trim();
				const formatted = this.#formatResponse(rawText);
				logger.debug("Agent responded", {
					responseLength: formatted.length,
					preview: formatted.slice(0, 100),
				});
				this.#recordPromptSuccess();
				return this.#buildMetaFromEvents(events, rawText, formatted, startedAt, {
					isFallback: false,
					aborted,
				});
			} catch (err) {
				this.#recordPromptFailure();
				if (this.#isCrashError(err)) {
					logger.warn("Agent process crashed, attempting recovery");
					await this.#attemptRecovery();
					return this.#fallbackMeta("系统正在恢复中，请稍后再试。", startedAt);
				}
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Agent bridge failed", { error: message });
				return this.#fallbackMeta(`系统错误：${message}`, startedAt);
			} finally {
				this.#abortRequested = false;
			}
		});
	}

	async executePrompt(
		prompt: string,
		options?: { timeoutMs?: number; sessionPath?: string; inactivityMs?: number },
	): Promise<string> {
		if (!prompt.trim()) {
			throw new Error("Empty prompt");
		}

		return this.#queue.runExclusive(async () => {
			if (!this.#canAttemptPrompt()) {
				throw new Error("Agent bridge circuit is open");
			}

			if (!this.isRunning) {
				await this.#restartTransport();
			}

			const timeoutMs = options?.timeoutMs ?? this.#options.timeoutMs ?? 120_000;
			const inactivityBudgetMs = options?.inactivityMs ?? 0;
			const sessionPath = options?.sessionPath;
			const previousSessionPath = this.#activeSessionPath;

			if (sessionPath) {
				try {
					await this.#switchSession(sessionPath);
					const modelToApply = this.#pendingModelOverride ?? this.#configuredModel;
					if (modelToApply) {
						try {
							await this.#transport.sendCommand(
								"set_model",
								{ provider: modelToApply.provider, modelId: modelToApply.modelId },
								30_000,
							);
						} catch (err) {
							logger.warn("Failed to re-apply model after switchSession", {
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Failed to switch to cron session: ${message}`);
				}
			}

			let inactivityReason: { idleMs: number; lastEventAt: number } | null = null;
			let watchdog: NodeJS.Timeout | null = null;
			if (inactivityBudgetMs > 0) {
				const POLL_MS = 500;
				let abortInflight: Promise<void> | null = null;
				watchdog = setInterval(() => {
					if (inactivityReason) return;
					const lastActivityAt = this.#queue.getActiveLastActivityAt();
					if (lastActivityAt === undefined) return;
					const idleMs = Date.now() - lastActivityAt;
					if (idleMs < inactivityBudgetMs) return;
					inactivityReason = { idleMs, lastEventAt: lastActivityAt };
					if (abortInflight) return;
					abortInflight = (async () => {
						try {
							if (this.isRunning) {
								await this.#transport.sendCommand("abort", {}, 30_000);
							}
						} catch (err) {
							logger.warn("Inactivity watchdog abort command failed", {
								error: err instanceof Error ? err.message : String(err),
							});
						} finally {
							this.#queue.resolveActiveAsAborted();
						}
					})();
				}, POLL_MS);
			}

			try {
				const { promise } = this.#queue.enqueue(prompt, timeoutMs);
				const { events } = await promise;
				const response = this.#extractAssistantText(events);

				const idleInfo = inactivityReason as { idleMs: number; lastEventAt: number } | null;
				if (idleInfo !== null) {
					throw new Error(
						`Agent cron prompt inactive for ${Math.round(idleInfo.idleMs)}ms (limit ${inactivityBudgetMs}ms)`,
					);
				}

				if (!response) {
					throw new Error("Agent returned empty response");
				}

				this.#recordPromptSuccess();
				return response.trim();
			} finally {
				if (watchdog) clearInterval(watchdog);
				if (sessionPath && previousSessionPath && previousSessionPath !== this.#activeSessionPath) {
					try {
						await this.#switchSession(previousSessionPath);
						const modelToApply = this.#pendingModelOverride ?? this.#configuredModel;
						if (modelToApply) {
							try {
								await this.#transport.sendCommand(
									"set_model",
									{ provider: modelToApply.provider, modelId: modelToApply.modelId },
									30_000,
								);
							} catch (err) {
								logger.warn("Failed to restore model after session restore", {
									error: err instanceof Error ? err.message : String(err),
								});
							}
						}
					} catch (err) {
						logger.warn("Failed to restore prior session after cron prompt", {
							priorSession: previousSessionPath,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
		});
	}

	#canAttemptPrompt(): boolean {
		if (this.#circuitState !== "open") return true;
		if (Date.now() - this.#circuitOpenedAt >= CIRCUIT_COOLDOWN_MS) {
			this.#circuitState = "half-open";
			return true;
		}
		return false;
	}

	#recordPromptSuccess(): void {
		this.#circuitState = "closed";
		this.#circuitFailures = 0;
		this.#circuitOpenedAt = 0;
	}

	#recordPromptFailure(): void {
		this.#circuitFailures++;
		if (this.#circuitFailures >= CIRCUIT_FAILURE_THRESHOLD || this.#circuitState === "half-open") {
			this.#circuitState = "open";
			this.#circuitOpenedAt = Date.now();
			logger.warn("Agent bridge circuit opened", { failures: this.#circuitFailures });
		}
	}

	resetActiveSession(): void {
		this.#activeSessionPath = undefined;
	}

	async switchSession(sessionPath: string): Promise<void> {
		await this.#queue.runExclusive(() => this.#switchSession(sessionPath));
	}

	async abort(): Promise<boolean> {
		if (!this.isRunning) {
			throw new Error("Agent process not running");
		}
		if (!this.#queue.hasPendingPrompts()) {
			return false;
		}
		this.#abortRequested = true;
		await this.#transport.sendCommand("abort", {}, 30_000);
		this.#queue.resolveActiveAsAborted();
		return true;
	}

	async #switchSession(sessionPath: string): Promise<void> {
		if (this.#activeSessionPath === sessionPath) return;
		const response = await this.#transport.sendCommand("switch_session", { sessionPath }, 30_000);
		if (
			response.data &&
			typeof response.data === "object" &&
			"cancelled" in response.data &&
			response.data.cancelled
		) {
			throw new Error(`Switch session cancelled: ${sessionPath}`);
		}
		this.#activeSessionPath = sessionPath;
	}

	async #restartTransport(): Promise<void> {
		if (this.#crashSuppressed) {
			throw new Error("Agent bridge is in ERROR state after repeated crashes");
		}
		if (this.#reconnectGuard) return;
		this.#reconnectGuard = true;
		try {
			await this.#transport.start();
			this.#applyDeniedTools();
		} finally {
			this.#reconnectGuard = false;
		}
	}

	#extractAssistantText(events: AgentEvent[]): string | null {
		const assistantEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
		const last = assistantEvents[assistantEvents.length - 1];
		if (!last?.message?.content) return null;
		const textContent = last.message.content.find(c => c.type === "text");
		return textContent?.text ?? null;
	}

	#extractAssistantError(events: AgentEvent[]): { stopReason: string; errorMessage: string } | null {
		const assistantEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
		const last = assistantEvents[assistantEvents.length - 1];
		if (!last?.message) return null;
		const wire = last.message as { stopReason?: string; errorMessage?: string };
		if (wire.stopReason === "error" && wire.errorMessage) {
			return { stopReason: wire.stopReason, errorMessage: wire.errorMessage };
		}
		return null;
	}

	#buildMetaFromEvents(
		events: AgentEvent[],
		rawText: string,
		formattedText: string,
		startedAt: number,
		overrides: { isFallback: boolean; error?: string | null; aborted?: boolean } = {
			isFallback: false,
		},
	): AgentResponseMeta {
		const wireEvents = events as unknown as Array<WireEvent>;

		const lastAssistant = lastAssistantMessage(wireEvents);
		const toolResults = collectToolResults(wireEvents);
		const toolCalls = lastAssistant ? collectToolCallsFromAssistant(lastAssistant) : [];

		const model = lastAssistant?.model ?? null;
		const provider = (lastAssistant?.provider as string | undefined) ?? null;
		const agentDurationMs = lastAssistant?.duration ?? null;
		const usage: AgentResponseMeta["usage"] = lastAssistant?.usage ? extractUsage(lastAssistant.usage) : null;

		return {
			text: formattedText,
			rawText,
			model,
			provider,
			usage,
			agentDurationMs,
			taskDurationMs: Date.now() - startedAt,
			effort: null,
			toolCalls,
			toolResults,
			error: overrides.error ?? null,
			aborted: overrides.aborted ?? false,
			isFallback: overrides.isFallback,
		};
	}

	#fallbackMeta(
		text: string,
		startedAt: number,
		overrides: { error?: string | null; aborted?: boolean } = {},
	): AgentResponseMeta {
		return {
			text,
			rawText: text,
			model: null,
			provider: null,
			usage: null,
			agentDurationMs: null,
			taskDurationMs: Date.now() - startedAt,
			effort: null,
			toolCalls: [],
			toolResults: [],
			error: overrides.error ?? null,
			aborted: overrides.aborted ?? false,
			isFallback: true,
		};
	}

	// ═══════════════════════════════════════════════════════════════
	// Crash Recovery
	// ═══════════════════════════════════════════════════════════════

	#isCrashError(err: unknown): boolean {
		if (err instanceof Error) {
			const msg = err.message;
			return msg.includes("exited") || msg.includes("before ready") || msg.includes("not running");
		}
		return false;
	}

	#recordCrash(): void {
		const now = Date.now();
		this.#crashTimestamps.push(now);
		this.#crashTimestamps = this.#crashTimestamps.filter(timestamp => now - timestamp <= CRASH_WINDOW_MS);
		if (this.#crashTimestamps.length > CRASH_WINDOW_LIMIT) {
			this.#crashSuppressed = true;
			this.#ready = false;
			logger.error("Agent bridge entered ERROR state after repeated crashes", {
				crashes: this.#crashTimestamps.length,
			});
			this.#lastError = "Agent bridge entered ERROR state after repeated crashes";
		}
	}

	async #attemptRecovery(): Promise<void> {
		if (this.#crashSuppressed) {
			logger.error("Agent bridge recovery suppressed after repeated crashes", {
				crashes: this.#crashTimestamps.length,
			});
			return;
		}
		const maxRetries = this.#options.maxCrashRetries ?? 3;
		const baseDelay = this.#options.crashBackoffMs ?? 1000;

		if (this.#crashCount >= maxRetries) {
			logger.error("Max crash retries exceeded, giving up", {
				crashCount: this.#crashCount,
				maxRetries,
			});
			return;
		}

		this.#crashCount++;
		const delay = baseDelay * 2 ** (this.#crashCount - 1);
		logger.warn("Agent process crashed, restarting", {
			crashCount: this.#crashCount,
			delayMs: delay,
		});

		if (this.#crashSuppressed) return;
		await Bun.sleep(delay);
		await this.#restartTransport();
	}

	// ═══════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════

	async #extractPrompt(msg: InboundMessage): Promise<{ text: string; images: ImageContent[] }> {
		const images: ImageContent[] = [];
		const attachmentTexts: string[] = [];
		const cwd = this.#options.cwd ?? process.cwd();

		if (msg.attachments) {
			for (const att of msg.attachments) {
				if (att.mimeType.startsWith("image/")) {
					images.push({
						type: "image",
						data: Buffer.from(att.data).toString("base64"),
						mimeType: att.mimeType,
					});
				} else if (att.mimeType === "application/pdf") {
					const name = att.filename ?? "document.pdf";
					const pdfText = extractPdfText(att.data);
					if (pdfText) {
						attachmentTexts.push(`[PDF: ${name}]
						${pdfText.slice(0, 10000)}`);
					} else {
						attachmentTexts.push(`[PDF: ${name} (${formatBytes(att.size)}) — scanned PDF, no extractable text]`);
					}
				} else {
					const savedPath = await this.#saveAttachmentToDisk(att, cwd);
					if (savedPath) {
						attachmentTexts.push(`[file: ${savedPath} (${att.mimeType}, ${formatBytes(att.size)})]`);
					} else {
						const name = att.filename ?? "file";
						attachmentTexts.push(
							`[${att.kind}: ${name} (${att.mimeType}, ${formatBytes(att.size)}) — failed to save to disk]`,
						);
					}
				}
			}
		}

		if (attachmentTexts.length > 0) {
			const baseText =
				msg.content.type === "text"
					? msg.content.text
					: msg.content.type === "markdown"
						? msg.content.markdown
						: msg.content.type === "voice" && msg.content.text
							? msg.content.text
							: "";
			return { text: [baseText, ...attachmentTexts].filter(Boolean).join("\n\n"), images };
		}

		if (msg.content.type === "text") return { text: msg.content.text, images };
		if (msg.content.type === "markdown") return { text: msg.content.markdown, images };
		if (msg.content.type === "voice" && msg.content.text) return { text: msg.content.text, images };

		const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"];
		const contentFilename = (msg.content as any).filename as string | undefined;
		const isVideoByName =
			contentFilename && VIDEO_EXTENSIONS.some(ext => contentFilename.toLowerCase().endsWith(ext));
		if (msg.content.type === "video" || (msg.content.type === "file" && isVideoByName)) {
			const name = contentFilename ?? "video";
			const size = msg.content.size ? formatBytes(msg.content.size) : "unknown size";
			if (images.length > 0) {
				return {
					text: `[用户发送了视频文件: ${name} (${size})。已从视频中提取 ${images.length} 个关键帧，请基于这些帧分析视频内容。]`,
					images,
				};
			}
			return {
				text: `[用户发送了视频文件: ${name} (${size})。视频帧提取失败，你无法查看视频内容。如果需要分析，请让用户截取关键帧图片重发。]`,
				images,
			};
		}

		if (msg.attachments && msg.attachments.length > 0) {
			const descriptions = msg.attachments.map(att => {
				const name = att.filename ?? "file";
				return `[${att.kind}: ${name} (${att.mimeType}, ${formatBytes(att.size)})]`;
			});
			logger.info("[AgentBridge] Non-text message with attachments", {
				contentType: msg.content.type,
				attachmentCount: msg.attachments.length,
				imageCount: images.length,
				text: descriptions.join("\n"),
			});
			return { text: descriptions.join("\n"), images };
		}

		logger.info("[AgentBridge] Non-text message without attachments — degrading to placeholder", {
			contentType: msg.content.type,
			url: (msg.content as any).url?.slice(0, 80),
			hasAttachments: !!msg.attachments,
		});
		return { text: "[non-text message]", images };
	}

	async #saveAttachmentToDisk(att: InboundAttachment, cwd: string): Promise<string | null> {
		const filename = att.filename ?? "attachment";
		const safeName = filename.replace(/[/\\\0]/g, "_");
		const attachmentsDir = path.join(cwd, "attachments");

		try {
			await fs.mkdir(attachmentsDir, { recursive: true });
			const filePath = path.join(attachmentsDir, safeName);
			await fs.writeFile(filePath, att.data);
			logger.info("[AgentBridge] Attachment saved to disk", {
				path: filePath,
				mimeType: att.mimeType,
				size: att.size,
			});
			return filePath;
		} catch (err) {
			logger.warn("[AgentBridge] Failed to save attachment to disk", {
				filename: safeName,
				mimeType: att.mimeType,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	#formatResponse(text: string): string {
		const cleaned = text.replace(/\s*<think>[\s\S]*?<\/think>/g, "").trim();

		const MAX_LENGTH = 4000;
		const TRUNCATE_NOTICE = "\n\n...(内容已截断，请使用终端查看完整输出)";
		if (cleaned.length <= MAX_LENGTH) return cleaned;
		let cutAt = cleaned.lastIndexOf("\n\n", MAX_LENGTH - TRUNCATE_NOTICE.length);
		if (cutAt < MAX_LENGTH * 0.5) {
			cutAt = cleaned.lastIndexOf("\n", MAX_LENGTH - TRUNCATE_NOTICE.length);
		}
		if (cutAt < MAX_LENGTH * 0.5) {
			cutAt = MAX_LENGTH - TRUNCATE_NOTICE.length;
		}
		return cleaned.slice(0, cutAt) + TRUNCATE_NOTICE;
	}

	// ═══════════════════════════════════════════════════════════════
	// RPC Commands (model management, state queries)
	// ═══════════════════════════════════════════════════════════════

	async getAvailableModels(): Promise<AgentEvent> {
		return this.#queue.runExclusive(async () => {
			if (!this.isRunning) {
				throw new Error("Agent process not running");
			}
			return await this.#transport.sendCommand("get_available_models", {}, 30_000);
		});
	}

	async setModel(provider: string, modelId: string): Promise<AgentEvent> {
		return this.#queue.runExclusive(async () => {
			if (!this.isRunning) {
				throw new Error("Agent process not running");
			}
			const response = await this.#transport.sendCommand("set_model", { provider, modelId }, 30_000);
			if (response.success) {
				this.#pendingModelOverride = { provider, modelId };
			}
			return response;
		});
	}

	async getState(): Promise<AgentEvent> {
		return this.#queue.runExclusive(async () => {
			if (!this.isRunning) {
				throw new Error("Agent process not running");
			}
			return await this.#transport.sendCommand("get_state", {}, 30_000);
		});
	}

	async setDisabledToolsets(toolsets: string[]): Promise<void> {
		if (!this.isRunning) return;
		await this.#transport.sendCommand("set_disabled_toolsets", { toolsets }, 30_000);
	}
}

// ═════════════════════════════════════════════════════════════════════
// Type-guarded event extraction
// ═════════════════════════════════════════════════════════════════════

type WireMessage = AssistantMessage | ToolResultMessage | { role: string; [k: string]: unknown };
type WireEvent = { type: string; message?: WireMessage; [k: string]: unknown };

function lastAssistantMessage(events: WireEvent[]): AssistantMessage | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev.type !== "message_end") continue;
		const msg = ev.message;
		if (msg && msg.role === "assistant") return msg as AssistantMessage;
	}
	return undefined;
}

function collectToolResults(events: WireEvent[]): AgentResponseToolResult[] {
	const out: AgentResponseToolResult[] = [];
	for (const ev of events) {
		if (ev.type !== "message_end") continue;
		const msg = ev.message;
		if (!msg || msg.role !== "toolResult") continue;
		const tr = msg as ToolResultMessage;
		out.push({
			id: tr.toolCallId,
			name: tr.toolName,
			isError: tr.isError === true,
		});
	}
	return out;
}

function collectToolCallsFromAssistant(assistant: AssistantMessage): AgentResponseToolCall[] {
	const out: AgentResponseToolCall[] = [];
	for (const item of assistant.content) {
		if (item.type !== "toolCall") continue;
		const tc = item as ToolCall;
		out.push({
			id: tc.id,
			name: tc.name,
			args: tc.arguments ?? null,
		});
	}
	return out;
}

function extractUsage(usage: Usage): NonNullable<AgentResponseMeta["usage"]> {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
	};
}
