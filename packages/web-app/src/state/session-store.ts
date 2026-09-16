import type {
	AgentInfoDto,
	AvailableModelsDto,
	BroughtBackChildResultDto,
	ConfigInheritanceRestoreDto,
	ConfigScopeDto,
	CronCreateInput,
	CronLogEntryDto,
	CronRemoveResultDto,
	CronTaskWriteResultDto,
	CronTestRunResultDto,
	CronUpdateInput,
	DashboardStatsDto,
	DiagnosisAggregationDto,
	EnvironmentSummaryDto,
	HostToolDefinitionDto,
	ImageContentDto,
	MemoryProjectionDto,
	MessageContentDto,
	MessageDto,
	ModelCatalogDto,
	ModelSelectionDto,
	ModelTestResultDto,
	PermissionRequestDto,
	ProgressEventDto,
	ProjectRecordDto,
	ProviderDisconnectResultDto,
	ProviderListDto,
	ProviderOAuthStartDto,
	ProviderStatusDto,
	SessionPhaseDto,
	SessionSnapshotDto,
	SessionTreeDto,
	SkillsResultDto,
	StatsPeriodDto,
	TaskRowDto,
	TodoPhaseDto,
	ToolSwitchesDto,
	WireServerEventDto,
} from "@cornfield/wire";
import { loadNotifyPrefs, notifyGuarded } from "../lib/notifications";
import type {
	AgentTodoDto,
	ArtifactDto,
	FsEntryDto,
	GatewayAccountPatchDto,
	GatewayStatusDto,
	ListenRecordingDto,
	McpServerDto,
	PiClient,
	RemoteSkillItemDto,
} from "../lib/pi-client-api";
import type { BranchPoint, PlaybackEntry, SessionRecordSummary } from "../lib/records";
import { createClient } from "./client";
import { type ServeConnectionConfig, saveServeConfig } from "./pi-client-adapter";

/** 渲染层工具卡状态（三态 + 参数/结果）。 */
export interface ToolView {
	id: string;
	name: string;
	argsText: string;
	intent?: string;
	state: "run" | "done" | "fail";
	result?: string;
	durationMs?: number;
}

/** 渲染层消息（由快照权威内容 + progress 瞬态增量归并而成）。 */
export interface TranscriptMessage {
	id: string;
	role: "user" | "assistant";
	model?: string;
	/** thinking 全文（瞬态层流式追加；快照到达后以权威内容覆盖）。 */
	thinking?: string;
	thinkingStreaming?: boolean;
	text?: string;
	textStreaming?: boolean;
	tools: ToolView[];
	done: boolean;
	error?: string;
}

/** 会话渲染视图 —— useSession() 的稳定快照。 */
export interface SessionView {
	connected: boolean;
	reconnecting: boolean;
	connectionId?: string;
	wsUrl: string;
	protocolVersion: number;
	phase: SessionPhaseDto;
	model: string | null;
	thinkingLevel: string | null;
	sessionId: string;
	sessionName?: string;
	/** 当前会话 JSONL 绝对路径（快照带出；产物 tab 按会话隔离视图用）。 */
	sessionFile?: string;
	/** 已落库消息。 */
	messages: TranscriptMessage[];
	/** messageId → session entryId（消息级 undo/fork/retry 定位）。 */
	messageEntryIds: Record<string, string>;
	/** 流式中的在途 assistant 消息（progress 瞬态层，快照到达即被权威替换）。 */
	live?: TranscriptMessage;
	isStreaming: boolean;
	activeToolNames: string[];
	queued: number;
	/** steer 回显文本（协议批 B-1；turn_end/agent_end 清空）。 */
	steer?: string;
	todo: TodoPhaseDto[];
	context?: { usedTokens: number; totalTokens: number; percent: number; lastCompaction: number | null };
	flags: { autoCompaction: boolean; autoRetry: boolean };
	agents: AgentInfoDto[];
	env: EnvironmentSummaryDto | null;
	/** 本连接当前焦点 agent 的 registry id（switchSession/openHistorySession 时记录）。 */
	activeAgentId?: string;
	/** 当前焦点会话/agent 的工作目录短名（cli 会话 = 其打开目录，agent 会话 = agentDir）。 */
	activeWorkspace?: string;
	/** 最近一次命令失败的可见错误（未连接等），成功或清空后为 undefined。 */
	commandError?: string;
	/** 待用户裁决的审批/澄清请求（permission_request push）。 */
	pendingPermission?: PermissionRequestDto;
	/** 历史会话回放：加载中（sidebar 点击会话行触发 get_session_messages）。 */
	historyLoading: boolean;
	/** 历史会话回放：失败错误文本（非空 = 加载失败，UI 可见）。 */
	historyError?: string;
	/**
	 * 当前会话直接委派出去的子会话（get_session_tree）。
	 * `undefined` = 还没查过；`[]` = 查了，确实没有委派 —— 两者不能当成同一件事。
	 */
	sessionTree?: SessionTreeDto;
	/** 会话树查询中。 */
	sessionTreeLoading: boolean;
	/** 会话树查不到的原因（读失败 ≠ 没有子会话，面板必须分开显示）。 */
	sessionTreeError?: string;
	/**
	 * 已声明的 Project（list_projects）。`undefined` = 还没读到；`[]` = 读到了，确实没声明过。
	 */
	projects?: ProjectRecordDto[];
	/** 被查询会话落在哪个 Project（serve 按 WP4 的 root 规则算）；缺省 = 没有归属。 */
	currentProjectId?: string;
	/**
	 * 当前会话的 Project 归属还没算出来（切会话后的窗口期，或还没读过）。
	 *
	 * 与「未归属」必须分开：切会话时归属会被作废，在重算结果回来之前我们**不知道**它属于谁；
	 * 把它渲染成「未归属」就是替一个尚未计算的答案发言。
	 */
	projectsPending: boolean;
	/** Project 读不到的原因（存储损坏）。读失败 ≠ 没声明过。 */
	projectsError?: string;
	/**
	 * 当前焦点 Agent 的 Todo 板（list_agent_todos）。
	 * `undefined` = 还没读到；`[]` = 读到了，**确实是空的** —— 两者不能当成同一件事。
	 */
	agentTodos?: AgentTodoDto[];
	/** 该 Agent 声明过的 Project 绑定（写面的上限）。缺省 = 未约束，不是「一个都不能绑」。 */
	agentTodoProjectIds?: string[];
	/** 板子还没读出来（切 Agent 后的窗口期 / 还没读过）。 */
	agentTodosPending: boolean;
	/** 板子读不到的原因（存储损坏 / 版本不符）。读失败 ≠ 没有任务。 */
	agentTodosError?: string;
}

/** B7-1：回合收尾通知——有错误消息走出错告警（errors 开关），否则走完成（agentDone 开关）。 */
function maybeNotifyTurnEnd(view: SessionView): void {
	try {
		const prefs = loadNotifyPrefs();
		const lastMsg = view.live ?? view.messages[view.messages.length - 1];
		if (lastMsg?.error) {
			if (!prefs.errors) return;
			void notifyGuarded("出错告警 · Agent 回合", lastMsg.error.slice(0, 120), "cornfield-notify-errors");
			return;
		}
		if (!prefs.agentDone) return;
		const reply = (lastMsg?.text ?? "").trim();
		void notifyGuarded("Agent 完成", reply ? reply.slice(0, 80) : "回合已结束", "cornfield-notify-done");
	} catch {
		// 通知失败静默——前台本就该静默
	}
}

const EMPTY_PHASE: SessionPhaseDto = "idle";

function cloneView(v: SessionView): SessionView {
	return {
		...v,
		messages: v.messages.map(m => ({ ...m, tools: m.tools.map(t => ({ ...t })) })),
		live: v.live ? { ...v.live, tools: v.live.tools.map(t => ({ ...t })) } : undefined,
		todo: v.todo.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) })),
	};
}

/**
 * SessionStore —— 单例。快照权威（缓存）+ progress 瞬态（打字机）两层：
 * - session_snapshot 到达 → 缓存更新，瞬态层清空，视图整体重建（权威）
 * - progress 到达 → 仅作用在瞬态层（视图克隆上增量），绝不移入缓存
 * 与 pi-wire「progress 不得归约为状态」语义一致。
 * 类本身导出供测试直接实例化（单例导出见文件底部）。
 */
export class SessionStore {
	#client!: PiClient;
	#view: SessionView | null = null;
	#listeners = new Set<() => void>();
	/** 本连接当前焦点 agent（switchSession/openHistorySession 记录；serve 启动焦点 = default）。 */
	#activeAgentId: string | null = null;
	/** 当前焦点会话/agent 的工作目录短名（cli 会话 = 其打开目录，agent 会话 = agentDir）。 */
	#activeWorkspace: string | undefined;
	/** 会话树属于一个会话：换会话就地作废，绝不让上一个会话的子树留在视图里。 */
	#sessionTree: SessionTreeDto | undefined;
	#sessionTreeLoading = false;
	#sessionTreeError: string | undefined;
	/**
	 * 已声明的 Project。**不随会话变**（客户端 scope 的 registry，跨 Agent 共享），
	 * 所以切会话不清空、不重读；只有归属 `#currentProjectId` 是会话级的。
	 */
	#projects: ProjectRecordDto[] | undefined;
	#currentProjectId: string | undefined;
	#projectsPending = true;
	/**
	 * Agent Todo 板属于一个 Agent，**不随会话变**：切会话（同一 Agent 换历史会话）不重读，
	 * 换 Agent 才作废重读。
	 */
	#agentTodos: AgentTodoDto[] | undefined;
	#agentTodoProjectIds: string[] | undefined;
	#agentTodosPending = true;
	#agentTodosError: string | undefined;
	/** 板子对应的 Agent（空串 = 还没定过焦点）；undefined 与 "" 都表示「还没读过」。 */
	#agentTodoKey: string | undefined;
	/** 请求按代际提交：换 Agent 后，上一个 Agent 的迟到响应整份丢弃。 */
	#agentTodoGeneration = 0;
	#projectsError: string | undefined;
	/**
	 * 最近一次算过归属的「会话身份」（焦点 agent + 会话文件）。
	 *
	 * 它是「归属要不要重算」的唯一判据：同一会话的重复快照不重读 registry（列表可缓存），
	 * 身份一变（切 Agent / 开新会话）就重新请求 —— 只清缓存不重请求会让归属停在上一次的「未归属」。
	 */
	#projectAttributionKey: string | undefined;
	/**
	 * 归属请求的代际。每次发起读请求前递增；响应回来时对不上就整份丢弃。
	 *
	 * 会话 A 的慢请求可能在切到 B 之后才回来 —— 提交它就是把 B 的 projects/currentProjectId/
	 * pending/error 覆盖成 A 的答案。请求取不得消，所以靠这道门把迟到的答案挡在外面。
	 */
	#projectGeneration = 0;

	init(client: PiClient): void {
		this.#client = client;
		const unsub = client.subscribe(frame => this.#onFrame(frame));
		// 连接状态变化（断线重连等）——由 adapter 的 subscribeConnection 驱动
		if (client.subscribeConnection) {
			const unsubConn = client.subscribeConnection(conn => {
				this.#view = cloneView(this.getSnapshot());
				this.#view.connected = conn.connected;
				this.#view.reconnecting = conn.reconnecting ?? false;
				this.#view.connectionId = conn.connectionId;
				this.#view.protocolVersion = conn.protocolVersion;
				this.#view.wsUrl = conn.wsUrl;
				this.#view.env = this.#client.getEnvironment();
				this.#notify();
				// 连接（重）建立时对齐一次归属。不走「先作废 key」：连接通知在 env 刷新等场合会重复
				// 到达，每次重置 key 就是每次重读 registry —— 而 registry 不随会话变。
				if (conn.connected) {
					this.#syncProjectAttribution();
					this.#syncAgentTodos();
				}
				void unsubConn;
			});
		}
		this.#view = this.#buildBaseView();
		this.#notify();
		// 生命周期与 store 共存
		void unsub;
	}

	connect(): Promise<void> {
		return this.#client.connect().then(() => {
			this.#view = this.#buildBaseView();
			this.#notify();
		});
	}

	/** 保存连接配置并用新配置重建客户端（设置页保存/重连用）。 */
	async reconfigure(config: ServeConnectionConfig): Promise<void> {
		saveServeConfig(config);
		this.#client.disconnect();
		this.#client = createClient();
		this.init(this.#client);
		await this.#client.connect();
		this.#view = this.#buildBaseView();
		this.#notify();
	}

	getSnapshot(): SessionView {
		if (!this.#view) {
			this.#view = this.#buildBaseView();
		}
		return this.#view;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	// ── 命令透传 ──

	/** 执行命令；失败（如未连接）时把错误写进 view.commandError，UI 显示提示条。 */
	async #run<T = void>(fn: () => Promise<T>): Promise<T | undefined> {
		try {
			const r = await fn();
			this.#clearCommandError();
			return r;
		} catch (err) {
			const msg = errorMessageOf(err);
			this.#view = cloneView(this.getSnapshot());
			this.#view.commandError = `命令失败（未连接）：${msg}`;
			this.#notify();
			// B7-1：出错告警（命令失败）
			void notifyGuarded("出错告警 · 命令失败", msg.slice(0, 120), "cornfield-notify-errors");
			return undefined;
		}
	}

	clearCommandError(): void {
		this.#clearCommandError();
	}

	#clearCommandError(): void {
		if (!this.#view?.commandError) return;
		this.#view = cloneView(this.getSnapshot());
		this.#view.commandError = undefined;
		this.#notify();
	}

	prompt(text: string, sessionId?: string, images?: ImageContentDto[]): void {
		// SERVE-1 回归：本地乐观回显。发送即出现在当前转录（不再等服务端帧回推，否则路由异常时页面毫无反馈）；
		// 目标 agent 的权威快照/流式帧到达后自然替换或推进；命令失败则把回显消息标错。
		const echoId = this.#echoUserPrompt(text);
		this.#client
			.prompt(text, sessionId, images)
			.then(() => this.#clearCommandError())
			.catch(err => this.#failUserPrompt(echoId, err));
	}

	/** 乐观回显：把用户消息立即挂到当前转录（快照到达后由权威消息替换）。返回回显 id 供失败标错。 */
	#echoUserPrompt(text: string): string {
		const id = `echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const view = cloneView(this.getSnapshot());
		view.messages.push({ id, role: "user", text, tools: [], done: false });
		this.#view = view;
		this.#notify();
		return id;
	}

	/** 发送失败：命令错误提示条 + 回显消息标错（不再悬挂「发送中」）。 */
	#failUserPrompt(echoId: string, err: unknown): void {
		const msg = errorMessageOf(err);
		const view = cloneView(this.getSnapshot());
		view.commandError = `命令失败（未连接）：${msg}`;
		view.messages = view.messages.map(m => (m.id === echoId ? { ...m, error: msg, done: true } : m));
		this.#view = view;
		this.#notify();
		void notifyGuarded("出错告警 · 命令失败", msg.slice(0, 120), "cornfield-notify-errors");
	}

	abort(): void {
		void this.#run(() => this.#client.abort());
	}

	compact(): void {
		void this.#run(() => this.#client.compact());
	}

	newSession(): void {
		// 新会话没有账本：上一会话的子会话树不得跟过来（私有字段与 view 要一起改，
		// 否则要等下一个快照才会消失）。
		this.#sessionTree = undefined;
		this.#sessionTreeError = undefined;
		const view = cloneView(this.getSnapshot());
		view.sessionTree = undefined;
		view.sessionTreeError = undefined;
		// 新会话就是一个新会话，与当前身份必然不同 —— 不看目标是什么，直接作废：
		// 少了这一步，上一会话的在途 list_projects 会在新会话的快照到达前落进新视图。
		this.#invalidateProjectAttribution(view);
		this.#view = view;
		this.#notify();
		void this.#run(() => this.#client.newSession());
	}

	/** 切换模型（set_model）。失败不再静默：错误写 view.commandError，由模型控制中心/工作台提示条渲染。 */
	setModel(modelId: string, provider?: string, agentId?: string): void {
		void this.#run(() => this.#client.setModel(modelId, provider, agentId));
	}

	setThinkingLevel(level: string, agentId?: string): void {
		void this.#client.setThinkingLevel(level, agentId).catch(() => undefined);
	}

	setTodos(phases: TodoPhaseDto[]): void {
		void this.#client.setTodos(phases).catch(() => undefined);
	}

	setAutoCompaction(enabled: boolean): void {
		void this.#client.setAutoCompaction(enabled).catch(() => undefined);
	}

	setAutoRetry(enabled: boolean): void {
		void this.#client.setAutoRetry(enabled).catch(() => undefined);
	}

	abortRetry(): void {
		void this.#run(() => this.#client.abortRetry());
	}
	forkFrom(entryId: string): void {
		void this.#run(() => this.#client.forkFrom(entryId));
	}

	undoExchange(entryId: string): void {
		void this.#run(() => this.#client.undoExchange(entryId));
	}

	retryFrom(entryId: string, message?: string): void {
		void this.#run(() => this.#client.retryFrom(entryId, message));
	}

	/** 用户裁决回传（optimistic 清空 pending + 发 permission_respond）。 */
	permissionRespond(requestId: string, choice: string): void {
		const view = cloneView(this.getSnapshot());
		if (view.pendingPermission?.requestId === requestId) {
			view.pendingPermission = undefined;
			this.#view = view;
			this.#notify();
		}
		void this.#client.permissionRespond(requestId, choice).catch(() => undefined);
	}

	/** 读目标 agent 的 config.yml 域（per-agent）。 */
	getConfig(agentId: string, key?: string): Promise<{ config: unknown }> {
		return this.#client.getConfig(agentId, key);
	}

	/** 写目标 agent 的 config.yml 域并持久化（per-agent；同步更新该 agent 的配置视图）。 */
	setConfig(agentId: string, key: string, value: unknown): Promise<{ ok: boolean }> {
		return this.#client.setConfig(agentId, key, value);
	}

	/** 工具开关语义视图（per-agent）。 */
	getToolSwitches(agentId: string): Promise<ToolSwitchesDto> {
		return this.#client.getToolSwitches(agentId);
	}

	/** 前端已注册 host tools（set_host_tools 本地权威态）。 */
	getHostTools(): HostToolDefinitionDto[] {
		return this.#client.getHostTools();
	}

	setHostTools(tools: HostToolDefinitionDto[]): void {
		void this.#run(() => this.#client.setHostTools(tools));
	}

	toggleTodo(phaseName: string, index: number): void {
		const view = this.getSnapshot();
		const phases = view.todo.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) }));
		const phase = phases.find(p => p.name === phaseName);
		const task = phase?.tasks[index];
		if (!phase || !task) return;
		task.status = task.status === "completed" ? "pending" : "completed";
		void this.#client.setTodos(phases).catch(() => undefined);
	}

	addTodo(phaseName: string, content: string): void {
		const view = this.getSnapshot();
		const phases = view.todo.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) }));
		const trimmed = content.trim();
		if (!trimmed) return;
		if (view.todo.some(p => p.name === phaseName)) {
			const phase = phases.find(p => p.name === phaseName);
			phase?.tasks.push({ content: trimmed, status: "pending" });
		} else {
			phases.push({ name: phaseName, tasks: [{ content: trimmed, status: "pending" }] });
		}
		void this.#client.setTodos(phases).catch(() => undefined);
	}

	removeTodo(phaseName: string, index: number): void {
		const view = this.getSnapshot();
		const phases = view.todo.map(p => ({ ...p, tasks: p.tasks.map(t => ({ ...t })) }));
		const phase = phases.find(p => p.name === phaseName);
		if (!phase) return;
		phase.tasks.splice(index, 1);
		void this.#client.setTodos(phases).catch(() => undefined);
	}

	/**
	 * 拉取模型目录数据（get_available_models：models + 停用名单）；展示层自行持有，
	 * 失败抛错由调用方（模型目录 CatalogView）渲染错误态。
	 */
	fetchModels(): Promise<AvailableModelsDto> {
		return this.#client.getAvailableModels();
	}

	/** 别名（ComposerBar 接入真实模型列表）。 */
	getAvailableModels(): Promise<AvailableModelsDto> {
		return this.#client.getAvailableModels();
	}

	/** 停用/恢复 provider（modelId 缺省）或单个模型；返回最新停用名单供 UI 同步。 */
	setModelDisabled(
		provider: string,
		modelId: string | undefined,
		disabled: boolean,
	): Promise<{ ok: boolean; disabledProviders: string[]; disabledModels: string[] }> {
		return this.#client.setModelDisabled(provider, modelId, disabled);
	}

	// ── 模型控制中心（#02 全量目录 / #03 Provider 接入 / #05 配置作用域）──
	// 契约方法（与 UI 并行开发约定）：失败抛错由调用方渲染错误态；敏感值（apiKey/code）
	// 只透传进请求载荷，本层不落日志。

	/** #02 全量模型目录（get_model_catalog；含未接入 provider，六态 status 区分）。 */
	fetchModelCatalog(): Promise<ModelCatalogDto> {
		return this.#client.fetchModelCatalog();
	}

	/** #05 模型选择两层视图（get_model_selection；临时/持久默认读写两侧可区分）。 */
	fetchModelSelection(): Promise<ModelSelectionDto> {
		return this.#client.fetchModelSelection();
	}

	/** 会话级临时切换模型（set_model_temporary；仅本会话，不写 settings）。 */
	setModelTemporary(providerId: string, modelId: string): Promise<void> {
		return this.#client.setModelTemporary(providerId, modelId);
	}

	/** #03 Provider 状态列表（get_providers；响应只含掩码密钥）。 */
	fetchProviders(): Promise<ProviderListDto> {
		return this.#client.fetchProviders();
	}

	/** #03 单个 Provider 状态（get_provider；未知 providerId 抛错）。 */
	fetchProvider(providerId: string): Promise<ProviderStatusDto> {
		return this.#client.fetchProvider(providerId);
	}

	/** #03 发起 OAuth 登录（start_provider_oauth；requiresManualCode 流需随后 completeProviderOauth）。 */
	startProviderOauth(providerId: string): Promise<ProviderOAuthStartDto> {
		return this.#client.startProviderOauth(providerId);
	}

	/** #03 提交 OAuth 手输 code / 粘贴 key（complete_provider_oauth）；返回最新状态。 */
	completeProviderOauth(providerId: string, code: string): Promise<ProviderStatusDto> {
		return this.#client.completeProviderOauth(providerId, code);
	}

	/** #03 保存/替换 API Key（save_provider_api_key；明文只进请求载荷，响应仅掩码）。 */
	saveProviderApiKey(providerId: string, apiKey: string): Promise<ProviderStatusDto> {
		return this.#client.saveProviderApiKey(providerId, apiKey);
	}

	/** #03 删除已存 API Key（delete_provider_api_key；幂等）。 */
	deleteProviderApiKey(providerId: string): Promise<ProviderStatusDto> {
		return this.#client.deleteProviderApiKey(providerId);
	}

	/** #03 设置自定义 Base URL（set_provider_base_url；null 清除覆盖）。 */
	setProviderBaseUrl(providerId: string, baseUrl: string | null): Promise<ProviderStatusDto> {
		return this.#client.setProviderBaseUrl(providerId, baseUrl);
	}

	/** #03 断开 provider（disconnect_provider；有依赖未 force 时 disconnected:false + 依赖清单）。 */
	disconnectProvider(providerId: string, force: boolean): Promise<ProviderDisconnectResultDto> {
		return this.#client.disconnectProvider(providerId, force);
	}

	/** #03 单 provider 目录刷新（refresh_provider；online 强制）。 */
	refreshProvider(providerId: string): Promise<ProviderStatusDto> {
		return this.#client.refreshProvider(providerId);
	}

	/** #04 全量目录刷新（refresh_catalog；registry 级并行，返回刷新后的完整目录）。 */
	refreshCatalog(): Promise<ModelCatalogDto> {
		return this.#client.refreshCatalog();
	}

	/** #04 单模型连通性测试（test_model；真实调用会产生费用，UI 必须先确认）。 */
	testModel(providerId: string, modelId: string): Promise<ModelTestResultDto> {
		return this.#client.testModel(providerId, modelId);
	}

	/** #05 配置作用域读取（get_config_scope；hasProjectConfig + 可覆盖键三层取值）。 */
	fetchConfigScope(): Promise<ConfigScopeDto> {
		return this.#client.fetchConfigScope();
	}

	/** #05 恢复继承（restore_config_inheritance；删除项目覆盖键而非复制值）。 */
	restoreConfigInheritance(key: string): Promise<ConfigInheritanceRestoreDto> {
		return this.#client.restoreConfigInheritance(key);
	}

	/** #05 按作用域写配置（set_config；global 写全局 config.yml，project 写 .cornfield/config.yml）。 */
	setConfigValue(key: string, value: unknown, scope: "global" | "project"): Promise<void> {
		return this.#client.setConfigValue(key, value, scope);
	}

	/** 持久化默认模型（set_model：写 settings.modelRoutes.default.primary 并持久化到 config.yml）。 */
	setPersistentDefaultModel(providerId: string, modelId: string): Promise<void> {
		return this.#client.setPersistentDefaultModel(providerId, modelId);
	}

	/** 拉取注册表 agent 列表（list_agents）并刷新视图。 */
	async fetchAgents(): Promise<void> {
		const agents = await this.#client.listAgents();
		this.#view = cloneView(this.getSnapshot());
		this.#view.agents = agents;
		this.#notify();
	}

	/** lazy attach 注册表 agent（attach 后 serve 会推该会话快照/进度）。 */
	attach(sessionId: string): void {
		void this.#client.attach(sessionId).catch(() => undefined);
	}

	/** 切换活动会话（switch_session；serve 随后推新 session_snapshot，工作台自动跟随）。 */
	switchSession(sessionId: string): void {
		this.#setActiveAgent(sessionId, this.#workspaceShortOf(undefined, sessionId));
		void this.#client.switchSession(sessionId).catch(() => undefined);
	}

	/** 记录本连接焦点 agent 并立即同步到 view（UI 立即跟随，不等 serve 快照）。 */
	#setActiveAgent(agentId: string, workspace?: string, targetSessionFile?: string): void {
		this.#activeAgentId = agentId;
		this.#activeWorkspace = workspace;
		// 会话树是上一个会话的账本视图，换会话后不能继续展示（否则把另一个 Agent 的子会话
		// 挂在当前会话下）；等下一次 refreshSessionTree 给出真实答案。
		this.#sessionTree = undefined;
		this.#sessionTreeError = undefined;
		const view = cloneView(this.getSnapshot());
		// view.sessionId 是 serve 推来的焦点（agent 注册名）：它与目标不同，说明手上这批消息
		// 属于**另一个 Agent**。留着它就是让 A 的工作显示在 B 的上下文里，等新快照到达再
		// 自动填回。同一个会话上的重复切换不算切换，不动转录。
		const sameAgent = view.sessionId === agentId;
		if (!sameAgent) {
			view.messages = [];
			view.live = undefined;
			view.sessionName = undefined;
			view.sessionFile = undefined;
			view.isStreaming = false;
			view.queued = 0;
		}
		// Project 归属跟着**会话身份**（agent + 会话文件）走，不只是 agent：同一个 Agent 下换一个
		// 会话（打开另一个历史会话）同样是另一个会话的归属。目标会话文件未知的入口
		// （switchSession / newSession）按空串算 —— 未知就是与已知不同：宁可让紧随其后的快照
		// 重算一次，也不要让上一会话的归属（和它在途请求）继续落在屏幕上。
		const identity = this.#projectIdentityOf(agentId, targetSessionFile);
		if (identity !== this.#projectAttributionKey) this.#invalidateProjectAttribution(view);
		// Todo 板跟着 **Agent** 走（不是会话）：同一个 Agent 换历史会话，板子不变；换 Agent 立即作废，
		// 在重读结果回来之前界面上是「还不知道」，而不是上一个 Agent 的任务。
		if (agentId !== this.#agentTodoKey) this.#invalidateAgentTodos(view);
		view.activeAgentId = agentId;
		view.activeWorkspace = workspace;
		view.sessionTree = undefined;
		view.sessionTreeError = undefined;
		this.#view = view;
		this.#notify();
	}

	/**
	 * 把归属作废到「还不知道」：代际同步递增（在途响应从此落不了地）、显示值清空、
	 * `#projectAttributionKey` 置回 undefined（下一次 sync 无条件重算）。
	 *
	 * **每一个改变会话身份的入口都必须走这里**（切换、打开历史会话、新会话）——
	 * 漏掉一个入口就是漏掉一个「上一会话的答案写进新会话」的窗口。
	 */
	#invalidateProjectAttribution(view: SessionView): void {
		this.#projectGeneration += 1;
		this.#projectAttributionKey = undefined;
		this.#currentProjectId = undefined;
		this.#projectsPending = true;
		// 错误也是上一次请求的判决，与归属同属一份被作废的结果：留着它，新身份在 pending 期间
		// 会继续挂在旧会话身上显示「读不出来」—— 一个我们已经宣告作废的请求的结论。
		this.#projectsError = undefined;
		view.currentProjectId = undefined;
		view.projectsPending = true;
		view.projectsError = undefined;
	}

	/** 归属对应的会话身份：焦点 agent + 会话文件（未知用空串）。一个概念一处定义。 */
	#projectIdentityOf(agentId: string | null, sessionFile: string | undefined): string {
		return `${agentId ?? ""}|${sessionFile ?? ""}`;
	}

	/** 工作目录短名：会话 cwd 优先，回落 agentDir 末段；均无则 undefined。 */
	#workspaceShortOf(cwd?: string, agentId?: string): string | undefined {
		const dir = cwd ?? this.#client.getServerAgents().find(a => a.id === agentId)?.agentDir;
		if (!dir) return undefined;
		const trimmed = dir.replace(/\/+$/, "");
		return trimmed.split("/").pop() || dir;
	}

	/** 拉取当前会话消息（get_messages）转播放时间线。 */
	getMessages(): Promise<PlaybackEntry[]> {
		return this.#client.getMessages();
	}

	/** 原始消息 JSON 序列（导出 JSONL）。 */
	getRawMessages(): Promise<unknown[]> {
		return this.#client.getRawMessages();
	}

	/** 分支候选（get_branch_messages）。 */
	getBranchMessages(): Promise<BranchPoint[]> {
		return this.#client.getBranchMessages();
	}

	/** 历史会话索引（list_sessions 真数据；失败时空数组，UI 空态）。 */
	listSessions(): Promise<SessionRecordSummary[]> {
		return this.#client.listSessions();
	}

	/**
	 * 打开历史会话（sidebar 点击会话行）：
	 * 1. switch 到所属 agent（serve 端 switch_session 内含 attach，工作台随后跟随）；
	 * 2. 有 sessionFile 则 get_session_messages 拉历史消息 → 覆盖 view.messages（Transcript 复用渲染）；
	 *    无 sessionFile 则仅 switch，serve 推权威快照填充 Transcript。
	 * 加载中 / 失败写 historyLoading / historyError（UI 可见，不 silent）。
	 */
	/** 历史会话时间线（get_session_messages；PlaybackView 回放消费，与 openHistorySession 同源）。 */
	getSessionMessages(file: string): Promise<MessageDto[]> {
		return this.#client.getSessionMessages(file);
	}

	/** 诊断会话（diagnose_session；异步启动诊断，返回任务句柄）。 */
	diagnoseSession(sessionFile: string): Promise<{ reportId: string; sessionId: string; state: "running" | "done" }> {
		return this.#client.diagnoseSession(sessionFile);
	}

	/** 列出诊断报告与后台任务（list_diagnosis_reports）。 */
	listDiagnosisReports(sessionFile?: string): Promise<{ reports: any[]; tasks: any[] }> {
		return this.#client.listDiagnosisReports(sessionFile);
	}

	/** 获取单个诊断报告详情（get_diagnosis_report）。 */
	getDiagnosisReport(reportId: string): Promise<{ markdown: string; summary: any } | null> {
		return this.#client.getDiagnosisReport(reportId);
	}

	/** 多会话诊断聚合统计（aggregate_diagnosis）。 */
	aggregateDiagnosis(opts?: { since?: number; until?: number; agentId?: string }): Promise<DiagnosisAggregationDto> {
		return this.#client.aggregateDiagnosis(opts);
	}

	async openHistorySession(record: { id: string; agent: string; sessionFile?: string; cwd?: string }): Promise<void> {
		const agents = this.#client.getServerAgents();
		const agentId = agents.find(a => a.id === record.agent || a.name === record.agent)?.id ?? record.agent;

		try {
			await this.#client.switchSession(agentId);
			// cli 会话显示其打开目录（header.cwd），agent 会话回落 agentDir
			this.#setActiveAgent(agentId, this.#workspaceShortOf(record.cwd, agentId), record.sessionFile);
		} catch {
			// switch 失败（agent 已删除 / 未注册）不阻断历史回放，仅历史加载失败才可见报错
		}

		const loading = cloneView(this.getSnapshot());
		loading.historyLoading = true;
		loading.historyError = undefined;
		this.#view = loading;
		this.#notify();

		if (!record.sessionFile) {
			// 降级：无 sessionFile 仅 attach/switch；前述 switch 已触发 serve 推快照填充 Transcript
			this.#clearHistoryLoading();
			return;
		}

		try {
			const messages = await this.#client.getSessionMessages(record.sessionFile);
			const next = cloneView(this.getSnapshot());
			next.messages = mergeToolResults(messages).map(m => this.#toMessage(m));
			next.live = undefined;
			next.historyLoading = false;
			next.historyError = undefined;
			// 产物 panel 定向到被回放会话（而非 live 快照的 sessionFile，后者可能未落盘）
			next.sessionFile = record.sessionFile;
			this.#view = next;
			this.#notify();
		} catch (err) {
			const next = cloneView(this.getSnapshot());
			next.historyLoading = false;
			next.historyError = `加载会话失败：${errorMessageOf(err)}`;
			this.#view = next;
			this.#notify();
		}
	}

	#clearHistoryLoading(): void {
		if (!this.#view?.historyLoading && !this.#view?.historyError) return;
		const next = cloneView(this.getSnapshot());
		next.historyLoading = false;
		next.historyError = undefined;
		this.#view = next;
		this.#notify();
	}

	/**
	 * 读当前会话直接委派出去的子会话（get_session_tree）。
	 *
	 * 失败不降级为空树：读不到（未附着 / 账本条目损坏）与「确实没有子会话」是两件事，
	 * 后者是本命令的正常答案（children: []），前者必须让面板显示错误。
	 */
	async refreshSessionTree(agentId?: string): Promise<void> {
		this.#sessionTreeLoading = true;
		const pending = cloneView(this.getSnapshot());
		pending.sessionTreeLoading = true;
		this.#view = pending;
		this.#notify();
		try {
			const tree = await this.#client.getSessionTree(agentId);
			this.#sessionTree = tree;
			this.#sessionTreeError = undefined;
		} catch (err) {
			this.#sessionTree = undefined;
			this.#sessionTreeError = errorMessageOf(err);
		} finally {
			this.#sessionTreeLoading = false;
			const settled = cloneView(this.getSnapshot());
			settled.sessionTree = this.#sessionTree;
			settled.sessionTreeLoading = false;
			settled.sessionTreeError = this.#sessionTreeError;
			this.#view = settled;
			this.#notify();
		}
	}

	/**
	 * 把子会话结果带回父会话（bring_back_child_result），并刷新会话树。
	 *
	 * 返回 serve 的原始结果（不只是布尔）：调用方要用 `firstTime` 区分「这次才带回」与
	 * 「早就带回过」，用 `content` 展示带回来的东西；重复带回不报错，但不得重复注入。
	 */
	async bringBackChild(childSessionId: string, agentId?: string): Promise<BroughtBackChildResultDto> {
		const result = await this.#client.bringBackChildResult(childSessionId, agentId);
		await this.refreshSessionTree(agentId);
		return result;
	}

	/**
	 * 读客户端级 Project registry（list_projects），并让 serve 算一次当前会话的归属。
	 *
	 * 失败不降级为空列表：存储损坏是错误，与「没声明过任何 Project」必须分开显示，
	 * 否则用户会以为自己的项目消失。
	 *
	 * 这是「手动重算」入口；会话换人时的自动重算见 {@link #syncProjectAttribution}。
	 */
	async refreshProjects(agentId?: string): Promise<void> {
		// 手动重算：它是比任何在途请求更新的一次请求，所以递增 generation 让旧的那份作废。
		return await this.#loadProjects(agentId, ++this.#projectGeneration);
	}

	/**
	 * 发一次读请求，并把结果**按 generation 提交**。
	 *
	 * 请求本身取不得消（pi-client 的 request 没有 abort），所以迟到的那一份只能丢掉：
	 * 会话 A 的慢响应在切到 B 之后到达时，它描述的是 A 的归属 —— 提交它就会把 B 的
	 * projects / currentProjectId / pending / projectsError 全部覆盖成 A 的答案（包括一个
	 * 与 B 无关的错误）。判定放在**每一个**写入点之前，成功和失败走同一条门。
	 */
	async #loadProjects(agentId: string | undefined, generation: number): Promise<void> {
		let projects: ProjectRecordDto[] | undefined;
		let currentProjectId: string | undefined;
		let error: string | undefined;
		try {
			const result = await this.#client.listProjects(agentId);
			projects = result.projects;
			currentProjectId = result.currentProjectId;
		} catch (err) {
			// 读不到就不知道归属，不是「没有归属」：列表与归属一起作废，错误挡住阅读。
			error = errorMessageOf(err);
		}
		if (generation !== this.#projectGeneration) return;
		this.#projects = projects;
		this.#currentProjectId = currentProjectId;
		this.#projectsError = error;
		this.#projectsPending = false;
		const view = cloneView(this.getSnapshot());
		view.projects = projects;
		view.currentProjectId = currentProjectId;
		view.projectsPending = false;
		view.projectsError = error;
		this.#view = view;
		this.#notify();
	}

	/**
	 * 会话身份（焦点 agent + 会话文件）变了就重算归属，没变就不动。
	 *
	 * 这是「切 Agent / 开新会话后归属必须自己跟上」的唯一入口。只在切的时候清缓存而不重新
	 * 请求，会让新会话的归属停在上一次的答案（典型表现：一直显示「未归属」，要手动刷新才对）；
	 * 反过来每次快照都重读，又会让 registry 白白重读 —— 而它并不随会话变。
	 *
	 * 作废是**同步**的：在重算结果回来之前，界面上必须是「还不知道」，而不是上一个会话的归属。
	 */
	#syncProjectAttribution(): void {
		const key = this.#projectIdentityOf(this.#activeAgentId, this.#view?.sessionFile);
		if (key === this.#projectAttributionKey) return;
		this.#projectAttributionKey = key;
		this.#currentProjectId = undefined;
		this.#projectsPending = true;
		const view = cloneView(this.getSnapshot());
		view.currentProjectId = undefined;
		view.projectsPending = true;
		this.#view = view;
		this.#notify();
		// generation 在发请求之前递增：从这一刻起，上一个身份的响应就再也落不了地。
		const generation = ++this.#projectGeneration;
		void this.#loadProjects(this.#activeAgentId ?? undefined, generation);
	}

	// ── Agent Todo（T10A）──────────────────────────────────────────────────
	// 与 Project 归属同一套纪律：**作废是同步的**（重读回来之前界面只能是「还不知道」），
	// 请求**按代际提交**（换 Agent 后上一个 Agent 的迟到响应整份丢弃）。
	// 差别只在 key：归属跟会话身份（agent + 会话文件），板子只跟 Agent。

	/**
	 * 手动重读 Todo 板（工作台刷新入口）。
	 *
	 * 不降级：读不到就错误态（调用方把「记过但读坏了」与「没记过」分开显示）。
	 */
	async refreshAgentTodos(): Promise<void> {
		return await this.#loadAgentTodos(++this.#agentTodoGeneration);
	}

	/**
	 * 新建或更新一条 Agent Todo（set_agent_todo），返回存储真正落盘的那一份。
	 *
	 * 失败**原样抛出**（owner 不对 / Project 没声明过 / 存储坏了）：吞掉它就会让用户以为已经
	 * 存下了。成功后就地替换板上那条 —— 用 serve 返回的记录，不是自己发出去的那份，因为
	 * `createdAt` / `updatedAt` / `sessionRefs` 是存储盖章的。
	 */
	async saveAgentTodo(todo: AgentTodoDto): Promise<AgentTodoDto> {
		const key = this.#agentTodoKey;
		const result = await this.#client.setAgentTodo(todo, this.#activeAgentId ?? undefined);
		this.#mergeAgentTodo(result.todo, key);
		return result.todo;
	}

	/** 删除一条 Agent Todo（delete_agent_todo）。幂等：本来就不在板上返回 false。 */
	async deleteAgentTodo(todoId: string): Promise<boolean> {
		const key = this.#agentTodoKey;
		const result = await this.#client.deleteAgentTodo(todoId, this.#activeAgentId ?? undefined);
		if (result.deleted) this.#mergeAgentTodoRemoval(todoId, key);
		return result.deleted;
	}

	/**
	 * 把一条权威记录合进板子。
	 *
	 * 板子属于另一个 Agent（`expectedKey` 已经过期）或还没读出来（错误态 / 初读中）时**不合并**：
	 * 前者是往别人的板上写，后者会把「读坏了」伪装成「读到了、里面就这几条」。两种情况都改用
	 * 重读拿真实结果。
	 */
	#mergeAgentTodo(todo: AgentTodoDto, expectedKey: string | undefined): void {
		if (expectedKey !== this.#agentTodoKey || this.#agentTodos === undefined) {
			void this.refreshAgentTodos();
			return;
		}
		const exists = this.#agentTodos.some(item => item.id === todo.id);
		this.#setAgentTodos(
			exists ? this.#agentTodos.map(item => (item.id === todo.id ? todo : item)) : [...this.#agentTodos, todo],
		);
	}

	/** 从板子上拿掉一条；板子已换主人 / 未读出时同样改走重读。 */
	#mergeAgentTodoRemoval(todoId: string, expectedKey: string | undefined): void {
		if (expectedKey !== this.#agentTodoKey || this.#agentTodos === undefined) {
			void this.refreshAgentTodos();
			return;
		}
		this.#setAgentTodos(this.#agentTodos.filter(item => item.id !== todoId));
	}

	#setAgentTodos(todos: AgentTodoDto[]): void {
		this.#agentTodos = todos;
		const view = cloneView(this.getSnapshot());
		view.agentTodos = todos;
		view.agentTodosPending = false;
		this.#view = view;
		this.#notify();
	}

	/**
	 * 焦点 Agent 变了就重读板子，没变就不动。
	 *
	 * 与归属同源调用点（连接就绪 / 快照到达 / 切 Agent），保证「切 Agent 后板子自己跟上」
	 * 不需要任何手动刷新。
	 */
	#syncAgentTodos(): void {
		const key = this.#activeAgentId ?? "";
		if (key === this.#agentTodoKey) return;
		const view = cloneView(this.getSnapshot());
		this.#invalidateAgentTodos(view, key);
		this.#view = view;
		this.#notify();
		void this.#loadAgentTodos(this.#agentTodoGeneration);
	}

	/**
	 * 把板子作废到「还不知道」：代际同步递增（在途响应从此落不了地）、显示值清空。
	 *
	 * `nextKey` 缺省 = key 置回「还没读过」，下一次 sync 无条件重算 —— 切换入口只负责作废，
	 * 重读交给紧随其后的快照（与 Project 归属同一条路）。
	 *
	 * 清错误也是清：留着上一个 Agent 的读取失败，新 Agent 在 pending 期间会继续挂着一个与它
	 * 无关的「读不出来」。
	 */
	#invalidateAgentTodos(view: SessionView, nextKey?: string): void {
		this.#agentTodoGeneration += 1;
		this.#agentTodoKey = nextKey;
		this.#agentTodos = undefined;
		this.#agentTodoProjectIds = undefined;
		this.#agentTodosPending = true;
		this.#agentTodosError = undefined;
		view.agentTodos = undefined;
		view.agentTodoProjectIds = undefined;
		view.agentTodosPending = true;
		view.agentTodosError = undefined;
	}

	/** 发一次读请求，并按代际提交（成功与失败走同一道门）。 */
	async #loadAgentTodos(generation: number): Promise<void> {
		let todos: AgentTodoDto[] | undefined;
		let projectIds: string[] | undefined;
		let error: string | undefined;
		try {
			const result = await this.#client.listAgentTodos(this.#activeAgentId ?? undefined);
			todos = result.todos;
			projectIds = result.projectIds;
		} catch (err) {
			error = errorMessageOf(err);
		}
		if (generation !== this.#agentTodoGeneration) return;
		this.#agentTodos = todos;
		this.#agentTodoProjectIds = projectIds;
		this.#agentTodosError = error;
		this.#agentTodosPending = false;
		const view = cloneView(this.getSnapshot());
		view.agentTodos = todos;
		view.agentTodoProjectIds = projectIds;
		view.agentTodosError = error;
		view.agentTodosPending = false;
		this.#view = view;
		this.#notify();
	}

	/** 列出 agent workspace 目录（fs_list，代理到 pi-client）。 */
	fsList(sessionId: string, path?: string): Promise<{ entries: FsEntryDto[] }> {
		return this.#client.fsList(sessionId, path);
	}

	/** 读 agent workspace 文件（fs_read，代理到 pi-client）。 */
	fsRead(sessionId: string, path: string): Promise<{ text: string; truncated: boolean }> {
		return this.#client.fsRead(sessionId, path);
	}

	/** 读 agent workspace 图片（fs_read_image，代理到 pi-client；serve 待实现）。 */
	fsReadImage(sessionId: string, path: string): Promise<{ dataUrl: string }> {
		return this.#client.fsReadImage(sessionId, path);
	}

	/** 产物列表（list_artifacts，代理到 pi-client；sessionFile 定向单会话；ArtifactsPanel 数据源）。 */
	listArtifacts(sessionId: string, sessionFile?: string): Promise<{ artifacts: ArtifactDto[] }> {
		return this.#client.listArtifacts(sessionId, sessionFile);
	}

	/** 产物静态预览 URL（交互式 web：serve 同源 /preview 路由；代理到 pi-client）。 */
	artifactPreviewUrl(agentId: string, path: string): string {
		return this.#client.artifactPreviewUrl(agentId, path);
	}

	/** 本机 gateway 运行状态（gateway_status，代理到 pi-client）。 */
	gatewayStatus(): Promise<GatewayStatusDto> {
		return this.#client.gatewayStatus();
	}

	/** 动态账号热生效（set_gateway_account，代理到 pi-client）。 */
	setGatewayAccount(accountId: string, patch: GatewayAccountPatchDto): Promise<{ ok: boolean }> {
		return this.#client.setGatewayAccount(accountId, patch);
	}

	/** 进程内 reload（reload_gateway，代理到 pi-client；兜底手动触发热生效）。 */
	reloadGateway(): Promise<{ ok: boolean }> {
		return this.#client.reloadGateway();
	}

	/** 本地用量统计（get_stats，代理到 pi-client；展示层自行持有状态）。 */
	fetchStats(period?: StatsPeriodDto): Promise<DashboardStatsDto> {
		return this.#client.getStats(period);
	}

	/** 记忆投影（get_memory，代理到 pi-client；sessionId 定向 agent，展示层自行持有状态）。 */
	fetchMemory(sessionId?: string): Promise<MemoryProjectionDto> {
		return this.#client.getMemory(sessionId);
	}

	/** 技能工作台数据（get_skills，代理到 pi-client；sessionId 定向 agent）。 */
	fetchSkills(sessionId?: string): Promise<SkillsResultDto> {
		return this.#client.getSkills(sessionId);
	}

	/** 启停技能（set_skill_enabled，代理到 pi-client；写该 agent 自己的配置）。 */
	setSkillEnabled(
		name: string,
		enabled: boolean,
		sessionId?: string,
	): Promise<{ ok: boolean; name: string; enabled: boolean }> {
		return this.#client.setSkillEnabled(name, enabled, sessionId);
	}

	/** 远程技能市场（list_remote_skills，代理到 pi-client；展示层自行持有状态）。 */
	fetchRemoteSkills(source?: string): Promise<RemoteSkillItemDto[]> {
		return this.#client.listRemoteSkills(source);
	}

	/** 安装远程技能（install_remote_skill，代理到 pi-client）。 */
	installRemoteSkill(source: string, name: string): Promise<{ path: string; alreadyInstalled: boolean }> {
		return this.#client.installRemoteSkill(source, name);
	}

	// ── MCP 服务器管理（设置页；契约命令由 serve 端 m1 并行实现，代理到 pi-client）──
	/** 列出 MCP 服务器（get_mcp_servers）。 */
	getMcpServers(): Promise<{ servers: McpServerDto[] }> {
		return this.#client.getMcpServers();
	}
	/** 新增/更新 MCP 服务器（set_mcp_server upsert）。 */
	setMcpServer(input: {
		name: string;
		command?: string;
		args?: string[];
		enabled?: boolean;
	}): Promise<{ ok: boolean }> {
		return this.#client.setMcpServer(input);
	}
	/** 删除 MCP 服务器（remove_mcp_server 幂等）。 */
	removeMcpServer(name: string): Promise<{ ok: boolean }> {
		return this.#client.removeMcpServer(name);
	}
	/** 测试 MCP 服务器（test_mcp_server，结果内联展示，失败不报错页）。 */
	testMcpServer(name: string): Promise<{ ok: boolean; message: string }> {
		return this.#client.testMcpServer(name);
	}

	/** 排队文本（get_state queued，代理到 pi-client；展示层自行持有）。 */
	fetchQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return this.#client.fetchQueue();
	}

	/** 取消最近一条排队消息（cancel_queued，代理到 pi-client）。 */
	cancelQueued(): Promise<{ cancelled: boolean; text?: string }> {
		return this.#client.cancelQueued();
	}

	/** TUI slash 命令表（list_commands，代理到 pi-client；W1 SlashPalette 消费）。 */
	listCommands(): Promise<{ name: string; description: string }[]> {
		return this.#client.listCommands();
	}

	/**
	 * 听记：上传浏览器录音（16kHz mono PCM WAV base64）→ serve 转写（TUI /record 同管线）→ 落盘。
	 * 长请求（本地 whisper 分钟级）——adapter 内部独立短连接 + 长超时，不阻塞主命令面。
	 */
	recordTranscribe(
		audioBase64: string,
		desc?: string,
	): Promise<{ ok: boolean; text: string; path: string; model: string; error?: string }> {
		return this.#client.recordTranscribe(audioBase64, desc);
	}

	/** 听记历史（listen_list；~/.cornfield/listen/ 全部录音，名称倒序 + 转写全文）。 */
	listenList(): Promise<{ ok: boolean; recordings: ListenRecordingDto[] }> {
		return this.#client.listenList();
	}

	/** 听记分帧转写（长录音；begin→chunk→end，同短连接）。 */
	recordTranscribeChunked(
		audioBase64: string,
		desc?: string,
		onProgress?: (sent: number, total: number) => void,
	): Promise<{ ok: boolean; text: string; path: string; model: string; error?: string }> {
		return this.#client.recordTranscribeChunked(audioBase64, desc, onProgress);
	}

	/** gateway cron 任务表（get_cron_tasks，代理到 pi-client）。 */
	fetchCronTasks(): Promise<{ tasks: TaskRowDto[] }> {
		return this.#client.getCronTasks();
	}

	/** cron 执行日志（get_cron_logs，代理到 pi-client）。 */
	fetchCronLogs(opts?: { taskId?: string; days?: number; limit?: number }): Promise<{ logs: CronLogEntryDto[] }> {
		return this.#client.getCronLogs(opts);
	}

	/**
	 * 调度定义写面（T10C，代理到 pi-client → gateway POST /wire）。
	 *
	 * 失败抛错（不返回 boolean）：「agentId 未注册 / agentDir 已不在 / 重名 / 未知 taskId」
	 * 是调用方必须看到的原因，吞成 false 等于把可修复的错误变成莫名的「创建失败」。
	 */
	cronCreate(input: CronCreateInput): Promise<CronTaskWriteResultDto> {
		return this.#client.cronCreate(input);
	}

	cronUpdate(taskId: string, input: CronUpdateInput): Promise<CronTaskWriteResultDto> {
		return this.#client.cronUpdate(taskId, input);
	}

	cronRemove(taskId: string): Promise<CronRemoveResultDto> {
		return this.#client.cronRemove(taskId);
	}

	cronTestRun(name: string, inMs?: number): Promise<CronTestRunResultDto> {
		return this.#client.cronTestRun(name, inMs);
	}

	// ── 帧归约 ──

	#onFrame(frame: WireServerEventDto): void {
		switch (frame.type) {
			case "session_snapshot":
				this.#applySnapshot(frame.snapshot);
				break;
			case "server_snapshot":
				// 多 Agent 后 server_snapshot 是 agents 列表权威源 —— 重读映射
				this.#view = cloneView(this.getSnapshot());
				this.#view.agents = this.#client.getServerAgents();
				this.#notify();
				break;
			case "progress":
				this.#applyProgress(frame.event);
				break;
			case "permission_request":
				this.#view = cloneView(this.getSnapshot());
				this.#view.pendingPermission = frame;
				this.#notify();
				break;
		}
	}

	#applySnapshot(snapshot: SessionSnapshotDto): void {
		const prevLive = this.#view?.live;
		const base = this.#buildBaseView();
		const view: SessionView = {
			...base,
			phase: snapshot.phase,
			model: snapshot.model?.id ?? null,
			thinkingLevel: snapshot.thinkingLevel ?? null,
			sessionId: snapshot.sessionId,
			sessionName: snapshot.sessionName,
			sessionFile: snapshot.sessionFile,
			messages: mergeToolResults(snapshot.messages).map(m => this.#toMessage(m)),
			messageEntryIds: snapshot.messageEntryIds ?? {},
			isStreaming: snapshot.isStreaming || snapshot.phase === "streaming",
			activeToolNames: [...snapshot.activeToolNames],
			queued: snapshot.queuedMessageCount,
			todo: snapshot.todoPhases,
			context: snapshot.context
				? {
						...snapshot.context,
						percent: ratioPercent(snapshot.context.usedTokens, snapshot.context.totalTokens),
						lastCompaction: snapshot.context.lastCompaction ?? null,
					}
				: undefined,
			flags: { autoCompaction: snapshot.autoCompactionEnabled, autoRetry: snapshot.autoRetryEnabled },
		};
		// 流式期间的里程碑快照（仅相位/工具变更）不含流式消息本体：保留瞬态层累积内容，
		// 避免已流出的 thinking/文本在每次 publish 后闪没；收尾快照（含完整消息）自然替换。
		if (view.isStreaming && prevLive && !view.messages.some(m => m.id === prevLive.id) && !view.live) {
			view.live = prevLive;
		}
		this.#view = view;
		this.#notify();
		// 快照是「会话身份」唯一的权威来源（切 Agent / 开新会话后 serve 必推一份）：归属在这儿对齐。
		this.#syncProjectAttribution();
		this.#syncAgentTodos();
	}

	#applyProgress(event: ProgressEventDto): void {
		const prev = this.getSnapshot();
		const view = cloneView(prev);

		switch (event.type) {
			case "turn_start":
			case "agent_start":
				view.isStreaming = true;
				view.phase = "streaming";
				break;
			case "turn_end":
			case "agent_end": {
				view.isStreaming = false;
				view.steer = undefined;
				if (view.phase === "streaming") view.phase = EMPTY_PHASE;
				// B7-1：回合收尾通知（仅 turn_end 触发一次；页面不在前台才发）
				if (event.type === "turn_end") void maybeNotifyTurnEnd(view);
				if (view.live) {
					view.live.done = true;
					view.live.textStreaming = false;
					view.live.thinkingStreaming = false;
					const live = view.live;
					view.live = undefined;
					view.messages.push(live);
				}
				break;
			}
			case "steer":
				view.steer = event.text;
				break;
			case "thinking_start":
				view.live = ensureLive(view, prev);
				view.live.thinking = view.live.thinking ?? "";
				view.live.thinkingStreaming = true;
				break;
			case "thinking_end":
				if (view.live) view.live.thinkingStreaming = false;
				break;
			case "message_update": {
				view.live = ensureLive(view, prev);
				const ev = event.assistantEvent;
				if (ev.type === "thinking_delta") {
					view.live.thinking = (view.live.thinking ?? "") + ev.delta;
					view.live.thinkingStreaming = true;
				} else if (ev.type === "text_delta") {
					view.live.text = (view.live.text ?? "") + ev.delta;
					view.live.textStreaming = true;
				}
				break;
			}
			case "tool_execution_start": {
				view.live = ensureLive(view, prev);
				view.live.tools = [
					...view.live.tools,
					{
						id: event.toolCallId,
						name: event.name,
						argsText: prettyArgs(event.arguments),
						intent: event.intent,
						state: "run",
					},
				];
				view.phase = "executing_tool";
				break;
			}
			case "tool_execution_end": {
				const tool = view.live?.tools.find(t => t.id === event.toolCallId);
				if (tool) {
					tool.state = event.isError ? "fail" : "done";
					tool.result = event.resultText;
					tool.durationMs = event.durationMs;
				}
				view.phase = "streaming";
				break;
			}
			case "auto_compaction_start":
				view.phase = "compacting";
				break;
			case "auto_retry_start":
				view.phase = "retrying";
				// B7-1：出错告警（重试前最后一次失败带 errorMessage）
				if (event.errorMessage) {
					void notifyGuarded("出错告警 · 自动重试", event.errorMessage.slice(0, 120), "cornfield-notify-errors");
				}
				break;
			// todo_reminder / todo_auto_clear —— UI 提示型，暂不消费
			case "todo_reminder":
			case "todo_auto_clear":
				break;
		}

		this.#view = view;
		this.#notify();
	}

	#toMessage(msg: {
		id: string;
		role: "user" | "assistant" | "developer" | "toolResult";
		model?: string;
		content: MessageContentDto[];
		errorMessage?: string;
	}): TranscriptMessage {
		const content = Array.isArray(msg.content) ? msg.content : [];
		const thinking = content
			.filter((c): c is Extract<MessageContentDto, { type: "thinking" }> => c.type === "thinking")
			.map(c => c.thinking)
			.join("\n");
		const text = content
			.filter((c): c is Extract<MessageContentDto, { type: "text" }> => c.type === "text")
			.map(c => c.text)
			.join("\n\n");
		const calls = content.filter((c): c is Extract<MessageContentDto, { type: "toolCall" }> => c.type === "toolCall");
		const results = new Map(
			content
				.filter((c): c is Extract<MessageContentDto, { type: "toolResult" }> => c.type === "toolResult")
				.map(c => [c.toolCallId, c] as const),
		);
		const tools: ToolView[] = calls.map(call => {
			const result = results.get(call.id);
			return {
				id: call.id,
				name: call.name,
				argsText: prettyArgs(call.arguments),
				intent: call.intent,
				state: result ? (result.isError ? "fail" : "done") : "done",
				result: result ? textOf(result) : undefined,
			};
		});
		return {
			id: msg.id,
			role: msg.role === "user" ? "user" : "assistant",
			model: msg.model,
			thinking: thinking || undefined,
			text: text || undefined,
			tools,
			done: msg.role !== "user",
			error: msg.errorMessage,
		};
	}

	#buildBaseView(): SessionView {
		const snapshot = this.#client.getSnapshot();
		const connection = this.#client.getConnection();
		const agents = this.#client.getServerAgents();
		const env = this.#client.getEnvironment();
		if (!snapshot) {
			return {
				connected: connection.connected,
				reconnecting: connection.reconnecting ?? false,
				connectionId: connection.connectionId,
				wsUrl: connection.wsUrl,
				protocolVersion: connection.protocolVersion,
				phase: EMPTY_PHASE,
				model: null,
				thinkingLevel: null,
				sessionId: "",
				messages: [],
				messageEntryIds: {},
				isStreaming: false,
				activeToolNames: [],
				queued: 0,
				todo: [],
				flags: { autoCompaction: false, autoRetry: false },
				agents,
				env,
				activeAgentId: this.#activeAgentId ?? undefined,
				activeWorkspace: this.#activeWorkspace,
				historyLoading: false,
				sessionTree: this.#sessionTree,
				sessionTreeLoading: this.#sessionTreeLoading,
				sessionTreeError: this.#sessionTreeError,
				projects: this.#projects,
				currentProjectId: this.#currentProjectId,
				projectsPending: this.#projectsPending,
				projectsError: this.#projectsError,
				agentTodos: this.#agentTodos,
				agentTodoProjectIds: this.#agentTodoProjectIds,
				agentTodosPending: this.#agentTodosPending,
				agentTodosError: this.#agentTodosError,
			};
		}
		return {
			connected: connection.connected,
			reconnecting: connection.reconnecting ?? false,
			connectionId: connection.connectionId,
			wsUrl: connection.wsUrl,
			protocolVersion: connection.protocolVersion,
			phase: snapshot.phase,
			model: snapshot.model?.id ?? null,
			thinkingLevel: snapshot.thinkingLevel ?? null,
			sessionId: snapshot.sessionId,
			sessionName: snapshot.sessionName,
			sessionFile: snapshot.sessionFile,
			messages: snapshot.messages.map(m => this.#toMessage(m)),
			messageEntryIds: snapshot.messageEntryIds ?? {},
			isStreaming: snapshot.isStreaming,
			activeToolNames: [...snapshot.activeToolNames],
			queued: snapshot.queuedMessageCount,
			todo: snapshot.todoPhases,
			context: snapshot.context
				? {
						...snapshot.context,
						percent: ratioPercent(snapshot.context.usedTokens, snapshot.context.totalTokens),
						lastCompaction: snapshot.context.lastCompaction ?? null,
					}
				: undefined,
			flags: { autoCompaction: snapshot.autoCompactionEnabled, autoRetry: snapshot.autoRetryEnabled },
			agents,
			env,
			activeAgentId: this.#activeAgentId ?? undefined,
			activeWorkspace: this.#activeWorkspace,
			historyLoading: false,
			sessionTree: this.#sessionTree,
			sessionTreeLoading: this.#sessionTreeLoading,
			sessionTreeError: this.#sessionTreeError,
			projects: this.#projects,
			currentProjectId: this.#currentProjectId,
			projectsPending: this.#projectsPending,
			projectsError: this.#projectsError,
			agentTodos: this.#agentTodos,
			agentTodoProjectIds: this.#agentTodoProjectIds,
			agentTodosPending: this.#agentTodosPending,
			agentTodosError: this.#agentTodosError,
		};
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}
}

/**
 * 把快照中独立的 toolResult 顶层消息（role:"toolResult"，content 为 text 全文）挂回对应
 * toolCallId 的 assistant 消息：serve 快照里工具结果是独立消息，直接渲染会把工具输出全文
 * 当成一条 assistant 消息铺满屏幕且无 model 标签（显示占位 "assistant"）。
 * 归并后：独立行不渲染，ToolCard 通过 #toMessage 的 results 读到真实结果。
 */
function mergeToolResults(messages: MessageDto[]): MessageDto[] {
	const resultByCall = new Map<string, Extract<MessageContentDto, { type: "toolResult" }>>();
	for (const m of messages) {
		if (m.role !== "toolResult" || !m.toolCallId) continue;
		resultByCall.set(m.toolCallId, {
			type: "toolResult",
			toolCallId: m.toolCallId,
			isError: m.isError,
			content: (Array.isArray(m.content) ? m.content : []).filter(
				(c): c is Extract<MessageContentDto, { type: "text" }> => c.type === "text",
			),
		});
	}
	if (resultByCall.size === 0) return messages;

	return messages
		.filter(m => m.role !== "toolResult") // 独立工具结果行不渲染为消息
		.map(m => {
			if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
			const attach = m.content
				.filter((c): c is Extract<MessageContentDto, { type: "toolCall" }> => c.type === "toolCall")
				.map(c => resultByCall.get(c.id))
				.filter((r): r is Extract<MessageContentDto, { type: "toolResult" }> => r !== undefined);
			if (attach.length === 0) return m;
			return { ...m, content: [...m.content, ...attach] };
		});
}

function ensureLive(view: SessionView, prev: SessionView): TranscriptMessage {
	if (view.live) return view.live;
	const live: TranscriptMessage = {
		id: `live-${view.messages.length}`,
		role: "assistant",
		model: prev.model ?? undefined,
		tools: [],
		done: false,
	};
	view.live = live;
	return live;
}

function prettyArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	return Object.entries(args)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" · ");
}

function textOf(result: Extract<MessageContentDto, { type: "toolResult" }>): string {
	const parts = result.content ?? [];
	return parts
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map(p => p.text)
		.join("\n");
}

function ratioPercent(used: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(100, Math.round((used / total) * 100));
}

function errorMessageOf(err: unknown): string {
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
		return (err as { message: string }).message;
	}
	return String(err);
}

/** 单例导出。 */
const store = new SessionStore();
export function useSessionStore(): SessionStore {
	return store;
}
