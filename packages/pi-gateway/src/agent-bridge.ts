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

import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type AgentEvent, RpcTransport, type RpcTransportEvent } from "./agent-transport";
import { CircuitBreaker, type CircuitState } from "./circuit-breaker";
import { CrashRecovery } from "./crash-recovery";
import { PromptExtractor } from "./prompt-extractor";
import { PromptQueue } from "./prompt-queue";
import { extractAssistantError, extractAssistantText, ResponseMetaBuilder } from "./response-meta";
import { clearRestartSentinel, writeRestartSentinel } from "./restart-sentinel";
import type { AgentResponseMeta, InboundMessage, SessionRecord } from "./types";

const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_WINDOW_LIMIT = 5;
const CRASH_MAX_RETRIES = 3;
const CRASH_BASE_DELAY_MS = 1000;
const CIRCUIT_FAILURE_THRESHOLD = 10;
const CIRCUIT_COOLDOWN_MS = 30_000;
const CIRCUIT_OPEN_MESSAGE = "系统繁忙，请稍后再试。";

const DEFAULT_LONG_TASK_THRESHOLD_MS = 180_000;
const DEFAULT_LONG_TASK_PROGRESS_PING_MS = 300_000;
const DEFAULT_STREAMING_WATCHDOG_MS = 90_000;
const STREAMING_WATCHDOG_POLL_MS = 10_000;

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
	cwd?: string;
	maxCrashRetries?: number;
	crashBackoffMs?: number;
	longTaskThresholdMs?: number;
	progressPingIntervalMs?: number;
	deniedTools?: string[];
	/** Account identifier — used by the crash log to attribute failures.
	 *  Falls back to "unknown" when not supplied (single-account mode). */
	accountId?: string;
	/** Optional crash log sink. When set, every crash / recovery /
	 *  suppressed event is mirrored to a JSONL file so the death loop
	 *  survives gateway restarts. See `crash-log.ts`. */
	crashLog?: import("./crash-log").CrashLog;
	/** Data dir for the restart sentinel. When set, every active
	 *  prompt writes a sentinel to `<dataDir>/restart-pending.json`
	 *  while it runs and clears it on completion — so a SIGKILL or
	 *  OOM during a long prompt still leaves a recoverable trail.
	 *  Without this, sentinel-based recovery only fires on graceful
	 *  shutdown. */
	dataDir?: string;
	/** Streaming watchdog in ms — if no session event arrives within
	 *  this window, the active prompt is force-aborted and the user
	 *  gets a 'system busy' fallback. Distinguishes 'LLM slow' (rolling
	 *  prompt-queue timeout) from 'OMP dead mid-stream' (this watchdog).
	 *  Default 90s; 0 disables. */
	streamingWatchdogMs?: number;
	/** Host tool dispatcher wired to the gateway's HostToolDispatcher. When
	 *  set, the bridge sends `set_host_tools` to OMP on each `ready` event
	 *  and routes `host_tool_call` frames to the dispatcher. */
	hostToolDispatcher?: import("./host-tool-dispatcher").HostToolDispatcher;
	/** Active chat context provider — returns the current InboundMessage
	 *  (if any) for delivery auto-inference by host tools like cron. */
	getActiveChatContext?: () => import("./types").InboundMessage | undefined;
}

/** Re-exported for use by PromptQueue and for backward compatibility. */
export type { ForwardStreamHandlers } from "./agent-bridge-types";
export type { AgentEvent };

import type { ForwardStreamHandlers } from "./agent-bridge-types";

export class AgentBridge {
	#transport: RpcTransport;
	#queue: PromptQueue;
	#extractor: PromptExtractor;
	/** Set when `abort()` is called, so `forwardWithMeta` can distinguish an
	 *  abort-induced empty response from a genuine empty response.
	 *  Reset after each `forwardWithMeta` completes. */
	#abortRequested = false;
	#activeSessionPath: string | undefined;
	#pendingModelOverride: { provider: string; modelId: string } | undefined;
	#configuredModel: { provider: string; modelId: string } | undefined;
	/** Set when the transport disconnects (crash/exit). The subprocess loses all
	 *  state on restart — session path, model, host tools — so the next prompt
	 *  must re-apply the model even if `#switchSession` would early-return.
	 *  Cleared after `set_model` succeeds. Without this, a crash recovery with
	 *  no `sessionPath` (e.g. a sessionless cron task) silently runs with the
	 *  subprocess's default model instead of `#pendingModelOverride`. */
	#needsModelReapply = false;
	/** Inbound message currently being processed by `forwardWithMeta`. Read
	 *  by host tools (cron) for delivery auto-inference. Lives on the bridge
	 *  (not the transport) so it survives across session switches within a
	 *  single prompt. Cleared in the `forwardWithMeta` finally block. */
	#activeChatContext: import("./types").InboundMessage | undefined;
	#crash: CrashRecovery;
	#circuit: CircuitBreaker;
	#metaBuilder: ResponseMetaBuilder;
	#options: AgentBridgeOptions;
	#reconnectGuard = false;
	#lastError: string | undefined;
	#accountId: string;
	#crashLog: import("./crash-log").CrashLog | undefined;
	#dataDir: string | undefined;
	#streamingWatchdogMs: number;

	constructor(options: AgentBridgeOptions = {}) {
		this.#options = options;
		this.#accountId = options.accountId ?? "unknown";
		this.#crashLog = options.crashLog;
		this.#dataDir = options.dataDir;
		this.#streamingWatchdogMs = options.streamingWatchdogMs ?? DEFAULT_STREAMING_WATCHDOG_MS;
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
			hostToolHandler: options.hostToolDispatcher
				? (call, reply) => {
						options.hostToolDispatcher!.setWriter((id, body) => {
							this.#transport.sendHostToolResult(id, body.tool_use_id, body.content, body.isError === true);
						});
						return options.hostToolDispatcher!.handleCall(call).then(() => {
							// Dispatcher invokes the writer synchronously inside
							// handleCall. `reply` is unused in the wired path
							// because the dispatcher owns the outbound frame.
							void reply;
						});
					}
				: undefined,
		});
		this.#queue = new PromptQueue(this.#transport, { thresholdMs, pingMs });
		this.#extractor = new PromptExtractor(options.cwd ?? process.cwd());
		this.#circuit = new CircuitBreaker({
			failureThreshold: CIRCUIT_FAILURE_THRESHOLD,
			cooldownMs: CIRCUIT_COOLDOWN_MS,
		});
		this.#crash = new CrashRecovery(() => this.#restartTransport(), {
			windowMs: CRASH_WINDOW_MS,
			windowLimit: CRASH_WINDOW_LIMIT,
			maxRetries: options.maxCrashRetries ?? CRASH_MAX_RETRIES,
			baseDelayMs: options.crashBackoffMs ?? CRASH_BASE_DELAY_MS,
		});
		this.#metaBuilder = new ResponseMetaBuilder();
		this.#transport.onEvent(event => this.#handleTransportEvent(event));
	}

	// ═══════════════════════════════════════════════════════════════
	// Transport event routing
	// ═══════════════════════════════════════════════════════════════

	#handleTransportEvent(event: RpcTransportEvent): void {
		switch (event.type) {
			case "ready":
				this.#crash.setReady(true);
				// OMP just became ready (or recovered from a crash). Re-register
				// the host tool set: the subprocess has no memory of the previous
				// set_host_tools command after a restart.
				this.#registerHostTools();
				break;
			case "command_response":
				this.#queue.onCommandResponse(event.commandId, event.event);
				break;
			case "session_event":
				this.#queue.onSessionEvent(event.event);
				break;
			case "disconnected":
				// The subprocess is gone — its in-memory state (session, model,
				// host tools) is lost. Clear the cached session path so the next
				// `#switchSession` actually sends `switch_session` instead of
				// early-returning with a stale path. Flag `#needsModelReapply` so
				// the next prompt re-applies the model even when no sessionPath
				// is provided (e.g. sessionless cron tasks).
				this.#activeSessionPath = undefined;
				this.#needsModelReapply = true;
				this.#recordCrash(
					event.error?.message ?? "transport disconnected (no error message)",
					event.error?.message?.match(/code (-?\d+)/)?.[1]
						? Number(event.error.message.match(/code (-?\d+)/)?.[1])
						: undefined,
				);
				if (event.error) this.#lastError = event.error.message;
				break;
		}
	}

	/** Wrapper around `CrashRecovery.recordCrash` that also mirrors the
	 *  event to the persistent crash log. Logs a `suppressed` event when
	 *  this crash crosses into the suppressed state for the first time
	 *  in the current window so operators can see exactly when the bridge
	 *  gave up. */
	#recordCrash(reason: string, exitCode?: number): void {
		const wasSuppressed = this.#crash.suppressed;
		this.#crash.recordCrash();
		this.#crashLog?.logCrash(this.#accountId, reason, exitCode);
		if (!wasSuppressed && this.#crash.suppressed) {
			this.#crashLog?.logSuppressed(this.#accountId, this.#crash.snapshot().windowCount);
		}
	}

	/** Wrapper around `CrashRecovery.attemptRecovery` that also logs the
	 *  attempt outcome to the crash log. */
	async #attemptRecovery(): Promise<void> {
		const before = this.#crash.snapshot();
		await this.#crash.attemptRecovery();
		const after = this.#crash.snapshot();
		const success = after.count > before.count && !after.suppressed;
		this.#crashLog?.logRecovery(this.#accountId, after.count, success);
	}

	// ═══════════════════════════════════════════════════════════════
	// Process Lifecycle
	// ═══════════════════════════════════════════════════════════════

	async start(): Promise<void> {
		if (this.#crash.suppressed) {
			throw new Error("Agent bridge is in ERROR state after repeated crashes");
		}
		try {
			await this.#transport.start();
		} catch (err) {
			this.#recordCrash(`bridge.start() failed: ${err instanceof Error ? err.message : String(err)}`);
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
				this.executePrompt(trimmed, { inactivityMs: 60_000 })
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

	/** Public hook for host tools (cron) to read the active chat context for
	 *  delivery auto-inference. Returns the InboundMessage currently being
	 *  processed by `forwardWithMeta`, or undefined outside a prompt. */
	getActiveChatContext(): import("./types").InboundMessage | undefined {
		return this.#activeChatContext;
	}

	/**
	 * Public hook for host tools (cron) to read the OMP session path
	 * the bridge is currently operating on. The LLM `cron.test-run`
	 * host tool uses this to stamp the origin on the test-run marker
	 * so the post-delivery notifier can push the result back to the
	 * same session. Returns `undefined` when no prompt is active or
	 * the active prompt is sessionless (cron path). The value is
	 * set by `forwardWithMeta` from the SessionRecord passed in by
	 * the SessionManager; it is the same `ompSessionPath` the
	 * bridge will write the response to.
	 */
	getActiveSessionPath(): string | undefined {
		return this.#activeSessionPath;
	}

	#setActiveChatContext(msg: import("./types").InboundMessage): void {
		this.#activeChatContext = msg;
	}

	#clearActiveChatContext(): void {
		this.#activeChatContext = undefined;
	}

	/**
	 * Write a restart sentinel so a SIGKILL / OOM during this prompt still
	 * leaves a recoverable trail. Best-effort: failures are logged at warn
	 * and never thrown, since writing the sentinel is not on the user path.
	 */
	#beginActiveSession(conversationId: string, ompSessionPath: string, continuationMessage?: string): void {
		if (!this.#dataDir) return;
		if (this.#accountId === "unknown") return;
		void writeRestartSentinel(
			{
				conversationId,
				accountId: this.#accountId,
				ompSessionPath,
				...(continuationMessage ? { continuationMessage } : {}),
			},
			{ dataDir: this.#dataDir },
		).catch(err => {
			logger.warn("Failed to write active-session sentinel", {
				accountId: this.#accountId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/** Clear the active-session sentinel. Best-effort, but awaitable so
	 *  callers that need the on-disk state to match the in-memory state
	 *  (e.g. tests) can synchronise. */
	#endActiveSession(): Promise<void> {
		if (!this.#dataDir) return Promise.resolve();
		return clearRestartSentinel({ dataDir: this.#dataDir }).catch(err => {
			logger.warn("Failed to clear active-session sentinel", {
				accountId: this.#accountId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	#registerHostTools(): void {
		const dispatcher = this.#options.hostToolDispatcher;
		if (!dispatcher) return;
		const defs = dispatcher.getToolNames();
		if (defs.length === 0) return;
		// We need the full definitions, not just names. The dispatcher exposes
		// them via setTools() at registration time, so cache them here.
		const payload = dispatcher.getDefinitions();
		this.#transport
			.sendCommand("set_host_tools", { tools: payload }, 30_000)
			.then(() => {
				logger.info("[AgentBridge] host tools registered", { names: defs });
			})
			.catch(err => {
				logger.error("[AgentBridge] set_host_tools failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	stop(): void {
		this.#crash.reset();
		this.#reconnectGuard = false;
		this.#circuit.reset();
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
		const circuitSnap = this.#circuit.snapshot();
		const crashSnap = this.#crash.snapshot();
		return {
			state,
			running: this.isRunning,
			ready: this.#crash.ready,
			pid: this.#transport.pid,
			activeSessionPath: this.#activeSessionPath,
			activePromptId: this.#queue.activePromptId,
			pendingPrompts: this.#queue.pendingCount,
			pendingCommands: 0,
			circuitState: circuitSnap.state,
			circuitFailures: circuitSnap.failures,
			circuitOpenedAt: circuitSnap.openedAt,
			crashCount: crashSnap.count,
			crashWindowCount: crashSnap.windowCount,
			crashSuppressed: crashSnap.suppressed,
			reconnecting: this.#reconnectGuard,
			lastError: this.#lastError,
		};
	}

	#getLifecycleState(busy: boolean): AgentBridgeLifecycleState {
		if (this.#crash.suppressed) return "error";
		if (this.#reconnectGuard) return this.#transport.pid !== undefined ? "restarting" : "starting";
		if (!this.#transport.pid) return "stopped";
		if (!this.#crash.ready) return "starting";
		if (busy) return "busy";
		if (this.#circuit.state !== "closed") return "degraded";
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
		const { text, images } = await this.#extractor.extract(msg);
		if (!text.trim()) {
			logger.debug("Empty message, skipping agent");
			return null;
		}

		const startedAt = Date.now();

		return this.#queue.runExclusive(async () => {
			if (!this.#circuit.canAttempt()) {
				logger.warn("Agent bridge circuit is open", { state: this.#circuit.state });
				return this.#metaBuilder.fallback(CIRCUIT_OPEN_MESSAGE, startedAt);
			}

			// Record the active chat context for the duration of this prompt
			// so that cron host-tool calls (D4 auto-inference of delivery)
			// can read it. Cleared in the finally block below.
			this.#setActiveChatContext(msg);

			// Write a restart sentinel so a SIGKILL mid-prompt leaves a
			// recoverable trail. Cleared in the finally block.
			if (session.ompSessionPath) {
				this.#beginActiveSession(msg.conversationId, session.ompSessionPath);
			}

			// Streaming watchdog: if no session event arrives within the
			// configured window, force-abort the prompt. Without this, a
			// streaming LLM that hangs after the thinking block (e.g. 60s
			// of silence) holds the entire IM queue hostage behind a
			// `runExclusive` waiting for an `agent_end` that will never
			// come. The prompt-queue inactivity watchdog (default 60s)
			// handles slow-but-active streams; this handles "OMP dead
			// mid-stream".
			let abortedByStreamingWatchdog = false;
			let streamingWatchdog: NodeJS.Timeout | null = null;
			if (this.#streamingWatchdogMs > 0) {
				// Poll at most every 10s, but at least every 1/3 of the
				// threshold so a short threshold (e.g. tests with 300ms)
				// still aborts within a few hundred ms rather than
				// waiting for the next 10s tick.
				const pollMs = Math.min(
					STREAMING_WATCHDOG_POLL_MS,
					Math.max(100, Math.floor(this.#streamingWatchdogMs / 3)),
				);
				streamingWatchdog = setInterval(() => {
					const lastActivityAt = this.#queue.getActiveLastActivityAt();
					if (lastActivityAt === undefined) return;
					const idleMs = Date.now() - lastActivityAt;
					if (idleMs < this.#streamingWatchdogMs) return;
					if (abortedByStreamingWatchdog) return;
					abortedByStreamingWatchdog = true;
					logger.warn("Streaming watchdog: aborting stalled prompt", {
						accountId: this.#accountId,
						conversationId: msg.conversationId,
						idleMs,
						thresholdMs: this.#streamingWatchdogMs,
					});
					this.#queue.resolveActiveAsAborted();
				}, pollMs);
			}

			if (!this.isRunning) {
				logger.warn("Agent bridge not running, attempting restart");
				try {
					await this.#restartTransport();
				} catch (err) {
					this.#circuit.recordFailure();
					return this.#metaBuilder.fallback(
						`系统错误：${err instanceof Error ? err.message : String(err)}`,
						startedAt,
					);
				}
			}

			logger.debug("Forwarding to agent", {
				userId: msg.userId,
				conversationId: msg.conversationId,
				messageLength: text.length,
				sessionPath: session.ompSessionPath,
			});

			try {
				const sessionChanged = session.ompSessionPath ? await this.#switchSession(session.ompSessionPath) : false;
				// Re-apply the model only when the session actually changed (the
				// subprocess restores the session's model on switch_session) or
				// when the transport was restarted (subprocess lost all state).
				// Without this gate, every IM message redundantly sends set_model,
				// which pollutes the session JSONL with model_change entries and
				// churns provider sessions even when nothing changed.
				const needsModel = sessionChanged || this.#needsModelReapply;
				const modelToApply = this.#pendingModelOverride ?? this.#configuredModel;
				if (modelToApply && needsModel) {
					try {
						await this.#transport.sendCommand(
							"set_model",
							{ provider: modelToApply.provider, modelId: modelToApply.modelId },
							30_000,
						);
						this.#needsModelReapply = false;
					} catch (err) {
						logger.error("Failed to re-apply model after switchSession", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				const { promise } = this.#queue.enqueue(text, handlers, images);
				const { events, aborted } = await promise;
				if (abortedByStreamingWatchdog) {
					logger.warn("Prompt aborted by streaming watchdog", {
						accountId: this.#accountId,
						conversationId: msg.conversationId,
					});
					return this.#metaBuilder.fallback("系统繁忙：LLM 长时间无响应，请重试上一条消息。", startedAt, {
						aborted: true,
					});
				}
				const rawResponse = extractAssistantText(events);

				if (!rawResponse) {
					if (this.#abortRequested) {
						logger.debug("Agent returned empty response after abort");
						return this.#metaBuilder.fallback("（已停止）", startedAt, { aborted: true });
					}
					const agentError = extractAssistantError(events);
					if (agentError) {
						logger.warn("Agent returned error", { errorMessage: agentError.errorMessage });
						return this.#metaBuilder.fallback(`LLM 请求失败：${agentError.errorMessage}`, startedAt);
					}
					logger.warn("Agent returned empty response");
					return this.#metaBuilder.fallback("（Agent 未返回内容）", startedAt);
				}

				const rawText = rawResponse.trim();
				const formatted = this.#formatResponse(rawText);
				logger.debug("Agent responded", {
					responseLength: formatted.length,
					preview: formatted.slice(0, 100),
				});
				this.#circuit.recordSuccess();
				return this.#metaBuilder.build(events, rawText, formatted, startedAt, {
					isFallback: false,
					aborted,
				});
			} catch (err) {
				this.#circuit.recordFailure();
				if (CrashRecovery.isCrashError(err)) {
					logger.warn("Agent process crashed, attempting recovery");
					await this.#attemptRecovery();
					return this.#metaBuilder.fallback("系统正在恢复中，请稍后再试。", startedAt);
				}
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Agent bridge failed", { error: message });
				// Inactivity watchdog rejection ("Agent RPC inactive for Xms ...")
				// means OMP stopped emitting session events. The agent's turn
				// has been abandoned — tell the user, don't dump the technical
				// error. Same shape as the streaming-watchdog fallback at
				// line 616 so the channel treats them identically.
				if (/Agent RPC inactive/i.test(message)) {
					return this.#metaBuilder.fallback(
						"Agent 长时间未响应（已停掉当前轮次）。请重试上一条消息，或发新消息继续。",
						startedAt,
						{ aborted: true },
					);
				}
				return this.#metaBuilder.fallback(`系统错误：${message}`, startedAt);
			} finally {
				if (streamingWatchdog) clearInterval(streamingWatchdog);
				this.#abortRequested = false;
				this.#clearActiveChatContext();
				await this.#endActiveSession();
			}
		});
	}

	async executePrompt(
		prompt: string,
		options?: {
			sessionPath?: string;
			inactivityMs?: number;
			/**
			 * Max time to wait for the per-account prompt queue to free up
			 * (LLM holding the bridge on a previous turn). When exceeded, the
			 * call throws with a "queue wait timed out" error instead of
			 * blocking indefinitely. The cron service uses this to fall back
			 * to a cold `omp --print` subprocess when the warm bridge is
			 * starved by long LLM turns. Internal callers (BOOT.md,
			 * restart-sentinel, streaming-sentinel) leave this unset and
			 * preserve the legacy wait-forever behaviour.
			 */
			queueTimeoutMs?: number;
		},
	): Promise<string> {
		if (!prompt.trim()) {
			throw new Error("Empty prompt");
		}

		return this.#queue.runExclusive(
			async () => {
				if (!this.#circuit.canAttempt()) {
					throw new Error("Agent bridge circuit is open");
				}

				if (!this.isRunning) {
					await this.#restartTransport();
				}

				const inactivityBudgetMs = options?.inactivityMs ?? 0;
				const sessionPath = options?.sessionPath;
				const previousSessionPath = this.#activeSessionPath;
				// N2 contract: if the caller passed a sessionPath, the OMP child
				// MUST end up writing to that exact path. We track the forced
				// path here and re-validate after the prompt completes — see
				// the post-run drift check in the `finally` block below.
				const forcedSessionPath = sessionPath ? path.resolve(sessionPath) : undefined;

				let sessionChanged = false;
				if (sessionPath) {
					try {
						sessionChanged = await this.#switchSession(sessionPath);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						throw new Error(`Failed to switch to cron session: ${message}`);
					}
				}
				// Re-apply model when the session changed or the transport restarted.
				// Moved outside the `if (sessionPath)` block so sessionless cron
				// tasks also get the correct model after a crash recovery.
				const needsModel = sessionChanged || this.#needsModelReapply;
				const modelToApply = this.#pendingModelOverride ?? this.#configuredModel;
				if (modelToApply && needsModel) {
					try {
						await this.#transport.sendCommand(
							"set_model",
							{ provider: modelToApply.provider, modelId: modelToApply.modelId },
							30_000,
						);
						this.#needsModelReapply = false;
					} catch (err) {
						logger.error("Failed to re-apply model for cron prompt", {
							error: err instanceof Error ? err.message : String(err),
						});
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
					const { promise } = this.#queue.enqueue(prompt, undefined, undefined, {
						inactivityMs: inactivityBudgetMs,
					});
					const { events } = await promise;
					const response = extractAssistantText(events);

					const idleInfo = inactivityReason as { idleMs: number; lastEventAt: number } | null;
					if (idleInfo !== null) {
						throw new Error(
							`Agent cron prompt inactive for ${Math.round(idleInfo.idleMs)}ms (limit ${inactivityBudgetMs}ms)`,
						);
					}

					if (!response) {
						throw new Error("Agent returned empty response");
					}

					// N2 enforcement: if the caller forced a sessionPath, the OMP
					// child's `state.sessionFile` must match. If not, the child
					// drifted to a different file (e.g. its own by-date default)
					// and we need to know about it. We log a warning and attempt
					// a corrective `switch_session` back to the forced path so
					// subsequent runs/state queries see the right file.
					//
					// We use the transport directly (not the public `getState()`
					// helper) because that helper re-enters the queue's
					// `runExclusive` and would deadlock — we are already inside
					// the queue from `executePrompt`'s outer `runExclusive`.
					if (forcedSessionPath) {
						try {
							const reported = await this.#transport.sendCommand("get_state", {}, 5_000);
							const reportedFile = (reported.data as { sessionFile?: string } | undefined)?.sessionFile;
							if (reportedFile && path.resolve(reportedFile) !== forcedSessionPath) {
								logger.warn("[AgentBridge] sessionPath drift", {
									forced: forcedSessionPath,
									reported: reportedFile,
								});
								try {
									await this.#switchSession(forcedSessionPath);
								} catch (switchErr) {
									logger.error("[AgentBridge] failed to recover from sessionPath drift", {
										forced: forcedSessionPath,
										error: switchErr instanceof Error ? switchErr.message : String(switchErr),
									});
								}
							}
						} catch (stateErr) {
							// getState failure isn't fatal — we just lose the drift check.
							logger.debug("[AgentBridge] getState for drift check failed", {
								error: stateErr instanceof Error ? stateErr.message : String(stateErr),
							});
						}
					}

					this.#circuit.recordSuccess();
					return response.trim();
				} finally {
					if (watchdog) clearInterval(watchdog);
					if (sessionPath && previousSessionPath && previousSessionPath !== this.#activeSessionPath) {
						try {
							const sessionRestored = await this.#switchSession(previousSessionPath);
							if (sessionRestored) {
								const modelToApply = this.#pendingModelOverride ?? this.#configuredModel;
								if (modelToApply) {
									try {
										await this.#transport.sendCommand(
											"set_model",
											{ provider: modelToApply.provider, modelId: modelToApply.modelId },
											30_000,
										);
									} catch (err) {
										logger.error("Failed to restore model after session restore", {
											error: err instanceof Error ? err.message : String(err),
										});
									}
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
			},
			{ queueTimeoutMs: options?.queueTimeoutMs },
		);
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

	async #switchSession(sessionPath: string): Promise<boolean> {
		if (this.#activeSessionPath === sessionPath) return false;
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
		return true;
	}

	async #restartTransport(): Promise<void> {
		if (this.#crash.suppressed) {
			throw new Error("Agent bridge is in ERROR state after repeated crashes");
		}
		if (this.#reconnectGuard) return;
		this.#reconnectGuard = true;
		try {
			await this.#transport.start();
			// A fresh subprocess is a clean slate — circuit failures and crash
			// timestamps accumulated against the previous process are no
			// longer relevant. Reset both so the new subprocess gets a fair
			// chance before the breaker re-opens.
			this.#circuit.reset();
			this.#crash.reset();
			this.#applyDeniedTools();
		} finally {
			this.#reconnectGuard = false;
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════

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

	/**
	 * Send RPC `new_session` to the agent to clear its in-memory state
	 * (messages, context, cache) and generate a fresh sessionId.
	 *
	 * After this call, the agent's `getState().sessionId` will differ from
	 * the previous value. The agent may also start writing to a new file
	 * path computed via `sessionFilePath()` (the interactive omp convention
	 * `by-date/<date>/<HHMMSS>__<8hex>.jsonl`), which differs from the
	 * gateway agent convention `<agentDir>/sessions/<safeConvId>.jsonl`.
	 * Callers should immediately follow with `switchSession(ompSessionPath)`
	 * to force the agent back to the gateway-tracked file.
	 */
	async newSession(): Promise<AgentEvent> {
		return this.#queue.runExclusive(async () => {
			if (!this.isRunning) {
				throw new Error("Agent process not running");
			}
			return await this.#transport.sendCommand("new_session", {}, 30_000);
		});
	}

	async setDisabledToolsets(toolsets: string[]): Promise<void> {
		if (!this.isRunning) return;
		await this.#transport.sendCommand("set_disabled_toolsets", { toolsets }, 30_000);
	}
}
