import type {
	AgentInfoDto,
	AvailableModelsDto,
	ConfigInheritanceRestoreDto,
	ConfigScopeDto,
	CronLogEntryDto,
	DashboardStatsDto,
	DisabledSkillDto,
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
	ProviderDisconnectResultDto,
	ProviderListDto,
	ProviderOAuthStartDto,
	ProviderStatusDto,
	SessionPhaseDto,
	SessionSnapshotDto,
	SkillDto,
	StatsPeriodDto,
	TaskRowDto,
	TodoPhaseDto,
	ToolSwitchesDto,
	WireServerEventDto,
} from "@cornfield/wire";
import { loadNotifyPrefs, notifyGuarded } from "../lib/notifications";
import type {
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
	#setActiveAgent(agentId: string, workspace?: string): void {
		this.#activeAgentId = agentId;
		this.#activeWorkspace = workspace;
		const view = cloneView(this.getSnapshot());
		view.activeAgentId = agentId;
		view.activeWorkspace = workspace;
		this.#view = view;
		this.#notify();
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

	async openHistorySession(record: { id: string; agent: string; sessionFile?: string; cwd?: string }): Promise<void> {
		const agents = this.#client.getServerAgents();
		const agentId = agents.find(a => a.id === record.agent || a.name === record.agent)?.id ?? record.agent;

		try {
			await this.#client.switchSession(agentId);
			// cli 会话显示其打开目录（header.cwd），agent 会话回落 agentDir
			this.#setActiveAgent(agentId, this.#workspaceShortOf(record.cwd, agentId));
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

	/** 记忆投影（get_memory，代理到 pi-client；展示层自行持有状态）。 */
	fetchMemory(): Promise<MemoryProjectionDto> {
		return this.#client.getMemory();
	}

	/** 已加载技能 + 已停用名单（get_skills，代理到 pi-client；展示层自行持有状态）。 */
	fetchSkills(): Promise<{ skills: SkillDto[]; disabled: DisabledSkillDto[] }> {
		return this.#client.getSkills();
	}

	/** 启停技能（set_skill_enabled，代理到 pi-client）。 */
	setSkillEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; name: string; enabled: boolean }> {
		return this.#client.setSkillEnabled(name, enabled);
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

	/** gateway cron 任务表（get_cron_tasks，代理到 pi-client）。 */
	fetchCronTasks(): Promise<{ tasks: TaskRowDto[] }> {
		return this.#client.getCronTasks();
	}

	/** cron 执行日志（get_cron_logs，代理到 pi-client）。 */
	fetchCronLogs(opts?: { taskId?: string; days?: number; limit?: number }): Promise<{ logs: CronLogEntryDto[] }> {
		return this.#client.getCronLogs(opts);
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
