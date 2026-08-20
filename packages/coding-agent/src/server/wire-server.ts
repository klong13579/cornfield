import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModelPriceCatalog, getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats";
import { getAgentDir, getConfigRootDir, isEnoent, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type {
	AgentMessageDto,
	ClientFrame,
	PermissionRequestPush,
	ServerFrame,
	WireCommand,
	WireCommandOfType,
	WireEnvironmentSummary,
	WireErrorCode,
	WireServerEvent,
} from "@oh-my-pi/pi-wire";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";
import { resolveGlobalMemoryRootCandidates } from "@oh-my-pi/self-evolution/paths";
import { Settings } from "../config/settings";
import {
	fetchMarketplace,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	isValidNameSegment,
	type MarketplacePluginEntry,
	readMarketplacesRegistry,
	resolvePluginSource,
} from "../extensibility/plugins/marketplace";
import { BUILTIN_SLASH_COMMANDS } from "../extensibility/slash-commands";
import { connectToServer, disconnectServer } from "../mcp/client";
import type { MCPServerConfig } from "../mcp/types";
import { getMemoryDb, getMemoryRoot, releaseMemoryDb, resolveMemoryDbPath } from "../memories";
import { loadSectionsFromDb } from "../memories/projection";
import { normalizeHostToolDefinitions } from "../modes/rpc/rpc-mode";
import { discoverSkills } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { SessionStore } from "../session/session-store";
import type { TodoPhase } from "../tools/todo-write";
import * as git from "../utils/git";
import { WireHostToolBridge } from "./host-tool-bridge";
import { PERMISSION_TIMEOUT_OUTCOME, PermissionGate } from "./permission-gate";
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
	/** 审批 pending 表（serve.ts 装配，canUseTool 与 inject_permission 共用）。 */
	permissionGate?: PermissionGate;
	/** 注册 permission_request 广播（canUseTool 触发时用）。 */
	registerPermissionBroadcast?: (fn: (push: PermissionRequestPush) => void) => void;
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

	// ── permission shell：pending 表 + 广播（canUseTool 与 inject_permission 共用）+ 超时清理 ──
	const gate = options.permissionGate ?? new PermissionGate();
	const broadcastPermission = (push: PermissionRequestPush): void => {
		for (const conn of connections) {
			send(conn.ws, { type: "push", event: push });
		}
	};
	options.registerPermissionBroadcast?.(broadcastPermission);

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
		const failWithCode = (code: WireErrorCode, message: string): void =>
			reply({ type: "response", id: "", ok: false, error: { code, message } });

		// ── h1：serve 端 skill hub（list_remote_skills / install_remote_skill）──
		// 契约命令不在 pi-wire 的 WireCommand union 内，serve 侧按字符串契约 + 局部窄类型实现；
		// 前端按同一契约字符串对接（m2/h2 亦 cast + 注释）。复用 marketplace fetcher。
		if ((command.type as string) === "list_remote_skills") {
			const cmd = command as unknown as { type: "list_remote_skills"; source?: string };
			try {
				const source = await resolveRemoteSkillSource(cmd.source);
				done({ items: await listRemoteSkills(source) });
			} catch (err) {
				failWithCode("internal", `list_remote_skills failed: ${String(err)}`);
			}
			return;
		}
		if ((command.type as string) === "install_remote_skill") {
			const cmd = command as unknown as { type: "install_remote_skill"; source: string; name: string };
			try {
				done(await installRemoteSkill(cmd.source, cmd.name));
			} catch (err) {
				failWithCode("internal", `install_remote_skill failed: ${String(err)}`);
			}
			return;
		}
		try {
			// ── MCP 服务器管理命令（契约命令，尚未登记进 pi-wire WireCommand union；最小局部 cast）──
			if (MCP_COMMAND_TYPES.has((command as { type: string }).type)) {
				await handleMcpServerCommand(command as unknown as WireMcpServerCommand, done, fail);
				return;
			}

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
				case "get_session_messages": {
					// 历史回放：读 sessionFile（绝对路径）的 message 条目，与 get_messages 同型。
					const res = await readSessionMessages(command.sessionFile);
					if ("error" in res) {
						fail(res.error);
						return;
					}
					done({ messages: res.messages });
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
				case "fs_read_image": {
					// R-IMG-SERVE（备用卡）：二进制图片读取——FileExplorer 预览数据源。
					// 返回 dataUrl（上限 2MB，超出截断标记），MIME 按扩展名。路径约束与 fs_read 同（resolveFsPath）。
					const agentId = (command as { sessionId?: string }).sessionId ?? conn.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const target = resolveFsPath(meta.agentDir, (command as { path: string }).path ?? "");
					if (!target.ok) {
						fail(target.error);
						return;
					}
					const res = await readImageFileClipped(target.path);
					if ("error" in res) {
						fail(res.error);
						return;
					}
					done({ path: (command as { path: string }).path ?? "", ...res });
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
				case "list_commands": {
					// 协议批 B-3：TUI slash 命令表（BUILTIN_SLASH_COMMAND registry 同源）。
					// 「能拿多少拿多少」：内置表 name/description；再补 active agent 会话挂载的
					// hook/custom/skill 命令（与 interactive-mode 的完整 slash 表同构）。
					// 每条带 group 分组（前端 palette 按组渲染 + 滚动）：系统命令/会话控制/扩展命令/自定义命令/技能命令。
					const builtin = BUILTIN_SLASH_COMMANDS.map(c => ({
						name: `/${c.name}`,
						description: c.description,
						group: "系统命令" as const,
					}));
					const virtual = TUI_VIRTUAL_COMMANDS.map(c => ({ ...c, group: "会话控制" as const }));
					const attached = registry.getAttached(conn.activeAgentId);
					const extra: { name: string; description: string; group: string }[] = [];
					if (attached) {
						const s = attached.session;
						const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map(c => c.name));
						for (const cmd of s.extensionRunner?.getRegisteredCommands(builtinNames) ?? []) {
							extra.push({
								name: cmd.name,
								description: cmd.description ?? "(hook command)",
								group: "扩展命令",
							});
						}
						for (const loaded of s.customCommands ?? []) {
							extra.push({
								name: loaded.command.name,
								description: `${loaded.command.description} (${loaded.source})`,
								group: "自定义命令",
							});
						}
						if (Settings.instance.get("skills.enableSkillCommands")) {
							for (const skill of s.skills) {
								extra.push({ name: `skill:${skill.name}`, description: skill.description, group: "技能命令" });
							}
						}
					}
					done({ commands: [...builtin, ...virtual, ...extra] });
					return;
				}
				case "get_cron_tasks": {
					// P2-W3-1（B6 只读代理）：jobs.json 直读，不依赖 gateway 进程。
					try {
						done({ tasks: await readCronTaskList() });
					} catch (err) {
						failWithCode("internal", `cron tasks unavailable: ${String(err)}`);
					}
					return;
				}
				case "get_cron_logs": {
					try {
						done({ logs: await readCronLogList(command.taskId, command.days, command.limit) });
					} catch (err) {
						failWithCode("internal", `cron logs unavailable: ${String(err)}`);
					}
					return;
				}
				case "inject_permission": {
					const { push, outcome } = gate.inject(command.kind ?? "approval");
					broadcastPermission(push);
					const choice = await outcome;
					if (choice === PERMISSION_TIMEOUT_OUTCOME) {
						fail("permission request timed out");
						return;
					}
					done({ requestId: push.requestId, choice });
					return;
				}
				case "permission_respond": {
					const result = gate.respond(command.requestId, command.choice);
					if (!result.ok) {
						fail(result.error);
						return;
					}
					done();
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
				"fork_from",
				"undo_exchange",
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
					// W3 D5 + P2-W3-3 回切：只读列出已加载技能 + 已停用名单。
					// skills = session.skills（discovery 按 settings 过滤后的「已启用」集）；
					// disabled = settings.skills.ignoredSkills 名单 + 技能目录 SKILL.md 元数据
					done({
						skills: session.skills.map(s => ({
							name: s.name,
							description: s.description,
							source: s.source,
							level: s._source?.level ?? "native",
							provider: s._source?.providerName ?? "builtin",
						})),
						disabled: await buildDisabledSkillList(),
					});
					break;
				}
				case "set_skill_enabled": {
					// P2-W3-3（B3 技能写协议）：写 settings（config.yml skills.ignoredSkills）+ 重发现热重载。
					const skillName = command.name.trim();
					if (!skillName || skillName.includes("/") || skillName.includes("\\")) {
						failWithCode("internal", `invalid skill name: ${String(command.name)}`);
						break;
					}
					try {
						const settings = Settings.instance;
						const ignored = new Set<string>(settings.get("skills.ignoredSkills") ?? []);
						if (command.enabled) {
							ignored.delete(skillName);
						} else {
							ignored.add(skillName);
						}
						settings.set("skills.ignoredSkills", [...ignored]);
						// 重发现参数与 sdk boot 完全一致（含 settings 的 disabledExtensions——上一版传 []
						// 会把用户停用的扩展技能全拉回来，42→74 事故根因）+ 会话热重载
						const skillsSettings = settings.getGroup("skills");
						const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
						const result = await discoverSkills(process.cwd(), getAgentDir(), {
							...skillsSettings,
							disabledExtensions: disabledExtensionIds,
						});
						await session.reloadSkills(result.skills, result.warnings);
						done({ ok: true, name: skillName, enabled: command.enabled });
					} catch (err) {
						failWithCode("internal", `skill toggle failed: ${String(err)}`);
					}
					break;
				}
				case "cancel_queued": {
					// 协议批 B-2：取消最近一条排队消息（session 现有 LIFO 队列操作）。
					const text = session.popLastQueuedMessage();
					done(text !== undefined ? { cancelled: true, text } : { cancelled: false });
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
					// P3 真实现：返回目标 session 的可用模型全量列表（按 disabledProviders /
					// disabledModels 过滤后），并随响应带两份停用名单——前端「已停用」分区恢复入口。
					const currentSettings = Settings.instance;
					done({
						models: session.getAvailableModels(),
						disabledProviders: currentSettings.get("disabledProviders") ?? [],
						disabledModels: currentSettings.get("disabledModels") ?? [],
					});
					break;
				}
				case "set_model_disabled": {
					// W3 模型禁用写协议（pi-wire）：provider 级写 disabledProviders，模型级
					// 写 disabledModels（`provider/modelId` 精确 pattern）。settings 是活引用——
					// isModelAvailable 每调用都读当前值，无需重载注册表即全局生效；持久化配置 yml。
					const currentSettings = Settings.instance;
					const provider = command.provider.trim();
					if (!provider) {
						fail("provider is required");
						break;
					}
					const modelId = command.modelId?.trim();
					if (modelId) {
						const selector = `${provider}/${modelId}`;
						const next = command.disabled
							? [...new Set([...(currentSettings.get("disabledModels") ?? []), selector])]
							: (currentSettings.get("disabledModels") ?? []).filter(p => p !== selector);
						currentSettings.setDisabledModels(next);
					} else {
						const next = command.disabled
							? [...new Set([...(currentSettings.get("disabledProviders") ?? []), provider])]
							: (currentSettings.get("disabledProviders") ?? []).filter(p => p !== provider);
						currentSettings.setDisabledProviders(next);
					}
					done({
						ok: true,
						provider,
						modelId: modelId || undefined,
						disabled: command.disabled,
						disabledProviders: currentSettings.get("disabledProviders") ?? [],
						disabledModels: currentSettings.get("disabledModels") ?? [],
					});
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
				case "fork_from": {
					// 从此 entry 分叉到新会话（复用 branch 语义），返回 fork 后会话 id + 推快照
					const result = await session.branch(command.entryId);
					sessionDone({ cancelled: result.cancelled, sessionId: session.sessionId });
					break;
				}
				case "undo_exchange": {
					// 撤销到指定轮：streaming 中拒绝（busy）制止竞态，截断后推权威快照
					if (session.isStreaming) {
						fail("busy");
						return;
					}
					const result = await session.navigateTree(command.entryId, {});
					sessionDone({ cancelled: result.cancelled, editorText: result.editorText });
					break;
				}
				case "retry_from": {
					// 撤销到指定轮 + 重新 prompt（原 user 文本，除非显式 message 覆盖）
					if (session.isStreaming) {
						fail("busy");
						return;
					}
					const result = await session.navigateTree(command.entryId, {});
					if (result.cancelled) {
						done({ cancelled: true });
						return;
					}
					const message = command.message ?? result.editorText ?? "";
					session.prompt(message, { images: command.images }).catch((err: Error) => {
						fail(err.message);
					});
					done();
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
					failWithCode("not_implemented", `command not implemented: ${(command as { type: string }).type}`);
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
				if (connections.size === 0) {
					gate.clearAll();
				}
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
		// 协议批 B-2：排队文本（QueueCard 数据源；快照只有计数）
		queued: session.getQueuedMessages(),
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

// ── P2-W3-3 回切：已停用技能名单（settings.skills.ignoredSkills + SKILL.md 元数据）──

interface DisabledSkillRow {
	name: string;
	description?: string;
}

async function buildDisabledSkillList(): Promise<DisabledSkillRow[]> {
	const ignored = Settings.instance.get("skills.ignoredSkills") ?? [];
	if (ignored.length === 0) return [];
	const agentDir = getAgentDir();
	const cwd = process.cwd();
	const rows: DisabledSkillRow[] = [];
	for (const name of ignored) {
		const description = await readSkillFrontmatterDescription(name, cwd, agentDir);
		rows.push(description !== undefined ? { name, description } : { name });
	}
	return rows;
}

/** 读技能目录 SKILL.md 的 description（用户级 agentDir/skills 或项目级 .omp/skills）。 */
async function readSkillFrontmatterDescription(
	name: string,
	cwd: string,
	agentDir: string,
): Promise<string | undefined> {
	const candidates = [
		path.join(agentDir, "skills", name, "SKILL.md"),
		path.join(cwd, ".omp", "skills", name, "SKILL.md"),
	];
	for (const filePath of candidates) {
		try {
			const content = await Bun.file(filePath).text();
			const { frontmatter } = parseFrontmatter(content, { source: filePath });
			if (typeof frontmatter.description === "string" && frontmatter.description.length > 0) {
				return frontmatter.description;
			}
			return undefined;
		} catch {
			// 该候选目录不存在/损坏——试下一个
		}
	}
	return undefined;
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

// ── P2-W3-1：gateway cron 只读代理（jobs.json + logs/by-task 直读，不 import gateway 运行时）──

const CRON_LOG_MAX_OUTPUT = 2048;

function gatewaySchedulerDir(): string {
	return path.join(homeDir(), ".omp", "gateway-data", "scheduler");
}

interface CronTaskRow {
	id: string;
	name: string;
	description?: string;
	scheduleType: "cron" | "interval" | "once";
	cron?: string;
	command?: string;
	nextRunAt?: number;
	lastRunAt?: number;
	enabled: boolean;
	accountId?: string;
	runCount?: number;
	failCount?: number;
	consecutiveFailures?: number;
}

/** 读 jobs.json（缺失/损坏 → 空列表，不抛）。 */
async function readCronTaskList(): Promise<CronTaskRow[]> {
	const jobsPath = path.join(gatewaySchedulerDir(), "jobs.json");
	let raw: string;
	try {
		raw = await Bun.file(jobsPath).text();
	} catch {
		return [];
	}
	let parsed: { tasks?: Record<string, unknown>[] };
	try {
		parsed = JSON.parse(raw) as { tasks?: Record<string, unknown>[] };
	} catch {
		return [];
	}
	return (parsed.tasks ?? []).map(task => ({
		id: String(task.id ?? ""),
		name: String(task.name ?? ""),
		description: typeof task.command === "string" ? String(task.command) : undefined,
		scheduleType: (task.scheduleType === "interval" || task.scheduleType === "once" ? task.scheduleType : "cron") as
			| "cron"
			| "interval"
			| "once",
		cron: typeof task.cron === "string" ? String(task.cron) : undefined,
		command: typeof task.command === "string" ? String(task.command) : undefined,
		nextRunAt: typeof task.nextRunAt === "number" ? (task.nextRunAt as number) : undefined,
		lastRunAt: typeof task.lastRunAt === "number" ? (task.lastRunAt as number) : undefined,
		enabled: task.status !== "disabled",
		accountId: typeof task.accountId === "string" ? String(task.accountId) : undefined,
		runCount: typeof task.runCount === "number" ? (task.runCount as number) : undefined,
		failCount: typeof task.failCount === "number" ? (task.failCount as number) : undefined,
		consecutiveFailures:
			typeof task.consecutiveFailures === "number" ? (task.consecutiveFailures as number) : undefined,
	}));
}

/** 日志条目 DTO（output/stderr 截断 2KB）。 */
interface CronLogRow {
	taskId: string;
	id: string;
	ts: number;
	status: string;
	exitCode: number | null;
	durationMs: number | null;
	output?: string;
	outputTruncated?: boolean;
	stderr?: string;
}

async function readCronLogList(taskId?: string, days = 3, limit = 50): Promise<CronLogRow[]> {
	const clampDays = Math.min(30, Math.max(1, days));
	const clampLimit = Math.min(200, Math.max(1, limit));
	const cutoff = Date.now() - clampDays * 24 * 60 * 60 * 1000;
	const logsRoot = path.join(gatewaySchedulerDir(), "logs", "by-task");

	let taskDirs: string[];
	try {
		taskDirs = (await fs.readdir(logsRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
	} catch {
		return [];
	}
	if (taskId) {
		// 精确匹配任务名目录；无则直接返回空
		if (!taskDirs.includes(taskId)) return [];
		taskDirs = [taskId];
	}

	const rows: CronLogRow[] = [];
	for (const dir of taskDirs) {
		const dirPath = path.join(logsRoot, dir);
		let files: string[];
		try {
			files = (await fs.readdir(dirPath)).filter(f => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			// 按文件名 YYYY-MM-DD 剪裁，避免整读陈旧日志
			const day = file.replace(/\.jsonl$/, "");
			const dayTs = Date.parse(day);
			if (!Number.isNaN(dayTs) && dayTs < cutoff) continue;
			let text: string;
			try {
				text = await Bun.file(path.join(dirPath, file)).text();
			} catch {
				continue;
			}
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				let entry: {
					id?: unknown;
					ts?: unknown;
					exitCode?: unknown;
					status?: unknown;
					durationMs?: unknown;
					output?: unknown;
					stderr?: unknown;
				};
				try {
					entry = JSON.parse(line) as typeof entry;
				} catch {
					continue;
				}
				const ts = typeof entry.ts === "number" ? entry.ts : 0;
				if (ts < cutoff) continue;
				rows.push({
					taskId: dir,
					id: String(entry.id ?? ""),
					ts,
					status: String(entry.status ?? "unknown"),
					exitCode: typeof entry.exitCode === "number" ? entry.exitCode : null,
					durationMs: typeof entry.durationMs === "number" ? entry.durationMs : null,
					output: typeof entry.output === "string" ? entry.output.slice(0, CRON_LOG_MAX_OUTPUT) : undefined,
					outputTruncated:
						typeof entry.output === "string" && entry.output.length > CRON_LOG_MAX_OUTPUT ? true : undefined,
					stderr: typeof entry.stderr === "string" ? entry.stderr.slice(0, CRON_LOG_MAX_OUTPUT) : undefined,
				});
			}
		}
	}
	rows.sort((a, b) => b.ts - a.ts);
	return rows.slice(0, clampLimit);
}

// ── h1：serve 端 skill hub（复用 extensibility/plugins/marketplace 的 fetchMarketplace）──

interface RemoteSkillItem {
	name: string;
	description?: string;
	source: string;
	type: "skill" | "plugin";
	/** 链接与元信息（Hub 详情用；catalog 无评分/下载数字段，排名由前端按 name 排序序号给出）。 */
	category?: string;
	homepage?: string;
	repository?: string;
	author?: string;
	version?: string;
}

/** 安装根目录：~/.omp/agent/skills（与 native skills 发现一致：skills/<name>/SKILL.md）。 */
function remoteSkillsDir(): string {
	return path.join(getAgentDir(), "skills");
}

/** 解析 source 缺省值：插件市场配置（marketplaces.json）里的第一个 marketplace 源。 */
async function resolveRemoteSkillSource(source: string | undefined): Promise<string> {
	const trimmed = source?.trim();
	if (trimmed) return trimmed;
	const reg = await readMarketplacesRegistry(getMarketplacesRegistryPath());
	const first = reg.marketplaces[0];
	if (!first) {
		throw new Error("no skill source provided and no marketplace configured (marketplaces.json is empty)");
	}
	return first.sourceUri;
}

/** 本地 marketplace 源目录（git/github 源走 fetchMarketplace 返回的 clonePath）。 */
function localMarketplaceRoot(source: string): string {
	const expanded = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
	return path.resolve(expanded);
}

/** 目录是否存在（try-catch + isEnoent，不预判 exists）。 */
async function isDirectoryPresent(dir: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dir);
		return stat.isDirectory();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/** 提取 plugin 条目的 source 特征串，用于 skill/plugin 分类。 */
function pluginSourceHint(entry: MarketplacePluginEntry): string {
	const s = entry.source;
	if (typeof s === "string") return s;
	switch (s.source) {
		case "git-subdir":
			return `${s.url} ${s.path}`;
		case "url":
			return s.url;
		case "github":
			return s.repo;
		default:
			return "";
	}
}

/**
 * skill/plugin 分类（deterministic，仅依据 catalog 条目自身信息，不额外网络/克隆）：
 * - 显式声明 skills 数组 → skill
 * - 名称以 -skills 结尾 → skill
 * - source 指向 skills 树（路径段或 URL 含 "skills"） → skill
 * - 其余 → plugin
 */
function classifyRemoteSkillType(entry: MarketplacePluginEntry): "skill" | "plugin" {
	const extended = entry as MarketplacePluginEntry & { skills?: unknown };
	if (Array.isArray(extended.skills) && extended.skills.length > 0) return "skill";
	if (/[-_]skills?$/i.test(entry.name)) return "skill";
	const hint = pluginSourceHint(entry).toLowerCase();
	if (hint.split(/[\\/]/).includes("skills") || /\bskills?\b/.test(hint)) return "skill";
	return "plugin";
}

/** 拉取 catalog 并投影可装项（fetchMarketplace 对 git/github 会 clone，用完清理临时 clone）。 */
async function listRemoteSkills(source: string): Promise<RemoteSkillItem[]> {
	const { catalog, clonePath } = await fetchMarketplace(source, getMarketplacesCacheDir());
	try {
		return catalog.plugins.map(entry => {
			const item: RemoteSkillItem = {
				name: entry.name,
				source,
				type: classifyRemoteSkillType(entry),
			};
			if (entry.description) item.description = entry.description;
			if (entry.category) item.category = entry.category;
			if (entry.homepage) item.homepage = entry.homepage;
			if (entry.repository) item.repository = entry.repository;
			if (entry.author && typeof entry.author === "object" && entry.author.name) item.author = entry.author.name;
			if (entry.version) item.version = entry.version;
			return item;
		});
	} finally {
		if (clonePath) await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * 安装一个远程 skill/plugin：resolve 条目的实际 source 目录后拷到 ~/.omp/agent/skills/<name>。
 * 幂等：目标目录已存在 → alreadyInstalled:true，不重复拷贝/克隆。
 */
async function installRemoteSkill(source: string, name: string): Promise<{ path: string; alreadyInstalled: boolean }> {
	if (!isValidNameSegment(name)) {
		throw new Error(`invalid skill/plugin name: "${name}"`);
	}
	const targetDir = path.join(remoteSkillsDir(), name);
	if (await isDirectoryPresent(targetDir)) {
		return { path: targetDir, alreadyInstalled: true };
	}

	const { catalog, clonePath } = await fetchMarketplace(source, getMarketplacesCacheDir());
	try {
		const entry = catalog.plugins.find(p => p.name === name);
		if (!entry) {
			throw new Error(`"${name}" not found in marketplace "${source}"`);
		}

		const marketplaceClonePath = clonePath ?? localMarketplaceRoot(source);
		const { dir: srcDir, tempCloneRoot } = await resolvePluginSource(entry, {
			marketplaceClonePath,
			catalogMetadata: catalog.metadata,
			tmpDir: os.tmpdir(),
		});
		try {
			await fs.mkdir(path.dirname(targetDir), { recursive: true });
			await fs.cp(srcDir, targetDir, { recursive: true });
		} finally {
			if (tempCloneRoot) await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
		}

		return { path: targetDir, alreadyInstalled: false };
	} finally {
		if (clonePath) await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
	}
}
/** 读会话 JSONL，逐行 JSON.parse，提取 message 条目（跳过空行/非 message/损坏行）。 */
async function readSessionMessages(sessionFile: string): Promise<{ messages: AgentMessageDto[] } | { error: string }> {
	try {
		const stat = await fs.stat(sessionFile);
		if (!stat.isFile()) return { error: `not a file: ${sessionFile}` };
	} catch (err) {
		if (isEnoent(err)) return { error: `session file not found: ${sessionFile}` };
		return { error: `cannot read session file: ${String(err)}` };
	}

	let text: string;
	try {
		text = await Bun.file(sessionFile).text();
	} catch (err) {
		return { error: `cannot read session file: ${String(err)}` };
	}

	const messages: AgentMessageDto[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: unknown; message?: unknown };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		if (typeof entry.message !== "object" || entry.message === null) continue;
		messages.push(entry.message as AgentMessageDto);
	}
	return { messages };
}

// ── MCP 服务器管理（读写 ~/.omp/agent/mcp.json + stdio 连通性测试）──

const MCP_TEST_TIMEOUT_MS = 8_000;

/** serve 端 MCP 服务器管理命令（契约命令；尚未登记进 pi-wire WireCommand union → 最小局部 cast）。 */
type WireMcpServerCommand =
	| { type: "get_mcp_servers" }
	| { type: "set_mcp_server"; name: string; command?: string; args?: string[]; enabled?: boolean }
	| { type: "remove_mcp_server"; name: string }
	| { type: "test_mcp_server"; name: string };

const MCP_COMMAND_TYPES = new Set<string>([
	"get_mcp_servers",
	"set_mcp_server",
	"remove_mcp_server",
	"test_mcp_server",
]);

interface AgentMcpServerEntry {
	command?: string;
	args?: string[];
	enabled?: boolean;
	env?: Record<string, string>;
	cwd?: string;
	type?: "stdio" | "http" | "sse";
	[key: string]: unknown;
}

interface AgentMcpJson {
	$schema?: string;
	mcpServers?: Record<string, AgentMcpServerEntry>;
	disabledServers?: string[];
	[key: string]: unknown;
}

function agentMcpJsonPath(): string {
	return path.join(getAgentDir(), "mcp.json");
}

async function readAgentMcpJson(): Promise<AgentMcpJson> {
	const filePath = agentMcpJsonPath();
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as AgentMcpJson;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		return {};
	} catch (err) {
		if (isEnoent(err)) return {};
		throw err;
	}
}

async function writeAgentMcpJson(config: AgentMcpJson): Promise<void> {
	const filePath = agentMcpJsonPath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	await fs.writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await fs.rename(tmpPath, filePath);
}

function projectMcpServers(
	config: AgentMcpJson,
): { name: string; command: string; args: string[]; enabled: boolean }[] {
	return Object.entries(config.mcpServers ?? {}).map(([name, entry]) => ({
		name,
		command: typeof entry.command === "string" ? entry.command : "",
		args: Array.isArray(entry.args) ? entry.args : [],
		enabled: entry.enabled !== false,
	}));
}

async function setMcpServer(
	name: string,
	patch: { command?: string; args?: string[]; enabled?: boolean },
): Promise<void> {
	const config = await readAgentMcpJson();
	const mcpServers: Record<string, AgentMcpServerEntry> = config.mcpServers ?? {};
	const existing: AgentMcpServerEntry = mcpServers[name] ?? {};
	const next: AgentMcpServerEntry = { ...existing };
	if (patch.command !== undefined) next.command = patch.command;
	if (patch.args !== undefined) next.args = patch.args;
	if (patch.enabled !== undefined) next.enabled = patch.enabled;
	mcpServers[name] = next;
	config.mcpServers = mcpServers;
	await writeAgentMcpJson(config);
}

async function removeMcpServer(name: string): Promise<void> {
	const config = await readAgentMcpJson();
	if (config.mcpServers) delete config.mcpServers[name];
	await writeAgentMcpJson(config);
}

async function testMcpServer(name: string, entry: AgentMcpServerEntry): Promise<{ ok: boolean; message: string }> {
	const command = typeof entry.command === "string" ? entry.command : "";
	if (!command) {
		return { ok: false, message: `server "${name}" has no command (only stdio servers are testable)` };
	}
	const config: MCPServerConfig = {
		command,
		args: Array.isArray(entry.args) ? entry.args : [],
		env: entry.env,
		cwd: entry.cwd,
		timeout: MCP_TEST_TIMEOUT_MS,
	};
	try {
		const connection = await connectToServer(name, config);
		try {
			return { ok: true, message: `${connection.serverInfo.name}@${connection.serverInfo.version}` };
		} finally {
			await disconnectServer(connection).catch(() => {});
		}
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}

async function handleMcpServerCommand(
	command: WireMcpServerCommand,
	done: (result?: unknown) => void,
	fail: (error: string) => void,
): Promise<void> {
	const name = (raw: unknown): string => (typeof raw === "string" ? raw.trim() : "");
	switch (command.type) {
		case "get_mcp_servers": {
			try {
				const config = await readAgentMcpJson();
				done({ servers: projectMcpServers(config) });
			} catch (err) {
				fail(`mcp config unavailable: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}
		case "set_mcp_server": {
			const serverName = name(command.name);
			if (!serverName) {
				fail("name is required");
				return;
			}
			try {
				await setMcpServer(serverName, { command: command.command, args: command.args, enabled: command.enabled });
				done({ ok: true, name: serverName });
			} catch (err) {
				fail(`set_mcp_server failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}
		case "remove_mcp_server": {
			const serverName = name(command.name);
			if (!serverName) {
				fail("name is required");
				return;
			}
			try {
				await removeMcpServer(serverName);
				done({ ok: true, name: serverName });
			} catch (err) {
				fail(`remove_mcp_server failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}
		case "test_mcp_server": {
			const serverName = name(command.name);
			if (!serverName) {
				fail("name is required");
				return;
			}
			try {
				const config = await readAgentMcpJson();
				const entry = config.mcpServers?.[serverName];
				if (!entry) {
					done({ ok: false, message: `unknown mcp server: ${serverName}` });
					return;
				}
				done(await testMcpServer(serverName, entry));
			} catch (err) {
				fail(`test_mcp_server failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}
	}
}

/** 协议批 B-3：W1 SlashPalette 虚拟惯例项（非内置 slash 命令，TUI 动作口径）。 */
const TUI_VIRTUAL_COMMANDS: { name: string; description: string }[] = [
	{ name: "/undo", description: "撤销最近一轮对话" },
	{ name: "/yolo", description: "切换免审批模式（危险）" },
	{ name: "/retry", description: "重试失败的上一轮" },
];

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

// ── R-IMG-SERVE：二进制图片读取（dataUrl，2MB 上限，MIME 按扩展名）──

const FS_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
};

async function readImageFileClipped(
	filePath: string,
): Promise<{ dataUrl: string; mimeType: string; sizeBytes: number; truncated: boolean } | { error: string }> {
	try {
		const f = Bun.file(filePath);
		const stat = await f.stat();
		const sizeBytes = stat.size;
		const mimeType = IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
		const bytes = await f.slice(0, Math.min(sizeBytes, FS_IMAGE_MAX_BYTES)).arrayBuffer();
		const base64 = Buffer.from(bytes).toString("base64");
		return {
			dataUrl: `data:${mimeType};base64,${base64}`,
			mimeType,
			sizeBytes,
			truncated: sizeBytes > FS_IMAGE_MAX_BYTES,
		};
	} catch (err) {
		if (isEnoent(err)) return { error: `no such file: ${path.basename(filePath)}` };
		throw err;
	}
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
