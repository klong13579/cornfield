/**
 * Agent Bridge — forwards IM messages to OMP via RPC mode.
 *
 * Architecture:
 *   [IM Message] → AgentBridge.forward() → omp --mode rpc → JSON-line protocol → [Reply]
 *
 * Spawns `omp --mode rpc` as a long-running child process. Communicates via
 * the RPC JSON-line protocol (stdin/stdout). Handles process lifecycle: spawn,
 * crash detection, and recovery with exponential backoff.
 *
 * Key improvement over polling-based approach:
 * - Event-driven promise latching: each prompt gets a unique `id`,
 *   and `agent_end` with matching id immediately resolves the pending promise.
 * - No polling (no 100ms setInterval overhead).
 * - Collects all `message_end` events with `role: "assistant"` between prompt and end.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import { resolveCredentialEnvVars } from "./credential-resolver";
import type { InboundMessage, SessionRecord } from "./types";

// Inline types for RPC protocol messages the bridge handles
type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

type RpcHostToolResult = {
	type: "host_tool_result";
	id: string;
	result: {
		type: "tool_result";
		tool_use_id: string;
		content: Array<{ type: "text"; text: string }>;
	};
	isError?: boolean;
};

type CircuitState = "closed" | "open" | "half-open";

const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_WINDOW_LIMIT = 5;
const CIRCUIT_FAILURE_THRESHOLD = 10;
const CIRCUIT_COOLDOWN_MS = 30_000;
const CIRCUIT_OPEN_MESSAGE = "系统繁忙，请稍后再试。";

export interface AgentBridgeOptions {
	/** Path to omp binary (default: "omp") */
	ompPath?: string;
	/** Model to use (default: undefined = omp default) */
	model?: string;
	/** Maximum time to wait for agent response in ms (default: 120000) */
	timeoutMs?: number;
	/** Working directory for agent execution (default: process.cwd()) */
	cwd?: string;
	/** Max retries for RPC process crash recovery (default: 3) */
	maxCrashRetries?: number;
	/** Base delay for crash recovery backoff in ms (default: 1000) */
	crashBackoffMs?: number;
}

/** Agent event from RPC stream */
interface AgentEvent {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: Array<{ type: string; text?: string }>;
	};
	text?: string;
}

/** Pending prompt state */
interface PendingPrompt {
	promptId: string;
	resolve: (events: AgentEvent[]) => void;
	reject: (error: Error) => void;
	events: AgentEvent[];
	timeout: NodeJS.Timeout;
}

interface PendingCommand {
	command: string;
	resolve: (event: AgentEvent) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

export class AgentBridge {
	#proc: { pid: number; kill: () => void } | null = null;
	#stdinWriter?: { write: (data: Uint8Array) => void };
	#ready = false;
	/** Map of prompt IDs to pending prompts */
	#pendingPrompts = new Map<string, PendingPrompt>();
	#pendingCommands = new Map<string, PendingCommand>();
	/** Currently active prompt ID (for routing session.subscribe events) */
	#activePromptId: string | undefined;
	#activeSessionPath: string | undefined;
	#operationTail: Promise<void> = Promise.resolve();
	/** Counter for generating unique prompt IDs */
	#promptIdCounter = 0;
	#commandIdCounter = 0;
	/** stderr reader (kept alive to prevent hanging pipe) */
	#stderrReader?: Promise<void>;
	/** stdout reader (kept alive to process events) */
	#stdoutReader?: Promise<void>;
	#crashCount = 0;
	#crashTimestamps: number[] = [];
	#crashSuppressed = false;
	#circuitState: CircuitState = "closed";
	#circuitFailures = 0;
	#circuitOpenedAt = 0;
	#options: AgentBridgeOptions;
	#reconnectGuard = false;

	constructor(options: AgentBridgeOptions = {}) {
		this.#options = options;
	}

	// ═══════════════════════════════════════════════════════════════
	// Process Lifecycle
	// ═══════════════════════════════════════════════════════════════

	async start(): Promise<void> {
		await this.#spawnAndWaitReady();
	}

	stop(): void {
		this.#crashCount = 0;
		this.#ready = false;
		this.#reconnectGuard = false;
		this.#activePromptId = undefined;
		this.#crashTimestamps = [];
		this.#crashSuppressed = false;
		this.#circuitState = "closed";
		this.#circuitFailures = 0;
		this.#circuitOpenedAt = 0;
		this.#activeSessionPath = undefined;

		if (this.#proc) {
			this.#proc.kill();
			this.#proc = null;
		}
		this.#stdinWriter = undefined;
		this.#stdoutReader = undefined;
		this.#stderrReader = undefined;

		const error = new Error("Agent bridge stopped");
		for (const pending of this.#pendingPrompts.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pendingPrompts.clear();
		for (const pending of this.#pendingCommands.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pendingCommands.clear();
	}

	get isRunning(): boolean {
		return this.#ready && this.#proc !== null;
	}

	async waitForIdle(): Promise<void> {
		await this.#operationTail;
	}

	// ═══════════════════════════════════════════════════════════════
	// Message Forwarding
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Forward a message to OMP and return the assistant's response text.
	 */
	async forward(msg: InboundMessage, session: SessionRecord): Promise<string | null> {
		const text = this.#extractText(msg);
		if (!text.trim()) {
			logger.debug("Empty message, skipping agent");
			return null;
		}

		return this.#runExclusive(async () => {
			if (!this.#canAttemptPrompt()) {
				logger.warn("Agent bridge circuit is open", { openedAt: this.#circuitOpenedAt });
				return CIRCUIT_OPEN_MESSAGE;
			}

			if (!this.isRunning) {
				logger.warn("Agent bridge not running, attempting restart");
				await this.#spawnAndWaitReady();
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
				const events = await this.#promptAndWait(text, timeoutMs);
				const response = this.#extractAssistantText(events);

				if (!response) {
					logger.warn("Agent returned empty response");
					return "（Agent 未返回内容）";
				}

				logger.debug("Raw response before format", { text: response.slice(0, 300) });

				const formatted = this.#formatResponse(response.trim());
				logger.debug("Agent responded", { responseLength: formatted.length, preview: formatted.slice(0, 100) });
				this.#recordPromptSuccess();
				return formatted;
			} catch (err) {
				this.#recordPromptFailure();
				if (this.#isCrashError(err)) {
					logger.warn("Agent process crashed, attempting recovery");
					await this.#attemptRecovery();
					return "系统正在恢复中，请稍后再试。";
				}
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Agent bridge failed", { error: message });
				return `系统错误：${message}`;
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

	async switchSession(sessionPath: string): Promise<void> {
		await this.#runExclusive(() => this.#switchSession(sessionPath));
	}

	async #switchSession(sessionPath: string): Promise<void> {
		if (this.#activeSessionPath === sessionPath) return;
		const response = await this.#sendCommandAndWait("switch_session", { sessionPath }, 30_000);
		if (response.data && typeof response.data === "object" && "cancelled" in response.data && response.data.cancelled) {
			throw new Error(`Switch session cancelled: ${sessionPath}`);
		}
		this.#activeSessionPath = sessionPath;
	}

	// ═══════════════════════════════════════════════════════════════
	// RPC Protocol
	// ═══════════════════════════════════════════════════════════════

	async #spawnAndWaitReady(): Promise<void> {
		if (this.#crashSuppressed) {
			throw new Error("Agent bridge is in ERROR state after repeated crashes");
		}
		if (this.#reconnectGuard) return;
		this.#reconnectGuard = true;

		try {
			if (this.#proc) {
				this.#proc.kill();
				this.#proc = null;
			}
			this.#ready = false;
			this.#activePromptId = undefined;
			this.#activeSessionPath = undefined;

			// Reject any pending prompts
			const error = new Error("Agent bridge restarting");
			for (const pending of this.#pendingPrompts.values()) {
				clearTimeout(pending.timeout);
				pending.reject(error);
			}
			this.#pendingPrompts.clear();
			for (const pending of this.#pendingCommands.values()) {
				clearTimeout(pending.timeout);
				pending.reject(error);
			}
			this.#pendingCommands.clear();

			const ompPath = this.#options.ompPath ?? "omp";
			const args = ["--mode", "rpc"];
			if (this.#options.model) {
				args.push("--model", this.#options.model);
			}

			logger.debug("Spawning agent RPC process", { ompPath, args });

			const proc = Bun.spawn([ompPath, ...args], {
				stdout: "pipe",
				stderr: "pipe",
				stdin: "pipe",
				cwd: this.#options.cwd ?? process.cwd(),
			env: { ...process.env, ...resolveCredentialEnvVars() },
			});

			const stdin = proc.stdin as FileSink;
			if (!stdin || typeof stdin.write !== "function") {
				logger.error("Invalid stdin for agent bridge");
				throw new Error("Failed to initialize agent bridge stdin");
			}

			this.#proc = { pid: proc.pid, kill: () => proc.kill() };
			this.#stdinWriter = {
				write: (data: Uint8Array) => {
					stdin.write(data);
				},
			};

			// Start stdout reader (processes events in real-time, resolving pending prompts)
			this.#stdoutReader = this.#startStdoutReader(proc.stdout as ReadableStream<Uint8Array>);

			// Drain stderr (non-blocking, prevent pipe from filling)
			this.#stderrReader = this.#drainStderr(proc.stderr as ReadableStream<Uint8Array>);

			// Wait for "ready" signal or process exit
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			let settled = false;

			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				proc.kill();
				reject(new Error("Agent RPC process timed out waiting for ready signal"));
			}, 30000);

			// Poll for ready state (stdout reader sets #ready when it sees "ready" event)
			const checkReady = setInterval(() => {
				if (settled) return;
				if (this.#ready) {
					settled = true;
					clearTimeout(timeout);
					clearInterval(checkReady);
					resolve();
				}
			}, 50);

			void proc.exited.then(exitCode => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				clearInterval(checkReady);
				reject(new Error(`Agent RPC process exited with code ${exitCode} before ready`));
			});

			try {
				await promise;
				this.#crashCount = 0;
				logger.debug("Agent RPC process ready", { pid: proc.pid });
			} catch (err) {
				this.#recordCrash();
				proc.kill();
				this.#proc = null;
				this.#stdinWriter = undefined;
				throw err;
			}
		} finally {
			this.#reconnectGuard = false;
		}
	}

	/**
	 * Start async stdout reader that processes incoming JSON lines in real-time.
	 * When it sees an `agent_end` event with a matching prompt ID, it resolves
	 * the corresponding pending promise immediately.
	 */
	async #startStdoutReader(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				let idx = buffer.indexOf("\n");
				while (idx !== -1) {
					const line = buffer.slice(0, idx).trim();
					buffer = buffer.slice(idx + 1);

					if (line) {
						await this.#processRpcLine(line);
					}

					idx = buffer.indexOf("\n");
				}
			}

			// Process remaining buffer
			if (buffer.trim()) {
				await this.#processRpcLine(buffer.trim());
			}
		} catch {
			// Stream error — handle gracefully
		} finally {
			reader.releaseLock();
		}
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		try {
			while (true) {
				const { done } = await reader.read();
				if (done) break;
			}
		} catch {
			// ignore stderr errors
		} finally {
			reader.releaseLock();
		}
	}

	#processRpcLine(line: string): void {
		try {
			const parsed = JSON.parse(line) as AgentEvent;

			if (parsed.type === "ready") {
				this.#ready = true;
				return;
			}

			// Handle extension_ui_request: auto-respond to unblock the agent
			// The bridge is headless and cannot show UI, so we cancel all blocking requests.
			if (parsed.type === "extension_ui_request") {
				const method = (parsed as any).method as string;
				// Blocking methods that require user input: auto-cancel
				if (method === "confirm" || method === "select" || method === "input" || method === "editor") {
					const response: RpcExtensionUIResponse = {
						type: "extension_ui_response",
						id: (parsed as any).id,
						cancelled: true,
						timedOut: true,
					};
					this.#writeToStdin(JSON.stringify(response) + "\n");
				}
				// Fire-and-forget methods (notify, setWidget, setStatus, etc.) are ignored
				return;
			}

			// Handle host_tool_call: reject immediately — bridge has no host tools
			if (parsed.type === "host_tool_call") {
				const result: RpcHostToolResult = {
					type: "host_tool_result",
					id: (parsed as any).id,
					result: {
						type: "tool_result",
						tool_use_id: (parsed as any).toolCallId,
						content: [{ type: "text", text: "Host tool not available in gateway mode" }],
					},
					isError: true,
				};
				this.#writeToStdin(JSON.stringify(result) + "\n");
				return;
			}

			// Handle command responses: "prompt" response means prompt was submitted
			// These have an id matching the prompt we sent
			if (parsed.type === "response" && (parsed as any).command && (parsed as any).id) {
				const cmdId = (parsed as any).id;
				const command = (parsed as any).command;
				const cmdSuccess = (parsed as any).success;

				if (command === "prompt" && cmdSuccess) {
					// Mark the pending prompt as active (events coming via session.subscribe)
					// Store the reference so we can route subsequent session events to it
					const pending = this.#pendingPrompts.get(cmdId);
					if (pending) {
						pending.events.push(parsed);
						this.#activePromptId = cmdId;
					}
					return;
				}

				const pendingPrompt = this.#pendingPrompts.get(cmdId);
				if (pendingPrompt) {
					clearTimeout(pendingPrompt.timeout);
					this.#pendingPrompts.delete(cmdId);
					pendingPrompt.reject(new Error(parsed.error ?? `RPC command failed: ${command}`));
					return;
				}

				const pendingCommand = this.#pendingCommands.get(cmdId);
				if (pendingCommand) {
					clearTimeout(pendingCommand.timeout);
					this.#pendingCommands.delete(cmdId);
					if (cmdSuccess) {
						pendingCommand.resolve(parsed);
					} else {
						pendingCommand.reject(new Error(parsed.error ?? `RPC command failed: ${command}`));
					}
				}
				return;
			}

			// Handle session events (emitted via session.subscribe, no id field):
			// These include agent_start, agent_end, message_start, message_end, etc.
			// They are routed to the currently active prompt.
			if (!parsed.id && this.#activePromptId) {
				const pending = this.#pendingPrompts.get(this.#activePromptId);
				if (pending) {
					pending.events.push(parsed);

					// agent_end event means the current agent turn is complete
					if (parsed.type === "agent_end") {
						clearTimeout(pending.timeout);
						this.#pendingPrompts.delete(this.#activePromptId);
						this.#activePromptId = undefined;
						pending.resolve(pending.events);
					}
				}
			}
		} catch {
			// Non-JSON line — ignore
		}
	}

	async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#operationTail;
		const { promise: current, resolve } = Promise.withResolvers<void>();
		this.#operationTail = previous.catch(() => {}).then(() => current);
		await previous.catch(() => {});
		try {
			return await operation();
		} finally {
			resolve();
		}
	}

	async #sendCommandAndWait(command: string, payload: Record<string, unknown>, timeoutMs: number): Promise<AgentEvent> {
		const commandId = `c_${++this.#commandIdCounter}`;
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent>();
		const timeout = setTimeout(() => {
			this.#pendingCommands.delete(commandId);
			reject(new Error(`Agent RPC command ${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingCommands.set(commandId, { command, resolve, reject, timeout });

		try {
			this.#writeToStdin(JSON.stringify({ type: command, id: commandId, ...payload }) + "\n");
		} catch (err) {
			clearTimeout(timeout);
			this.#pendingCommands.delete(commandId);
			reject(err instanceof Error ? err : new Error(String(err)));
		}

		return promise;
	}

	async #promptAndWait(message: string, timeoutMs: number): Promise<AgentEvent[]> {
		const promptId = `p_${++this.#promptIdCounter}`;

		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();

		const timeout = setTimeout(() => {
			this.#pendingPrompts.delete(promptId);
			reject(new Error(`Agent RPC timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const pending: PendingPrompt = {
			promptId,
			resolve,
			reject,
			events: [],
			timeout,
		};

		this.#pendingPrompts.set(promptId, pending);

		// Write prompt to stdin with unique id
		const frame = `${JSON.stringify({ type: "prompt", id: promptId, message })}\n`;
		if (this.#stdinWriter) {
			this.#stdinWriter.write(new TextEncoder().encode(frame));
		} else {
			clearTimeout(timeout);
			this.#pendingPrompts.delete(promptId);
			reject(new Error("Agent process not running"));
		}

		return promise;
	}

	#extractAssistantText(events: AgentEvent[]): string | null {
		const assistantEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
		const last = assistantEvents[assistantEvents.length - 1];
		if (!last?.message?.content) return null;
		const textContent = last.message.content.find(c => c.type === "text");
		return textContent?.text ?? null;
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
			logger.error("Agent bridge entered ERROR state after repeated crashes", { crashes: this.#crashTimestamps.length });
		}
	}

	async #attemptRecovery(): Promise<void> {
		if (this.#crashSuppressed) {
			logger.error("Agent bridge recovery suppressed after repeated crashes", { crashes: this.#crashTimestamps.length });
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
		await this.#spawnAndWaitReady();
	}

	// ═══════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════

	/** Write data to the agent's stdin. */
	#writeToStdin(data: string): void {
		if (!this.#stdinWriter) {
			throw new Error("Agent process not running");
		}
		this.#stdinWriter.write(new TextEncoder().encode(data));
	}

	#extractText(msg: InboundMessage): string {
		if (msg.content.type === "text") return msg.content.text;
		if (msg.content.type === "markdown") return msg.content.markdown;
		if (msg.content.type === "voice" && msg.content.text) return msg.content.text;
		return "[non-text message]";
	}

	#formatResponse(text: string): string {
		// Strip think blocks from model response
		const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

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
}
