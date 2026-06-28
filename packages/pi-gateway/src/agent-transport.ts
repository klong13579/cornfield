/**
 * RpcTransport — owns the lifecycle of an `omp --mode rpc` child process and
 * the JSON-line protocol on its stdin/stdout.
 *
 * Responsibilities (and ONLY these):
 * - Spawn the child process, wait for the `ready` signal.
 * - Write JSON frames to stdin.
 * - Read JSON lines from stdout, parse them.
 * - Auto-respond to `extension_ui_request` (cancel) and `host_tool_call` (reject).
 * - Correlate `response` frames back to outstanding commands by id.
 * - Emit session events (frames with no id) to subscribers.
 * - Kill the process on `stop()`.
 *
 * Non-responsibilities (owned by `AgentBridge`):
 * - Prompt queueing, serialization (`#runExclusive`).
 * - Session switching, model overrides, abort coordination.
 * - Long-task watchers, circuit breaker, crash recovery.
 * - Streaming handler dispatch, text accumulation.
 * - The public `forward` / `forwardWithMeta` / `executePrompt` API.
 *
 * The transport is deliberately small. Its interface is what `AgentBridge`
 * needs from "a thing that talks to a child process" — nothing more.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import { resolveCredentialEnvVars } from "./credential-resolver";

/** Inline-shape RPC event (subset of @oh-my-pi/pi-agent AgentEvent). */
export interface AgentEvent {
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
	/** For `message_update` events: the streaming sub-event from the agent
	 * loop. Carries incremental deltas (text/thinking/toolcall) plus lifecycle
	 * markers. Bridge consumers that want streaming chrome subscribe via
	 * `ForwardStreamHandlers` instead of parsing this shape directly. */
	assistantMessageEvent?: {
		type: string;
		delta?: string;
		contentIndex?: number;
		[key: string]: unknown;
	};
}

/** Events emitted by RpcTransport to its owner (AgentBridge). */
export type RpcTransportEvent =
	/** The child process emitted `{type: "ready"}`. Caller can now send commands. */
	| { type: "ready" }
	/** A `response` frame arrived for a command we sent. `commandId` is the id
	 * we used in the outgoing frame; `event` is the parsed response event. */
	| { type: "command_response"; commandId: string; event: AgentEvent }
	/** A session event arrived (no id field). These are streamed to the
	 * currently-active prompt by the bridge. */
	| { type: "session_event"; event: AgentEvent }
	/** The child process exited (cleanly or via crash). `error` is set when
	 * the exit was unexpected. */
	| { type: "disconnected"; error?: Error };

type EventHandler = (event: RpcTransportEvent) => void;

interface RpcExtensionUIResponse {
	type: "extension_ui_response";
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: true;
	timedOut?: boolean;
}

interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: {
		type: "tool_result";
		tool_use_id: string;
		content: Array<{ type: "text"; text: string }>;
	};
	isError?: boolean;
}

interface PendingCommand {
	command: string;
	resolve: (event: AgentEvent) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

export interface RpcTransportOptions {
	/** Path to omp binary (default: "omp") */
	ompPath?: string;
	/** Model to pass via `--model` flag on spawn (default: undefined) */
	model?: string;
	/** Working directory for the child process (default: process.cwd()) */
	cwd?: string;
	/** Timeout in ms to wait for the `ready` signal (default: 30000) */
	readyTimeoutMs?: number;
}

/**
 * RpcTransport — process lifecycle + JSON-line protocol adapter.
 *
 * The transport is a leaf module. It has no knowledge of prompts, sessions,
 * models, or circuit breakers. The bridge composes it with orchestration
 * concerns.
 */
export class RpcTransport {
	#proc: { pid: number; kill: () => void } | null = null;
	#stdinWriter?: { write: (data: Uint8Array) => void };
	#ready = false;
	#pendingCommands = new Map<string, PendingCommand>();
	#commandIdCounter = 0;
	#reconnectGuard = false;
	#options: RpcTransportOptions;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced in stop() and #spawnAndWaitReady for stream-reader liveness
	#stderrReader?: Promise<void>;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced in stop() and #spawnAndWaitReady for stream-reader liveness
	#stdoutReader?: Promise<void>;
	#listeners: EventHandler[] = [];

	constructor(options: RpcTransportOptions = {}) {
		this.#options = options;
	}

	// ═══════════════════════════════════════════════════════════════
	// Event subscription
	// ═══════════════════════════════════════════════════════════════

	/** Subscribe to transport events. Returns an unsubscribe function. */
	onEvent(handler: EventHandler): () => void {
		this.#listeners.push(handler);
		return () => {
			const idx = this.#listeners.indexOf(handler);
			if (idx !== -1) this.#listeners.splice(idx, 1);
		};
	}

	#emit(event: RpcTransportEvent): void {
		for (const handler of this.#listeners) {
			try {
				handler(event);
			} catch (err) {
				logger.warn("RpcTransport event handler threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// Lifecycle
	// ═══════════════════════════════════════════════════════════════

	get isReady(): boolean {
		return this.#ready && this.#proc !== null;
	}

	get pid(): number | undefined {
		return this.#proc?.pid;
	}

	async start(): Promise<void> {
		await this.#spawnAndWaitReady();
	}

	stop(): void {
		this.#ready = false;
		this.#reconnectGuard = false;

		if (this.#proc) {
			this.#proc.kill();
			this.#proc = null;
		}
		this.#stdinWriter = undefined;
		this.#stdoutReader = undefined;
		this.#stderrReader = undefined;

		const error = new Error("RpcTransport stopped");
		for (const pending of this.#pendingCommands.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pendingCommands.clear();
	}

	// ═══════════════════════════════════════════════════════════════
	// Command / frame sending
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Send a command and wait for its `response` frame. The caller passes a
	 * `commandId` prefix (e.g. `"c"` for commands, `"p"` for prompts) — the
	 * transport appends a monotonic counter to produce a unique id.
	 *
	 * Resolves with the parsed response event. Rejects on timeout, process
	 * death, or `success: false` responses.
	 */
	async sendCommand(
		command: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
		idPrefix: string = "c",
	): Promise<AgentEvent> {
		const commandId = `${idPrefix}_${++this.#commandIdCounter}`;
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent>();
		const timeout = setTimeout(() => {
			this.#pendingCommands.delete(commandId);
			reject(new Error(`Agent RPC command ${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingCommands.set(commandId, { command, resolve, reject, timeout });

		try {
			this.#writeFrame({ type: command, id: commandId, ...payload });
		} catch (err) {
			clearTimeout(timeout);
			this.#pendingCommands.delete(commandId);
			reject(err instanceof Error ? err : new Error(String(err)));
		}

		return promise;
	}

	/**
	 * Send a fire-and-forget frame (e.g. `extension_ui_response`,
	 * `host_tool_result`). Throws if the process is not running.
	 */
	sendFrame(type: string, payload: Record<string, unknown>): void {
		this.#writeFrame({ type, ...payload });
	}

	#writeFrame(frame: Record<string, unknown> | RpcExtensionUIResponse | RpcHostToolResult): void {
		if (!this.#stdinWriter) {
			throw new Error("Agent process not running");
		}
		this.#stdinWriter.write(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
	}

	// ═══════════════════════════════════════════════════════════════
	// Process spawn
	// ═══════════════════════════════════════════════════════════════

	async #spawnAndWaitReady(): Promise<void> {
		if (this.#reconnectGuard) return;
		this.#reconnectGuard = true;

		try {
			if (this.#proc) {
				this.#proc.kill();
				this.#proc = null;
			}
			this.#ready = false;

			// Reject any pending commands
			const error = new Error("RpcTransport restarting");
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
				logger.error("Invalid stdin for RPC transport");
				throw new Error("Failed to initialize RPC transport stdin");
			}

			this.#proc = { pid: proc.pid, kill: () => proc.kill() };
			this.#stdinWriter = {
				write: (data: Uint8Array) => {
					stdin.write(data);
				},
			};

			this.#stdoutReader = this.#startStdoutReader(proc.stdout as ReadableStream<Uint8Array>);
			this.#stderrReader = this.#drainStderr(proc.stderr as ReadableStream<Uint8Array>);

			const readyTimeoutMs = this.#options.readyTimeoutMs ?? 30_000;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			let settled = false;

			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				proc.kill();
				reject(new Error(`Agent RPC process timed out waiting for ready signal (${readyTimeoutMs}ms)`));
			}, readyTimeoutMs);

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
				logger.debug("Agent RPC process ready", { pid: proc.pid });
			} catch (err) {
				proc.kill();
				this.#proc = null;
				this.#stdinWriter = undefined;
				throw err;
			}
		} finally {
			this.#reconnectGuard = false;
		}
	}

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
		let parsed: AgentEvent;
		try {
			parsed = JSON.parse(line) as AgentEvent;
		} catch {
			// Non-JSON line — ignore
			return;
		}

		// ready signal: mark transport ready, emit to owner
		if (parsed.type === "ready") {
			this.#ready = true;
			this.#emit({ type: "ready" });
			return;
		}

		// extension_ui_request: auto-respond to unblock the agent.
		// Bridge is headless; cancel all blocking UI requests.
		if (parsed.type === "extension_ui_request") {
			const method = (parsed as unknown as { method?: string }).method;
			if (method === "confirm" || method === "select" || method === "input" || method === "editor") {
				const response: RpcExtensionUIResponse = {
					type: "extension_ui_response",
					id: (parsed as unknown as { id: string }).id,
					cancelled: true,
					timedOut: true,
				};
				this.#writeFrame(response);
			}
			// Fire-and-forget methods (notify, setWidget, setStatus, etc.) are ignored
			return;
		}

		// host_tool_call: reject immediately — bridge has no host tools
		if (parsed.type === "host_tool_call") {
			const result: RpcHostToolResult = {
				type: "host_tool_result",
				id: (parsed as unknown as { id: string }).id,
				result: {
					type: "tool_result",
					tool_use_id: (parsed as unknown as { toolCallId: string }).toolCallId,
					content: [{ type: "text", text: "Host tool not available in gateway mode" }],
				},
				isError: true,
			};
			this.#writeFrame(result);
			return;
		}

		// response frame: resolve the pending command (if any) AND emit to owner.
		// The owner may have a pending prompt keyed by the same id (e.g. `prompt`
		// commands are fire-and-forget from the bridge's perspective — the
		// bridge tracks them in its own `#pendingPrompts` map, not in the
		// transport's `#pendingCommands`).
		if (parsed.type === "response" && parsed.command && parsed.id) {
			const pendingCommand = this.#pendingCommands.get(parsed.id);
			if (pendingCommand) {
				clearTimeout(pendingCommand.timeout);
				this.#pendingCommands.delete(parsed.id);
				if (parsed.success) {
					pendingCommand.resolve(parsed);
				} else {
					pendingCommand.reject(new Error(parsed.error ?? `RPC command failed: ${parsed.command}`));
				}
			}
			this.#emit({ type: "command_response", commandId: parsed.id, event: parsed });
			return;
		}

		// session event: no id, routed to the active prompt by the bridge
		if (!parsed.id) {
			this.#emit({ type: "session_event", event: parsed });
		}
	}
}
