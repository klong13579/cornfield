import { randomUUID } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { SessionStore } from "../session/session-store";
import type { TodoPhase } from "../tools/todo-write";
import {
	type ClientFrame,
	MULTIDEVICE_PROTOCOL_VERSION,
	type ServerFrame,
	type WireCommand,
	type WireServerEvent,
} from "./wire-types";

export interface WireServerOptions {
	host: string;
	port: number;
	token: string;
	session: AgentSession;
	store: SessionStore;
}

interface Connection {
	connectionId: string;
	ws: Bun.ServerWebSocket<Connection | undefined>;
}

type WireSocket = Bun.ServerWebSocket<Connection | undefined>;

/**
 * `omp serve` 的 WS 传输层。
 *
 * 职责（且仅此）：
 * - 升级 /ws 连接前校验 query token
 * - 握手：hello → hello_ack(connectionId)（版本不符 → hello_error）
 * - request/response 按 request id 关联
 * - 会话事件 → 全连接广播：session_snapshot（权威）+ progress（提示）
 *
 * 命令语义（wire 子集）在 handleCommand 内按 session 方法实现；未实现的
 * 命令显式返回 not_implemented，绝不静默吞掉。
 */
export async function startWireServer(options: WireServerOptions): Promise<void> {
	const { token, session, store } = options;
	const connections = new Set<Connection>();

	const send = (ws: WireSocket, frame: ServerFrame): void => {
		ws.send(JSON.stringify(frame));
	};

	const broadcast = (frame: ServerFrame): void => {
		for (const conn of connections) {
			send(conn.ws, frame);
		}
	};

	const sendSnapshot = (ws: WireSocket): void => {
		const event: WireServerEvent = {
			type: "session_snapshot",
			sessionId: session.sessionId,
			snapshot: store.getSnapshot(),
		};
		send(ws, { type: "push", event });
	};

	const handleCommand = async (command: WireCommand, reply: (frame: ServerFrame) => void): Promise<void> => {
		const done = (result?: unknown): void => reply({ type: "response", id: "", ok: true, result });
		const fail = (error: string): void => reply({ type: "response", id: "", ok: false, error });

		try {
			switch (command.type) {
				// ─────────────────────────────────────────────────────────────
				// Prompting (P1)
				// ─────────────────────────────────────────────────────────────
				case "prompt": {
					// fire-and-forget：事件流经 store.subscribe 推送，错误回到 response
					session.prompt(command.message, { images: command.images }).catch((err: Error) => {
						fail(err.message);
					});
					done();
					break;
				}
				case "steer": {
					await session.steer(command.message, command.images);
					done();
					break;
				}
				case "follow_up": {
					await session.followUp(command.message, command.images);
					done();
					break;
				}
				case "abort": {
					await session.abort();
					done();
					break;
				}
				case "abort_and_prompt": {
					// 组合语义与 rpc-mode 完全一致：先 abort，再 fire-and-forget 新 prompt。
					await session.abort();
					session.prompt(command.message, { images: command.images }).catch((err: Error) => {
						fail(err.message);
					});
					done();
					break;
				}
				case "new_session": {
					const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
					const success = await session.newSession(options);
					done({ cancelled: !success });
					break;
				}

				// ─────────────────────────────────────────────────────────────
				// State (P1 + P2 补齐)
				// ─────────────────────────────────────────────────────────────
				case "get_snapshot": {
					done({ snapshot: store.getSnapshot() });
					break;
				}
				case "get_state": {
					done(buildRpcState(session, store));
					break;
				}
				case "set_todos": {
					session.setTodoPhases(command.phases as TodoPhase[]);
					done({ todoPhases: session.getTodoPhases() });
					break;
				}
				case "set_host_tools": {
					// P2 已知缺口（见 mock/DEV-PLAN.md 与本次交付说明）：
					// host tools 需要双向 wire 帧（host_tool_call/host_tool_result/
					// host_tool_update/host_tool_cancel），本迭代未定义这些帧类型也未
					// 约定客户端 handler，属协议层新增，需与 fe-dev 同步。返回明确的
					// not_implemented 而非静默接受 tool 声明后无法调用（避免向 LLM 暴露
					// 不可执行的工具，形成 plausible lie）。
					fail(
						"not_implemented: set_host_tools requires bidirectional host_tool_* frames (planned; needs pi-wire协议扩展 + client handler)",
					);
					break;
				}

				// ─────────────────────────────────────────────────────────────
				// Model (P2 补齐)
				// ─────────────────────────────────────────────────────────────
				case "set_model": {
					const models = session.getAvailableModels();
					const model = models.find(m => m.provider === command.provider && m.id === command.modelId);
					if (!model) {
						fail(`Model not found: ${command.provider}/${command.modelId}`);
						break;
					}
					await session.setModel(model);
					done(model);
					break;
				}
				case "cycle_model": {
					const result = await session.cycleModel();
					done(result ?? null);
					break;
				}

				// ─────────────────────────────────────────────────────────────
				// Thinking (P1)
				// ─────────────────────────────────────────────────────────────
				case "set_thinking_level": {
					session.setThinkingLevel(command.level);
					done();
					break;
				}
				case "cycle_thinking_level": {
					const level = session.cycleThinkingLevel();
					done(level ? { level } : null);
					break;
				}

				// ─────────────────────────────────────────────────────────────
				// Compaction (P2 补齐)
				// ─────────────────────────────────────────────────────────────
				case "compact": {
					const result = await session.compact(command.customInstructions);
					done(result);
					break;
				}
				case "set_auto_compaction": {
					session.setAutoCompactionEnabled(command.enabled);
					done();
					break;
				}

				// ─────────────────────────────────────────────────────────────
				// Retry (P2 补齐)
				// ─────────────────────────────────────────────────────────────
				case "set_auto_retry": {
					session.setAutoRetryEnabled(command.enabled);
					done();
					break;
				}
				case "abort_retry": {
					session.abortRetry();
					done();
					break;
				}

				// ─────────────────────────────────────────────────────────────
				// Session (P2 补齐)
				// ─────────────────────────────────────────────────────────────
				case "set_session_name": {
					const name = command.name.trim();
					if (!name) {
						fail("Session name cannot be empty");
						break;
					}
					const applied = await session.setSessionName(name, "user");
					if (!applied) {
						fail("Session name cannot be empty");
						break;
					}
					done();
					break;
				}
				case "get_last_assistant_text": {
					const text = session.getLastAssistantText();
					done({ text: text ?? null });
					break;
				}

				// ─────────────────────────────────────────────────────────────
				// wire 扩展 / P1 stub 保留
				// ─────────────────────────────────────────────────────────────
				case "subscribe":
				case "unsubscribe":
				case "get_available_models":
					// P1 单会话：连接级推送，无显式订阅表；命令保留以兼容协议面。
					// get_available_models 属 P3 会话/多 Agent 阶段，本迭代不动。
					done();
					break;
				default:
					fail(`not_implemented: ${(command as { type: string }).type}`);
			}
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err));
		}
	};

	const handleFrame = (ws: WireSocket, raw: string | Buffer): void => {
		let frame: ClientFrame;
		try {
			frame = JSON.parse(String(raw)) as ClientFrame;
		} catch {
			send(ws, { type: "response", id: "", ok: false, error: "invalid_json" });
			return;
		}

		if (frame.type === "hello") {
			if (frame.version !== MULTIDEVICE_PROTOCOL_VERSION) {
				send(ws, { type: "hello_error", error: `unsupported protocol version ${frame.version}` });
				return;
			}
			if (frame.token !== token) {
				send(ws, { type: "hello_error", error: "invalid token" });
				return;
			}
			const conn: Connection = { connectionId: randomUUID(), ws };
			ws.data = conn;
			connections.add(conn);
			send(ws, {
				type: "hello_ack",
				connectionId: conn.connectionId,
				protocolVersion: MULTIDEVICE_PROTOCOL_VERSION,
			});
			sendSnapshot(ws);
			return;
		}

		if (frame.type !== "request") {
			send(ws, { type: "response", id: "", ok: false, error: "expected request frame" });
			return;
		}
		// 握手完成前拒绝一切 request
		if (!ws.data) {
			send(ws, { type: "hello_error", error: "hello required before request" });
			return;
		}
		const reply = (f: ServerFrame): void => {
			send(ws, f.type === "response" ? { ...f, id: frame.id } : f);
		};
		void handleCommand(frame.command, reply);
	};

	const unsubscribe = store.subscribe((snapshot, event) => {
		const snapshotEvent: WireServerEvent = { type: "session_snapshot", sessionId: session.sessionId, snapshot };
		broadcast({ type: "push", event: snapshotEvent });
		if (event.type === "message_update" || event.type === "tool_execution_update") {
			const progressEvent: WireServerEvent = { type: "progress", sessionId: session.sessionId, event };
			broadcast({ type: "push", event: progressEvent });
		}
	});

	const server = Bun.serve<Connection | undefined>({
		hostname: options.host,
		port: options.port,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
			if (url.searchParams.get("token") !== token) return new Response("unauthorized", { status: 401 });
			const upgraded = srv.upgrade(req, { data: undefined });
			return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws) {
				ws.data = undefined; // 等 hello
			},
			message(ws, raw) {
				handleFrame(ws, raw as string | Buffer);
			},
			close(ws) {
				const conn = ws.data;
				if (conn) connections.delete(conn);
			},
		},
	});

	logger.info("serve:listening", {
		url: `ws://${options.host}:${options.port}/ws?token=${token}`,
		sessionId: session.sessionId,
	});

	const stop = (): void => {
		unsubscribe();
		connections.clear();
		server.stop();
		process.exit(0);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	// 常驻：Bun.serve 维持事件循环；信号到达时走 stop()
	await new Promise<void>(() => {});
}

function buildRpcState(session: AgentSession, store: SessionStore): Record<string, unknown> {
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		queuedMessageCount: session.queuedMessageCount,
		todoPhases: session.getTodoPhases(),
		snapshotSeq: store.getSnapshot().seq,
	};
}
