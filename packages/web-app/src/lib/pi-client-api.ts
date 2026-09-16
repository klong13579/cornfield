import type {
	AgentInfoDto,
	AgentTodoDeleteDto,
	AgentTodoDto,
	AgentTodoListDto,
	AgentTodoUpsertDto,
	ArtifactDto,
	AvailableModelsDto,
	BroughtBackChildResultDto,
	ConfigInheritanceRestoreDto,
	ConfigScopeDto,
	ConnectionInfoDto,
	CronCreateInput,
	CronLogEntryDto,
	CronRemoveResultDto,
	CronTaskWriteResultDto,
	CronTestRunResultDto,
	CronUpdateInput,
	DashboardStatsDto,
	DelegateChildInput,
	DelegatedChildDto,
	EnvironmentSummaryDto,
	EvolvedSkillsDto,
	GitChangesDto,
	HostToolDefinitionDto,
	ImageContentDto,
	ListenRecordingDto,
	MemoryProjectionDto,
	MessageDto,
	ModelCatalogDto,
	ModelSelectionDto,
	ModelTestResultDto,
	ProjectDeleteDto,
	ProjectListDto,
	ProjectRecordDto,
	ProjectUpsertDto,
	ProviderDisconnectResultDto,
	ProviderListDto,
	ProviderOAuthStartDto,
	ProviderStatusDto,
	SessionSnapshotDto,
	SessionTreeDto,
	SkillsResultDto,
	StatsPeriodDto,
	TaskRowDto,
	TodoPhaseDto,
	ToolSwitchesDto,
	WireServerEventDto,
} from "@cornfield/wire";

// ArtifactDto / ArtifactsResultDto 由 pi-wire 定义，消费方（ArtifactsPanel 等）从本层引入。
// Session Tree / Project DTO（T8）与 Agent Todo DTO（T10A）同样由 pi-wire 定义：消费方从本层
// 引入，保证「一个概念一种表示」—— 前端不再自己拼一份子会话/项目/Todo 形状。
// 定时任务写面（T10C）同理：入参/回写形状都从 pi-wire 转发，前端不自建。
export type {
	AgentTodoDeleteDto,
	AgentTodoDto,
	AgentTodoListDto,
	AgentTodoPriorityDto,
	AgentTodoReminderDto,
	AgentTodoSourceDto,
	AgentTodoStatusDto,
	AgentTodoUpsertDto,
	ArtifactDto,
	BroughtBackChildResultDto,
	ChildSessionEscalationDto,
	ChildSessionNodeDto,
	ChildSessionStatusDto,
	CronCreateInput,
	CronRemoveResultDto,
	CronTaskWriteResultDto,
	CronTestRunResultDto,
	CronUpdateInput,
	DelegateChildInput,
	DelegatedChildDto,
	EvolvedSkillDto,
	EvolvedSkillsDto,
	GitChangeDto,
	GitChangeStateDto,
	GitChangesDto,
	ProjectDeleteDto,
	ProjectListDto,
	ProjectRecordDto,
	ProjectUpsertDto,
	ScheduleAgentResolution,
	SessionProjectSourceDto,
	SessionTreeDto,
	TaskDeliveryDto,
	TaskRetryDto,
} from "@cornfield/wire";

import type { BranchPoint, PlaybackEntry, SessionRecordSummary } from "./records";

/** fs_list 条目（agent workspace 目录项）。 */
export interface FsEntryDto {
	name: string;
	type: "dir" | "file";
	size: number;
}

/** fs_read_image 结果（R-IMG-SERVE：dataUrl + MIME + 大小/截断）。 */
export interface FsImageResult {
	dataUrl: string;
	mimeType: string;
	sizeBytes: number;
	truncated: boolean;
}

/**
 * fs_read 结果：正文 + 截断标记 + **磁盘内容身份**。
 *
 * `version` 是服务端对磁盘上那一份字节算出的身份（sha256，覆盖整个文件而非被截断的前段）：
 * 编辑器拿它当 base，保存时原样回传给 fs_write 做 compare-and-swap —— 「我改的是我读到的那一份」
 * 是唯一能让外部改写不被静默覆盖的判定依据。正文被截断时 version 仍然覆盖全文（尾部的改动
 * 也必须能被判定出来）。
 */
export interface FsReadResult {
	text: string;
	/** 磁盘字节超预算（128KiB）被裁剪：`text` **不是**全文，调用方不得据此整段写回。 */
	truncated: boolean;
	version: string;
}

/** fs_write 结果：落盘字节数 + 写入后文件的新身份（客户端直接采纳，免二次读）。 */
export interface FsWriteResult {
	path: string;
	bytesWritten: number;
	version: string;
	/**
	 * 落盘内容与请求正文不同（服务端 writethrough 改写过，如 `lsp.formatOnWrite`）。
	 * true 时客户端必须回读一次同步编辑器——否则屏幕上留着的是发出去的文本，不是文件现在的样子。
	 */
	normalized: boolean;
}

/** fs_diff 结果（与 coding-agent `generateUnifiedDiffString` 同形的带行号统一 diff）。 */
export interface FsDiffResult {
	diff: string;
	firstChangedLine?: number;
}

/**
 * 保存被拒绝：文件在磁盘上已不是编辑器读到的那一份（fs_write 的 compare-and-swap 失败）。
 *
 * 这是**可恢复**的判决，不是故障：调用方应当重新读一次磁盘、把差异摆给用户看，
 * 再让用户决定保留哪一份。服务端在拒绝时一个字节都没写 —— 抛错即「磁盘上仍是别人的版本」。
 */
export class FsConflictError extends Error {
	/** 服务端原始判决文本（`fs_conflict: expected <version>, actual <version>`）。 */
	readonly detail: string;

	constructor(detail: string) {
		super("文件已在磁盘上被外部修改，保存已拒绝");
		this.name = "FsConflictError";
		this.detail = detail;
	}
}

/**
 * 听记历史条目（listen_list：单条录音的元数据 + 转写全文 + 来源标注）。
 *
 * T10C：改用 pi-wire 的规范形状（`@cornfield/wire` 的 `ListenRecordingDto`），serve 侧
 * `stt/listen-service.ts` 也 import 同一份 —— 听记条目只有一种表示，两端不再各写一遍。
 */
export type { ListenProvenanceDto, ListenRecordingDto } from "@cornfield/wire";

/**
 * list_remote_skills 返回的远程可装项（契约命令，h1 serve 端并行实现，运行期对齐）。
 * type: 'skill' 技能 / 'plugin' 插件；source 为来源标识（插件市场源 URL/名）；
 * homepage/repository/author/version 供 Hub 详情与链接（catalog 无评分字段，排名由前端按 name 序号给出）。
 */
export interface RemoteSkillItemDto {
	name: string;
	description?: string;
	source: string;
	type: "skill" | "plugin";
	category?: string;
	homepage?: string;
	repository?: string;
	author?: string;
	version?: string;
}

/**
 * Skills / Memory 工作台的 scope 契约（T10B）。
 *
 * 形状的权威在 `@cornfield/wire`（serve 生产、web-app 消费同一份）——
 * 这里只做转发，不再自己声明一份同形接口（否则两端漂移不会被编译期抓住）。
 */
export type {
	MemoryEntryDto,
	MemoryFileZoneDto,
	MemoryProjectionDto,
	MemoryResolutionDto,
	MemoryScope,
	MemorySectionDto,
	MemorySessionZoneDto,
	MemoryStoreDto,
	MemoryTextFileDto,
	Scope,
	SkillActivation,
	SkillBlockedDto,
	SkillLoadErrorDto,
	SkillScopeFactsDto,
	SkillScopeRowDto,
	SkillStatus,
	SkillsResultDto,
} from "@cornfield/wire";

/**
 * 新建会话的入参（new_session）。
 *
 * 三项都是**请求**，都被这一条命令带上 wire，但只有「真的建了」才是事实：serve 可以拒
 * （`ok:false`，如未知 projectId、目标 Agent 没 attach），也可以接而不做（`cancelled:true`）。
 * 两种都不是「建成了」，见 {@link NewSessionResult} 与 store 的 `NewSessionOutcome`。
 */ export interface NewSessionOptions {
	/**
	 * 目标 Agent（注册表名）→ wire `new_session` 的 `sessionId`。缺省 = 本连接当前焦点 agent。
	 *
	 * serve 的路由规则：该 Agent 要**已经 attach** 过，否则整条命令 ok:false
	 * （`agent not attached: X (send attach first)`）。这里不代调用方 attach —— 把一个 Agent
	 * 拉起来是另一个动作，隐藏它会让调用方以为「切过去了」而实际上只是建了个会话。
	 */
	agentId?: string;
	/** 标题 → wire `set_session_name`（wire 没有「创建时命名」这条命令，只能是创建后紧跟一次改名）。 */
	title?: string;
	/**
	 * 目标 Project → wire `new_session` 的 `projectId`，即这个会话的**权威归属**
	 * （serve 按它解析工作根与边界根，`SessionHeader.projectId` 记下这个事实）。
	 *
	 * 缺省 = 这个会话不声明归属：行为与今天一致（落在 serve 的启动根），**不**静默落回启动根
	 * 冒充「已经归属某个 Project」。
	 *
	 * 未知 id 不会被悄悄忽略：serve 直接 ok:false，错误原文由调用方原样显示（不吞）。
	 */
	projectId?: string;
}

/**
 * 新建会话的结果 —— 回答「真的建了吗」+「哪些入参没落地」。
 *
 * 命令本身的传输失败不走这里：失败抛错（未连接 / serve 拒绝），与其它写命令同一个约定。
 * 但 **serve 接了命令不等于建了会话** —— `new_session` 可以回 `cancelled:true`（比如上一回合
 * 还没收尾），那是一个 ok:true 的空动作。把它当成功就是把界面切成一个不存在的会话。
 */
export interface NewSessionResult {
	/**
	 * serve 是否为这次请求真的开了新会话。
	 *
	 * false = 回了 `cancelled:true`：新会话不存在，界面不得切成它（标题也不会被落上 ——
	 * 那一跳会改到**上一个**会话的名字）。
	 */
	created: boolean;
	/**
	 * 本次请求里 wire **表达不出来**的入参名（空数组 = 全部落上了）。
	 *
	 * 这个出口必须留着：将来有一个 wire 上表达不出来的字段时，字段名要出现在这里，
	 * 而不是被静默丢掉 —— 静默丢弃会让调用方把一个**没发生**的事实渲染成已生效。
	 *
	 * 今天**恒为空**：三个入参都有去处（`agentId` → `new_session.sessionId`，
	 * `projectId` → `new_session.projectId`，`title` → 创建后紧跟一次 `set_session_name`）。
	 * `projectId` 曾经在这个列表里，那是「归属只能由 serve 按 cwd 算出来」的年代留下的。
	 */
	notApplied: string[];
}

export interface GatewayGroupInfo {
	channelId: string;
	title: string;
	conversationId: string;
	lastActive: number;
}

/** gateway 运行状态（gateway_status 命令转发 gateway.status.json）。 */
export interface GatewayStatusDto {
	pid?: number;
	statusWrittenAt?: number;
	/** 状态文件是否陈旧（写入距今 > 30s —— gateway 可能已退出）。 */
	stale: boolean;
	accounts: {
		accountId: string;
		bridgeRunning?: boolean;
		bridgeState?: string;
		channelConnected?: boolean;
		agentDir?: string;
		groups?: GatewayGroupInfo[];
	}[];
	scheduler?: { running?: boolean; taskCount?: number } | null;
}

/**
 * 账号级动态可 patch 字段（set_gateway_account 写面，与 gateway wire 白名单一致）。
 * 凭证类（appSecret/appKey）刻意不在内 —— 前端不落明文密钥。
 */
export interface GatewayAccountPatchDto {
	enabled?: boolean;
	robotName?: string;
	robotCode?: string;
	agentDir?: string;
	deniedTools?: string[];
	hideThinkingBlock?: boolean;
}

/** MCP 服务器条目（get_mcp_servers 返回；serve 端契约命令，与 m1 字符串契约对接）。 */
export interface McpServerDto {
	name: string;
	command: string;
	args: string[];
	enabled: boolean;
}

/** 诊断报告列表项（list_diagnosis_reports 返回）。 */
export interface DiagnosisReportListItemDto {
	reportId: string;
	sessionId: string;
	sessionFile?: string;
	/** P0/P1/P2/P3 */
	severity: string;
	/** A-F */
	delivery: string;
	/** A-F */
	process: string;
	title: string;
	reportAt?: string;
	reportPath?: string;
}

/** 诊断报告摘要（get_diagnosis_report → summary）。 */
export interface UserCorrectionDto {
	turn: number;
	userText: string;
	targetDim: "intent" | "tool" | "output" | "reasoning" | "meta";
	intent: "correction" | "clarification" | "rejection";
	isValid: boolean;
	isResolved: boolean;
	precedingContext: string;
}

export interface DiagnosisSummaryDto {
	reportId: string;
	sessionId: string;
	sessionFile?: string;
	severity: string;
	delivery: string;
	process: string;
	title: string;
	rootCause?: string;
	topActions?: string[];
	/** dimensionKey → detail */
	dimensions?: Record<string, DiagnosisDimensionDto>;
	corrections?: UserCorrectionDto[];
	reportAt?: string;
	hasSummary?: boolean;
}

export interface DiagnosisAggregationDto {
	totalSessions: number;
	severityDistribution: Record<string, number>;
	dimensionReports?: Record<
		string,
		Array<{
			reportId: string;
			sessionId: string;
			sessionFile: string;
			severity: string;
			title: string;
			dimState: "ok" | "warn" | "fail";
			reportAt: string;
		}>
	>;
	dimensionFailureRates: Record<string, { ok: number; warn: number; fail: number; failRate: number }>;
	deliveryDistribution: Record<string, number>;
	processDistribution: Record<string, number>;
	topIssues: Array<{ title: string; count: number; severity: string }>;
	weeklyTrend: Array<{ weekStart: string; total: number; p0: number; p1: number; p2: number; p3: number }>;
}

/** 单维度详情。 */
export interface DiagnosisDimensionDto {
	state: "ok" | "warn" | "fail";
	summary: string;
	basis?: string;
	rows?: { label: string; value: string }[];
	evidence?: { turn: number; kind: string; quote: string }[];
	fix?: string;
}
/**
 * serve get_session_messages 返回的 message 条目 —— 与 get_messages 的 AgentMessage 同型
 * （前端渲染子集即 wire MessageDto：user/assistant/toolResult，含独立 toolResult 顶层消息）。
 */
export type AgentMessageDto = MessageDto;

/**
 * pi-client 接口契约（Web 壳消费的唯一数据面）。
 *
 * 形态对齐 requirements.md FR-1 与 pi-wire 的 snapshot/progress 语义：
 * - `session_snapshot` 为权威缓存（getSnapshot/subscribe 重建 UI）
 * - `progress` 只做事件通知（subscribe 回调中的 progress 事件，UI 层不得归约为权威状态）
 * - 命令面覆盖 workspace 需要的 12+ 条（prompt/abort/set_model/set_todos/…）
 *
 * 实现：`state/client.ts` 的 `createClient()` 返回 PiClientAdapter（真 pi-client 适配）。
 */
export interface PiClient {
	/** hello 握手建立连接（指数退避重连由实现管理）。 */
	connect(): Promise<ConnectionInfoDto>;
	disconnect(): void;
	getConnection(): ConnectionInfoDto;
	/** 权威快照缓存（连接成功前为 null）。 */
	getSnapshot(): SessionSnapshotDto | null;
	getServerAgents(): AgentInfoDto[];
	getEnvironment(): EnvironmentSummaryDto | null;
	/** 订阅推送帧（session_snapshot / progress / server_snapshot），返回退订函数。 */
	subscribe(listener: (frame: WireServerEventDto) => void): () => void;
	/** 连接状态订阅（断线重连等）。 */
	subscribeConnection?(listener: (conn: ConnectionInfoDto) => void): () => void;

	// ── 命令面（12 条 workspace 命令子集）──
	prompt(text: string, sessionId?: string, images?: ImageContentDto[]): Promise<void>;
	abort(): Promise<void>;
	/** abort_retry：中止当前重试流。 */
	abortRetry(): Promise<void>;
	/** 前端已注册的 host tools（set_host_tools 本地态）。 */
	getHostTools(): HostToolDefinitionDto[];
	compact(): Promise<void>;
	/**
	 * 新建会话（new_session）。`opts.agentId` 定向目标 Agent（wire 的 `sessionId`），
	 * `opts.projectId` 定为权威归属（wire 的 `projectId`），`opts.title` 在创建后用
	 * `set_session_name` 落上。失败抛错 —— serve 的拒绝是 `PiServerError`（错误原文在
	 * `serverError` 上），与其它写命令同一个约定。
	 *
	 * 三个入参今天都发得出去；万一将来有表达不出来的，走 {@link NewSessionResult}.`notApplied`
	 * 报出去，不静默丢。
	 */
	newSession(opts?: NewSessionOptions): Promise<NewSessionResult>;
	forkFrom(entryId: string): Promise<void>;
	undoExchange(entryId: string): Promise<void>;
	retryFrom(entryId: string, message?: string): Promise<void>;
	setModel(modelId: string, provider?: string, sessionId?: string): Promise<void>;
	setThinkingLevel(level: string, sessionId?: string): Promise<void>;
	/** 读目标 agent 的 config.yml 域（per-agent）。 */
	getConfig(sessionId: string, key?: string): Promise<{ config: unknown }>;
	/** 写目标 agent 的 config.yml 域并持久化（per-agent）。 */
	setConfig(sessionId: string, key: string, value: unknown): Promise<{ ok: boolean; key: string; value: unknown }>;
	/** 工具开关语义视图（per-agent）。 */
	getToolSwitches(sessionId: string): Promise<ToolSwitchesDto>;
	setTodos(phases: TodoPhaseDto[]): Promise<void>;
	setAutoCompaction(enabled: boolean): Promise<void>;
	setAutoRetry(enabled: boolean): Promise<void>;
	getAvailableModels(): Promise<AvailableModelsDto>;

	/**
	 * 停用/恢复 provider（modelId 缺省）或单个模型（provider/modelId 精确 pattern）。
	 * 写 settings（~/.cornfield/agent/config.yml）并即时生效；返回最新停用名单供 UI 同步。
	 */
	setModelDisabled(
		provider: string,
		modelId: string | undefined,
		disabled: boolean,
	): Promise<{ ok: boolean; disabledProviders: string[]; disabledModels: string[] }>;

	// ── 模型控制中心（#02 全量目录 / #03 Provider 接入 / #05 配置作用域）──
	/** #02 全量模型目录（get_model_catalog：含未接入 provider，六态 status 区分）。 */
	fetchModelCatalog(): Promise<ModelCatalogDto>;
	/** #05 模型选择两层视图（get_model_selection：会话临时/持久默认语义读写两侧可区分）。 */
	fetchModelSelection(): Promise<ModelSelectionDto>;
	/** 会话级临时切换模型（set_model_temporary：仅本会话，不写 settings）。 */
	setModelTemporary(providerId: string, modelId: string): Promise<void>;
	/** 持久化默认模型（set_model：serve 侧写 settings.modelRoutes.default.primary 并持久化）。 */
	setPersistentDefaultModel(providerId: string, modelId: string): Promise<void>;
	/** #05 按作用域写配置（set_config；global 写全局 config.yml，project 写 .cornfield/config.yml）。 */
	setConfigValue(key: string, value: unknown, scope: "global" | "project"): Promise<void>;
	/** #03 Provider 状态列表（get_providers；响应只含掩码密钥，不回显明文）。 */
	fetchProviders(): Promise<ProviderListDto>;
	/** #03 单个 Provider 状态（get_provider；未知 providerId 抛错）。 */
	fetchProvider(providerId: string): Promise<ProviderStatusDto>;
	/** #03 发起 OAuth 登录（start_provider_oauth；requiresManualCode 流需随后 completeProviderOauth）。 */
	startProviderOauth(providerId: string): Promise<ProviderOAuthStartDto>;
	/** #03 提交 OAuth 手输 code / 粘贴 key（complete_provider_oauth）；返回最新状态。 */
	completeProviderOauth(providerId: string, code: string): Promise<ProviderStatusDto>;
	/** #03 保存/替换 API Key（save_provider_api_key；明文只进请求载荷，响应仅掩码）。 */
	saveProviderApiKey(providerId: string, apiKey: string): Promise<ProviderStatusDto>;
	/** #03 删除已存 API Key（delete_provider_api_key；幂等）。 */
	deleteProviderApiKey(providerId: string): Promise<ProviderStatusDto>;
	/** #03 设置自定义 Base URL（set_provider_base_url；null 清除覆盖）。 */
	setProviderBaseUrl(providerId: string, baseUrl: string | null): Promise<ProviderStatusDto>;
	/** #03 断开 provider（disconnect_provider；有依赖未 force 时 disconnected:false + 依赖清单）。 */
	disconnectProvider(providerId: string, force: boolean): Promise<ProviderDisconnectResultDto>;
	/** #03 单 provider 目录刷新（refresh_provider；online 强制）。 */
	refreshProvider(providerId: string): Promise<ProviderStatusDto>;
	/** #04 全量目录刷新（refresh_catalog；registry 级并行，返回刷新后的完整目录）。 */
	refreshCatalog(): Promise<ModelCatalogDto>;
	/** #04 单模型连通性测试（test_model；真实调用会产生费用，UI 必须先确认）。 */
	testModel(providerId: string, modelId: string): Promise<ModelTestResultDto>;
	/** #05 配置作用域读取（get_config_scope：hasProjectConfig + 可覆盖键三层取值）。 */
	fetchConfigScope(): Promise<ConfigScopeDto>;
	/** #05 恢复继承（restore_config_inheritance：删除项目覆盖键而非复制值）。 */
	restoreConfigInheritance(key: string): Promise<ConfigInheritanceRestoreDto>;

	// ── P3 多 Agent ──
	/** 拉取注册表 agent 元数据列表（list_agents，不触发 attach）。 */
	listAgents(): Promise<AgentInfoDto[]>;
	/** lazy attach 一个注册表 agent 到本进程（attach）。 */
	attach(sessionId: string): Promise<void>;
	/** 切换本连接的活动会话（switch_session；server 随后推新 session_snapshot）。 */
	switchSession(sessionId: string): Promise<void>;
	/** 注册 host tool 声明（set_host_tools；双向帧协议见 wire frames）。 */
	setHostTools(tools: HostToolDefinitionDto[]): Promise<void>;
	/** host tool 执行结果回传（host_tool_result client frame；视 pi-client 支持与否）。 */
	hostToolResult?(id: string, resultText: string, isError?: boolean): void;
	/** 用户裁决回传（permission_respond；approval 白名单 deny|once|session|always，clarify 为 option 文本）。 */
	permissionRespond(requestId: string, choice: string): Promise<void>;

	// ── P4 会话记录（serve 已实现 get_messages/get_session_stats/get_branch_messages）──
	/** 拉取当前 attached session 的全部消息（get_messages），转播放时间线。 */
	getMessages(): Promise<PlaybackEntry[]>;
	/** 拉取原始消息 JSON 序列（导出 JSONL 用，不转换）。 */
	getRawMessages(): Promise<unknown[]>;
	/** 按 sessionFile 拉取历史会话消息（get_session_messages；serve 端契约命令，运行期对齐）。 */
	getSessionMessages(sessionFile: string): Promise<AgentMessageDto[]>;
	/** 分支候选（get_branch_messages：用户消息分支点 {entryId,text}）。 */
	getBranchMessages(): Promise<BranchPoint[]>;
	/** 历史会话索引（list_sessions；be-dev 就绪后返回真数据，未实现时返回基础查询）。 */
	listSessions(): Promise<SessionRecordSummary[]>;

	// ── Session Tree（T8：父会话的委派账本 + 结果带回）──
	/**
	 * 读一个会话直接委派出去的子会话（get_session_tree）。
	 * 只回答这一层：孙会话在子会话自己的日志里，要展开拿它的 sessionId 再查一次。
	 * sessionId 定向注册表 agent，缺省 = 本连接当前焦点会话；无附着会话/未知 agent 招错。
	 */
	getSessionTree(sessionId?: string): Promise<SessionTreeDto>;
	/**
	 * 把一个子会话委派出去（delegate_child）。
	 *
	 * 成功才回一条**真实启动**的子会话记录；起不来、没通过注册门（子进程没真的以本会话为
	 * parent 挂上 broker）、目标 Agent 不存在、父会话上不了 broker —— 全部招错，错误文本就是
	 * serve 给的真实原因。调用方不得把它当成「已提交，稍后可能有」：没有 OK 就没有子会话。
	 */
	delegateChild(input: DelegateChildInput, sessionId?: string): Promise<DelegatedChildDto>;
	/**
	 * 把子会话的结果带回父会话（bring_back_child_result）。
	 * 幂等：`firstTime:false` 表示此前已带回 —— 调用方不得重复注入同一份结果。
	 */
	bringBackChildResult(childSessionId: string, sessionId?: string): Promise<BroughtBackChildResultDto>;

	// ── Project（T8：客户端级 Project registry）──
	/**
	 * 已声明的 Project + 被查询会话落在哪个 Project（list_projects）。
	 *
	 * 读不出来（存储损坏）会招错，**不**退化成空列表 —— 调用方必须把「没声明过」与
	 * 「声明过但读不到」分开显示。sessionId 缺省 = 只要列表，不算会话归属。
	 */
	listProjects(sessionId?: string): Promise<ProjectListDto>;
	/**
	 * 声明或更新一个 Project（set_project），返回存储真正落盘的那一份。
	 *
	 * 形状复用读模型 `ProjectRecordDto`（存储的就是一份 `ProjectRecord`，不是第二套写入形状）；
	 * `defaultAgentId` 缺省 = 不声明默认 Agent。`root` 必须是绝对路径，`root` 已被别的 Project
	 * 占用也会招错 —— 失败**原样招错**，不静默改写别人的声明。
	 */
	setProject(project: ProjectRecordDto): Promise<ProjectUpsertDto>;
	/**
	 * 删掉一个已声明的 Project（delete_project）。
	 *
	 * 幂等：再删一次（已经不在）会招错，不是一次成功的空删除 —— 报「删掉了」而实际上早就不在，
	 * 就是在拿一个不是这次调用的结果冒充这次调用的结果。
	 */
	deleteProject(projectId: string): Promise<ProjectDeleteDto>;

	// ── Agent Todo（T10A：Agent 级 Todo 板，owner = Agent、Project 可选绑定）──
	/**
	 * 读一个 Agent 的整块 Todo 板（list_agent_todos）。
	 *
	 * 读不出来（存储损坏 / 版本不符）会招错，**不**退化成空板 —— 调用方必须把「没记过」
	 * 与「记过但读坏了」分开显示。sessionId 缺省 = 本连接当前焦点的 Agent。
	 */
	listAgentTodos(sessionId?: string): Promise<AgentTodoListDto>;
	/**
	 * 新建或更新一条 Todo（set_agent_todo），返回存储真正落盘的那一份。
	 *
	 * `createdAt` / `updatedAt` 由存储盖章、`sessionRefs` 由存储保留，所以调用方必须用返回的
	 * 记录替换自己手上那份。owner 与 Project 绑定由 serve 校验（不属于这个 Agent 的板子、
	 * 没声明过的 Project、绑定范围外的 Project、声明读不出来的 Agent 都会招错）。
	 */
	setAgentTodo(todo: AgentTodoDto, sessionId?: string): Promise<AgentTodoUpsertDto>;
	/** 删除一条 Todo（delete_agent_todo）。幂等：本来就不在板上返回 deleted:false。 */
	deleteAgentTodo(todoId: string, sessionId?: string): Promise<AgentTodoDeleteDto>;

	/** 诊断会话（diagnose_session；异步启动诊断，返回任务句柄）。 */
	diagnoseSession(sessionFile: string): Promise<{ reportId: string; sessionId: string; state: "running" | "done" }>;
	/** 列出诊断报告与后台任务（list_diagnosis_reports）。 */
	listDiagnosisReports(sessionFile?: string): Promise<{ reports: DiagnosisReportListItemDto[]; tasks: any[] }>;
	/** 获取单个诊断报告详情（get_diagnosis_report）。 */
	getDiagnosisReport(reportId: string): Promise<{ markdown: string; summary: DiagnosisSummaryDto } | null>;
	/** 多会话诊断聚合统计（aggregate_diagnosis）。 */
	aggregateDiagnosis(opts?: { since?: number; until?: number; agentId?: string }): Promise<DiagnosisAggregationDto>;
	// ── 文件系统（Agent 详情页只读浏览）──
	/** 列出 agent workspace 目录（fs_list，相对 agentDir；省略 path = 根）。 */
	fsList(sessionId: string, path?: string): Promise<{ entries: FsEntryDto[] }>;
	/**
	 * 读 agent workspace 文件（fs_read）。
	 *
	 * 磁盘字节 > 128KiB 就截断并标记 `truncated`（按**字节**判、UTF-8 安全截断；不是按字符数），
	 * `version` = 整份文件的磁盘内容身份。编辑器用 `truncated` 决定只读降级 —— 漏报一次就会
	 * 让人拿半份内容写回、把文件真截断。
	 */
	fsRead(sessionId: string, path: string): Promise<FsReadResult>;
	/**
	 * 整段写文件（fs_write）。
	 *
	 * `expectedVersion` **必填**（新建文件传空串）：服务端核对磁盘现状后才会写，不一致就拒绝，
	 * 一个字节都不落盘。让它必填而不是可选，是因为「可选 = 忘传就能静默覆盖外部修改」。
	 * 拒绝时抛 {@link FsConflictError}。
	 */
	fsWrite(sessionId: string, path: string, content: string, expectedVersion: string): Promise<FsWriteResult>;
	/**
	 * 两段纯文本的统一 diff（fs_diff 的 before/after 分支，不落地）。
	 * 保存预览与外部冲突对比共用它 —— 前端不再实现第二套 diff 生成。
	 */
	fsDiff(before: string, after: string): Promise<FsDiffResult>;
	/** 读 agent workspace 图片（fs_read_image；dataUrl，2MB 上限，MIME 按扩展名）。 */
	fsReadImage(sessionId: string, path: string): Promise<FsImageResult>;
	// ── Git 工作区改动（Changes 视图；契约命令 git_changes，serve 端经 ticket 实现）──
	/**
	 * 一个 agent 工作区的改动清单（git_changes）。
	 *
	 * 空清单 = **读到了，工作区确实干净**；读不到（不是 git 仓库 / git 失败 / 未知 agent）抛错
	 * —— 调用方必须把「没有改动」与「读失败」分开显示，不许把后者渲染成前者。
	 * sessionId 定向 agent（缺省 = 本连接焦点 agent）。
	 */
	getGitChanges(sessionId?: string): Promise<GitChangesDto>;

	/** 产物列表（list_artifacts；从会话 toolCall 提取写出文件，按 mtime 倒序）。
	 * `sessionId` 是 **wire 定向身份**（会话身份 = 附件地址），不是 Agent 名。 */
	listArtifacts(sessionId: string, sessionFile?: string): Promise<{ artifacts: ArtifactDto[] }>;
	/** 产物静态预览 URL（/preview/<附件地址>/<relpath>，serve 端只读 docroot 路由）。
	 * 第一段传**会话身份**（`SessionView.attachmentAddress`）；serve 也认 Agent 名，但那解到的是
	 * 该 Agent **未绑定**的附件（另一个根），绑了 Project 的产物会 404。 */
	artifactPreviewUrl(attachmentAddress: string, path: string): string;
	/** 本机 gateway 运行状态（gateway_status；未运行/文件缺失抛错）。 */
	gatewayStatus(): Promise<GatewayStatusDto>;

	/**
	 * 动态账号热生效（set_gateway_account）：写 gateway.json accounts.<id> 白名单
	 * 字段并触发 gateway 进程内 reload（只重建受影响账号，不重启 gateway）。
	 * appSecret/appKey 不在写面 —— 凭证维护走 `$ENV_VAR` 引用或 setup 向导。
	 */
	setGatewayAccount(accountId: string, patch: GatewayAccountPatchDto): Promise<{ ok: boolean }>;

	/** 进程内 reload（reload_gateway；兜底手动触发配置热生效）。 */
	reloadGateway(): Promise<{ ok: boolean }>;

	// ── 用量统计（W3 D2 InsightsPanel）──
	/**
	 * 本地用量统计（get_stats，只读）。period 可选时间窗口（1d/7d/30d/90d/all）。
	 * 失败/未连接抛错，由调用方渲染空态。
	 */
	getStats(period?: StatsPeriodDto): Promise<DashboardStatsDto>;

	// ── 记忆投影（W3 D3 MemoryPanel；T10B 改为按 Agent/Project/Session/User scope 分区）──
	/**
	 * 记忆投影（get_memory，只读）——按 scope 分区：user（user.md）/ agent（Agent 记忆 home）/
	 * project（会话所在 Project）/ session（本会话 stage-1 记忆）/ memoryStore（全局库）。
	 * sessionId 定向 agent（缺省 = 本连接焦点 agent）；失败/未连接抛错，由调用方渲染错误态。
	 */
	getMemory(sessionId?: string): Promise<MemoryProjectionDto>;

	// ── 技能（W3 D5 SkillsPanel；T10B 补 scope/来源/版本/激活/错误）──
	/**
	 * 已加载技能 + 停用名单 + 被挡住的技能 + 发现错误（get_skills，只读）。
	 * sessionId 定向 agent（缺省 = 本连接焦点 agent）；失败/未连接抛错。
	 */
	getSkills(sessionId?: string): Promise<SkillsResultDto>;

	// ── 演化技能（self-evolution 提炼结果；契约命令 get_evolved_skills）──
	/**
	 * 演化系统沉淀的技能（get_evolved_skills，只读）。
	 *
	 * 与 `getSkills` 是两件事（磁盘发现 vs 演化产出），不合并。空清单 = 确实一条都没有；
	 * 读不到（库在但打不开）抛错 —— 那是读取失败，不是「还没演化出技能」。
	 * sessionId 定向 agent（缺省 = 本连接焦点 agent）。
	 */
	getEvolvedSkills(sessionId?: string): Promise<EvolvedSkillsDto>;

	// ── 队列（协议批 B-2）──
	/** 排队文本（get_state 的 queued 字段；快照只有计数）。 */
	fetchQueue(): Promise<{ steering: string[]; followUp: string[] }>;
	/** 取消最近一条排队消息（cancel_queued；空队列返回 cancelled:false）。 */
	cancelQueued(): Promise<{ cancelled: boolean; text?: string }>;

	// ── 命令表（协议批 B-3）──
	/** TUI slash 命令表（list_commands；W1 SlashPalette 真源）。 */
	listCommands(): Promise<{ name: string; description: string }[]>;

	// ── cron 只读代理（P2-W3-1 B6）──
	/** gateway cron 任务表（get_cron_tasks；jobs.json 直读）。 */
	getCronTasks(): Promise<{ tasks: TaskRowDto[] }>;
	/** cron 执行日志（get_cron_logs；logs/by-task 直读，taskId/days/limit 可选）。 */
	getCronLogs(opts?: { taskId?: string; days?: number; limit?: number }): Promise<{ logs: CronLogEntryDto[] }>;

	// ── 技能启停（P2-W3-3 B3 写协议）──
	/** 启停技能（set_skill_enabled；serve 写该 agent 自己的 config.yml + 重发现热重载）。 */
	setSkillEnabled(
		name: string,
		enabled: boolean,
		sessionId?: string,
	): Promise<{ ok: boolean; name: string; enabled: boolean }>;

	// ── 开源 Skill Hub（h1 契约：list_remote_skills / install_remote_skill；WireCommand union 暂缺故适配器 cast）──
	/**
	 * 远程技能市场列表（list_remote_skills；source 缺省用插件市场默认源）。
	 * 失败/未连接抛错，由调用方渲染空态。
	 */
	listRemoteSkills(source?: string): Promise<RemoteSkillItemDto[]>;
	/**
	 * 安装远程技能（install_remote_skill；下载/克隆到 skills 对应来源子目录）。
	 * 已存在返回 alreadyInstalled:true 不重复克隆；失败抛错由调用方提示。
	 */
	installRemoteSkill(source: string, name: string): Promise<{ path: string; alreadyInstalled: boolean }>;

	// ── 听记（VOICE-D：/voice 听记 tab）──
	/**
	 * 上传浏览器录音（16kHz mono PCM WAV base64）→ serve 转写（TUI /record 同管线：本地
	 * whisper / record.model API，自动分块）→ 落 ~/.cornfield/listen/。返回转写文本 + 落盘路径 + 模型。
	 */
	recordTranscribe(
		audioBase64: string,
		desc?: string,
	): Promise<{
		ok: boolean;
		text: string;
		path: string;
		model: string;
		error?: string;
	}>;

	/** 听记历史（listen_list：~/.cornfield/listen/ 全部录音 json，名称倒序 + 转写全文，前端本地搜索/预览）。 */
	listenList(): Promise<{ ok: boolean; recordings: ListenRecordingDto[] }>;

	/**
	 * 新建调度定义（cron_create → gateway POST /wire）。
	 *
	 * `input.agentId`/`input.agentDir` 至少给一个：网关用 agent-domain 解析成
	 * `{ agentId, agentDir }` 再落盘（就是「持久化 resolved agentId」）。解析不到 → 抛错，
	 * 不写一条跑不起来的调度。回写落盘后的行（含 agentResolution）。
	 */
	cronCreate(input: CronCreateInput): Promise<CronTaskWriteResultDto>;
	/** 改调度定义/改绑 Agent（cron_update；`taskId` 是调度定义 id，不是关联 id）。 */
	cronUpdate(taskId: string, input: CronUpdateInput): Promise<CronTaskWriteResultDto>;
	/** 删除调度定义（cron_remove）；返回被删掉的任务名。 */
	cronRemove(taskId: string): Promise<CronRemoveResultDto>;
	/**
	 * 试跑（cron_test_run）：把调度临时改成一次性并触发，跑完自行恢复（test-run marker）。
	 * 无可用 Agent 绑定的任务会被网关拒绝（否则操作者只等到超时，看不到真实原因）。
	 */
	cronTestRun(name: string, inMs?: number): Promise<CronTestRunResultDto>;

	/**
	 * 分帧转写（长录音）：base64 超 Bun WS 单帧 16MB 上限时走 begin→chunk→end。
	 * onProgress 每帧上报累计已传帧数/总帧数，用于「上传中 x/y」提示。
	 */
	recordTranscribeChunked(
		audioBase64: string,
		desc?: string,
		onProgress?: (sent: number, total: number) => void,
	): Promise<{ ok: boolean; text: string; path: string; model: string; error?: string }>;

	// ── MCP 服务器管理（设置页；契约命令 get_mcp_servers / set_mcp_server / remove_mcp_server / test_mcp_server，由 serve 端并行实现）──
	/** 列出 MCP 服务器（get_mcp_servers；读 ~/.cornfield/agent/mcp.json 的 mcpServers）。 */
	getMcpServers(): Promise<{ servers: McpServerDto[] }>;
	/** 新增/更新 MCP 服务器（set_mcp_server upsert；name 必填，command/args/enabled 可选缺省）。 */
	setMcpServer(input: {
		name: string;
		command?: string;
		args?: string[];
		enabled?: boolean;
	}): Promise<{ ok: boolean }>;
	/** 删除 MCP 服务器（remove_mcp_server；幂等，不存在也返回 ok）。 */
	removeMcpServer(name: string): Promise<{ ok: boolean }>;
	/** 测试 MCP 服务器（test_mcp_server；JSON-RPC initialize 握手，8s 超时）。 */
	testMcpServer(name: string): Promise<{ ok: boolean; message: string }>;
}
