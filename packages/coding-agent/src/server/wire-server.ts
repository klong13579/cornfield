import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModelPriceCatalog, getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats";
import { getAgentDir, getConfigRootDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type {
	ClientFrame,
	ServerFrame,
	WireCommand,
	WireCommandOfType,
	WireEnvironmentSummary,
	WireServerEvent,
} from "@oh-my-pi/pi-wire";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";
import { resolveGlobalMemoryRootCandidates } from "@oh-my-pi/self-evolution/paths";
import { getMemoryDb, getMemoryRoot, releaseMemoryDb, resolveMemoryDbPath } from "../memories";
import { loadSectionsFromDb } from "../memories/projection";
import { normalizeHostToolDefinitions } from "../modes/rpc/rpc-mode";
import type { AgentSession } from "../session/agent-session";
import type { SessionStore } from "../session/session-store";
import type { TodoPhase } from "../tools/todo-write";
import * as git from "../utils/git";
import { WireHostToolBridge } from "./host-tool-bridge";
import { agentSessionsRoot, defaultSessionsRoot, indexSessions, type SessionIndexSource } from "./session-index";
import {
	type AgentMeta,
	type AttachedSession,
	loadAgentMetas,
	type SessionFactory,
	SessionRegistry,
} from "./session-registry";

export interface WireServerOptions {
	host: string;
	port: number;
	token: string;
	/** P1 兼容：serve 启动时自建的会话（cwd 进程），注册为 default agent。 */
	defaultSession: { session: AgentSession; store: SessionStore };
	/** lazy attach 注册表 agent 的工厂（serve.ts 装配）。 */
	sessionFactory: SessionFactory;
}

/** 用户 HOME（读取 gateway 状态文件用；进程替换时跟随环境）。 */
function homeDir(): string {
	return process.env.HOME ?? os.homedir();
}

interface Connection {
	connectionId: string;
	ws: Bun.ServerWebSocket<Connection | undefined>;
	/** 本连接当前焦点 agent（P1：恒为 default）。 */
	activeAgentId: string;
	/** 本连接注册的 host tool bridge（per agent）。发 set_host_tools 的连接 = 执行者。 */
	hostToolBridges: Map<string, WireHostToolBridge>;
}

type WireSocket = Bun.ServerWebSocket<Connection | undefined>;

const PROGRESS_EVENT_TYPES = new Set([
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"turn_start",
	"turn_end",
	"agent_start",
	"agent_end",
]);

/**
 * `omp serve` 的 WS 传输层（P3 多 Agent 版）。
 *
 * 职责（且仅此）：
 * - 升级 /ws 连接前校验 query token；hello → hello_ack
 * - request/response 按 id 关联；ping → pong（不消耗 session）
 * - 命令按 command.sessionId ?? conn.activeAgentId 定向 agent（P1：无 sessionId 即 default）
 * - 事件路由：session_snapshot/progress 只推给 active 在该 agent 上的连接；
 *   server_snapshot（agent 列表）广播全连接
 * - host tool：set_host_tools 注册 bridge，call 帧只发给执行者连接；断开全拒
 */
export async function startWireServer(options: WireServerOptions): Promise<void> {
	const { token, defaultSession } = options;
	const connections = new Set<Connection>();

	const registry = new SessionRegistry(options.sessionFactory);
	registry.registerMeta({
		id: "default",
		name: "default",
		agentDir: process.cwd(),
	});
	const metas = await loadMetasSafe();
	for (const meta of metas) registry.registerMeta(meta);

	// default agent 启动即 attached（P1 语义：无 lazy、无 attach 命令也全功能）
	registry.attachExisting("default", {
		meta: registry.getMeta("default") as AgentMeta,
		session: defaultSession.session,
		store: defaultSession.store,
	});

	// 启动即预挂载所有注册 agent（与 gateway 4 bridge 常驻语义对齐）：
	// lazy attach 令 agent 在 serve 重启后全部回到"未挂载"，前端反复误读。
	// 预挂载后列表恒显示空闲/运行中；单个实例化失败仅告警，不阻塞 serve 启动。
	await Promise.allSettled(
		metas.map(async meta => {
			try {
				await registry.attach(meta.id);
			} catch (err) {
				logger.warn("serve:preload attach failed", { agentId: meta.id, error: String(err) });
			}
		}),
	);

	const send = (ws: WireSocket, frame: ServerFrame): void => {
		ws.send(JSON.stringify(frame));
	};

	const activeAgentIds = (): Set<string> => {
		const ids = new Set<string>();
		for (const conn of connections) ids.add(conn.activeAgentId);
		return ids;
	};

	const broadcastServerSnapshot = (): void => {
		const event: WireServerEvent = {
			type: "server_snapshot",
			sessions: registry.buildSessionList(activeAgentIds()),
		};
		for (const conn of connections) {
			send(conn.ws, { type: "push", event });
		}
	};

	const sendSessionSnapshot = (conn: Connection): void => {
		const attached = registry.getAttached(conn.activeAgentId);
		if (!attached) return;
		const event: WireServerEvent = {
			type: "session_snapshot",
			sessionId: conn.activeAgentId,
			snapshot: attached.store.getSnapshot(),
		};
		send(conn.ws, { type: "push", event });
	};

	// ── 事件路由：只推给 active 在该 agent 上的连接 ──
	registry.subscribe(event => {
		if (event.kind === "snapshot") {
			for (const conn of connections) {
				if (conn.activeAgentId !== event.sessionId) continue;
				const snapshotEvent: WireServerEvent = {
					type: "session_snapshot",
					sessionId: event.sessionId,
					snapshot: event.snapshot,
				};
				send(conn.ws, { type: "push", event: snapshotEvent });
				if (PROGRESS_EVENT_TYPES.has(event.event.type)) {
					const progressEvent: WireServerEvent = {
						type: "progress",
						sessionId: event.sessionId,
						event: event.event,
					};
					send(conn.ws, { type: "push", event: progressEvent });
				}
			}
			return;
		}
		// attached / detached → 列表变了，广播
		broadcastServerSnapshot();
	});

	/** 命令解析：返回目标 attached session；未 attach / 未注册时报错。 */
	const resolveTarget = (
		conn: Connection,
		command: { sessionId?: string },
	): { agentId: string; attached: AttachedSession } | { error: string } => {
		const agentId = command.sessionId ?? conn.activeAgentId;
		if (!registry.getMeta(agentId)) {
			return { error: `unknown agent: ${agentId}` };
		}
		const attached = registry.getAttached(agentId);
		if (!attached) {
			return { error: `agent not attached: ${agentId} (send attach first)` };
		}
		return { agentId, attached };
	};

	const handleCommand = async (
		conn: Connection,
		command: WireCommand,
		reply: (frame: ServerFrame) => void,
	): Promise<void> => {
		const done = (result?: unknown): void => reply({ type: "response", id: "", ok: true, result });
		const fail = (error: string): void => reply({ type: "response", id: "", ok: false, error });

		try {
			// ── registry 级命令（不定向具体 session）──
			switch (command.type) {
				case "list_agents": {
					done({ agents: registry.buildSessionList(activeAgentIds()) });
					return;
				}
				case "attach": {
					if (!registry.getMeta(command.sessionId)) {
						fail(`unknown agent: ${command.sessionId}`);
						return;
					}
					const attached = await registry.attach(command.sessionId);
					done({ sessionId: command.sessionId, sessionFile: attached.session.sessionFile });
					// broadcastServerSnapshot 已由 registry attached 事件触发
					return;
				}
				case "detach": {
					if (command.sessionId === "default") {
						fail("cannot detach default agent");
						return;
					}
					for (const c of connections) {
						if (c.activeAgentId === command.sessionId) {
							fail(`agent is active on a connection: ${command.sessionId} (switch_session first)`);
							return;
						}
					}
					await registry.detach(command.sessionId);
					done();
					return;
				}
				case "switch_session": {
					if (!registry.getMeta(command.sessionId)) {
						fail(`unknown agent: ${command.sessionId}`);
						return;
					}
					await registry.attach(command.sessionId);
					conn.activeAgentId = command.sessionId;
					// 新焦点的快照立即推给本连接（快照权威，客户端零恢复逻辑）
					sendSessionSnapshot(conn);
					broadcastServerSnapshot();
					done({ sessionId: command.sessionId });
					return;
				}
				case "subscribe":
				case "unsubscribe": {
					// P1 语义保留：连接级推送（跟随 activeAgentId），无显式订阅表。
					done();
					return;
				}
				case "list_sessions": {
					// P4 历史会话索引：纯文件扫描，不触碰 attached session。
					const metas = command.sessionId
						? registry.listMetas().filter(m => m.id === command.sessionId)
						: registry.listMetas();
					if (command.sessionId && metas.length === 0) {
						fail(`unknown agent: ${command.sessionId}`);
						return;
					}
					const sources: SessionIndexSource[] = metas.map(m => ({
						agentId: m.id,
						agentName: m.name,
						sessionsRoot: m.id === "default" ? defaultSessionsRoot() : agentSessionsRoot(m),
						source: m.id === "default" ? "cli" : "agent",
					}));
					const sessions = await indexSessions(sources, command.limit);
					done({ sessions });
					return;
				}
				case "fs_list": {
					const fsCmd = command as { type: "fs_list"; sessionId?: string; path?: string };
					const agentId = fsCmd.sessionId ?? conn.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const target = resolveFsPath(meta.agentDir, fsCmd.path ?? "");
					if (!target.ok) {
						fail(target.error);
						return;
					}
					const entries = await listDirEntries(target.path);
					if (entries.error) {
						fail(entries.error);
						return;
					}
					done({ path: fsCmd.path ?? "", entries: entries.items });
					return;
				}
				case "fs_read": {
					const fsCmd = command as { type: "fs_read"; sessionId?: string; path?: string };
					const agentId = fsCmd.sessionId ?? conn.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const target = resolveFsPath(meta.agentDir, fsCmd.path ?? "");
					if (!target.ok) {
						fail(target.error);
						return;
					}
					const content = await readTextFileClipped(target.path);
					if (content.error) {
						fail(content.error);
						return;
					}
					done({ path: fsCmd.path ?? "", ...content });
					return;
				}
				case "gateway_status": {
					const res = await readGatewayStatus();
					if (!res.ok) {
						fail(res.error);
						return;
					}
					done(res.status);
					return;
				}
				case "get_stats": {
					// W3 D1：与 `omp stats --json` 同源——先增量同步会话文件再读聚合。
					// 只读转发 stats.db（本地聚合缓存），不触碰任何 attached session。
					// W3 D2：可选 period 对聚合做时间窗口；响应附带 models.json 单价目录。
					try {
						await syncAllSessions();
						const periodMs = parseStatsPeriod(command.period);
						const stats = await getDashboardStats(periodMs);
						done({ ...stats, priceCatalog: buildModelPriceCatalog(stats.byModel) });
					} catch (err) {
						fail(`stats unavailable: ${String(err)}`);
					}
					return;
				}
				case "get_memory": {
					// W3 D3：只读记忆投影（memory/user/project 三分区），锚定 serve 进程 cwd 的 default agent。
					// 记忆根用 getAgentDir()（~/.omp/agent）——default meta 的 agentDir 是 workspace cwd（P1 语义），
					// 与 sdk.ts 里 memory 扩展的解析不一致，不能用于记忆投影。
					try {
						const cwd = process.cwd();
						done(await buildMemoryProjection(cwd, getAgentDir()));
					} catch (err) {
						fail(`memory unavailable: ${String(err)}`);
					}
					return;
				}
				default:
					break;
			}

			// ── session 级命令：全部需要已 attach 的目标 ──
			const target = resolveTarget(conn, command);
			if ("error" in target) {
				fail(target.error);
				return;
			}
			const { agentId, attached } = target;
			const session = attached.session;

			// 状态型命令（不产生 session 事件的 mutation）完成后主动推快照：
			// set_todos/set_model 等只改 getter，不走事件流，客户端等不到权威更新。
			// 事件型命令（prompt 等）自然会推，不需要重复。
			const MUTATING_NO_EVENT = new Set([
				"set_todos",
				"set_model",
				"set_thinking_level",
				"cycle_thinking_level",
				"cycle_model",
				"set_auto_compaction",
				"set_auto_retry",
				"abort_retry",
				"set_session_name",
				"set_host_tools",
				"new_session",
				"branch",
			]);
			const sessionDone = (result?: unknown): void => {
				done(result);
				if (MUTATING_NO_EVENT.has(command.type)) sendSessionSnapshot(conn);
			};
			switch (command.type) {
				// ── Prompting ──
				case "prompt": {
					session.prompt(command.message, { images: command.images }).catch((err: Error) => {
						fail(err.message);
					});
					done();
					break;
				}
				case "steer": {
					await session.steer(command.message, command.images);
					// 协议批 B-1：steer 事件回显——转发后向订阅连接推 progress 帧（steer 标记 + 文本摘要），
					// W2 的 SteerIndicator 以此为数据源（web-app 端归一到 ProgressEventDto steer）。
					send(conn.ws, {
						type: "push",
						event: {
							type: "progress",
							sessionId: agentId,
							event: { type: "steer", text: command.message },
						},
					});
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
					await session.abort();
					session.prompt(command.message, { images: command.images }).catch((err: Error) => {
						fail(err.message);
					});
					done();
					break;
				}
				case "new_session": {
					const opts = command.parentSession ? { parentSession: command.parentSession } : undefined;
					const success = await session.newSession(opts);
					sessionDone({ cancelled: !success });
					break;
				}

				// ── State ──
				case "get_snapshot": {
					done({ snapshot: attached.store.getSnapshot() });
					break;
				}
				case "get_state": {
					done(buildRpcState(session, attached.store, await buildEnvironmentSummary(registry)));
					break;
				}
				case "get_skills": {
					// W3 D5：只读列出该 agent 已加载技能（session.skills 与 agent 实际运行同源）。
					// discovery 已按 settings 过滤——此处列表即「已启用」集；B3 启停协议落地前不做任何写返回。
					// level（user/project/native）+ provider 供前端分类折叠。
					done({
						skills: session.skills.map(s => ({
							name: s.name,
							description: s.description,
							source: s.source,
							level: s._source?.level ?? "native",
							provider: s._source?.providerName ?? "builtin",
						})),
					});
					break;
				}
				case "set_todos": {
					session.setTodoPhases(command.phases as TodoPhase[]);
					sessionDone({ todoPhases: session.getTodoPhases() });
					break;
				}
				case "set_host_tools": {
					// P3：双向帧已定义（pi-wire HostToolCallPush/...）。本连接成为执行者。
					const definitions = normalizeHostToolDefinitions(command.tools);
					let bridge = conn.hostToolBridges.get(agentId);
					if (!bridge) {
						bridge = new WireHostToolBridge(agentId);
						conn.hostToolBridges.set(agentId, bridge);
					}
					bridge.bindOutput(push => send(conn.ws, { type: "push", event: push }));
					await session.refreshRpcHostTools(bridge.setTools(definitions));
					const changedEvent: WireServerEvent = {
						type: "host_tools_changed",
						sessionId: agentId,
						tools: command.tools,
					};
					send(conn.ws, { type: "push", event: changedEvent });
					sessionDone({ toolNames: definitions.map(tool => tool.name) });
					break;
				}

				// ── Model ──
				case "set_model": {
					const models = session.getAvailableModels();
					const model = models.find(m => m.provider === command.provider && m.id === command.modelId);
					if (!model) {
						fail(`Model not found: ${command.provider}/${command.modelId}`);
						break;
					}
					await session.setModel(model);
					sessionDone(model);
					break;
				}
				case "cycle_model": {
					const result = await session.cycleModel();
					sessionDone(result ?? null);
					break;
				}
				case "get_available_models": {
					// P3 真实现：返回目标 session 的可用模型全量列表。
					done({ models: session.getAvailableModels() });
					break;
				}

				// ── Thinking ──
				case "set_thinking_level": {
					session.setThinkingLevel(command.level);
					sessionDone();
					break;
				}
				case "cycle_thinking_level": {
					const level = session.cycleThinkingLevel();
					sessionDone(level ? { level } : null);
					break;
				}

				// ── Compaction ──
				case "compact": {
					const result = await session.compact(command.customInstructions);
					done(result);
					break;
				}
				case "set_auto_compaction": {
					session.setAutoCompactionEnabled(command.enabled);
					sessionDone();
					break;
				}

				// ── Retry ──
				case "set_auto_retry": {
					session.setAutoRetryEnabled(command.enabled);
					sessionDone();
					break;
				}
				case "abort_retry": {
					session.abortRetry();
					sessionDone();
					break;
				}

				// ── Session ──
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
					sessionDone();
					break;
				}
				case "get_last_assistant_text": {
					const text = session.getLastAssistantText();
					done({ text: text ?? null });
					break;
				}
				case "get_session_stats": {
					done(session.getSessionStats());
					break;
				}
				case "branch": {
					// 语义对齐 rpc-mode：从指定 entry 建 branch 会话，结果带选中文案供编辑器预填。
					// branch 会替换 session 内容但不保证走事件流 → 加入 MUTATING_NO_EVENT 推权威快照。
					const result = await session.branch(command.entryId);
					sessionDone({ text: result.selectedText, cancelled: result.cancelled });
					break;
				}
				case "get_branch_messages": {
					done({ messages: session.getUserMessagesForBranching() });
					break;
				}
				case "get_messages": {
					done({ messages: session.messages });
					break;
				}

				default:
					fail(`not_implemented: ${(command as { type: string }).type}`);
			}
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err));
		}
	};

	const handleHostToolFrame = (conn: Connection, frame: ClientFrame): boolean => {
		if (frame.type !== "host_tool_result" && frame.type !== "host_tool_update") return false;
		for (const bridge of conn.hostToolBridges.values()) {
			if (frame.type === "host_tool_result") {
				if (bridge.handleResult(frame)) return true;
			} else if (bridge.handleUpdate(frame)) {
				return true;
			}
		}
		logger.warn("serve:host-tool-frame-unmatched", { connectionId: conn.connectionId, frameType: frame.type });
		return true;
	};

	const handleFrame = (ws: WireSocket, raw: string | Buffer): void => {
		let frame: ClientFrame;
		try {
			frame = JSON.parse(String(raw)) as ClientFrame;
		} catch {
			send(ws, { type: "response", id: "", ok: false, error: "invalid_json" });
			return;
		}

		const conn = ws.data;

		// ping/pong 在握手前后都可响应（心跳不依赖业务状态）
		if (frame.type === "ping") {
			send(ws, { type: "pong", ts: frame.ts });
			return;
		}

		if (frame.type === "hello") {
			if (frame.version !== MULTIDEVICE_PROTOCOL_VERSION) {
				send(ws, { type: "hello_error", error: `unsupported protocol version ${frame.version}` });
				return;
			}
			// token 为空 = 本地免鉴权：hello 帧不校验（与 fetch 层空 token 跳过一致）
			if (token !== "" && frame.token !== token) {
				send(ws, { type: "hello_error", error: "invalid token" });
				return;
			}
			const connection: Connection = {
				connectionId: randomUUID(),
				ws,
				activeAgentId: "default",
				hostToolBridges: new Map(),
			};
			ws.data = connection;
			connections.add(connection);
			send(ws, {
				type: "hello_ack",
				connectionId: connection.connectionId,
				protocolVersion: MULTIDEVICE_PROTOCOL_VERSION,
			});
			// 列表 + 当前焦点快照（P1 兼容：客户端仍能只靠 session_snapshot 重建）
			broadcastServerSnapshot();
			sendSessionSnapshot(connection);
			return;
		}

		if (!conn) {
			if (frame.type === "host_tool_result" || frame.type === "host_tool_update") {
				send(ws, { type: "hello_error", error: "hello required before host_tool frames" });
				return;
			}
			send(ws, { type: "hello_error", error: "hello required before request" });
			return;
		}

		if (handleHostToolFrame(conn, frame)) return;

		if (frame.type !== "request") {
			send(ws, { type: "response", id: "", ok: false, error: "expected request frame" });
			return;
		}
		const reply = (f: ServerFrame): void => {
			send(ws, f.type === "response" ? { ...f, id: frame.id } : f);
		};
		void handleCommand(conn, frame.command, reply);
	};

	const server = Bun.serve<Connection | undefined>({
		hostname: options.host,
		port: options.port,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
			// token 为空 = 本地免鉴权（仅绑 127.0.0.1）；非空时 URL query 与 hello 帧都要校验
			if (token !== "" && url.searchParams.get("token") !== token)
				return new Response("unauthorized", { status: 401 });
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
				const connection = ws.data;
				if (!connection) return;
				connections.delete(connection);
				// host tool 执行者断开：pending 全拒（fail fast）
				for (const bridge of connection.hostToolBridges.values()) {
					bridge.detachOutput(`connection ${connection.connectionId} closed`);
				}
				connection.hostToolBridges.clear();
			},
		},
	});

	logger.info("serve:listening", {
		url: token ? `ws://${options.host}:${options.port}/ws?token=${token}` : `ws://${options.host}:${options.port}/ws`,
		sessionId: defaultSession.session.sessionId,
		agents: registry.listMetas().map(meta => meta.id),
	});

	const stop = async (): Promise<void> => {
		connections.clear();
		await registry.disposeAll();
		server.stop();
		process.exit(0);
	};
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());

	// 常驻：Bun.serve 维持事件循环；信号到达时走 stop()
	await new Promise<void>(() => {});
}

async function loadMetasSafe(): Promise<AgentMeta[]> {
	try {
		return await loadAgentMetas();
	} catch (err) {
		logger.warn("serve:registry-load-failed", { error: String(err) });
		return [];
	}
}

function buildRpcState(
	session: AgentSession,
	store: SessionStore,
	env: WireEnvironmentSummary,
): Record<string, unknown> {
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
		env,
	};
}

/** B1 环境摘要：repos/branch 来自 serve 进程 cwd，agent 数来自注册表；cron 仅 gateway 面。 */
async function buildEnvironmentSummary(registry: SessionRegistry): Promise<WireEnvironmentSummary> {
	const cwd = process.cwd();
	return {
		repos: path.basename(cwd) || cwd,
		branch: await git.branch.current(cwd),
		activeAgentCount: registry.listAttached().length,
	};
}

// ── Agent 详情页文件系统（只读）──

const FS_MAX_READ_BYTES = 128 * 1024;

/** 解析 agentDir 内相对路径；拒绝越界（含 .. 逃逸与符号链接逃逸）。 */
function resolveFsPath(agentDir: string, rel: string): { ok: true; path: string } | { ok: false; error: string } {
	const resolved = path.resolve(agentDir, rel);
	if (resolved !== agentDir && !resolved.startsWith(agentDir + path.sep)) {
		return { ok: false, error: `path escapes agentDir: ${rel}` };
	}
	return { ok: true, path: resolved };
}

/** 列出目录条目（目录在前，按名排序）。 */
async function listDirEntries(
	dir: string,
): Promise<
	| { items: { name: string; type: "dir" | "file"; size: number }[]; error?: undefined }
	| { items?: undefined; error: string }
> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return { error: `no such directory: ${path.basename(dir)}` };
		throw err;
	}
	const items = await Promise.all(
		entries.map(async name => {
			const full = path.join(dir, name);
			const stat = await fs.stat(full).catch(() => null);
			if (!stat) return { name, type: "file" as const, size: 0 };
			return { name, type: stat.isDirectory() ? ("dir" as const) : ("file" as const), size: stat.size };
		}),
	);
	items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
	return { items };
}

/** 读文本文件，> 128KB 截断并标记 truncated。 */
async function readTextFileClipped(
	file: string,
): Promise<
	{ text: string; truncated: boolean; error?: undefined } | { text?: undefined; truncated?: undefined; error: string }
> {
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (err) {
		if (isEnoent(err)) return { error: `no such file: ${path.basename(file)}` };
		throw err;
	}
	if (text.length <= FS_MAX_READ_BYTES) return { text, truncated: false };
	return { text: text.slice(0, FS_MAX_READ_BYTES), truncated: true };
}

// ── gateway 运行状态（只读转发 gateway.status.json）──

interface GatewayAccountStatus {
	accountId: string;
	bridgeRunning?: boolean;
	bridgeState?: string;
	channelConnected?: boolean;
	agentDir?: string;
}

/**
 * 读 `~/.omp/gateway-data/gateway.status.json`（gateway 定期写盘）。
 * 返回 accounts 明细 + stale 标记；文件缺失/失效返回 error（gateway 未运行）。
 */
async function readGatewayStatus(): Promise<
	| {
			ok: true;
			status: {
				pid?: number;
				statusWrittenAt?: number;
				stale: boolean;
				accounts: GatewayAccountStatus[];
				scheduler?: { running?: boolean; taskCount?: number } | null;
			};
	  }
	| { ok: false; error: string }
> {
	const statusPath = path.join(homeDir(), ".omp", "gateway-data", "gateway.status.json");
	let raw: string;
	try {
		raw = await fs.readFile(statusPath, "utf8");
	} catch (err) {
		if (isEnoent(err)) return { ok: false, error: "gateway 未运行（无状态文件）" };
		throw err;
	}
	try {
		const parsed = JSON.parse(raw) as {
			pid?: number;
			statusWrittenAt?: number;
			accounts?: GatewayAccountStatus[];
			scheduler?: { running?: boolean; taskCount?: number } | null;
		};
		// stale 判据：写文件进程（pid）是否还活着。gateway 只在启动/重载时写盘，
		// 空闲期文件长期不更新 —— 时间阈值会误报；pid 存活即运行中。
		const pidAlive = parsed.pid != null && isPidAlive(parsed.pid);
		const stale = !pidAlive;
		return {
			ok: true,
			status: {
				pid: parsed.pid,
				statusWrittenAt: parsed.statusWrittenAt,
				stale,
				accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
				scheduler: parsed.scheduler ?? null,
			},
		};
	} catch {
		return { ok: false, error: "gateway 状态文件损坏（非 JSON）" };
	}
}

/** pid 是否存活（kill 0 探测；ESRCH=不存在，EPERM=存在）。 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

const STATS_PERIOD_MS: Record<"1d" | "7d" | "30d" | "90d" | "all", number | undefined> = {
	"1d": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
	"90d": 90 * 24 * 60 * 60 * 1000,
	all: undefined,
};

/** get_stats 可选 period → 毫秒时间窗口（省略/未知值 → undefined = 全量）。 */
function parseStatsPeriod(period: WireCommandOfType<"get_stats">["period"]): number | undefined {
	return period === undefined ? undefined : (STATS_PERIOD_MS[period] ?? undefined);
}

// ── W3 D3：记忆投影（memory/user/project 三分区，只读）──

interface MemoryTextFileProjection {
	path: string;
	content: string;
	truncated: boolean;
}

/** 读文本文件（>128KB 截断并标记）；文件不存在/读取失败返回 null（空态）。 */
async function readMemoryFileClipped(filePath: string): Promise<MemoryTextFileProjection | null> {
	const res = await readTextFileClipped(filePath);
	if ("error" in res) return null;
	return { path: filePath, content: res.text, truncated: res.truncated };
}

interface MemorySectionProjection {
	namespace: string;
	entries: { id: string; content: string; importance: number; lastAccessedAt: number }[];
}

interface MemoryProjectFileProjection {
	memoryRoot: string;
	memoryMd: MemoryTextFileProjection | null;
	summaryMd: MemoryTextFileProjection | null;
	rawMd: MemoryTextFileProjection | null;
}

/**
 * 项目记忆三分区：canonical evolution 目录优先，旧版扁平目录（agentDir/memories）回落。
 * 任一候选目录有投影文件即采用；全部无文件则返回 canonical 的空投影（UI 显示「未生成」）。
 */
async function buildProjectMemoryZone(
	memoryRoot: string | undefined,
	agentDir: string,
	cwd: string,
): Promise<MemoryProjectFileProjection | null> {
	if (!memoryRoot) return null;

	const candidates = [memoryRoot];
	try {
		candidates.push(...resolveGlobalMemoryRootCandidates(agentDir, cwd));
	} catch {
		// 旧目录解析失败不影响 canonical
	}

	let emptyFallback: MemoryProjectFileProjection | null = null;
	for (const root of candidates) {
		const [memoryMd, summaryMd, rawMd] = await Promise.all([
			readMemoryFileClipped(path.join(root, "MEMORY.md")),
			readMemoryFileClipped(path.join(root, "memory_summary.md")),
			readMemoryFileClipped(path.join(root, "raw_memories.md")),
		]);
		if (memoryMd || summaryMd || rawMd) {
			return { memoryRoot: root, memoryMd, summaryMd, rawMd };
		}
		if (!emptyFallback) emptyFallback = { memoryRoot: root, memoryMd, summaryMd, rawMd };
	}
	return emptyFallback;
}

/** 记忆投影：user.md + 项目 MEMORY 文件 + self-evolution 记忆库分区。 */
async function buildMemoryProjection(
	cwd: string,
	agentDir: string,
): Promise<{
	user: MemoryTextFileProjection | null;
	project: MemoryProjectFileProjection | null;
	memoryStore: { dbPath: string; sections: MemorySectionProjection[]; totalEntries: number };
}> {
	// user 区：~/.omp/user.md（身份画像；与 identity 工具同路径解析）
	const userPath = path.join(getConfigRootDir(), "user.md");
	const user = await readMemoryFileClipped(userPath);

	// project 区：当前项目记忆目录的投影文件（MEMORY.md / memory_summary.md / raw_memories.md）
	// getMemoryRoot 对系统路径（~/.omp 等）返回 undefined——该场景项目记忆不适用，置 null。
	const memoryRoot = getMemoryRoot(agentDir, cwd);
	const project = await buildProjectMemoryZone(memoryRoot, agentDir, cwd);

	// memory 区：self-evolution 记忆库（vector_embeddings 分区，importance 降序）
	// refcount 平衡：get 后无论如何 release（load 抛错也不漏 ref）
	let sections: MemorySectionProjection[] = [];
	let dbPath = "";
	const db = getMemoryDb(cwd);
	try {
		dbPath = resolveMemoryDbPath(cwd);
		sections = loadSectionsFromDb(db).map(section => ({
			namespace: section.namespace,
			entries: section.entries.map(e => ({
				id: e.id,
				content: e.content,
				importance: e.importance,
				lastAccessedAt: e.lastAccessedAt,
			})),
		}));
	} catch (err) {
		logger.debug("memory store read failed", { cwd, error: err instanceof Error ? err.message : String(err) });
	} finally {
		releaseMemoryDb(cwd);
	}
	const totalEntries = sections.reduce((sum, s) => sum + s.entries.length, 0);

	return {
		user,
		project,
		memoryStore: { dbPath, sections, totalEntries },
	};
}
