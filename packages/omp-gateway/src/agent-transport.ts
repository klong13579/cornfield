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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import { randomUUID } from "crypto";
import { resolveCredentialEnvVars } from "./credential-resolver";

/**
 * Version of the `--mode rpc` wire protocol spoken by the omp agent
 * subprocess. Bump this when the RPC frame shapes change incompatibly so
 * the gateway can reject an old omp binary with a clear upgrade error
 * instead of mis-parsing frames.
 *
 * The value must stay in sync with `packages/coding-agent/src/modes/rpc/
 * rpc-mode.ts` which stamps it into the `ready` frame.
 */
export const RPC_PROTOCOL_VERSION = 1;

/**
 * Resolve the default omp binary path used to spawn `omp --mode rpc` agent
 * subprocesses.
 *
 * Priority:
 *   1. `~/.local/bin/omp` when present and executable — the canonical install
 *      location produced by scripts/install.sh. Pinning the stable path here
 *      (instead of the bare PATH name) makes the gateway's agent child
 *      independent of the operator's shell PATH, which the daemon does not
 *      source.
 *   2. `"omp"` from PATH, for dev setups that have not installed the binary.
 *
 * Operators who set `agent.ompPath` explicitly in gateway.json keep their
 * value — this function only fills the unset case.
 *
 * The `home` argument is exposed for hermetic tests; production callers omit
 * it and the real `os.homedir()` is used.
 */
export function resolveDefaultOmpPath(home: string = os.homedir()): string {
	const stable = path.join(home, ".local", "bin", "omp");
	try {
		fs.accessSync(stable, fs.constants.X_OK);
		return stable;
	} catch {
		return "omp";
	}
}

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
	 * the exit was unexpected; `stderrTail` carries the last lines the child
	 * wrote to stderr before dying, so crash diagnostics survive process
	 * death (the child's own panic output would otherwise be lost). */
	| { type: "disconnected"; error?: Error; stderrTail?: string };

/**
 * Error thrown when the child exits before reaching `ready`, carrying the
 * child's stderr tail. The bridge surfaces it in crash logs so a spawn-time
 * failure (bad config, missing binary, Bun runtime panic) is diagnosable
 * instead of reducing to a bare exit code.
 */
export class RpcTransportError extends Error {
	readonly stderrTail?: string;
	constructor(message: string, stderrTail?: string) {
		super(message);
		this.name = "RpcTransportError";
		this.stderrTail = stderrTail;
	}
}

/** Number of trailing stderr lines retained per child process for crash
 * diagnosis. Bounded so a chatty child can't grow memory unboundedly. */
const STDERR_TAIL_LINES = 50;

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

export interface HostToolCallRequest {
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Callback invoked when OMP emits a `host_tool_call` frame. The transport
 *  does not understand the semantics — it just hands the call to this
 *  callback and writes whatever `reply(result)` is given back as a
 *  `host_tool_result` frame. If the callback throws, the transport writes
 *  an `isError: true` result with the error message. */
export type HostToolCallHandler = (
	call: HostToolCallRequest,
	reply: (body: { content: Array<{ type: "text"; text: string }>; isError?: boolean }) => void,
) => Promise<void> | void;

export interface RpcTransportOptions {
	/** Path to omp binary (default: resolveDefaultOmpPath()) */
	ompPath?: string;
	/** Model to pass via `--model` flag on spawn (default: undefined) */
	model?: string;
	/** Working directory for the child process (default: process.cwd()) */
	cwd?: string;
	/** Timeout in ms to wait for the `ready` signal (default: 30000) */
	readyTimeoutMs?: number;
	/** Handler for `host_tool_call` frames from OMP. When unset, the transport
	 *  falls back to the legacy "reject" behaviour (returns `isError: true`).
	 *  The bridge wires this to its `HostToolDispatcher`. */
	hostToolHandler?: HostToolCallHandler;
	/** Intercom parent target (session name or stable id). When set, the
	 *  spawned omp child gets PI_SUBAGENT_ORCHESTRATOR_* env so it registers
	 *  as a child of that session on the intercom broker. */
	intercomParent?: string;
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
	/** Set when the `ready` frame arrives with an incompatible (or missing)
	 *  protocol_version. The child is killed and `start()` rejects with this
	 *  diagnostic instead of a bare exit code. */
	#readyFailureReason: string | undefined;
	#pendingCommands = new Map<string, PendingCommand>();
	#commandIdCounter = 0;
	#reconnectGuard = false;
	#options: RpcTransportOptions;
	/** Stable per-transport run id for the intercom child metadata. */
	#intercomRunId = randomUUID();
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced in stop() and #spawnAndWaitReady for stream-reader liveness
	#stderrReader?: Promise<void>;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced in stop() and #spawnAndWaitReady for stream-reader liveness
	#stdoutReader?: Promise<void>;
	/** Trailing stderr lines of the current child process (crash diagnosis). */
	#stderrTail: string[] = [];
	#listeners: EventHandler[] = [];
	#hostToolHandler: HostToolCallHandler | undefined;

	constructor(options: RpcTransportOptions = {}) {
		this.#options = options;
		this.#hostToolHandler = options.hostToolHandler;
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
		this.#readyFailureReason = undefined;
		this.#reconnectGuard = false;

		if (this.#proc) {
			this.#proc.kill();
			this.#proc = null;
		}
		this.#stdinWriter = undefined;
		this.#stdoutReader = undefined;
		this.#stderrReader = undefined;
		this.#stderrTail = [];

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

	/** Convenience: write a `host_tool_result` frame for a call dispatched
	 *  via the `hostToolHandler` callback. The bridge uses this so the
	 *  dispatcher doesn't have to know the wire shape. */
	sendHostToolResult(
		id: string,
		toolUseId: string,
		content: Array<{ type: "text"; text: string }>,
		isError: boolean,
	): void {
		this.#writeFrame({
			type: "host_tool_result",
			id,
			result: { type: "tool_result", tool_use_id: toolUseId, content },
			isError,
		});
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
			this.#readyFailureReason = undefined;
			this.#stderrTail = [];

			// Reject any pending commands
			const error = new Error("RpcTransport restarting");
			for (const pending of this.#pendingCommands.values()) {
				clearTimeout(pending.timeout);
				pending.reject(error);
			}
			this.#pendingCommands.clear();

			const ompPath = this.#options.ompPath ?? resolveDefaultOmpPath();
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
				env: {
					...process.env,
					...resolveCredentialEnvVars(),
					...(this.#options.intercomParent
						? {
								PI_SUBAGENT_ORCHESTRATOR_TARGET: this.#options.intercomParent,
								PI_SUBAGENT_RUN_ID: this.#intercomRunId,
								PI_SUBAGENT_CHILD_AGENT: "gateway-account",
								PI_SUBAGENT_CHILD_INDEX: "0",
							}
						: {}),
				},
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

			const readyTimeoutMs = this.#options.readyTimeoutMs ?? 60_000;
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
				if (!settled && !this.#ready) {
					// Genuine spawn failure: the process died before the ready
					// frame was ever processed (or died without emitting it).
					settled = true;
					clearTimeout(timeout);
					clearInterval(checkReady);
					reject(
						new RpcTransportError(
							this.#readyFailureReason ?? `Agent RPC process exited with code ${exitCode} before ready`,
							this.#stderrTail.join("\n"),
						),
					);
					return;
				}
				if (!settled) {
					// Race: the ready frame was processed (`#ready` is true) but
					// the 50ms ready-check interval hadn't resolved yet when the
					// process died. This is a post-ready crash, not a spawn
					// failure — resolve start() and surface the death as a
					// `disconnected` event so the bridge records a crash.
					// Without this branch, a crash in the first milliseconds
					// after ready is misreported as "before ready" and the
					// start() promise hangs (interval + timeout both cleared).
					settled = true;
					clearTimeout(timeout);
					clearInterval(checkReady);
					resolve();
				}
				// Process exited after reaching `ready` — surface this as a
				// `disconnected` event so the bridge can record a crash and
				// back off. Without this emit, the transport silently loses
				// the subprocess and the bridge only learns on its next
				// `transport.start()` retry, which can take 30+ seconds to
				// surface as a `before ready` error.
				const wasReady = this.#ready;
				this.#ready = false;
				this.#proc = null;
				this.#stdinWriter = undefined;
				this.#emit({
					type: "disconnected",
					error: new Error(`Agent RPC process exited with code ${exitCode} after ready (wasReady=${wasReady})`),
					stderrTail: this.#stderrTail.join("\n"),
				});
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
		const decoder = new TextDecoder();
		let partial = "";
		const push = (line: string): void => {
			const trimmed = line.trim();
			if (!trimmed) return;
			this.#stderrTail.push(trimmed);
			if (this.#stderrTail.length > STDERR_TAIL_LINES) {
				this.#stderrTail.shift();
			}
		};
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				partial += decoder.decode(value, { stream: true });
				const lines = partial.split("\n");
				partial = lines.pop() ?? "";
				for (const line of lines) push(line);
			}
			if (partial.trim()) push(partial);
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

		// ready signal: verify the protocol handshake, then mark transport
		// ready and emit to owner.
		if (parsed.type === "ready") {
			const version = (parsed as { protocol_version?: unknown }).protocol_version;
			if (version !== RPC_PROTOCOL_VERSION) {
				// Hard handshake rejection: the child is a legacy or
				// version-mismatched omp binary. Kill the child; the exited
				// handler rejects start() with this diagnostic instead of
				// leaving a half-ready subprocess or a bare exit code.
				const why =
					version === undefined
						? "ready frame missing protocol_version (legacy omp)"
						: `protocol_version ${String(version)} != expected ${RPC_PROTOCOL_VERSION}`;
				this.#readyFailureReason = `Agent RPC handshake failed: ${why}. Upgrade omp (expected protocol_version: ${RPC_PROTOCOL_VERSION}).`;
				logger.error("[RpcTransport] protocol handshake rejected", { reason: this.#readyFailureReason });
				this.#proc?.kill();
				return;
			}
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

		// host_tool_call: route to the bridge's HostToolDispatcher when one is
		// wired in. Otherwise fall back to the legacy reject behaviour (kept
		// for backward compatibility with bridges that have no host tools).
		if (parsed.type === "host_tool_call") {
			const call = parsed as unknown as HostToolCallRequest;
			const reply = (body: { content: Array<{ type: "text"; text: string }>; isError?: boolean }) => {
				const result: RpcHostToolResult = {
					type: "host_tool_result",
					id: call.id,
					result: { type: "tool_result", tool_use_id: call.toolCallId, content: body.content },
					isError: body.isError,
				};
				this.#writeFrame(result);
			};
			if (this.#hostToolHandler) {
				Promise.resolve(this.#hostToolHandler(call, reply)).catch(err => {
					logger.error("[RpcTransport] hostToolHandler threw", {
						toolName: call.toolName,
						error: err instanceof Error ? err.message : String(err),
					});
					reply({
						content: [
							{ type: "text", text: `Host tool error: ${err instanceof Error ? err.message : String(err)}` },
						],
						isError: true,
					});
				});
				return;
			}
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
