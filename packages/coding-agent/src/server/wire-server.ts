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
	ToolSwitchesDto,
	WireCommand,
	WireCommandOfType,
	WireEnvironmentSummary,
	WireErrorCode,
	WireServerEvent,
} from "@oh-my-pi/pi-wire";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";
import { resolveGlobalMemoryRootCandidates } from "@oh-my-pi/self-evolution/paths";
import { YAML } from "bun";
import { withFileLock } from "../config/file-lock";
import { type SettingPath, Settings } from "../config/settings";
import {
	DEFAULT_EDIT_MODE,
	type EditMode,
	executeAtomSingle,
	executeHashlineSingle,
	executePatchSingle,
	executeReplaceSingle,
	generateUnifiedDiffString,
	type HashlineToolEdit,
	normalizeEditMode,
	type PatchEditEntry,
	type ReplaceEditEntry,
} from "../edit";
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
import {
	createLspWritethrough,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
	writethroughNoop,
} from "../lsp";
import { connectToServer, disconnectServer } from "../mcp/client";
import type { MCPServerConfig } from "../mcp/types";
import { getMemoryDb, getMemoryRoot, releaseMemoryDb, resolveMemoryDbPath } from "../memories";
import { loadSectionsFromDb } from "../memories/projection";
import { normalizeHostToolDefinitions } from "../modes/rpc/rpc-mode";
import { discoverSkills } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { getDefaultSessionDirName } from "../session/session-manager";
import type { SessionStore } from "../session/session-store";
import { listListenRecordings, saveListenText, transcribeAudioWithDefaults } from "../stt/listen-service";
import type { ToolSession } from "../tools";
import { invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";
import type { TodoPhase } from "../tools/todo-write";
import * as git from "../utils/git";
import { listAgentArtifacts, listSessionArtifacts } from "./artifacts";
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
	/** interactive（TUI 进程内）场景：不加载多 agent metas（单会话），默认 false。 */
	loadAgents?: boolean;
}

interface Connection {
	connectionId: string;
	ws: Bun.ServerWebSocket<Connection | undefined>;
	/** 本连接当前焦点 agent（P1：恒为 default）。 */
	activeAgentId: string;
	/** 本连接注册的 host tool bridge（per agent）。发 set_host_tools 的连接 = 执行者。 */
	hostToolBridges: Map<string, WireHostToolBridge>;
	/** wire core 注册的接收端注销函数（hello 时登记，close 时调用）。 */
	removeTarget: () => void;
}

/**
 * 传输无关的命令执行上下文（P3：ws 与内存传输共用 handleCommand）。
 * ws 层把 Connection 适配成此接口；未来 TUI 进程内客户端传内存实现。
 */
export interface CommandContext {
	/** 当前焦点 agent id。 */
	activeAgentId: string;
	/** attach/switch 后更新焦点。 */
	setActiveAgentId(id: string): void;
	/** 本上下文注册的 host tool bridge（per agent）。 */
	hostToolBridges: Map<string, WireHostToolBridge>;
	/** 推 push 帧（progress/snapshot/...）给本上下文的接收端。 */
	sendPush(frame: ServerFrame): void;
	/** 推当前焦点 agent 的权威快照。 */
	sendSessionSnapshot(): void;
	/** 广播 server snapshot（agent 列表变化）。 */
	broadcastServerSnapshot(): void;
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
 * 工具开关语义注册表（get_tool_switches 数据源）。
 *
 * 与 tools/index.ts `createTools` 的 isToolAllowed 中 settings 门控路径同源；
 * 增加/删除开关时两侧同步。bash/python 由 python.toolMode 派生，不列在布尔开关里；
 * search_tool_bm25 依赖 mcp.discoveryMode（非布尔枚举），不列。
 */
const TOOL_SWITCH_DEFS: Array<{ tool: string; label: string; path: SettingPath }> = [
	{ tool: "find", label: "find 文件查找", path: "find.enabled" },
	{ tool: "search", label: "search 内容搜索", path: "search.enabled" },
	{ tool: "ast_grep", label: "ast_grep 结构搜索", path: "astGrep.enabled" },
	{ tool: "ast_edit", label: "ast_edit 结构改写", path: "astEdit.enabled" },
	{ tool: "lsp", label: "lsp 代码智能", path: "lsp.enabled" },
	{ tool: "debug", label: "debug 调试器", path: "debug.enabled" },
	{ tool: "todo_write", label: "todo_write 任务看板", path: "todo.enabled" },
	{ tool: "github", label: "github 集成", path: "github.enabled" },
	{ tool: "render_mermaid", label: "render_mermaid 图表渲染", path: "renderMermaid.enabled" },
	{ tool: "notebook", label: "notebook Jupyter 笔记本", path: "notebook.enabled" },
	{ tool: "switch_model", label: "switch_model 模型切换", path: "switchModel.enabled" },
	{ tool: "inspect_image", label: "inspect_image 图像分析", path: "inspect_image.enabled" },
	{ tool: "web_search", label: "web_search 联网搜索", path: "web_search.enabled" },
	{ tool: "calc", label: "calc 计算器", path: "calc.enabled" },
	{ tool: "browser", label: "browser 浏览器自动化", path: "browser.enabled" },
	{ tool: "checkpoint", label: "checkpoint 检查点/回退", path: "checkpoint.enabled" },
	{ tool: "irc", label: "irc 会话互发消息", path: "irc.enabled" },
	{ tool: "identity", label: "identity 身份档案", path: "identity.enabled" },
	{ tool: "recipe", label: "recipe 配方执行", path: "recipe.enabled" },
];

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
export interface WireCoreTarget {
	id: string;
	/** 当前焦点 agent id（可变：ws 连接 switch_session；内存客户端切换）。 */
	getActiveAgentId(): string;
	/** 推帧给本接收端（ws: send(ws)；内存: 直接投递）。 */
	send(frame: ServerFrame): void;
}

export interface WireCore {
	registry: SessionRegistry;
	/** 注册接收端（ws 连接或内存客户端），返回注销函数。 */
	addTarget(target: WireCoreTarget): () => void;
	handleCommand(ctx: CommandContext, command: WireCommand, reply: (frame: ServerFrame) => void): Promise<void>;
	/** 推目标 agent 的权威快照。 */
	sendSessionSnapshotTo(target: WireCoreTarget): void;
	broadcastServerSnapshot(): void;
}

/**
 * 传输无关的 wire 核心（P3）：registry + 事件路由 + 权限 shell + 命令处理。
 * ws 传输（startWireServer）与进程内内存传输（TUI 客户端）共用。
 */
export async function createWireCore(options: WireServerOptions): Promise<WireCore> {
	const { defaultSession } = options;

	const registry = new SessionRegistry(options.sessionFactory);
	registry.registerMeta({
		id: "default",
		name: "default",
		agentDir: process.cwd(),
	});
	// record_transcribe 的 API 转写路径（record.model）复用 default 会话的模型注册表；
	// 未配置 API 模型时仅走本地 whisper，本引用不会被触碰。
	const defaultModelRegistry = defaultSession.session.modelRegistry;
	const metas = options.loadAgents === false ? [] : await loadMetasSafe();
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

	const targets = new Set<WireCoreTarget>();
	const addTarget = (t: WireCoreTarget): (() => void) => {
		targets.add(t);
		return () => {
			targets.delete(t);
			// 最后一个接收端断开：清空审批 pending（原 ws 层 close 逻辑）
			if (targets.size === 0) gate.clearAll();
		};
	};
	const activeAgentIds = (): Set<string> => {
		const ids = new Set<string>();
		for (const target of targets) ids.add(target.getActiveAgentId());
		return ids;
	};
	const broadcastServerSnapshot = (): void => {
		const event: WireServerEvent = {
			type: "server_snapshot",
			sessions: registry.buildSessionList(activeAgentIds()),
		};
		for (const target of targets) {
			target.send({ type: "push", event });
		}
	};
	const sendSessionSnapshotTo = (target: WireCoreTarget): void => {
		const attached = registry.getAttached(target.getActiveAgentId());
		if (!attached) return;
		const event: WireServerEvent = {
			type: "session_snapshot",
			sessionId: target.getActiveAgentId(),
			snapshot: attached.store.getSnapshot(),
		};
		target.send({ type: "push", event });
	};

	// ── permission shell：pending 表 + 广播（canUseTool 与 inject_permission 共用）+ 超时清理 ──
	const gate = options.permissionGate ?? new PermissionGate();
	const broadcastPermission = (push: PermissionRequestPush): void => {
		for (const target of targets) {
			target.send({ type: "push", event: push });
		}
	};
	options.registerPermissionBroadcast?.(broadcastPermission);

	// ── 事件路由：只推给 active 在该 agent 上的连接 ──
	registry.subscribe(event => {
		if (event.kind === "snapshot") {
			for (const target of targets) {
				if (target.getActiveAgentId() !== event.sessionId) continue;
				const snapshotEvent: WireServerEvent = {
					type: "session_snapshot",
					sessionId: event.sessionId,
					snapshot: event.snapshot,
				};
				target.send({ type: "push", event: snapshotEvent });
				if (PROGRESS_EVENT_TYPES.has(event.event.type)) {
					const progressEvent: WireServerEvent = {
						type: "progress",
						sessionId: event.sessionId,
						event: event.event,
					};
					target.send({ type: "push", event: progressEvent });
				}
			}
			return;
		}
		// attached / detached → 列表变了，广播
		broadcastServerSnapshot();
	});

	/** 命令解析：返回目标 attached session；未 attach / 未注册时报错。 */
	const resolveTarget = (
		ctx: { activeAgentId: string },
		command: { sessionId?: string },
	): { agentId: string; attached: AttachedSession } | { error: string } => {
		const agentId = command.sessionId ?? ctx.activeAgentId;
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
		ctx: CommandContext,
		command: WireCommand,
		reply: (frame: ServerFrame) => void,
	): Promise<void> => {
		const done = (result?: unknown): void => reply({ type: "response", id: "", ok: true, result });
		const fail = (error: string): void => reply({ type: "response", id: "", ok: false, error });
		const failWithCode = (code: WireErrorCode, message: string): void =>
			reply({ type: "response", id: "", ok: false, error: { code, message } });

		// ── h1：serve 端 skill hub（list_remote_skills / install_remote_skill）──
		// P0 收口：命令已登记进 pi-wire WireCommand union，直接按具体类型处理。
		if (command.type === "list_remote_skills") {
			try {
				const source = await resolveRemoteSkillSource(command.source);
				done({ items: await listRemoteSkills(source) });
			} catch (err) {
				failWithCode("internal", `list_remote_skills failed: ${String(err)}`);
			}
			return;
		}
		if (command.type === "install_remote_skill") {
			try {
				done(await installRemoteSkill(command.source, command.name));
			} catch (err) {
				failWithCode("internal", `install_remote_skill failed: ${String(err)}`);
			}
			return;
		}
		try {
			// ── MCP 服务器管理命令（P0 收口：已登记进 pi-wire WireCommand union）──
			if (
				command.type === "get_mcp_servers" ||
				command.type === "set_mcp_server" ||
				command.type === "remove_mcp_server" ||
				command.type === "test_mcp_server"
			) {
				await handleMcpServerCommand(command, done, fail);
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
					for (const target of targets) {
						if (target.getActiveAgentId() === command.sessionId) {
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
					ctx.setActiveAgentId(command.sessionId);
					// 新焦点的快照立即推给本连接（快照权威，客户端零恢复逻辑）
					ctx.sendSessionSnapshot();
					ctx.broadcastServerSnapshot();
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
					const agentId = fsCmd.sessionId ?? ctx.activeAgentId;
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
					const agentId = fsCmd.sessionId ?? ctx.activeAgentId;
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
					const agentId = (command as { sessionId?: string }).sessionId ?? ctx.activeAgentId;
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
				case "list_artifacts": {
					// R-ARTIFACTS：从会话 JSONL 工具调用提取写出文件（write/edit/screenshot）。
					// sessionFile（可选）→ 按会话隔离视图，只提取该会话的产物；缺省 → agent 维度。
					const cmd = command as { sessionId?: string; sessionFile?: string };
					if (cmd.sessionFile) {
						// 定向会话：agentDir 从该会话归属的 agent 解析（sessionFile 位于其 sessions 树下，
						// 用 activeAgentId 对应 meta 的 agentDir 做路径约束即可——sessionFile 本身只读）。
						const agentId = cmd.sessionId ?? ctx.activeAgentId;
						const meta = registry.getMeta(agentId);
						if (!meta) {
							fail(`unknown agent: ${agentId}`);
							return;
						}
						// sessionFile 容错：fresh 会话（serve 刚重启 / 新会话尚无消息）JSONL 可能尚未落盘。
						// 此时诚实返回空数组（该会话确实没有产物），不降级 agent 维度——降级会混入
						// 其它会话的产物，破坏按会话隔离视图。
						let exists = false;
						try {
							exists = (await fs.stat(cmd.sessionFile)).isFile();
						} catch {
							exists = false;
						}
						if (!exists) {
							done({ artifacts: [] });
							return;
						}
						const artifacts = await listSessionArtifacts(meta.agentDir, cmd.sessionFile);
						done({ artifacts });
						return;
					}
					const agentId = cmd.sessionId ?? ctx.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					// 会话根必须精确到 agent 自己的目录：default 是 <sessions>/<encoded-cwd>
					// （全局根下其它项目的新会话会挤掉 Top N）；registry 是 <agentDir>/sessions。
					const sessionsRoot =
						meta.id === "default"
							? path.join(defaultSessionsRoot(), getDefaultSessionDirName(meta.agentDir).encodedDirName)
							: agentSessionsRoot(meta);
					const artifacts = await listAgentArtifacts(meta.agentDir, sessionsRoot);
					done({ artifacts });
					return;
				}
				case "record_transcribe": {
					// VOICE-D：浏览器录音上传 → TUI /record 同源转写管线（本地 whisper / record.model，
					// 自动分块）→ 落 ~/.omp/listen/，与 /record 同目录同格式。不定向 agent（纯数据路径）。
					const audio = (command as { audio?: unknown }).audio;
					if (typeof audio !== "string" || audio.length === 0) {
						fail("audio required (base64 PCM WAV)");
						return;
					}
					const desc =
						typeof (command as { desc?: unknown }).desc === "string"
							? (command as { desc: string }).desc
							: undefined;
					let bytes: Uint8Array;
					try {
						bytes = Buffer.from(audio, "base64");
					} catch {
						fail("audio is not valid base64");
						return;
					}
					if (bytes.length < 100) {
						fail("audio is empty or too small");
						return;
					}
					const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
					const tmpPath = path.join(os.tmpdir(), `omp-web-listen-${id}.wav`);
					try {
						await fs.writeFile(tmpPath, bytes);
						const { text, model } = await transcribeAudioWithDefaults(tmpPath, {
							modelRegistry: defaultModelRegistry,
						});
						const savedPath = await saveListenText(text, desc);
						done({ ok: true, text, path: savedPath, model });
					} catch (err) {
						fail(err instanceof Error ? err.message : "transcription failed");
					} finally {
						await fs.rm(tmpPath, { force: true }).catch(() => {});
					}
					return;
				}
				case "listen_list": {
					// /listen 前端化：列出 ~/.omp/listen/ 全部录音（名称倒序 + 转写全文，前端本地搜索/预览）。
					const recordings = await listListenRecordings();
					done({ ok: true, recordings });
					return;
				}
				case "gateway_status": {
					// P2-4：转发 gateway 生产端点（POST /wire；不再直读 status.json）
					const res = await callGatewayWire({ type: "gateway_status" });
					if (!res.ok) {
						fail(res.error);
						return;
					}
					done(res.result);
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
					const attached = registry.getAttached(ctx.activeAgentId);
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
					// P2-4：转发 gateway 生产端点（不再直读 jobs.json）
					const res = await callGatewayWire({ type: "get_cron_tasks" });
					if (!res.ok) {
						failWithCode("internal", res.error);
						return;
					}
					done(res.result);
					return;
				}
				case "get_cron_logs": {
					// P2-4：转发 gateway 生产端点（不再直读 logs/by-task）
					const res = await callGatewayWire({
						type: "get_cron_logs",
						taskId: command.taskId,
						days: command.days,
						limit: command.limit,
					});
					if (!res.ok) {
						failWithCode("internal", res.error);
						return;
					}
					done(res.result);
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
				// ── git 最小集（票 02）──
				case "git_status": {
					const agentId = (command as { sessionId?: string }).sessionId ?? ctx.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					try {
						const branch = await git.branch.current(meta.agentDir);
						const porcelain = await runWireGit(meta.agentDir, [
							"status",
							"--porcelain=v1",
							"--untracked-files=all",
						]);
						if (porcelain.exitCode !== 0) {
							fail(
								`git_status failed: ${porcelain.stderr.trim() || porcelain.stdout.trim() || "git status exited non-zero"}`,
							);
							return;
						}
						const { staged, unstaged, untracked } = parseGitPorcelain(porcelain.stdout);
						done({ branch, staged, unstaged, untracked });
					} catch (err) {
						fail(`git_status failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "git_diff": {
					const agentId = (command as { sessionId?: string }).sessionId ?? ctx.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const cmd = command as { cached?: boolean; path?: string };
					try {
						const args = ["diff"];
						if (cmd.cached) args.push("--cached");
						if (cmd.path) args.push("--", cmd.path);
						const r = await runWireGit(meta.agentDir, args);
						if (r.exitCode !== 0) {
							fail(`git_diff failed: ${r.stderr.trim() || r.stdout.trim() || "git diff exited non-zero"}`);
							return;
						}
						done({ diff: r.stdout });
					} catch (err) {
						fail(`git_diff failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "git_log": {
					const agentId = (command as { sessionId?: string }).sessionId ?? ctx.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const count = Math.min(100, Math.max(1, Math.trunc((command as { count?: number }).count ?? 20)));
					try {
						const r = await runWireGit(meta.agentDir, ["log", `-n${count}`, "--pretty=format:%H%x1f%an%x1f%s"]);
						// 空仓库（无 commit）/ 非 git 目录：git log 非零退出 → 空列表而非报错
						if (r.exitCode !== 0) {
							done({ commits: [] });
							return;
						}
						done({ commits: parseGitLog(r.stdout) });
					} catch (err) {
						fail(`git_log failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "git_show": {
					const agentId = (command as { sessionId?: string }).sessionId ?? ctx.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const revision = (command as { revision: string }).revision;
					try {
						const r = await runWireGit(meta.agentDir, ["show", "--format=fuller", "--stat", revision]);
						if (r.exitCode !== 0) {
							fail(`git_show failed: ${r.stderr.trim() || r.stdout.trim() || "unknown revision"}`);
							return;
						}
						done({ revision, detail: r.stdout });
					} catch (err) {
						fail(`git_show failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "git_branches": {
					const agentId = (command as { sessionId?: string }).sessionId ?? ctx.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					try {
						const [current, localRes, remoteRes] = await Promise.all([
							git.branch.current(meta.agentDir),
							runWireGit(meta.agentDir, ["branch", "--format=%(refname:short)"]),
							runWireGit(meta.agentDir, ["branch", "-r", "--format=%(refname:short)"]),
						]);
						if (localRes.exitCode !== 0 || remoteRes.exitCode !== 0) {
							fail("git_branches failed to list branches");
							return;
						}
						done({
							current,
							local: localRes.stdout
								.split("\n")
								.map(s => s.trim())
								.filter(Boolean),
							remote: remoteRes.stdout
								.split("\n")
								.map(s => s.trim())
								.filter(Boolean),
						});
					} catch (err) {
						fail(`git_branches failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				// ── 配置读写（票 03）—— per-agent：sessionId 定向到该 agent 的 config.yml ──
				// default agent 的配置根 ~/.omp/agent（Settings.init 的 agentDir），非 process.cwd()；
				// registry agent 的配置根 <agentDir>/config.yml（与 serve sessionFactory 的
				// Settings.create({ agentDir }) 同源）。
				case "get_config": {
					const agentId = (command as { sessionId?: string }).sessionId ?? ctx.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					try {
						const config = await readAgentConfigYaml(agentConfigPathFor(meta));
						const key = (command as { key?: string }).key;
						const value = key ? configGetByPath(config, key.split(".")) : config;
						done({ config: value });
					} catch (err) {
						fail(`get_config failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "set_config": {
					const agentId = (command as { sessionId?: string }).sessionId ?? ctx.activeAgentId;
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const cmd = command as { key: string; value?: unknown };
					const key = cmd.key.trim();
					if (!key) {
						fail("key is required");
						return;
					}
					try {
						const config = await readAgentConfigYaml(agentConfigPathFor(meta));
						configSetByPath(config, key.split("."), cmd.value);
						await writeAgentConfigYaml(agentConfigPathFor(meta), config);
						done({ ok: true, key, value: cmd.value });
					} catch (err) {
						fail(`set_config failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}

				default:
					break;
			}

			// ── session 级命令：全部需要已 attach 的目标 ──
			const target = resolveTarget(ctx, command);
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
				if (MUTATING_NO_EVENT.has(command.type)) ctx.sendSessionSnapshot();
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
					ctx.sendPush({
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
				// ── P3：TUI 交互命令（wire 面补齐） ──
				case "send_user_message": {
					await session.sendUserMessage(command.message);
					sessionDone();
					break;
				}
				case "send_custom_message": {
					await session.sendCustomMessage({
						customType: command.customType,
						content: command.content,
						display: command.display ?? false,
					});
					sessionDone();
					break;
				}
				case "set_active_tools": {
					await session.setActiveToolsByName(command.toolNames);
					sessionDone({ active: session.getActiveToolNames() });
					break;
				}
				case "set_model_temporary": {
					const models = session.getAvailableModels();
					const model = models.find(m => m.provider === command.provider && m.id === command.modelId);
					if (!model) {
						fail(`model not found: ${command.provider}/${command.modelId}`);
						break;
					}
					await session.setModelTemporary(model, command.thinkingLevel);
					sessionDone({ model });
					break;
				}
				case "get_available_thinking_levels": {
					done({ levels: session.getAvailableThinkingLevels() });
					break;
				}
				case "cycle_role_models": {
					const result = await session.cycleRoleModels(command.roleOrder);
					if (!result) {
						fail("no role models for role order");
						break;
					}
					sessionDone({ model: result.model, thinkingLevel: result.thinkingLevel, role: result.role });
					break;
				}
				case "set_plan_mode": {
					session.setPlanModeState({
						enabled: command.enabled,
						planFilePath: command.planFilePath ?? "",
					});
					sessionDone();
					break;
				}
				case "send_plan_mode_context": {
					await session.sendPlanModeContext();
					sessionDone();
					break;
				}
				case "set_plan_reference": {
					session.setPlanReferencePath(command.path);
					if (command.markSent) session.markPlanReferenceSent();
					sessionDone();
					break;
				}
				case "set_slash_commands": {
					session.setSlashCommands(
						command.commands.map(c => ({
							name: c.name,
							description: c.description,
							content: c.content,
							source: c.source ?? "wire",
						})),
					);
					sessionDone();
					break;
				}
				case "abort_compaction": {
					session.abortCompaction();
					sessionDone();
					break;
				}
				case "abort_branch_summary": {
					session.abortBranchSummary();
					sessionDone();
					break;
				}
				case "run_idle_compaction": {
					await session.runIdleCompaction();
					sessionDone();
					break;
				}
				case "reload": {
					await session.reload();
					sessionDone();
					break;
				}
				case "handoff": {
					const result = await session.handoff(command.customInstructions);
					sessionDone({ result });
					break;
				}
				case "run_ephemeral_turn": {
					await session.runEphemeralTurn({ promptText: command.message });
					sessionDone();
					break;
				}
				case "execute_python": {
					const result = await session.executePython(command.code);
					sessionDone(result);
					break;
				}
				case "abort_python": {
					session.abortPython();
					sessionDone();
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
					let bridge = ctx.hostToolBridges.get(agentId);
					if (!bridge) {
						bridge = new WireHostToolBridge(agentId);
						ctx.hostToolBridges.set(agentId, bridge);
					}
					bridge.bindOutput(push => ctx.sendPush({ type: "push", event: push }));
					await session.refreshRpcHostTools(bridge.setTools(definitions));
					const changedEvent: WireServerEvent = {
						type: "host_tools_changed",
						sessionId: agentId,
						tools: command.tools,
					};
					ctx.sendPush({ type: "push", event: changedEvent });
					sessionDone({ toolNames: definitions.map(tool => tool.name) });
					break;
				}

				// ── Model ──
				case "get_tool_switches": {
					// 工具开关语义视图：config.yml 文件优先（与 .omp 显示一致），未配置项回落
					// 内核默认（session.settings，attach 时加载）。修改走 set_config 写同一文件。
					try {
						const config = await readAgentConfigYaml(agentConfigPathFor(attached.meta));
						done({
							tools: TOOL_SWITCH_DEFS.map(({ tool, label, path }) => ({
								tool,
								label,
								path,
								enabled:
									(configGetByPath(config, path.split(".")) as boolean | undefined) ??
									session.settings.get(path) === true,
							})),
							pythonToolMode:
								(configGetByPath(config, ["python", "toolMode"]) as
									| ToolSwitchesDto["pythonToolMode"]
									| undefined) ?? session.settings.get("python.toolMode"),
						});
					} catch (err) {
						fail(`get_tool_switches failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
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
					sessionDone({
						text: result.selectedText,
						selectedText: result.selectedText,
						cancelled: result.cancelled,
					});
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

				// ── P3：TUI 渲染/导出查询 ──
				case "get_tool": {
					const tool = session.getToolByName(command.toolName);
					done({
						tool: tool ? { name: tool.name, description: tool.description, parameters: tool.parameters } : null,
					});
					break;
				}
				case "get_async_job_snapshot": {
					done({ jobs: session.getAsyncJobSnapshot({ recentLimit: command.recentLimit }) });
					break;
				}
				case "format_session_as_text": {
					done({ text: session.formatSessionAsText() });
					break;
				}
				case "get_display_context": {
					const context = session.buildDisplaySessionContext();
					done({ context });
					break;
				}
				case "resolve_role_model": {
					const resolved = session.resolveRoleModelWithThinking(command.role);
					done({
						model: resolved.model,
						thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
					});
					break;
				}
				// ── fs 写命令面（票 01）：LSP writethrough 续接 ──
				case "fs_write": {
					const cmd = command as { path: string; content: string };
					if (typeof cmd.content !== "string") {
						fail("content required (string)");
						break;
					}
					const agentDir = registry.getMeta(agentId)?.agentDir ?? session.sessionManager.getCwd();
					const target = resolveFsPath(agentDir, cmd.path);
					if (!target.ok) {
						fail(target.error);
						break;
					}
					try {
						const toolSession = toWireToolSession(session, agentDir);
						await createWireWritethrough(toolSession)(target.path, cmd.content);
						invalidateFsScanAfterWrite(target.path);
						done({ path: cmd.path, bytesWritten: Buffer.byteLength(cmd.content, "utf8") });
					} catch (err) {
						fail(err instanceof Error ? err.message : String(err));
					}
					break;
				}
				case "fs_edit": {
					const cmd = command as { path: string; mode?: EditMode; edits?: unknown[]; input?: string };
					const agentDir = registry.getMeta(agentId)?.agentDir ?? session.sessionManager.getCwd();
					const target = resolveFsPath(agentDir, cmd.path);
					if (!target.ok) {
						fail(target.error);
						break;
					}
					const mode =
						cmd.mode ?? normalizeEditMode(String(session.settings.get("edit.mode") ?? "")) ?? DEFAULT_EDIT_MODE;
					try {
						const toolSession = toWireToolSession(session, agentDir);
						const writethrough = createWireWritethrough(toolSession);
						const { diff, firstChangedLine } = await executeWireEdit(
							mode,
							toolSession,
							target.path,
							{ edits: cmd.edits, input: cmd.input },
							writethrough,
						);
						done({ path: cmd.path, mode, diff, firstChangedLine });
					} catch (err) {
						fail(err instanceof Error ? err.message : String(err));
					}
					break;
				}
				case "fs_diff": {
					const cmd = command as { path?: string; content?: string; before?: string; after?: string };
					try {
						if (cmd.before !== undefined || cmd.after !== undefined) {
							done(generateUnifiedDiffString(cmd.before ?? "", cmd.after ?? ""));
							break;
						}
						if (cmd.path !== undefined && cmd.content !== undefined) {
							const agentDir = registry.getMeta(agentId)?.agentDir ?? session.sessionManager.getCwd();
							const target = resolveFsPath(agentDir, cmd.path);
							if (!target.ok) {
								fail(target.error);
								break;
							}
							let beforeText: string;
							try {
								beforeText = await Bun.file(target.path).text();
							} catch (err) {
								if (isEnoent(err)) {
									fail(`no such file: ${cmd.path}`);
									break;
								}
								throw err;
							}
							done(generateUnifiedDiffString(beforeText, cmd.content));
							break;
						}
						fail("fs_diff requires (path, content) or (before, after)");
					} catch (err) {
						fail(err instanceof Error ? err.message : String(err));
					}
					break;
				}

				default:
					failWithCode("not_implemented", `command not implemented: ${(command as { type: string }).type}`);
			}
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err));
		}
	};
	return {
		registry,
		addTarget,
		handleCommand,
		sendSessionSnapshotTo,
		broadcastServerSnapshot,
	};
}

export async function startWireServer(options: WireServerOptions): Promise<void> {
	const { token, defaultSession } = options;
	const core = await createWireCore(options);
	const { registry } = core;
	const connections = new Set<Connection>();
	const send = (ws: WireSocket, frame: ServerFrame): void => {
		ws.send(JSON.stringify(frame));
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
				removeTarget: () => {},
			};
			ws.data = connection;
			connections.add(connection);
			const target: WireCoreTarget = {
				id: connection.connectionId,
				getActiveAgentId: () => connection.activeAgentId,
				send: frame => send(ws, frame),
			};
			connection.removeTarget = core.addTarget(target);
			send(ws, {
				type: "hello_ack",
				connectionId: connection.connectionId,
				protocolVersion: MULTIDEVICE_PROTOCOL_VERSION,
			});
			// 列表 + 当前焦点快照（P1 兼容：客户端仍能只靠 session_snapshot 重建）
			core.broadcastServerSnapshot();
			core.sendSessionSnapshotTo(target);
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
		// ws → 传输无关 ctx 适配（P3：handleCommand 不碰 Connection）
		const ctx: CommandContext = {
			activeAgentId: conn.activeAgentId,
			setActiveAgentId: id => {
				conn.activeAgentId = id;
			},
			hostToolBridges: conn.hostToolBridges,
			sendPush: frame => send(conn.ws, frame),
			sendSessionSnapshot: () =>
				core.sendSessionSnapshotTo({
					id: conn.connectionId,
					getActiveAgentId: () => conn.activeAgentId,
					send: frame => send(conn.ws, frame),
				}),
			broadcastServerSnapshot: () => core.broadcastServerSnapshot(),
		};
		void core.handleCommand(ctx, frame.command, reply);
	};

	const server = Bun.serve<Connection | undefined>({
		hostname: options.host,
		port: options.port,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/health") {
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			// R-ARTIFACTS 静态预览：/preview/<agentId>/<relpath>（agentDir 当 docroot，只读）。
			// 路径逐段 URL 编码；token 校验同 /ws（空 token 本地免鉴权）。
			if (url.pathname.startsWith("/preview/")) {
				if (token !== "" && url.searchParams.get("token") !== token)
					return new Response("unauthorized", { status: 401 });
				const segs = url.pathname.slice("/preview/".length).split("/").filter(Boolean);
				if (segs.length < 2) return new Response("bad request", { status: 400 });
				let agentId: string;
				let rel: string;
				try {
					agentId = decodeURIComponent(segs[0]);
					rel = segs
						.slice(1)
						.map(s => decodeURIComponent(s))
						.join("/");
				} catch {
					return new Response("bad request", { status: 400 });
				}
				const meta = registry.getMeta(agentId);
				if (!meta) return new Response("unknown agent", { status: 404 });
				const target = resolveFsPath(meta.agentDir, rel);
				if (!target.ok) return new Response(target.error, { status: 400 });
				return servePreviewFile(target.path);
			}
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
				connection.removeTarget();
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

// ── P2-4：cron/gateway 命令转发 gateway 生产端点（POST /wire）──
//
// serve 不再直读 jobs.json / gateway.status.json——gateway 是调度器主人，直接回答
// 自己领域。gateway 未运行（端点不可达）时返回明确错误（旧客户端可见原因）。
// 形状与旧直读代理一致（TaskRowDto / CronLogEntryDto / GatewayStatusDto），
// 因此 web-app 消费方无需改动。

const GATEWAY_WIRE_PORT = Number.parseInt(process.env.OMP_GATEWAY_WIRE_PORT ?? "7892", 10);

async function callGatewayWire(command: {
	type: string;
	[key: string]: unknown;
}): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
	try {
		const res = await fetch(`http://127.0.0.1:${GATEWAY_WIRE_PORT}/wire`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(command),
		});
		const data = (await res.json()) as { ok?: boolean; result?: unknown; error?: unknown };
		if (!res.ok) {
			return { ok: false, error: typeof data.error === "string" ? data.error : `gateway wire ${res.status}` };
		}
		return data.ok
			? { ok: true, result: data.result }
			: { ok: false, error: (data.error as string | undefined) ?? "gateway error" };
	} catch (err) {
		return { ok: false, error: `gateway unreachable: ${err instanceof Error ? err.message : String(err)}` };
	}
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

/** serve 端 MCP 服务器管理命令（P0 收口：已登记进 pi-wire WireCommand union）。 */
type WireMcpServerCommand = Extract<
	WireCommand,
	{ type: "get_mcp_servers" | "set_mcp_server" | "remove_mcp_server" | "test_mcp_server" }
>;

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

/** /preview 静态预览 Content-Type（html/md 走文本，图片复用 IMAGE_MIME_BY_EXT）。 */
const PREVIEW_MIME_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".pdf": "application/pdf",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	...IMAGE_MIME_BY_EXT,
};

/** 只读静态预览（/preview 路由）：agentDir 内文件 → Response。不存在 → 404。 */
async function servePreviewFile(filePath: string): Promise<Response> {
	try {
		const f = Bun.file(filePath);
		const stat = await f.stat();
		if (!stat.isFile()) return new Response("not a file", { status: 404 });
		const mime = PREVIEW_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
		return new Response(f, { headers: { "content-type": mime, "cache-control": "no-store" } });
	} catch (err) {
		if (isEnoent(err)) return new Response("not found", { status: 404 });
		logger.warn("serve:preview-read-failed", { file: filePath, error: String(err) });
		return new Response("internal error", { status: 500 });
	}
}

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

// ═══════════════════════════════════════════════════════════════════════
// fs 写 / git 最小集 / 配置（票 01+02+03）
// ═══════════════════════════════════════════════════════════════════════

/** 从 AgentSession 构造写/编辑所需的 ToolSession 适配（cwd 锚定 agentDir，与 read 侧 sandbox 同源）。 */
function toWireToolSession(session: AgentSession, agentDir: string): ToolSession {
	return {
		cwd: agentDir,
		hasUI: false,
		enableLsp: true,
		settings: session.settings,
		getSessionFile: () => session.sessionFile ?? null,
		getSessionSpawns: () => null,
		getPlanModeState: () => undefined,
	};
}

/** LSP writethrough：与 write/edit 工具同一路径（didChange 同步 + notifySaved，格式化/诊断不重置）。 */
function createWireWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	return enableLsp ? createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics }) : writethroughNoop;
}

/** wire 侧无流式诊断注入点——延迟诊断直接取消。 */
function makeWireDeferredDiagnostics(): WritethroughDeferredHandle {
	const ctrl = new AbortController();
	return {
		onDeferredDiagnostics: () => {},
		signal: ctrl.signal,
		finalize: () => ctrl.abort(),
	};
}

/** 透传既有 edit 工具的多模执行（replace/patch/hashline/atom），聚合 diff。 */
async function executeWireEdit(
	mode: EditMode,
	session: ToolSession,
	absPath: string,
	payload: { edits?: unknown[]; input?: string },
	writethrough: WritethroughCallback,
): Promise<{ diff: string; firstChangedLine?: number }> {
	const allowFuzzy = session.settings.get("edit.fuzzyMatch");
	const fuzzyThreshold = session.settings.get("edit.fuzzyThreshold");
	const beginDeferred = makeWireDeferredDiagnostics;

	switch (mode) {
		case "replace": {
			const entries = (payload.edits ?? []) as ReplaceEditEntry[];
			if (entries.length === 0) throw new Error("fs_edit replace mode requires at least one edit entry");
			const diffs: string[] = [];
			let first: number | undefined;
			for (const entry of entries) {
				const res = await executeReplaceSingle({
					session,
					path: absPath,
					params: entry,
					allowFuzzy,
					fuzzyThreshold,
					writethrough,
					beginDeferredDiagnosticsForPath: beginDeferred,
				});
				if (res.details?.diff) diffs.push(res.details.diff);
				first ??= res.details?.firstChangedLine;
			}
			return { diff: diffs.join("\n"), firstChangedLine: first };
		}
		case "patch": {
			const entries = (payload.edits ?? []) as PatchEditEntry[];
			if (entries.length === 0) throw new Error("fs_edit patch mode requires at least one edit entry");
			const diffs: string[] = [];
			let first: number | undefined;
			for (const entry of entries) {
				const res = await executePatchSingle({
					session,
					path: absPath,
					params: entry,
					allowFuzzy,
					fuzzyThreshold,
					writethrough,
					beginDeferredDiagnosticsForPath: beginDeferred,
				});
				if (res.details?.diff) diffs.push(res.details.diff);
				first ??= res.details?.firstChangedLine;
			}
			return { diff: diffs.join("\n"), firstChangedLine: first };
		}
		case "hashline": {
			const edits = (payload.edits ?? []) as HashlineToolEdit[];
			if (edits.length === 0) throw new Error("fs_edit hashline mode requires at least one edit entry");
			const res = await executeHashlineSingle({
				session,
				path: absPath,
				edits,
				writethrough,
				beginDeferredDiagnosticsForPath: beginDeferred,
			});
			return { diff: res.details?.diff ?? "", firstChangedLine: res.details?.firstChangedLine };
		}
		case "atom": {
			if (typeof payload.input !== "string") throw new Error("fs_edit atom mode requires input string");
			const res = await executeAtomSingle({
				session,
				input: payload.input,
				path: absPath,
				writethrough,
				beginDeferredDiagnosticsForPath: beginDeferred,
			});
			return { diff: res.details?.diff ?? "", firstChangedLine: res.details?.firstChangedLine };
		}
		default:
			throw new Error(`fs_edit mode "${mode}" is not supported over wire (use replace/patch/hashline/atom)`);
	}
}

// ── git 最小集（票 02）──

const GIT_WIRE_SHORT_LIVED_CONFIG: readonly string[] = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
	"--no-optional-locks",
];

interface WireGitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** spawn git 子进程（与 utils/git 相同的短生命周期配置，避免并行锁竞争）。 */
async function runWireGit(cwd: string, args: readonly string[]): Promise<WireGitResult> {
	const child = Bun.spawn(["git", ...GIT_WIRE_SHORT_LIVED_CONFIG, ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	if (!child.stdout || !child.stderr) {
		throw new Error("Failed to capture git command output.");
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode: exitCode ?? 0, stdout, stderr };
}

/** 解析 porcelain v1 状态行（rename 取目标路径）。 */
function parseGitPorcelain(text: string): { staged: string[]; unstaged: string[]; untracked: string[] } {
	const staged: string[] = [];
	const unstaged: string[] = [];
	const untracked: string[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		const x = line[0];
		const y = line[1];
		if (!x || !y) continue;
		const rest = line.slice(3).trim();
		const target = rest.includes(" -> ") ? (rest.split(" -> ")[1] ?? "").trim() : rest;
		if (x === "?" && y === "?") {
			untracked.push(target);
			continue;
		}
		if (x !== " " && x !== "?") staged.push(target);
		if (y !== " ") unstaged.push(target);
	}
	return { staged, unstaged, untracked };
}

/** 解析 `%H%x1f%an%x1f%s` 日志行。 */
function parseGitLog(stdout: string): { hash: string; author: string; message: string }[] {
	return stdout
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => {
			const [hash = "", author = "", ...message] = line.split("\x1f");
			return { hash, author, message: message.join("\x1f") };
		});
}

// ── 配置读写（票 03）──

/** 目标 agent 的 config.yml 路径：default 的配置根是全局 agent 目录，registry agent 是自身 agentDir。 */
function agentConfigPathFor(meta: AgentMeta): string {
	return meta.id === "default" ? path.join(getAgentDir(), "config.yml") : path.join(meta.agentDir, "config.yml");
}

async function readAgentConfigYaml(filePath: string): Promise<Record<string, unknown>> {
	try {
		const raw = await Bun.file(filePath).text();
		const parsed = YAML.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch (err) {
		if (isEnoent(err)) return {};
		throw err;
	}
}

async function writeAgentConfigYaml(filePath: string, config: Record<string, unknown>): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await withFileLock(filePath, async () => {
		const tmpPath = `${filePath}.tmp`;
		await fs.writeFile(tmpPath, YAML.stringify(config, null, 2), { encoding: "utf8" });
		await fs.rename(tmpPath, filePath);
	});
}

function configGetByPath(obj: Record<string, unknown>, segments: string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function configSetByPath(obj: Record<string, unknown>, segments: string[], value: unknown): void {
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		const next = current[segment];
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1]] = value;
}
