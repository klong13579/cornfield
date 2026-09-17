import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModelPriceCatalog, getDashboardStats, syncAllSessions } from "@cornfield/stats";
import { getClientDir, isEnoent, logger, pathIsWithin, prompt } from "@cornfield/utils";
import type {
	AgentMessageDto,
	ClientFrame,
	ConfigScope,
	ModelSelectionDto,
	PermissionRequestPush,
	ServerFrame,
	WireCommand,
	WireCommandOfType,
	WireEnvironmentSummary,
	WireErrorCode,
	WireServerEvent,
} from "@cornfield/wire";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { YAML } from "bun";
import { runAgentInit } from "../cli/agent-cli";
import { withFileLock } from "../config/file-lock";
import { parseModelString } from "../config/model-resolver";
import { getDefault, SETTINGS_SCHEMA, type SettingPath } from "../config/settings";
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
import { normalizeHostToolDefinitions } from "../modes/rpc/rpc-mode";
import diagnoseSessionPrompt from "../prompts/diagnose-session.md" with { type: "text" };
import { discoverSkills } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { getDefaultSessionDirName } from "../session/session-manager";
import type { SessionStore } from "../session/session-store";
import { type ResolvedSessionWorkspace, resolveSessionWorkspace } from "../session/session-workspace";
import { AGENT_DIR_PROMPT_FILES } from "../skeleton/agent-dir-files";
import { resolveListenProvenance } from "../stt/listen-provenance";
import type { ListenProvenance } from "../stt/listen-service";
import {
	abortChunkedListenUpload,
	appendChunkedListenUpload,
	beginChunkedListenUpload,
	finishChunkedListenUpload,
	getListenDir,
	listListenRecordings,
	saveListenText,
	transcribeAudioWithDefaults,
} from "../stt/listen-service";
import type { ToolSession } from "../tools";
import { invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";
import type { TodoPhase } from "../tools/todo-write";
import * as git from "../utils/git";
import { resolveAgentScope } from "./agent-scope";
import { dropAgentTodo, listAgentTodos, writeAgentTodo } from "./agent-todos-wire";
import { listAgentArtifacts, listSessionArtifacts } from "./artifacts";
import { aggregateDiagnosis } from "./diagnosis-aggregation";
import { getDiagnosisReport, listDiagnosisReports, runSimpleDiagnosis } from "./diagnosis-runner";
import { readEvolvedSkills } from "./evolution-skills-wire";
import { readGitChanges } from "./git-wire";
import { WireHostToolBridge } from "./host-tool-bridge";
import { buildMemoryScopeProjection } from "./memory-scope";
import { PERMISSION_TIMEOUT_OUTCOME, PermissionGate } from "./permission-gate";
import { declareProject, dropProject, readProjectContext } from "./projects-wire";
import { agentSessionsRoot, defaultSessionsRoot, indexSessions, type SessionIndexSource } from "./session-index";
import {
	type AgentMeta,
	type AttachedSession,
	loadAgentMetas,
	type SessionFactory,
	SessionRegistry,
} from "./session-registry";
import { bringBackChildResult, delegateChildSession, readSessionTree } from "./session-tree-wire";
import {
	collectDisabledInputs,
	projectDisabledSkills,
	projectLoadedSkills,
	type SkillScopeAnchor,
	splitSkillWarnings,
} from "./skill-scope";
import { clearStatsCache, getCachedStats, setCachedStats } from "./stats-cache";

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
	/** 本连接当前焦点的**附件地址**（未绑定的附件地址就是 Agent 名）。 */
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
	/** 当前焦点的**附件地址**（`AttachedSession.address`；未绑定附件的地址就是 Agent 名）。 */
	activeAgentId: string;
	/** attach/switch 后更新焦点（传入附件的地址）。 */
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
	"message_start",
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
	{ tool: "glob", label: "glob 文件查找", path: "glob.enabled" },
	{ tool: "grep", label: "grep 内容搜索", path: "grep.enabled" },
	{ tool: "ast_grep", label: "ast_grep 结构搜索", path: "astGrep.enabled" },
	{ tool: "ast_edit", label: "ast_edit 结构改写", path: "astEdit.enabled" },
	{ tool: "lsp", label: "lsp 代码智能", path: "lsp.enabled" },
	{ tool: "debug", label: "debug 调试器", path: "debug.enabled" },
	{ tool: "todo", label: "todo 任务看板", path: "todo.enabled" },
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
 * - 命令按 command.sessionId 定向（Agent 名或**附件地址**）；缺省 = 本连接焦点附件
 * - 事件路由：session_snapshot/progress 只推给焦点就在**那个附件**上的连接（按附件地址比）；
 *   server_snapshot（agent 列表）广播全连接
 * - host tool：set_host_tools 注册 bridge，call 帧只发给执行者连接；断开全拒
 */
export interface WireCoreTarget {
	id: string;
	/** 当前焦点的**附件地址**（可变：ws 连接 switch_session；内存客户端切换）。 */
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
 * 按**地址**取附件。地址是附件自己的事实，所以按 `listAttached()` 比对 —— 不拼 key
 * （拼 key 是 registry 的事，`attachmentKey` 不从那里漏出来）。
 */
function focusedAttachment(registry: SessionRegistry, address: string): AttachedSession | undefined {
	return registry.listAttached().find(attached => attached.address === address);
}

/**
 * 一个 id（`session_snapshot.sessionId` / 命令的 `sessionId` / `/preview` 的那一段）指的是哪个附件。
 *
 * 两种可能的写法指的是同一件东西的两面，所以两种都认：
 *   - **附件地址** —— 绑了 Project 的会话只能这样指认，而客户端拿到的快照 `sessionId` 就是地址，
 *     它会把这个值原样回传，所以地址不是服务端内部的私事；
 *   - **Agent 名** —— 今天的形状（点名一个 Agent = 它自己根上的那个附件）。
 *
 * 先地址后 Agent 名：未绑定附件的地址就是 Agent 名，两者重合时结果一样；Agent 名里不可能含地址的
 * 分隔符（NUL），所以不存在遮蔽。认不出来返回 `undefined`，由调用方按「未知 agent」报。
 */
function attachmentFor(registry: SessionRegistry, sessionId: string | undefined): AttachedSession | undefined {
	if (sessionId === undefined) return undefined;
	return focusedAttachment(registry, sessionId) ?? registry.getAttached(sessionId);
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

	const targets = new Set<WireCoreTarget>();
	const addTarget = (t: WireCoreTarget): (() => void) => {
		targets.add(t);
		return () => {
			targets.delete(t);
			// 最后一个接收端断开：清空审批 pending（原 ws 层 close 逻辑）
			if (targets.size === 0) gate.clearAll();
		};
	};
	/**
	 * 本命令指的是哪个 Agent：点名的认（附件地址或 Agent 名），**认不出来就把那个名字原样交回去**
	 * —— 由调用方的 `getMeta` 决定「未知 agent」还是「注册了但没 attach」，不许拿焦点的 Agent 顶上
	 * （那会把「读 X」变成「读我正在看的那个」）。缺省才用焦点附件的 Agent。
	 */
	const agentOf = (ctx: { activeAgentId: string }, sessionId: string | undefined): string => {
		if (sessionId !== undefined) return attachmentFor(registry, sessionId)?.meta.id ?? sessionId;
		return attachmentFor(registry, ctx.activeAgentId)?.meta.id ?? ctx.activeAgentId;
	};

	/**
	 * 本命令指的是哪个附件：点名的**只**取那个（点名的东西不在就是不在 —— 拿焦点顶上会让「读 X」变成
	 * 「读我正在看的那个」，那是另一份事实），缺省才是本连接焦点附件。
	 */
	const attachmentOf = (
		ctx: { activeAgentId: string },
		sessionId: string | undefined,
	): AttachedSession | undefined => {
		if (sessionId !== undefined) return attachmentFor(registry, sessionId);
		return attachmentFor(registry, ctx.activeAgentId);
	};

	const activeAgentIds = (): Set<string> => {
		const ids = new Set<string>();
		// 焦点是**附件地址**；server_snapshot 是 Agent 列表（一行一个 Agent），所以换回 Agent 名。
		for (const target of targets) {
			const focused = focusedAttachment(registry, target.getActiveAgentId());
			if (focused) ids.add(focused.meta.id);
		}
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
		const focused = focusedAttachment(registry, target.getActiveAgentId());
		if (!focused) return;
		const event: WireServerEvent = {
			type: "session_snapshot",
			sessionId: focused.address,
			snapshot: focused.store.getSnapshot(),
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

	// ── 事件路由：只推给焦点就在**那个附件**上的连接 ──
	// 事件的 `sessionId` 是附件地址（`AttachedSession.address`）：未绑定的附件地址就是 Agent 名，
	// 所以「按 agentId 比」的旧行为逐字节不变；绑了 Project 的附件按地址比，一个 Agent 两个附件
	// 因此不会互相串台。
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

	/**
	 * 命令解析：返回目标 attached session；未 attach / 未注册时报错。
	 * `sessionId` 可能是 Agent 名，也可能是附件地址（见 `attachmentFor`）；
	 * 缺省 = 本连接焦点附件（焦点也是附件地址）。
	 */
	const resolveTarget = (
		ctx: { activeAgentId: string },
		command: { sessionId?: string },
	): { agentId: string; attached: AttachedSession } | { error: string } => {
		const attached = attachmentOf(ctx, command.sessionId);
		if (attached) return { agentId: attached.meta.id, attached };
		// 报错文案按今天的两条分开报：点名了一个不存在的 Agent ≠ 点名了一个还没 attach 的 Agent。
		const named = command.sessionId ?? ctx.activeAgentId;
		if (!registry.getMeta(named)) {
			return { error: `unknown agent: ${named}` };
		}
		return { error: `agent not attached: ${named} (send attach first)` };
	};

	/**
	 * 听记的写入方来源（T10C）：焦点**附件**的 scope。
	 *
	 * 听记存在客户端级目录，页面要按 Agent/Project/Session 分它就必须在写入时标上 —— 但
	 * **转写本身不能因为归属解析失败而失败**（音频是用户的数据，丢不得）。所以解析不到时
	 * 返回空 provenance：落盘上就是「未标注」，而不是把这条录音冒充成焦点 Agent 的。
	 *
	 * 收的是**附件**而不是一个字符串 id：焦点是附件地址，绑了 Project 的会话要按它自己的工作根
	 * 标（`sessionCwd` 在 `./agent-scope` 里就是从附件会话取的）—— 拿地址去查 agent 只会查出
	 * 一个不存在的 Agent，那份 provenance 就变成一条错的。
	 */
	const listenProvenance = async (attached: AttachedSession | undefined): Promise<ListenProvenance> => {
		if (!attached) return {};
		try {
			const anchor = await resolveAgentScope({
				agentId: attached.meta.id,
				meta: attached.meta,
				attached,
			});
			return await resolveListenProvenance({
				agentId: anchor.agentId,
				agentDir: anchor.agentDir,
				cwd: anchor.sessionCwd,
				...(anchor.sessionFile ? { sessionFile: anchor.sessionFile } : {}),
			});
		} catch (err) {
			logger.warn("listen provenance unresolved; recording stays unattributed", {
				agentId: attached.meta.id,
				error: err instanceof Error ? err.message : String(err),
			});
			return {};
		}
	};

	/** 从 session JSONL 首行提取 session id。 */
	function readSessionId(sessionFile: string): string {
		try {
			const firstLine = require("node:fs").readFileSync(sessionFile, "utf8").split("\n")[0] ?? "";
			const parsed = JSON.parse(firstLine) as { id?: string };
			return parsed.id ?? `session-${Date.now()}`;
		} catch {
			return `session-${Date.now()}`;
		}
	}

	/** 生成 reportId：<safeSessionId>_<YYYYMMDD-HHMMSS> */
	function generateReportId(sessionId: string): string {
		const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		return `${safe}_${ts}`;
	}

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
				/**
				 * 建一个 agentDir（`cornfield agent init` 的 wire 面）。
				 *
				 * 走 CLI 同一条实现（`runAgentInit`）：写骨架 + workspace 声明 + registry 三件事都在它
				 * 里面，这里只搬入参、刷新进程内注册表。失败把**原文**交回去（名字非法 / 目录不可写 /
				 * mission 文件不存在 …），不另编一套话术 —— 客户端的「失败原因」只能来自这里。
				 *
				 * 建完刷注册表是有必要的：注册表的权威是 `registry.json`，进程内 `#metas` 是它的缓存，
				 * 不刷新则刚建好的 agentDir 在 `list_agents` / `attach` 里不存在，客户端看到的会是一个
				 * 「刚建好但还没身份证」的 agent。刷新失败不回退成创建失败（盘上真的有它），只记日志。
				 *
				 * 与 CLI 并发建的互斥由注册表自己保证：`registerAgent` 的 read-modify-write 在
				 * registry.json 的文件锁里（skeleton/registry.ts）—— 两个客户端同时建 agent 不会丢条目。
				 */
				case "create_agent": {
					try {
						const created = await runAgentInit({
							name: command.name,
							...(command.dir === undefined ? {} : { dir: command.dir }),
							...(command.mission === undefined ? {} : { mission: command.mission }),
							...(command.template === undefined ? {} : { template: command.template }),
						});
						// 不需要在这条命令上再自排一个队列：registry.json 的 read-modify-write 自己在文件锁里
						// （skeleton/registry.ts），所以两个客户端同时建 agent 也不会丢条目。
						for (const meta of await loadMetasSafe()) registry.registerMeta(meta);
						done(created);
					} catch (err) {
						fail(err instanceof Error ? err.message : String(err));
					}
					return;
				}
				// ── Project（T8）：客户端级 Project registry 的读面与写面 ──
				case "list_projects": {
					try {
						// 会话归属只看**已 attach** 的会话（不 lazy attach）：查一次项目列表不应把 agent 拉起来。
						// 归属问的是**会话本身**（它头里记着权威 projectId），不是它的 cwd 字符串 ——
						// 只拿到一个目录的桥只能按路径猜。agentDir 是 resolver 要的身份根。
						// 取附件用 T26 的原语（点名的认附件地址或 Agent 名，缺省才是焦点附件）。
						const attached = attachmentOf(ctx, command.sessionId);
						done(
							await readProjectContext(
								attached
									? { session: attached.session.sessionManager, agentDir: attached.meta.agentDir }
									: undefined,
							),
						);
					} catch (err) {
						// 存储存在但读不出来 / 会话记的 Project 注册表里没有 → ok:false（不当成「没有 Project」）
						fail(`list_projects failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "set_project": {
					try {
						// 写面不挂会话、不 lazy attach：声明一个 Project 与哪个 agent 附着无关。
						const input = {
							projectId: command.projectId,
							name: command.name,
							root: command.root,
							...(command.defaultAgentId === undefined ? {} : { defaultAgentId: command.defaultAgentId }),
						};
						done(await declareProject(input));
					} catch (err) {
						// root 已被别的 Project 占用 / 输入不成立 / 存储写不进去 → ok:false（不谎报已声明）
						fail(`set_project failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "delete_project": {
					try {
						done(await dropProject(command.projectId));
					} catch (err) {
						// 没声明过就是没删掉 → ok:false（不当成一次成功的空删除）
						fail(`delete_project failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				// ── Agent Todo（T10A）：Agent 级 Todo 板（owner = Agent，Project 可选绑定）──
				// 只读/只写这个 agentDir 的板子，不 lazy attach：列一块板不该把 agent 拉起来。
				// 目标 agent 未注册 → ok:false（不拿别的 agent 的板子冒充）。
				case "list_agent_todos":
				case "set_agent_todo":
				case "delete_agent_todo": {
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const target = { agentId, agentDir: meta.agentDir };
					if (command.type === "list_agent_todos") {
						done(await listAgentTodos(target));
						return;
					}
					if (command.type === "set_agent_todo") {
						done({ todo: await writeAgentTodo(target, command.todo) });
						return;
					}
					done({ deleted: await dropAgentTodo(target, command.todoId) });
					return;
				}
				case "attach": {
					// `sessionId` 可能是 Agent 名（attach 它自己根上的那个附件），也可能是**附件地址**
					// （已经在了的那个）—— 两种都幂等：已经在的会话直接回它，不然会把另一个附件拉起来。
					const existing = attachmentFor(registry, command.sessionId);
					if (existing) {
						done({ sessionId: command.sessionId, sessionFile: existing.session.sessionFile });
						return;
					}
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
					// 点名可以给 Agent 名，也可以给附件地址（见 `attachmentFor`）。
					const target = attachmentFor(registry, command.sessionId);
					const detachAgentId = target?.meta.id ?? command.sessionId;
					if (detachAgentId === "default") {
						fail("cannot detach default agent");
						return;
					}
					// 焦点也在那个附件上的连接不能把它拆掉（对比的是**地址**：一个 Agent 两个附件时
					// 拆掉一个不等于「这个 Agent 没人在看」）。
					const detachAddress = target?.address ?? command.sessionId;
					for (const connection of targets) {
						if (connection.getActiveAgentId() === detachAddress) {
							fail(`agent is active on a connection: ${detachAgentId} (switch_session first)`);
							return;
						}
					}
					await registry.detach(detachAgentId, target?.projectId);
					done();
					return;
				}
				case "switch_session": {
					// 点名一个 Agent（今天）或一个**附件地址**（绑了 Project 的会话只能这样指认）。
					const existing = attachmentFor(registry, command.sessionId);
					if (existing) {
						ctx.setActiveAgentId(existing.address);
						// 新焦点的快照立即推给本连接（快照权威，客户端零恢复逻辑）
						ctx.sendSessionSnapshot();
						ctx.broadcastServerSnapshot();
						done({ sessionId: existing.address });
						return;
					}
					if (!registry.getMeta(command.sessionId)) {
						fail(`unknown agent: ${command.sessionId}`);
						return;
					}
					const attached = await registry.attach(command.sessionId);
					// 焦点 = 那个附件的**地址**（未绑定的地址就是 Agent 名，与今天同值）
					ctx.setActiveAgentId(attached.address);
					// 新焦点的快照立即推给本连接（快照权威，客户端零恢复逻辑）
					ctx.sendSessionSnapshot();
					ctx.broadcastServerSnapshot();
					done({ sessionId: attached.address });
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
				case "diagnose_session": {
					// 诊断会话：先做简单路径（快速出 fallback），再用 runEphemeralTurn 做 LLM 深度分析
					const sf = command.sessionFile;
					if (!(await Bun.file(sf).exists())) {
						fail(`session file not found: ${sf}`);
						return;
					}

					// 生成 reportId 和路径
					const sessionId = readSessionId(sf);
					const reportId = generateReportId(sessionId);
					const reportsDir = path.join(getClientDir(), "diagnosis-reports");
					const reportPath = path.join(reportsDir, `${reportId}.md`);
					const summaryPath = path.join(reportsDir, `${reportId}.summary.json`);

					// 幂等
					if (await Bun.file(reportPath).exists()) {
						done({ reportId, sessionId, state: "done" });
						return;
					}

					// 异步后台：先简单路径写 fallback，再用 runEphemeralTurn 做 LLM 深度分析
					(async () => {
						try {
							// reportsDir 可能尚不存在（首诊/全新 agentDir），不建目录则
							// runSimpleDiagnosis 写文件 ENOENT，诊断永远落不了库
							await fs.mkdir(reportsDir, { recursive: true });
							await runSimpleDiagnosis(sf, reportId, sessionId, reportsDir, reportPath, summaryPath);

							// LLM 深度分析（in-process ephemeral turn）
							const target = resolveTarget(ctx, {});
							if (!("error" in target)) {
								const rendered = prompt.render(diagnoseSessionPrompt, {
									sessionFile: sf,
									reportPath,
									summaryPath,
									reportId,
								});
								await target.attached.session.runEphemeralTurn({ promptText: rendered });
							}
						} catch (err) {
							logger.error("diagnose_session: LLM analysis failed, fallback kept", {
								sessionFile: sf,
								error: String(err),
							});
						}
					})();

					done({ reportId, sessionId, state: "running" });
					return;
				}
				case "list_diagnosis_reports": {
					const result = listDiagnosisReports(command.sessionFile);
					done(result);
					return;
				}
				case "get_diagnosis_report": {
					const result = getDiagnosisReport(command.reportId);
					if (!result) {
						fail(`report not found: ${command.reportId}`);
						return;
					}
					done(result);
					return;
				}
				case "aggregate_diagnosis": {
					const { since, until, agentId } = command as {
						type: string;
						since?: number;
						until?: number;
						agentId?: string;
					};
					try {
						const result = aggregateDiagnosis({ since, until, agentId });
						done(result);
					} catch (err) {
						fail(`aggregate_diagnosis failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "fs_list": {
					const fsCmd = command as { type: "fs_list"; sessionId?: string; path?: string };
					// `sessionId` 可能是 Agent 名，也可能是附件地址（客户端把快照里那个值原样回传）；
					// 缺省 = 本连接焦点附件。
					const attached = attachmentOf(ctx, fsCmd.sessionId);
					const agentId = agentOf(ctx, fsCmd.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					// 边界 = 会话的工作面（绑定了 Project 就是它的 root + agentDir 声明的额外根）：
					// 未 attach 时没有会话可问，resolver 手上只有 agentDir 这一个事实 —— 与今天一致。
					const target = await resolveFsTarget({
						agentDir: meta.agentDir,
						session: attached?.session,
						path: fsCmd.path ?? "",
					});
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
					const attached = attachmentOf(ctx, fsCmd.sessionId);
					const agentId = agentOf(ctx, fsCmd.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const target = await resolveFsTarget({
						agentDir: meta.agentDir,
						session: attached?.session,
						path: fsCmd.path ?? "",
					});
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
					// 返回 dataUrl（上限 2MB，超出截断标记），MIME 按扩展名。路径约束与 fs_read 同（同一条 roots 边界）。
					const attached = attachmentOf(ctx, command.sessionId);
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const target = await resolveFsTarget({
						agentDir: meta.agentDir,
						session: attached?.session,
						path: (command as { path: string }).path ?? "",
					});
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
						// 定向会话：边界 = 那个会话的工作面（与 fs_read 同一处判定）。
						const agentId = agentOf(ctx, cmd.sessionId);
						const meta = registry.getMeta(agentId);
						if (!meta) {
							fail(`unknown agent: ${agentId}`);
							return;
						}
						const anchor = await workspaceAnchorOf({
							agentDir: meta.agentDir,
							session: attachmentOf(ctx, cmd.sessionId)?.session,
						});
						if (!anchor.ok) {
							fail(anchor.error);
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
						const artifacts = await listSessionArtifacts(anchor.workspace.roots, cmd.sessionFile);
						done({ artifacts });
						return;
					}
					const agentId = agentOf(ctx, cmd.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const anchor = await workspaceAnchorOf({
						agentDir: meta.agentDir,
						session: attachmentOf(ctx, cmd.sessionId)?.session,
					});
					if (!anchor.ok) {
						fail(anchor.error);
						return;
					}
					// 会话根必须精确到 agent 自己的目录：default 是 <sessions>/<encoded-cwd>
					// （全局根下其它项目的新会话会挤掉 Top N）；registry 是 <agentDir>/sessions。
					const sessionsRoot =
						meta.id === "default"
							? path.join(defaultSessionsRoot(), getDefaultSessionDirName(meta.agentDir).encodedDirName)
							: agentSessionsRoot(meta);
					const artifacts = await listAgentArtifacts(anchor.workspace.roots, sessionsRoot);
					done({ artifacts });
					return;
				}
				case "record_transcribe": {
					// VOICE-D：浏览器录音上传 → TUI /record 同源转写管线（本地 whisper / record.model，
					// 自动分块）→ 落 ~/.cornfield/listen/，与 /record 同目录同格式。不定向 agent（纯数据路径）。
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
						const savedPath = await saveListenText(
							text,
							desc,
							tmpPath,
							await listenProvenance(attachmentOf(ctx, undefined)),
						);
						done({ ok: true, text, path: savedPath, model });
					} catch (err) {
						fail(err instanceof Error ? err.message : "transcription failed");
					} finally {
						await fs.rm(tmpPath, { force: true }).catch(() => {});
					}
					return;
				}
				case "record_transcribe_begin": {
					// VOICE-D 分帧上传：长录音 base64 超 Bun WS 单帧 16MB 上限，前端按 begin→chunk→end 分帧。
					const opts = command as { totalBytes?: unknown; desc?: unknown };
					try {
						const uploadId = await beginChunkedListenUpload({
							...(typeof opts.totalBytes === "number" ? { totalBytes: opts.totalBytes } : {}),
							...(typeof opts.desc === "string" && opts.desc ? { desc: opts.desc } : {}),
						});
						done({ ok: true, uploadId });
					} catch (err) {
						fail(err instanceof Error ? err.message : "begin upload failed");
					}
					return;
				}
				case "record_transcribe_chunk": {
					const c = command as { uploadId?: unknown; seq?: unknown; data?: unknown };
					if (typeof c.uploadId !== "string" || typeof c.seq !== "number" || typeof c.data !== "string") {
						fail("uploadId, seq (number), data (base64) required");
						return;
					}
					try {
						const received = await appendChunkedListenUpload(c.uploadId, c.seq, c.data);
						done({ ok: true, received });
					} catch (err) {
						await abortChunkedListenUpload(c.uploadId);
						fail(err instanceof Error ? err.message : "chunk failed");
					}
					return;
				}
				case "record_transcribe_end": {
					const c = command as { uploadId?: unknown };
					if (typeof c.uploadId !== "string") {
						fail("uploadId required");
						return;
					}
					let tmpPath: string | null = null;
					try {
						const finished = await finishChunkedListenUpload(c.uploadId);
						tmpPath = finished.path;
						const { text, model } = await transcribeAudioWithDefaults(tmpPath, {
							modelRegistry: defaultModelRegistry,
						});
						const savedPath = await saveListenText(
							text,
							finished.desc,
							finished.path,
							await listenProvenance(attachmentOf(ctx, undefined)),
						);
						done({ ok: true, text, path: savedPath, model });
					} catch (err) {
						fail(err instanceof Error ? err.message : "transcription failed");
					} finally {
						if (tmpPath) await fs.rm(tmpPath, { force: true }).catch(() => {});
					}
					return;
				}
				case "listen_list": {
					// /listen 前端化：列出 ~/.cornfield/listen/ 全部录音（名称倒序 + 转写全文，前端本地搜索/预览）。
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
					// 性能：聚合查询扫全量 messages 表 ~700ms-1s——TTL 10s 内同 period 复用响应
					//（sync 有新条目即刻失效，保证数据新鲜度）；固定时间序列随包缓存不重算。
					try {
						const synced = await syncAllSessions();
						if (synced.processed > 0) clearStatsCache();
						const cached = getCachedStats(command.period);
						if (cached) {
							done(cached);
							return;
						}
						const periodMs = parseStatsPeriod(command.period);
						const stats = await getDashboardStats(periodMs);
						const value = { ...stats, priceCatalog: buildModelPriceCatalog(stats.byModel) };
						setCachedStats(command.period, value);
						done(value);
					} catch (err) {
						fail(`stats unavailable: ${String(err)}`);
					}
					return;
				}
				case "get_memory": {
					// W3 D3 + T10B：只读记忆投影，按 Agent/Project/Session/User scope 分区。
					// sessionId（= agent id）缺省 = 本连接焦点 agent；未 attach 的 agent 只按 agentDir 推算。
					// T10B：sessionId（= agent id）缺省 = 本连接焦点 agent；pi-wire 的 get_memory 命令已带 sessionId。
					const agentId = agentOf(ctx, command.sessionId);
					// 未注册的 agent 不能回退到「default 的目录 + 别人的名字」：那会把一个不存在的
					// Agent 的记忆显示成它自己的。注册表说了算（与 fs_read / list_projects 同一判决）。
					if (!registry.getMeta(agentId)) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					try {
						const anchor = await resolveAgentScope({
							agentId,
							meta: registry.getMeta(agentId),
							attached: attachmentOf(ctx, command.sessionId),
						});
						done(
							await buildMemoryScopeProjection({
								agentId: anchor.agentId,
								agentDir: anchor.agentDir,
								sessionCwd: anchor.sessionCwd,
								configRoot: anchor.configRoot,
								projectRoot: anchor.project?.root,
								declaredMemoryDir: anchor.declaredMemoryDir,
								sessionFile: anchor.sessionFile,
								attached: anchor.attached,
							}),
						);
					} catch (err) {
						fail(`memory unavailable: ${String(err)}`);
					}
					return;
				}
				case "get_evolved_skills": {
					// 演化技能只读投影（T13）：与 get_memory 同一个库、同一条 scope 解析规则，两页读同一份事实。
					// 与 get_skills（会话级、需要 attach）不同：这是全局库的读面，不 lazy attach 任何 agent。
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					try {
						const anchor = await resolveAgentScope({
							agentId,
							meta,
							attached: attachmentOf(ctx, command.sessionId),
						});
						done(await readEvolvedSkills(anchor.sessionCwd));
					} catch (err) {
						// 库在但读不出来（不是库 / 表结构不对）→ ok:false。空清单只用于「库还没生成」。
						fail(`evolved skills unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
					const attached = attachmentOf(ctx, undefined);
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
						// 命令表属于这个会话：开关读会话自己那份 settings。读全局单例会让一个 agent 的
						// `skills.enableSkillCommands` 决定另一个 agent 的命令表（与配置面同一类缺陷）。
						if (s.settings.get("skills.enableSkillCommands")) {
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
				/**
				 * T10C：调度定义写面同样转发 gateway 生产端点 —— 调度器的主人是 gateway，
				 * serve 不代它写 jobs.json（那会造出第二个存储真相）。
				 *
				 * 失败用字符串错误（不带 code）：「任务不存在 / Agent 绑定解析不到」是调用方错误，
				 * 归到 `internal` 等于告诉调用方「服务器出 bug 了」。
				 */
				case "cron_create":
				case "cron_update":
				case "cron_remove":
				case "cron_test_run": {
					const payload: { type: string; [key: string]: unknown } = { ...command };
					// `id` 是 wire 关联 id，不是调度定义的 id（后者是 taskId）——不往 gateway 透传。
					delete payload.id;
					const res = await callGatewayWire(payload);
					if (!res.ok) {
						fail(res.error);
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
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					// git 面读的是**这个会话工作的那个根**（绑定了 Project 就是它的 root）；
					// 未绑定 = agentDir，与今天同一个目录。
					const work = await resolveWorkRoot({
						agentDir: meta.agentDir,
						session: attachmentOf(ctx, command.sessionId)?.session,
					});
					if (!work.ok) {
						fail(work.error);
						return;
					}
					try {
						const branch = await git.branch.current(work.root);
						const porcelain = await runWireGit(work.root, ["status", "--porcelain=v1", "--untracked-files=all"]);
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
				case "git_changes": {
					// `git_status` 的逐条版本（T13）：同一个仓库（目标 agent 的工作目录）——
					// 「几条」与「哪几条」必须说的是同一份事实，所以这里与上面三个 git 命令同一处取目录。
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const work = await resolveWorkRoot({
						agentDir: meta.agentDir,
						session: attachmentOf(ctx, command.sessionId)?.session,
					});
					if (!work.ok) {
						fail(work.error);
						return;
					}
					try {
						done(await readGitChanges(work.root));
					} catch (err) {
						// 不是 git 仓库 / git 读不出来 / 整份输出无法解析 → ok:false；
						// 空清单是「工作区确实干净」这个事实，不能拿来冒充读不到。
						fail(`git_changes failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "git_diff": {
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const cmd = command as { cached?: boolean; path?: string };
					const work = await resolveWorkRoot({
						agentDir: meta.agentDir,
						session: attachmentOf(ctx, command.sessionId)?.session,
					});
					if (!work.ok) {
						fail(work.error);
						return;
					}
					try {
						const args = ["diff"];
						if (cmd.cached) args.push("--cached");
						if (cmd.path) args.push("--", cmd.path);
						const r = await runWireGit(work.root, args);
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
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const count = Math.min(100, Math.max(1, Math.trunc((command as { count?: number }).count ?? 20)));
					const work = await resolveWorkRoot({
						agentDir: meta.agentDir,
						session: attachmentOf(ctx, command.sessionId)?.session,
					});
					if (!work.ok) {
						fail(work.error);
						return;
					}
					try {
						const r = await runWireGit(work.root, ["log", `-n${count}`, "--pretty=format:%H%x1f%an%x1f%s"]);
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
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					const revision = (command as { revision: string }).revision;
					const work = await resolveWorkRoot({
						agentDir: meta.agentDir,
						session: attachmentOf(ctx, command.sessionId)?.session,
					});
					if (!work.ok) {
						fail(work.error);
						return;
					}
					try {
						const r = await runWireGit(work.root, ["show", "--format=fuller", "--stat", revision]);
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
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					try {
						const work = await resolveWorkRoot({
							agentDir: meta.agentDir,
							session: attachmentOf(ctx, command.sessionId)?.session,
						});
						if (!work.ok) {
							fail(work.error);
							return;
						}
						const [current, localRes, remoteRes] = await Promise.all([
							git.branch.current(work.root),
							runWireGit(work.root, ["branch", "--format=%(refname:short)"]),
							runWireGit(work.root, ["branch", "-r", "--format=%(refname:short)"]),
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
				// ── 配置读写（票 03 / F6）—— per-agent：sessionId 定向到该 agent 的配置 ──
				// 读的是**目标 agent 自己的 Settings 实例**的合并视图（project 压 global），与
				// set_config / get_tool_switches / 模型停用名单同一个来源。自己拼文件读会漏掉另一层
				// （写进 project 的值在 global 文件里读不到），也会让运行中的会话看到的是另一份事实。
				// 配置属于活着的 agent，所以定位与 get_tool_switches 同层：需要该 agent 已 attach
				// （serve 启动即预挂载全部注册 agent）。
				case "get_config": {
					const target = resolveTarget(ctx, command);
					if ("error" in target) {
						fail(target.error);
						return;
					}
					const key = (command as { key?: string }).key;
					done({ config: target.attached.session.settings.getRawValue(key) });
					return;
				}
				case "set_config": {
					const target = resolveTarget(ctx, command);
					if ("error" in target) {
						fail(target.error);
						return;
					}
					const cmd = command as { key: string; value?: unknown; scope?: ConfigScope };
					const key = cmd.key.trim();
					if (!key) {
						fail("key is required");
						return;
					}
					// 落点规则只有 Settings#setEffective 一处实现：#05 的显式 scope 只是把自动判定
					// 换成点名的层；缺省 = 合并视图解析这个键的那一层（有 project 层就写 project，
					// 否则写该 agent 自己的 config.yml）。回包报的就是真的落到的那一层。
					const settings = target.attached.session.settings;
					try {
						settings.setEffective(key, cmd.value, cmd.scope);
						// 命令语义是「写并持久化」：保存是防抖的，回包前先落盘。
						await settings.flush();
						done({ ok: true, key, value: cmd.value, scope: cmd.scope ?? settings.getEffectiveScope() });
					} catch (err) {
						fail(`set_config failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				// ── 配置作用域（#05）：按**文件**看两层（global / project）的取值与覆盖 ──
				// 与 get_config/set_config 不同源：那两个走目标 agent 的 Settings 合并视图（活的那份）；
				// 这里回答的是「哪个文件写了什么、项目层覆盖了哪些键」，所以直读两个文件。
				// 已知边界：restore_config_inheritance 只删 project 文件里的键，活着的 Settings 实例
				// 仍持有该覆盖直到重载。
				case "get_config_scope": {
					const target = resolveTarget(ctx, command);
					if ("error" in target) {
						fail(target.error);
						return;
					}
					try {
						// 两个路径都问目标 agent 的 live Settings —— 按身份的解析只在 `Settings` 里有一处实现
						// （`getGlobalConfigPath` / `getProjectConfigPath`）。本命令过去自己按 `agentHomeFor(meta)`
						// 推一份，于是「页面报的文件 / 写侧落的文件」可以给出两个答案。
						const liveSettings = target.attached.session.settings;
						const globalPath = liveSettings.getGlobalConfigPath();
						const projectPath = liveSettings.getProjectConfigPath();
						const globalConfig = await readAgentConfigYaml(globalPath);
						const projectConfig = await readAgentConfigYaml(projectPath);
						// 与 Settings#hasProjectConfigFile 同源：文件存在即 true（空文件也算）
						const hasProjectConfig = await Bun.file(projectPath).exists();
						const keys = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(settingsKey => {
							const segments = settingsKey.split(".");
							const projectValue = configGetByPath(projectConfig, segments);
							const globalValue = configGetByPath(globalConfig, segments);
							const uiTab = (SETTINGS_SCHEMA[settingsKey] as { ui?: { tab?: string } } | undefined)?.ui?.tab;
							return {
								key: settingsKey,
								...(uiTab ? { uiTab } : {}),
								overridden: projectValue !== undefined,
								...(projectValue !== undefined ? { projectValue } : {}),
								...(globalValue !== undefined ? { globalValue } : {}),
								effectiveValue: configMergeValues(globalValue, projectValue) ?? getDefault(settingsKey),
							};
						});
						done({
							hasProjectConfig,
							...(hasProjectConfig ? { projectConfigPath: projectPath } : {}),
							globalConfigPath: globalPath,
							keys,
						});
					} catch (err) {
						fail(`get_config_scope failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "restore_config_inheritance": {
					const target = resolveTarget(ctx, command);
					if ("error" in target) {
						fail(target.error);
						return;
					}
					const key = (command as { key?: string }).key?.trim();
					if (!key) {
						fail("key is required");
						return;
					}
					// 删的是目标 agent 那份 project 文件（写侧落点的同一个文件），跌回值读它的 global 文件。
					const liveSettings = target.attached.session.settings;
					const projectPath = liveSettings.getProjectConfigPath();
					try {
						const projectConfig = await readAgentConfigYaml(projectPath);
						const removed = configDeleteByPath(projectConfig, key.split("."));
						if (removed) {
							await writeAgentConfigYaml(projectPath, projectConfig);
						}
						// 删除后的生效值回落全局/ schema 默认（项目覆盖已不存在）
						const globalValue = configGetByPath(
							await readAgentConfigYaml(liveSettings.getGlobalConfigPath()),
							key.split("."),
						);
						done({
							key,
							removed,
							effectiveValue: globalValue ?? getDefault(key as SettingPath),
						});
					} catch (err) {
						fail(`restore_config_inheritance failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				// ── agentDir 的 prompt 源清单 ──
				// 工作面是 agentDir（不是会话），所以只查注册表、不 attach（不同于 get_config：
				// 那个读的是活着的 agent 的配置实例）。
				// 清单本身来自 agentDir 文件的单一真相（skeleton/agent-dir-files.ts），前端不另抄一份。
				case "get_agent_prompt_sources": {
					const agentId = agentOf(ctx, command.sessionId);
					const meta = registry.getMeta(agentId);
					if (!meta) {
						fail(`unknown agent: ${agentId}`);
						return;
					}
					try {
						// 逐项报 exists：缺的那一项也在这份清单里（不裁成「存在的那些」）。
						const sources = await Promise.all(
							AGENT_DIR_PROMPT_FILES.map(async file => ({
								path: file.relPath,
								title: file.title,
								description: file.description,
								exists: await Bun.file(path.join(meta.agentDir, file.relPath)).exists(),
							})),
						);
						done({ sources });
					} catch (err) {
						fail(`get_agent_prompt_sources failed: ${err instanceof Error ? err.message : String(err)}`);
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
				"set_model_temporary",
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
				// 带回的结果以 custom message 直接落进会话状态（`sendCustomMessage` 不发事件），
				// 不显式推快照的话客户端要等下一次无关的变更才看得到它。
				"bring_back_child_result",
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
					/**
					 * 带 `projectId` = 在**那个 Project 的工作根**上开一个会话：归属解析与装配都在 registry 里
					 * （`registry.attach(agentId, projectId)` 问 resolver 取根）。解析失败（未声明的 id /
					 * Project 注册表读不出来 / agentDir 声明坏）在那里抛，**一个会话都不建** ——
					 * 这里不自己解析一遍，也不许落回启动根：那会造出一个「声称在 Project 里、实际不在」的会话。
					 */
					if (command.projectId !== undefined) {
						if (command.parentSession !== undefined) {
							// 新附件由工厂装配，没地方安放 parentSession；静默丢掉一条父链就是一句假话。
							fail("new_session 暂不支持同时指定 projectId 与 parentSession");
							break;
						}
						let bound: AttachedSession;
						try {
							bound = await registry.attach(agentId, command.projectId);
						} catch (err) {
							// 原话给前端（resolver 的报错说清了是哪个 id / 哪个文件）。
							fail(err instanceof Error ? err.message : String(err));
							break;
						}
						// 焦点跟到那个附件的**地址**（读它的，不拼）：调用方要的就是这个 Project 上的会话。
						ctx.setActiveAgentId(bound.address);
						// 刚装配的附件里的会话就是这次新开出来的那个；本来就在这个附件上（同一个对象）则按今天
						// 的语义再开一个新会话文件 —— 否则回一个「建好了」而盘上什么都没多。
						const created = bound === attached ? await bound.session.newSession() : true;
						sessionDone({ cancelled: !created });
						break;
					}
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
					// W3 D5 + P2-W3-3 + T10B：只读列出技能，并带上 scope / 来源 / 版本 / 激活 / 错误五个事实。
					// 全部来自既有事实源：session.skills（本次会话真的加载了）、session.settings（停用名单）、
					// session.skillWarnings（发现错误）、agent-scope（范围判定的三个根）。
					// 停用名单读的是**这个 agent 自己的** settings（registry agent 各有一份；旧实现读全局实例，
					// 会把 default agent 的名单当成人家的）。
					const anchor = await resolveAgentScope({ agentId, meta: attached.meta, attached });
					const facts: SkillScopeAnchor = {
						agentId: anchor.agentId,
						agentDir: anchor.agentDir,
						sessionCwd: anchor.sessionCwd,
					};
					if (anchor.project) facts.projectRoot = anchor.project.root;
					const loaded = await projectLoadedSkills(facts, session.skills);
					const disabled = await projectDisabledSkills(
						facts,
						collectDisabledInputs(
							session.settings.get("skills.ignoredSkills") ?? [],
							session.settings.get("disabledExtensions") ?? [],
						),
					);
					const warnings = splitSkillWarnings(session.skillWarnings);
					done({
						skills: loaded.rows,
						disabled,
						blocked: warnings.blocked,
						errors: [...loaded.errors, ...warnings.errors],
						scope: {
							agentId: anchor.agentId,
							agentDir: anchor.agentDir,
							sessionCwd: anchor.sessionCwd,
							projectRoot: anchor.project?.root ?? null,
							projectError: anchor.projectError ?? null,
						},
					});
					break;
				}
				case "set_skill_enabled": {
					// P2-W3-3（B3 技能写协议）：写 settings（config.yml skills.ignoredSkills）+ 重发现热重载。
					// T10B：写**焦点 agent 自己的** settings 与它的会话根 —— 旧实现用全局 Settings.instance +
					// process.cwd()，对 registry agent 会把停用名单写进 default agent 的 config.yml，
					// 并把 serve 项目根的技能重新热加载进人家的会话（写错人 + 拿错范围）。
					const skillName = command.name.trim();
					if (!skillName || skillName.includes("/") || skillName.includes("\\")) {
						failWithCode("internal", `invalid skill name: ${String(command.name)}`);
						break;
					}
					try {
						const settings = session.settings;
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
						// 发现根由 (cwd, home) 决定：registry agent 的会话根 = 它的 agentDir，所以它的
						// `.cornfield/skills`（project 级）会被扫到；`~/.cornfield/agent/skills`（loader 的
						// user 级根）仍然是共享用户库，不是这个 agent 私有的。
						const anchor = await resolveAgentScope({ agentId, meta: attached.meta, attached });
						const result = await discoverSkills(anchor.sessionCwd, anchor.agentDir, {
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
					// 工具开关语义视图：读**本会话自己的 Settings 合并视图**（project 压 global，未配置项
					// 回落内核默认）。与 set_config 写的是同一层——显示的就是生效的那份。
					try {
						const agentSettings = session.settings;
						done({
							tools: TOOL_SWITCH_DEFS.map(({ tool, label, path }) => ({
								tool,
								label,
								path,
								enabled: agentSettings.get(path) === true,
							})),
							pythonToolMode: agentSettings.get("python.toolMode"),
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
					// P3 真实现：返回目标 session 的可用模型全量列表（按**该 agent 自己的**
					// disabledProviders / disabledModels 过滤后），并随响应带两份停用名单——前端
					// 「已停用」分区恢复入口。列表与名单取自同一个 Settings 实例（会话自己的那份）：
					// 读全局单例会让一个 agent 的停用名单对所有 agent 生效。
					const agentSettings = session.settings;
					done({
						models: session.getAvailableModels(),
						disabledProviders: agentSettings.get("disabledProviders") ?? [],
						disabledModels: agentSettings.get("disabledModels") ?? [],
					});
					break;
				}
				case "set_model_disabled": {
					// W3 模型禁用写协议（pi-wire）：provider 级写 disabledProviders，模型级
					// 写 disabledModels（`provider/modelId` 精确 pattern）。settings 是活引用——
					// isModelAvailable 每调用都读当前值，无需重载注册表即生效；落点跟随读侧优先级
					// 持久化到 yml。写的是**目标 agent 自己的**那份（旧实现用全局 Settings.instance，
					// 会把停用名单写进 default agent 的 config.yml —— 写错人 + 读侧读不到）。
					const currentSettings = session.settings;
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

				// ── 模型控制中心（#02 全量目录 / #03 Provider 接入）──
				// handler 全部在 AgentSession（session.modelRegistry/authStorage/settings 共享
				// 链路）；响应不回显明文密钥，apiKey/code 只进写命令请求载荷。
				case "get_model_catalog": {
					try {
						done(await session.buildModelCatalog());
					} catch (err) {
						fail(`get_model_catalog failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "get_model_selection": {
					// #05 模型选择读侧：session.source 标记 temporary/persistent/registry-default；
					// persistedDefault 独立给出持久化层取值（settings.modelRoles.default，可带 thinking 后缀）。
					const current = session.model;
					const persistedRaw = session.settings.getModelRole("default");
					const persisted = persistedRaw ? parseModelString(persistedRaw) : undefined;
					const source: ModelSelectionDto["session"]["source"] = !persisted
						? "registry-default"
						: current && persisted.provider === current.provider && persisted.id === current.id
							? "persistent"
							: "temporary";
					if (current) {
						done({
							session: { provider: current.provider, modelId: current.id, source },
							persistedDefault: persisted ? { provider: persisted.provider, modelId: persisted.id } : null,
						});
					} else if (persisted) {
						// 尚无会话模型（模型解析失败的启动边态）：回落持久化默认
						done({
							session: { provider: persisted.provider, modelId: persisted.id, source: "persistent" },
							persistedDefault: { provider: persisted.provider, modelId: persisted.id },
						});
					} else {
						fail("no model selected: session has no model and no persisted default");
					}
					break;
				}
				case "get_providers": {
					try {
						done(await session.listProviders());
					} catch (err) {
						fail(`get_providers failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "get_provider": {
					try {
						done(await session.getProviderStatus(command.providerId));
					} catch (err) {
						fail(`get_provider failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "start_provider_oauth": {
					try {
						done(await session.startProviderOauth(command.providerId));
					} catch (err) {
						fail(`start_provider_oauth failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "complete_provider_oauth": {
					try {
						done(await session.completeProviderOauth(command.providerId, command.code ?? ""));
					} catch (err) {
						fail(`complete_provider_oauth failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "save_provider_api_key": {
					try {
						done(await session.saveProviderApiKey(command.providerId, command.apiKey));
					} catch (err) {
						fail(`save_provider_api_key failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "delete_provider_api_key": {
					try {
						done(await session.deleteProviderApiKey(command.providerId));
					} catch (err) {
						fail(`delete_provider_api_key failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "set_provider_base_url": {
					try {
						done(await session.setProviderBaseUrl(command.providerId, command.baseUrl));
					} catch (err) {
						fail(`set_provider_base_url failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "disconnect_provider": {
					try {
						// 依赖检查结果是命令的正常结果（ok:true + disconnected:false），不走错误通道
						done(await session.disconnectProvider(command.providerId, command.force ?? false));
					} catch (err) {
						fail(`disconnect_provider failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "refresh_provider": {
					try {
						done(await session.refreshProviderCatalog(command.providerId));
					} catch (err) {
						fail(`refresh_provider failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "refresh_catalog": {
					try {
						// #04 全量刷新：单 provider 失败不抛——错误在返回目录的 providers[].refreshError/stale 里
						done(await session.refreshFullCatalog());
					} catch (err) {
						fail(`refresh_catalog failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "test_model": {
					try {
						// #04 连通性测试：真实调用（可能产生费用，UI 已确认）；结果六类 outcome，不伪装成功
						done(await session.testModel(command.providerId, command.modelId));
					} catch (err) {
						fail(`test_model failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}

				// ── Thinking ──
				case "set_thinking_level": {
					// persist 缺省 = 只改本次会话（P1 行为不变）；persist:true 时内核把生效档位写进目标
					// agent 的 <agentDir>/config.yml（defaultThinkingLevel），所以「看板上选的档位」重启后还在。
					session.setThinkingLevel(command.level, command.persist === true);
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

				// ── Session Tree（T8）：父会话对被委派子会话的账本读取与结果带回 ──
				case "get_session_tree": {
					try {
						done(await readSessionTree(session, attached.meta));
					} catch (err) {
						fail(`get_session_tree failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				// 会话树唯一的写入口：真的起一个子会话。目标 Agent 只查注册表（不 lazy attach）——
				// 委派出的是一个独立子进程，不是把对方 Agent 的会话在本进程里拉起来。
				case "delegate_child": {
					try {
						done(
							await delegateChildSession(session, attached.meta, command, {
								resolveAgent: agentId => registry.getMeta(agentId),
							}),
						);
					} catch (err) {
						fail(`delegate_child failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					break;
				}
				case "bring_back_child_result": {
					try {
						done(await bringBackChildResult(session, attached.meta, command.childSessionId));
					} catch (err) {
						fail(`bring_back_child_result failed: ${err instanceof Error ? err.message : String(err)}`);
					}
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
					// 乐观并发（CAS）：客户端带上读到时的 `expectedVersion`，盘上现状不同就拒写，
					// 而不是默默覆盖外部写入者（比如 agent 自己）的改动。
					// 冲突报错走现有 `error: string` 通道，以 `fs_conflict: ` 前缀作为客户端契约——
					// WireErrorCode 定义在 packages/pi-wire（本票范围外），所以不新增错误码。
					const cmd = command as { path: string; content: string; expectedVersion?: string };
					if (typeof cmd.content !== "string") {
						fail("content required (string)");
						break;
					}
					const agentDir = registry.getMeta(agentId)?.agentDir ?? session.sessionManager.getCwd();
					const target = await resolveFsTarget({ agentDir, session, path: cmd.path });
					if (!target.ok) {
						fail(target.error);
						break;
					}
					const bytesWritten = Buffer.byteLength(cmd.content, "utf8");
					if (bytesWritten > FS_MAX_WRITE_BYTES) {
						fail(`content too large: ${bytesWritten} bytes exceeds limit of ${FS_MAX_WRITE_BYTES} bytes`);
						break;
					}
					try {
						if (cmd.expectedVersion !== undefined) {
							const currentVersion = await contentVersionOfFile(target.path);
							if (currentVersion !== cmd.expectedVersion) {
								fail(`fs_conflict: expected ${cmd.expectedVersion}, actual ${currentVersion}`);
								break;
							}
						}
						const toolSession = toWireToolSession(session, agentDir);
						const sentVersion = contentVersionOf(new TextEncoder().encode(cmd.content));
						await createWireWritethrough(toolSession)(target.path, cmd.content);
						invalidateFsScanAfterWrite(target.path);
						// 回读再算版本：writethrough 可能格式化后落盘，`cmd.content` 的哈希未必等于盘上字节。
						const version = await contentVersionOfFile(target.path);
						// 落盘内容被改写（lsp.formatOnWrite 等）时必须说出来，不能报成「写的就是你发的那份」：
						// 客户端据此把编辑器同步成盘上的那一份，否则「已保存」显示的是发出去的样子而不是文件现在的样子。
						done({ path: cmd.path, bytesWritten, version, normalized: version !== sentVersion });
					} catch (err) {
						fail(err instanceof Error ? err.message : String(err));
					}
					break;
				}
				case "fs_edit": {
					const cmd = command as { path: string; mode?: EditMode; edits?: unknown[]; input?: string };
					const agentDir = registry.getMeta(agentId)?.agentDir ?? session.sessionManager.getCwd();
					const target = await resolveFsTarget({ agentDir, session, path: cmd.path });
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
							const target = await resolveFsTarget({ agentDir, session, path: cmd.path });
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
				// 客户端（浏览器）读不到 env，代它把 gateway 的 wire 端口报过去：与下面 callGatewayWire
				// 用的是同一个值。不报的话前端只能自己猜 7892 —— 隔离环境里那会连到真实 gateway。
				gatewayWirePort: GATEWAY_WIRE_PORT,
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

	/**
	 * `/preview/<agentId>/<rel>` 的边界判定与应答。
	 *
	 * 与 `fs_read` 同一条边界（同一个 resolver 给的 roots）——只读站点不另写一份判定，
	 * 否则「浏览器能看到的」与「fs_read 能读到的」会各算各的。已 attach 的会话用它记录/匹配出来的
	 * 工作面；没有会话时手上只有 agentDir 这一个事实（与今天一致）。
	 */
	const servePreviewTarget = async (agentId: string, rel: string): Promise<Response> => {
		// URL 里那一段既可以是 Agent 名（今天的形状），也可以是**附件地址**（客户端手上就有）。
		// 给了地址时边界 = 那个附件的工作面 —— 绑了 Project 的产物因此点得开，而不是拿 agentDir 拒掉。
		const attached = attachmentFor(registry, agentId);
		const meta = attached?.meta ?? registry.getMeta(agentId);
		if (!meta) return new Response("unknown agent", { status: 404 });
		const target = await resolveFsTarget({
			agentDir: meta.agentDir,
			session: attached?.session,
			path: rel,
		});
		if (!target.ok) return new Response(target.error, { status: 400 });
		return servePreviewFile(target.path);
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
			// R-ARTIFACTS 静态预览：/preview/<agentId>/<relpath>（会话工作面当 docroot，只读）。
			// 第一段也可以是**附件地址**（客户端手上就有，绑了 Project 的产物因此点得开）。
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
				// 边界的判定是异步的（归属 + realpath），只在这一支上返回 Promise：
				// `fetch` 本身（以及 /ws 升级那条 `return undefined` 的路）保持同步。
				return servePreviewTarget(agentId, rel);
			}
			// VOICE-D 听记音频回放：/listen-audio/<file>（listen/audio 目录内，只读，仅 .wav）。
			// token 校验同 /preview（空 token 本地免鉴权）。
			if (url.pathname.startsWith("/listen-audio/")) {
				if (token !== "" && url.searchParams.get("token") !== token)
					return new Response("unauthorized", { status: 401 });
				const file = decodeURIComponent(url.pathname.slice("/listen-audio/".length));
				// 拒绝路径穿越（不限制字符集——录音文件名含任意 Unicode）；剩余部分仅作 docroot 内相对名
				if (!file || file.includes("/") || file.includes("\\") || file.includes(".."))
					return new Response("bad request", { status: 400 });
				if (!file.endsWith(".wav")) return new Response("bad request", { status: 400 });
				return serveListenAudioFile(path.join(getListenDir(), "audio", file));
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

	// 启动即预挂载所有注册 agent（与 gateway bridge 常驻语义对齐）——挪到 listening 之后后台执行：
	// 不阻塞 serve 就绪（桌面客户端「打开即连接」的关键）；列表仍立即完整（metas 只读加载），
	// 每个 attach 完成后经 registry attached 事件自动广播 server_snapshot；实例化失败仅告警。
	void Promise.allSettled(
		registry
			.listMetas()
			.filter(meta => meta.id !== "default")
			.map(async meta => {
				try {
					await registry.attach(meta.id);
				} catch (err) {
					logger.warn("serve:preload attach failed", { agentId: meta.id, error: String(err) });
				}
			}),
	);

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

/**
 * 单次 fs_read 的磁盘字节预算（128KiB）。
 *
 * 比较对象是**文件在磁盘上的字节数**，不是解码后的字符数：多字节文本（中文 3B/字、
 * emoji 4B/字）按字符判会让超标文件报 `truncated:false`，从而把「只读降级」关掉。
 */
const FS_MAX_READ_BYTES = 128 * 1024;

/**
 * 单次整段写入正文的内存上限（8 MiB）。
 *
 * 与只读侧的 {@link FS_MAX_READ_BYTES} 是两件事，互不推导：读侧超预算就裁剪并标记 truncated
 * （拿得到一份不完整的预览），写侧超上限就整体拒写（一份不完整的正文不该落盘）。
 * 两者都以磁盘/载荷的 **UTF-8 字节**为准。
 */
const FS_MAX_WRITE_BYTES = 8 * 1024 * 1024;

/** 文件内容身份令牌：整体字节的 sha256 十六进制。『读到的东西』与『要写回去的东西』是否同一份，靠它判定。 */
function contentVersionOf(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** 盘上文件的当前内容身份令牌。文件不存在 = 空基线（""），客户端据此以 CAS 语义创建新文件。 */
async function contentVersionOfFile(file: string): Promise<string> {
	try {
		return contentVersionOf(await Bun.file(file).bytes());
	} catch (err) {
		if (isEnoent(err)) return "";
		throw err;
	}
}

/**
 * 会话工作面锚点（Project 归属 + 在力的 roots）。
 *
 * 判定只有一处 —— `./session-workspace` 的 `resolveSessionWorkspace`（本模块不再写一份）：
 * `header.projectId` 权威 → 会话 cwd 匹配 Project 注册表（旧会话回落）→ 没声明就是没声明。
 * 已 attach 的会话把 header 与当前 cwd 一起递进去；没有会话（未 attach 的 agent）时手上只有
 * agentDir 这一个事实，resolver 因此不会凭一条谁都没记过的路径编出归属。
 *
 * 读不出来（Project 注册表坏、workspace 声明读不出来）→ 原样抛，由调用方回 ok:false。
 * **不**降级成「没声明过」：那会把一个归属未知的会话交给 agentDir 去跑，正是 resolver 拒的那种降级。
 */
async function resolveWorkspaceAnchor(input: {
	agentDir: string;
	session: AgentSession | undefined;
}): Promise<ResolvedSessionWorkspace> {
	const manager = input.session?.sessionManager;
	return resolveSessionWorkspace(
		manager ? { agentDir: input.agentDir, session: manager } : { agentDir: input.agentDir },
	);
}

/**
 * 文件面的一条相对路径 → 落在哪个根里。
 *
 * 边界是会话的 roots（Project root + agentDir 声明的 attachedRoots + agentDir），不是「agentDir 之内」，
 * 也不是任意路径。两条判定一条都不能少：
 *   1. 词法落点：`..` 逃逸与绝对逃逸在这一步就被拒（`path.resolve` 之后必须落在某个根里）；
 *   2. symlink 落点：realpath 归一之后仍要在**同一个**根里 —— 目标还不存在时（fs_write 新建）
 *      归一不了，改判它**最近的已存在条目**；否则 `agentDir/link -> /outside` 下的 `link/new.txt`
 *      会拿词法路径蒙混过关。
 *
 * 多个根都能容纳同一条相对路径时，取**第一个真的存在**的候选：产物路径相对它所属的那个根命名，
 * 挨个根试一遍才读得回同一个文件；一个都不存在（新建）时取第一个根 —— 写入目标必须是确定的。
 */
async function resolveWithinRoots(
	roots: readonly string[],
	rel: string,
): Promise<{ ok: true; path: string; root: string } | { ok: false; error: string }> {
	const candidates: { path: string; root: string }[] = [];
	for (const root of roots) {
		const candidate = path.resolve(root, rel);
		if (isUnderLexically(root, candidate)) candidates.push({ path: candidate, root });
	}
	if (candidates.length === 0) return { ok: false, error: `path escapes the session workspace: ${rel}` };

	let chosen = candidates[0];
	for (const candidate of candidates) {
		if (await entryExists(candidate.path)) {
			chosen = candidate;
			break;
		}
	}
	if (!(await isWithinRealPath(chosen.root, chosen.path))) {
		return { ok: false, error: `path escapes the session workspace: ${rel}` };
	}
	return { ok: true, path: chosen.path, root: chosen.root };
}

/** 词法落点：`..` 与绝对逃逸在这里被拒（不看盘，symlink 判定在下一步）。 */
function isUnderLexically(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 条目存在（`lstat`：悬空 symlink 也算存在 —— 它的真实落点是链接目标）。 */
async function entryExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/**
 * 真实落点是否还在根里。
 *
 * 判的是「目标自己，或者它最近的已存在条目」的 realpath：新建文件还没有 realpath，但它的父目录
 * 可能正是那个指向外部的 symlink。`pathIsWithin` 负责归一（含 symlink 的每一段）。
 */
async function isWithinRealPath(root: string, candidate: string): Promise<boolean> {
	const entry = (await nearestExistingEntry(candidate)) ?? candidate;
	return pathIsWithin(root, await realTargetOf(entry));
}

/** 从目标自己往上找到第一个存在的条目（到文件系统根为止）。 */
async function nearestExistingEntry(target: string): Promise<string | undefined> {
	let current = target;
	for (;;) {
		if (await entryExists(current)) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * 条目的真实落点。`realpath` 走不通时退一步：悬空 symlink 写的是**它的目标**，
 * 所以按链接目标解析（按「不存在」处理会把一次越界写读成一次新建）；真的什么都没有才用它自己的位置。
 */
async function realTargetOf(entry: string): Promise<string> {
	try {
		return await fs.realpath(entry);
	} catch (err) {
		if (!isEnoent(err)) throw err;
		try {
			return path.resolve(path.dirname(entry), await fs.readlink(entry));
		} catch (linkErr) {
			if (isEnoent(linkErr)) return entry;
			throw linkErr;
		}
	}
}

/**
 * 文件面目标的唯一入口：问出会话的工作面，再把相对路径落到某个根里。
 * 归属解析失败（Project 注册表坏、workspace 声明读不出来、会话记着一个注册表没有的 Project）
 * 一律 ok:false —— 文件面不替调用方猜一个根。
 */
async function resolveFsTarget(input: {
	agentDir: string;
	session: AgentSession | undefined;
	path: string;
}): Promise<{ ok: true; path: string; root: string } | { ok: false; error: string }> {
	const anchor = await workspaceAnchorOf(input);
	if (!anchor.ok) return anchor;
	return resolveWithinRoots(anchor.workspace.roots, input.path);
}

/**
 * 归属解析的失败通道：读不出来就是读不出来 —— 调用方回 ok:false，
 * 不拿 agentDir 冒充（那会把「归属未知」渲染成「这个会话就属于这儿」）。
 */
async function workspaceAnchorOf(input: {
	agentDir: string;
	session: AgentSession | undefined;
}): Promise<{ ok: true; workspace: ResolvedSessionWorkspace } | { ok: false; error: string }> {
	try {
		return { ok: true, workspace: await resolveWorkspaceAnchor(input) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 会话**工作**在哪个根上：git 面的锚。
 *
 * 绑定了 Project 就是它的 root；没绑定就是身份根 agentDir —— 与今天逐字节一致，且**不**因为
 * agentDir 声明了 attachedRoots 就换一个工作根（那是额外的读写面，不是「这个会话在哪儿干活」）。
 * 归属读不出来 → ok:false：拿另一个根去读 git 就是把别人的仓库当成这个会话的。
 */
async function resolveWorkRoot(input: {
	agentDir: string;
	session: AgentSession | undefined;
}): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
	const anchor = await workspaceAnchorOf(input);
	if (!anchor.ok) return anchor;
	return { ok: true, root: anchor.workspace.projectRoot ?? anchor.workspace.agentDir };
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

/**
 * 读文本文件，磁盘字节 > {@link FS_MAX_READ_BYTES} 就截断并标记 `truncated`。
 *
 * 判定按**原始字节**，不按解码后的 `text.length`：常量名就是 BYTES，而「这份内容还全不全」
 * 是磁盘上的事实。按字符数判会让多字节文本（中文/emoji）超出很多字节仍然报 `truncated:false`
 * —— 一个 300KiB 的中文文件会被当成「读全了」，下游（编辑器）就会拿半份内容去写回，
 * 把文件真的截断。
 *
 * 截断是 UTF-8 安全的：`stream: true` 让解码器把边界上被切开的多字节序列留在缓冲里丢掉，
 * 而不是吐一个 U+FFFD —— 截断是「少一截」，不是「改一个字」。
 *
 * 字节只读一次：`text` 是裁剪后的内容，`version` 覆盖整份文件的原始字节——
 * 因此对超限文件只改尾部（裁剪区之外）也能被写侧 CAS 发现。
 */
async function readTextFileClipped(
	file: string,
): Promise<
	| { text: string; truncated: boolean; version: string; error?: undefined }
	| { text?: undefined; truncated?: undefined; version?: undefined; error: string }
> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(file).bytes();
	} catch (err) {
		if (isEnoent(err)) return { error: `no such file: ${path.basename(file)}` };
		throw err;
	}
	const version = contentVersionOf(bytes);
	if (bytes.byteLength <= FS_MAX_READ_BYTES) {
		return { text: new TextDecoder("utf-8").decode(bytes), truncated: false, version };
	}
	const clipped = new TextDecoder("utf-8").decode(bytes.subarray(0, FS_MAX_READ_BYTES), { stream: true });
	return { text: clipped, truncated: true, version };
}

// ── P2-4：cron/gateway 命令转发 gateway 生产端点（POST /wire）──
//
// serve 不再直读 jobs.json / gateway.status.json——gateway 是调度器主人，直接回答
// 自己领域。gateway 未运行（端点不可达）时返回明确错误（旧客户端可见原因）。
// 形状与旧直读代理一致（TaskRowDto / CronLogEntryDto / GatewayStatusDto），
// 因此 web-app 消费方无需改动。

const GATEWAY_WIRE_PORT = Number.parseInt(process.env.CORNFIELD_GATEWAY_WIRE_PORT ?? "7892", 10);

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

/** 安装根目录：~/.cornfield/agent/skills（与 native skills 发现一致：skills/<name>/SKILL.md）。 */
function remoteSkillsDir(): string {
	return path.join(getClientDir(), "skills");
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
 * 安装一个远程 skill/plugin：resolve 条目的实际 source 目录后拷到 ~/.cornfield/agent/skills/<name>。
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

// ── MCP 服务器管理（读写 ~/.cornfield/agent/mcp.json + stdio 连通性测试）──

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
	return path.join(getClientDir(), "mcp.json");
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

/** 只读静态预览（/preview 路由）：会话工作面内的文件 → Response。不存在 → 404。 */
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

/** 听记音频回放（/listen-audio 路由）：listen/audio 内 .wav → Response。不存在 → 404。 */
async function serveListenAudioFile(filePath: string): Promise<Response> {
	try {
		const f = Bun.file(filePath);
		const stat = await f.stat();
		if (!stat.isFile()) return new Response("not a file", { status: 404 });
		return new Response(f, {
			headers: { "content-type": "audio/wav", "cache-control": "no-store" },
		});
	} catch (err) {
		if (isEnoent(err)) return new Response("not found", { status: 404 });
		logger.warn("serve:listen-audio-read-failed", { file: filePath, error: String(err) });
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

// ═══════════════════════════════════════════════════════════════════════
// fs 写 / git 最小集 / 配置（票 01+02+03）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 从 AgentSession 构造写/编辑所需的 ToolSession 适配。
 *
 * cwd 仍锚 agentDir —— 那是**写/编辑工具上下文**的装配面（会话在哪儿干活由 serve 的
 * sessionFactory 决定，见 `commands/serve.ts` 的 sessionFactory）。被写的**路径**不走它，
 * 走会话的工作面（`resolveFsTarget` / `resolveWithinRoots`）。
 */
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

/** 删除指定路径的键（#05 恢复继承）；父对象空了则逐级剪枝。返回是否实际删除。 */
function configDeleteByPath(obj: Record<string, unknown>, segments: string[]): boolean {
	const stack: Array<{ parent: Record<string, unknown>; segment: string }> = [];
	let current: unknown = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (current === null || typeof current !== "object") return false;
		const parent = current as Record<string, unknown>;
		if (!(segment in parent)) return false;
		stack.push({ parent, segment });
		current = parent[segment];
	}
	if (current === null || typeof current !== "object") return false;
	const leaf = current as Record<string, unknown>;
	const last = segments[segments.length - 1];
	if (!(last in leaf)) return false;
	delete leaf[last];
	for (let i = stack.length - 1; i >= 0; i--) {
		const { parent, segment } = stack[i];
		const child = parent[segment];
		if (typeof child === "object" && child !== null && !Array.isArray(child) && Object.keys(child).length === 0) {
			delete parent[segment];
		} else {
			break;
		}
	}
	return true;
}

/** #05 effectiveValue：project 覆盖在 global 之上（与 Settings#deepMerge 同语义：
 * 两侧都是普通对象时递归合并，否则 project 胜出）。 */
function configMergeValues(globalValue: unknown, projectValue: unknown): unknown {
	if (projectValue === undefined) return globalValue;
	if (
		typeof projectValue === "object" &&
		projectValue !== null &&
		!Array.isArray(projectValue) &&
		typeof globalValue === "object" &&
		globalValue !== null &&
		!Array.isArray(globalValue)
	) {
		const merged: Record<string, unknown> = { ...(globalValue as Record<string, unknown>) };
		for (const [key, value] of Object.entries(projectValue as Record<string, unknown>)) {
			merged[key] = configMergeValues((globalValue as Record<string, unknown>)[key], value);
		}
		return merged;
	}
	return projectValue;
}
