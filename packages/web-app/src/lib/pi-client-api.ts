import type {
	AgentInfoDto,
	ArtifactDto,
	AvailableModelsDto,
	ConfigInheritanceRestoreDto,
	ConfigScopeDto,
	ConnectionInfoDto,
	CronLogEntryDto,
	DashboardStatsDto,
	DisabledSkillDto,
	EnvironmentSummaryDto,
	HostToolDefinitionDto,
	ImageContentDto,
	MemoryProjectionDto,
	MessageDto,
	ModelCatalogDto,
	ModelSelectionDto,
	ModelTestResultDto,
	ProviderDisconnectResultDto,
	ProviderListDto,
	ProviderOAuthStartDto,
	ProviderStatusDto,
	SessionSnapshotDto,
	SkillDto,
	StatsPeriodDto,
	TaskRowDto,
	TodoPhaseDto,
	ToolSwitchesDto,
	WireServerEventDto,
} from "@cornfield/wire";

// ArtifactDto / ArtifactsResultDto 由 pi-wire 定义，消费方（ArtifactsPanel 等）从本层引入。
export type { ArtifactDto } from "@cornfield/wire";

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

/** 听记历史条目（listen_list：~/.cornfield/listen/ 单条录音的元数据 + 转写全文）。 */
export interface ListenRecordingDto {
	name: string;
	path: string;
	/** ISO 时间（json recorded_at，缺失回退文件 mtime）。 */
	recordedAt: string;
	size: number;
	text: string;
}

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
	reportAt?: string;
	hasSummary?: boolean;
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
	newSession(): Promise<void>;
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

	/** 诊断会话（diagnose_session；异步启动诊断，返回任务句柄）。 */
	diagnoseSession(sessionFile: string): Promise<{ reportId: string; sessionId: string; state: "running" | "done" }>;
	/** 列出诊断报告与后台任务（list_diagnosis_reports）。 */
	listDiagnosisReports(sessionFile?: string): Promise<{ reports: DiagnosisReportListItemDto[]; tasks: any[] }>;
	/** 获取单个诊断报告详情（get_diagnosis_report）。 */
	getDiagnosisReport(reportId: string): Promise<{ markdown: string; summary: DiagnosisSummaryDto } | null>;
	// ── 文件系统（Agent 详情页只读浏览）──
	/** 列出 agent workspace 目录（fs_list，相对 agentDir；省略 path = 根）。 */
	fsList(sessionId: string, path?: string): Promise<{ entries: FsEntryDto[] }>;
	/** 读 agent workspace 文件（fs_read；>128KB 截断并标记 truncated）。 */
	fsRead(sessionId: string, path: string): Promise<{ text: string; truncated: boolean }>;
	/** 读 agent workspace 图片（fs_read_image；dataUrl，2MB 上限，MIME 按扩展名）。 */
	fsReadImage(sessionId: string, path: string): Promise<FsImageResult>;
	/** 产物列表（list_artifacts；从会话 toolCall 提取写出文件，按 mtime 倒序）。 */
	listArtifacts(sessionId: string, sessionFile?: string): Promise<{ artifacts: ArtifactDto[] }>;
	/** 产物静态预览 URL（/preview/<agentId>/<relpath>，serve 端只读 docroot 路由）。 */
	artifactPreviewUrl(agentId: string, path: string): string;
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

	// ── 记忆投影（W3 D3 MemoryPanel）──
	/**
	 * 记忆投影（get_memory，只读）——三分区：memory（self-evolution 记忆库）/ user（user.md）/ project（项目 MEMORY 文件）。
	 * 取不到的区为 null；失败/未连接抛错，由调用方渲染空态。
	 */
	getMemory(): Promise<MemoryProjectionDto>;

	// ── 技能列表（W3 D5 SkillsPanel）──
	/** 已加载技能（get_skills，只读；session.skills 同源）。失败/未连接抛错，由调用方渲染空态。 */
	getSkills(): Promise<{ skills: SkillDto[]; disabled: DisabledSkillDto[] }>;

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
	/** 启停技能（set_skill_enabled；serve 写 config.yml + 重发现热重载）。 */
	setSkillEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; name: string; enabled: boolean }>;

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
