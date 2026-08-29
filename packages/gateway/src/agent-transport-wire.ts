/**
 * WireTransport — owns the lifecycle of an `omp --mode wire-stdio` child process
 * and the Wire protocol (pi-wire frames) on its stdin/stdout. P2 replacement for
 * RpcTransport (JSON-line protocol). P2-4：agent-transport.ts 已删除——原 JSON-line
 * 协议类型（AgentEvent / HostToolCall* / RpcTransportEvent）迁入本文件，bridge 消费
 * 侧 continue 使用（本文件是共享协议类型的唯一家）。
 *
 * Responsibilities (mirror RpcTransport):
 * - Spawn the child, send `hello`, wait for `hello_ack`.
 * - Write `request` frames to stdin; correlate `response` frames by id.
 * - Emit push events (progress / host_tool_call / session_snapshot) to subscribers.
 * - Kill the process on `stop()`.
 *
 * Compatibility with AgentBridge call sites:
 * - `sendCommand(name, payload, timeoutMs)` keeps its signature — the payload is
 *   mapped onto the WireCommand of the same name, and the wire response is
 *   returned as the rpc-shaped AgentEvent (`data` = wire `result`) so bridge
 *   consumers (`response.data.x`) keep working unchanged.
 * - `sendFrame` / `sendHostToolResult` keep their shapes (wire frames are
 *   structurally identical for host_tool_result).
 * - No extension_ui_request handling: wire-stdio auto-defaults UI dialogs on the
 *   agent side (bridge has no dialog host).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@cornfield/utils";
import type { ClientFrame, ServerFrame, WireCommand, WireErrorPayload } from "@cornfield/wire";
import type { FileSink } from "bun";
import { randomUUID } from "crypto";
import { resolveCredentialEnvVars } from "./credential-resolver";

// ── 共享协议类型（迁自 agent-transport.ts；JSON-line 时代的心智模型保留）──

/** Inline-shape RPC event（rpc-types 的传输投影；bridge 消费侧保持此形状）。 */
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
	/** 流式子事件（text/thinking/toolcall 增量 + 生命周期标记）。 */
	assistantMessageEvent?: {
		type: string;
		delta?: string;
		contentIndex?: number;
		[key: string]: unknown;
	};
}

/** 传输向 owner 发出的事件（父进程视角；wire 帧推到 rpc 形状）。 */
export type RpcTransportEvent =
	/** 子进程握手完成，可发命令。 */
	| { type: "ready" }
	/** 已发命令的 response 帧到达。 */
	| { type: "command_response"; commandId: string; event: AgentEvent }
	/** 会话事件（无 id），流式推给当前 prompt。 */
	| { type: "session_event"; event: AgentEvent }
	/** 子进程退出（异常退出带 stderrTail 供崩溃诊断）。 */
	| { type: "disconnected"; error?: Error; stderrTail?: string };

/** OMP 发出的 host_tool_call 请求（传输不理解语义，仅转交 handler）。 */
export interface HostToolCallRequest {
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** host_tool_call 回调：写入 reply(result) 即回 host_tool_result 帧。 */
export type HostToolCallHandler = (
	call: HostToolCallRequest,
	reply: (body: { content: Array<{ type: "text"; text: string }>; isError?: boolean }) => void,
) => Promise<void> | void;

interface PendingCommand {
	command: string;
	resolve: (event: AgentEvent) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

export interface WireTransportOptions {
	/** Path to cornfield binary (default: resolveDefaultCornfieldPath()) */
	cornfieldPath?: string;
	/** Model to pass via `--model` flag on spawn (default: undefined) */
	model?: string;
	/** Working directory for the child process (default: process.cwd()) */
	cwd?: string;
	/** Timeout in ms to wait for the `hello_ack` signal (default: 30000) */
	readyTimeoutMs?: number;
	/** Handler for `host_tool_call` push events. */
	hostToolHandler?: HostToolCallHandler;
	/** Intercom parent target. */
	intercomParent?: string;
}

export class WireTransportError extends Error {
	/** Trailing stderr lines of the child process at failure time (crash diagnosis). */
	readonly stderrTail: string | undefined;

	constructor(message: string, stderrTail?: string) {
		super(stderrTail ? `${message}\nstderr tail:\n${stderrTail}` : message);
		this.name = "WireTransportError";
		this.stderrTail = stderrTail;
	}
}

export class WireTransport {
	#proc: { pid: number; kill: () => void } | null = null;
	#stdinWriter?: { write: (data: Uint8Array) => void };
	#ready = false;
	/** Set when the hello_ack frame arrives with an incompatible protocol
	 *  version. The child is killed and `start()` rejects with this diagnostic. */
	#readyFailureReason: string | undefined;
	#pendingCommands = new Map<string, PendingCommand>();
	#commandIdCounter = 0;
	#reconnectGuard = false;
	#options: WireTransportOptions;
	/** Stable per-transport run id for the intercom child metadata. */
	#intercomRunId = randomUUID();
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced in stop() and #spawnAndWaitReady for stream-reader liveness
	#stderrReader?: Promise<void>;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced in stop() and #spawnAndWaitReady for stream-reader liveness
	#stdoutReader?: Promise<void>;
	/** Trailing stderr lines of the current child process (crash diagnosis). */
	#stderrTail: string[] = [];
	#listeners: Array<(event: RpcTransportEvent) => void> = [];
	#hostToolHandler: HostToolCallHandler | undefined;

	constructor(options: WireTransportOptions = {}) {
		this.#options = options;
		this.#hostToolHandler = options.hostToolHandler;
	}

	/** Subscribe to transport events. Returns an unsubscribe function. */
	onEvent(handler: (event: RpcTransportEvent) => void): () => void {
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
				logger.warn("WireTransport event handler threw", {
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

		const error = new Error("WireTransport stopped");
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
	 * Send a WireCommand request and wait for its `response` frame.
	 * The payload is mapped onto the WireCommand of the same `type` name, and
	 * the wire response is returned as the rpc-shaped AgentEvent (`data` =
	 * wire `result`) so AgentBridge call sites (`response.data.x`) keep working.
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
			reject(new Error(`Agent wire command ${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingCommands.set(commandId, { command, resolve, reject, timeout });

		const wireCommand = { id: commandId, type: command, ...payload } as unknown as WireCommand;
		try {
			this.#writeFrame({ type: "request", id: commandId, command: wireCommand });
		} catch (err) {
			clearTimeout(timeout);
			this.#pendingCommands.delete(commandId);
			reject(err instanceof Error ? err : new Error(String(err)));
		}

		return promise;
	}

	/**
	 * Send a fire-and-forget frame (e.g. `follow_up` — no response consumed).
	 * The frame id prefers `payload.id` so bridge-side prompt tracking can
	 * correlate the response via `command_response` (rpc parity: prompt frames
	 * carry promptId as their id and the bridge keys its pending prompts on it).
	 */
	sendFrame(type: string, payload: Record<string, unknown>): void {
		const id = (payload.id as string | undefined) ?? `f_${++this.#commandIdCounter}`;
		const wireCommand = { id, type, ...payload } as unknown as WireCommand;
		this.#writeFrame({ type: "request", id, command: wireCommand });
	}

	/** Convenience: write a `host_tool_result` frame for a call dispatched
	 *  via the `hostToolHandler` callback. Shape is identical in rpc and wire. */
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

	#writeFrame(frame: ClientFrame | Record<string, unknown>): void {
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
			const error = new Error("WireTransport restarting");
			for (const pending of this.#pendingCommands.values()) {
				clearTimeout(pending.timeout);
				pending.reject(error);
			}
			this.#pendingCommands.clear();

			const cornfieldPath = this.#options.cornfieldPath ?? resolveDefaultCornfieldPath();
			const args = ["--mode", "wire-stdio"];
			if (this.#options.model) {
				args.push("--model", this.#options.model);
			}

			logger.debug("Spawning agent wire-stdio process", { cornfieldPath, args });

			const proc = Bun.spawn([cornfieldPath, ...args], {
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
				logger.error("Invalid stdin for wire transport");
				throw new Error("Failed to initialize wire transport stdin");
			}

			this.#proc = { pid: proc.pid, kill: () => proc.kill() };
			this.#stdinWriter = {
				write: (data: Uint8Array) => {
					stdin.write(data);
				},
			};

			this.#stdoutReader = this.#startStdoutReader(proc.stdout as ReadableStream<Uint8Array>);
			this.#stderrReader = this.#drainStderr(proc.stderr as ReadableStream<Uint8Array>);

			// Wire handshake: client sends hello, server replies hello_ack.
			this.#writeFrame({ type: "hello", version: 1, token: "gateway" });

			const readyTimeoutMs = this.#options.readyTimeoutMs ?? 60_000;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			let settled = false;

			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				proc.kill();
				reject(new Error(`Agent wire process timed out waiting for hello_ack (${readyTimeoutMs}ms)`));
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
				// Only the process currently registered as `#proc` may drive the
				// disconnect path. A stale exit callback from a process killed
				// during `#restartTransport` must not clobber the freshly spawned
				// replacement's `#ready`/`#proc`/`#stdinWriter` registration —
				// otherwise the new process stays alive-but-unregistered and the
				// bridge reports `isRunning=false` until a manual restart.
				if (this.#proc?.pid !== proc.pid) {
					logger.debug("Ignoring exit from stale wire process", {
						pid: proc.pid,
						currentPid: this.#proc?.pid,
						exitCode,
					});
					return;
				}
				if (!settled && !this.#ready) {
					settled = true;
					clearTimeout(timeout);
					clearInterval(checkReady);
					reject(
						new WireTransportError(
							this.#readyFailureReason ?? `Agent wire process exited with code ${exitCode} before hello_ack`,
							this.#stderrTail.join("\n"),
						),
					);
					return;
				}
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					clearInterval(checkReady);
					resolve();
				}
				const wasReady = this.#ready;
				this.#ready = false;
				this.#proc = null;
				this.#stdinWriter = undefined;
				this.#emit({
					type: "disconnected",
					error: new Error(
						`Agent wire process exited with code ${exitCode} after hello_ack (wasReady=${wasReady})`,
					),
					stderrTail: this.#stderrTail.join("\n"),
				});
			});

			try {
				await promise;
				logger.debug("Agent wire process ready", { pid: proc.pid });
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

	// ═══════════════════════════════════════════════════════════════
	// Frame parsing
	// ═══════════════════════════════════════════════════════════════

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
						await this.#processWireLine(line);
					}

					idx = buffer.indexOf("\n");
				}
			}

			if (buffer.trim()) {
				await this.#processWireLine(buffer.trim());
			}
		} catch {
			// Stream error — handle gracefully
		} finally {
			reader.releaseLock();
		}
	}

	async #processWireLine(line: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			logger.warn("WireTransport: unparseable line from agent", { line: line.slice(0, 200) });
			return;
		}

		const frame = parsed as ServerFrame<unknown, unknown>;

		switch (frame.type) {
			case "hello_ack": {
				if (typeof frame.protocolVersion !== "number" || frame.protocolVersion < 1) {
					this.#readyFailureReason = `Incompatible wire protocol version: ${String(frame.protocolVersion)}`;
					return;
				}
				this.#ready = true;
				// rpc parity：bridge 的 lifecycle state 依赖 ready 事件（setReady + registerHostTools）
				this.#emit({ type: "ready" });
				return;
			}

			case "hello_error": {
				this.#readyFailureReason = `hello rejected: ${frame.error}`;
				return;
			}

			case "response": {
				const pending = this.#pendingCommands.get(frame.id);
				if (pending) {
					this.#pendingCommands.delete(frame.id);
					clearTimeout(pending.timeout);
					if (frame.ok) {
						const event: AgentEvent = {
							id: frame.id,
							type: "response",
							command: pending.command,
							success: true,
							data: frame.result,
						};
						pending.resolve(event);
						this.#emit({ type: "command_response", commandId: frame.id, event });
					} else {
						const message =
							typeof frame.error === "string"
								? frame.error
								: ((frame.error as WireErrorPayload | undefined)?.message ?? "Unknown error");
						pending.reject(new Error(message));
					}
					return;
				}
				// 无关联 pending（fire-and-forget 命令如 prompt 的确认响应）——仍转发
				// command_response，让 bridge 的 PromptQueue 按 promptId 关联（rpc parity）。
				const orphan: AgentEvent = {
					id: frame.id,
					type: "response",
					command: frame.ok ? "prompt" : "prompt",
					success: frame.ok,
					...(frame.ok ? {} : { error: typeof frame.error === "string" ? frame.error : "Unknown error" }),
				};
				this.#emit({ type: "command_response", commandId: frame.id, event: orphan });
				return;
			}

			case "push": {
				const event = frame.event;
				if (event && typeof event === "object" && "type" in event) {
					const e = event as { type: string };
					if (e.type === "host_tool_call") {
						const call = event as unknown as {
							id: string;
							toolCallId: string;
							toolName: string;
							arguments: Record<string, unknown>;
						};
						await this.#dispatchHostToolCall(call);
						return;
					}
					if (e.type === "progress") {
						// 打平 progress 帧：bridge 消费 rpc 裸事件形状（message_end/agent_end/text_delta…），
						// 内层 event 即 AgentEvent。session_snapshot / host_tools_changed 非 bridge 事件流，
						// 忽略（bridge 用 get_state 拿状态）。
						const inner = (event as { event?: unknown }).event;
						if (inner !== undefined) {
							this.#emit({ type: "session_event", event: inner as AgentEvent });
						}
						return;
					}
					if (e.type === "session_snapshot" || e.type === "host_tools_changed") {
						return;
					}
				}
				return;
			}

			case "pong":
				return;

			default:
				logger.debug("WireTransport: unknown server frame", { frame: (frame as { type?: string }).type });
		}
	}

	async #dispatchHostToolCall(call: {
		id: string;
		toolCallId: string;
		toolName: string;
		arguments: Record<string, unknown>;
	}): Promise<void> {
		const handler = this.#hostToolHandler;
		const reply = (body: { content: Array<{ type: "text"; text: string }>; isError?: boolean }) => {
			this.sendHostToolResult(call.id, call.toolCallId, body.content, body.isError === true);
		};
		if (!handler) {
			reply({
				content: [{ type: "text", text: `Host tool "${call.toolName}" is not supported by this host` }],
				isError: true,
			});
			return;
		}
		try {
			await handler(call, reply);
		} catch (err) {
			logger.error("Host tool handler threw", {
				tool: call.toolName,
				error: err instanceof Error ? err.message : String(err),
			});
			reply({
				content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			});
		}
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
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
						this.#stderrTail.push(line);
						if (this.#stderrTail.length > 100) this.#stderrTail.shift();
					}
					idx = buffer.indexOf("\n");
				}
			}
			if (buffer.trim()) {
				this.#stderrTail.push(buffer.trim());
			}
		} catch {
			// Stream error — handle gracefully
		} finally {
			reader.releaseLock();
		}
	}
}

/**
 * Resolve the default cornfield binary path (same policy as WireTransport).
 */
export function resolveDefaultCornfieldPath(home: string = os.homedir()): string {
	const stable = path.join(home, ".local", "bin", "cornfield");
	try {
		fs.accessSync(stable, fs.constants.X_OK);
		return stable;
	} catch {
		return "cornfield";
	}
}
