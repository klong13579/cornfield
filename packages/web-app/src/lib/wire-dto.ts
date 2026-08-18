/**
 * 前端协议 DTO —— 适配层契约。
 *
 * 镜像 `packages/coding-agent/src/server/wire-types.ts`（帧模型）与
 * `packages/coding-agent/src/session/session-snapshot.ts`（权威快照字段）的语义：
 * - 权威快照（session_snapshot）：可据此完整重建 UI，行为 `进度不得归约为状态`。
 * - 进度事件（progress）：仅打字机/delta 提示，跨快照即失效。
 *
 * 当 `@oh-my-pi/pi-wire` 抽包完成后，本文件只做 pi-wire 类型 → 前端 DTO 的映射，
 * 不改动上层组件的消费形态。
 */

// ── 快照 ──

/** 会话运行阶段（镜像 SessionPhase，枚举化 UI 提示，非权威门控）。 */
export type SessionPhaseDto = "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";

export type TodoStatusDto = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItemDto {
	content: string;
	status: TodoStatusDto;
	notes?: string[];
}

export interface TodoPhaseDto {
	name: string;
	tasks: TodoItemDto[];
}

export interface ModelDto {
	id: string;
	provider?: string;
	name?: string;
}

/** 消息内容块（镜像 AgentMessage content 的 thinking/text/toolCall/toolResult）。 */
export type MessageContentDto =
	| { type: "thinking"; thinking: string }
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown>; intent?: string }
	| { type: "toolResult"; toolCallId?: string; isError?: boolean; content?: { type: "text"; text: string }[] };

export interface MessageDto {
	id: string;
	role: "user" | "assistant" | "developer" | "toolResult";
	model?: string;
	content: MessageContentDto[];
	/** 助手出错（空 content + errorMessage），UI 渲染 ✗ Error 而不展示为空回复。 */
	errorMessage?: string;
	/** 独立 toolResult 消息：关联的 toolCall id（serve 快照/jsonl 顶层字段）。 */
	toolCallId?: string;
	/** 独立 toolResult 消息：该工具调用是否报错。 */
	isError?: boolean;
}

/** 会话权威快照（对应 SessionSnapshot；context 为可选扩展，真机数据可接 get_session_stats）。 */
export interface SessionSnapshotDto {
	seq: number;
	sessionId: string;
	sessionName?: string;
	sessionFile?: string;
	model?: ModelDto;
	thinkingLevel?: string;
	messages: MessageDto[];
	/** messageId → session entryId（消息级 undo/fork/retry 定位）。 */
	messageEntryIds: Record<string, string>;
	todoPhases: TodoPhaseDto[];
	activeToolNames: string[];
	queuedMessageCount: number;
	phase: SessionPhaseDto;
	retryAttempt: number;
	isCompacting: boolean;
	isStreaming: boolean;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	scopedModels?: { model: ModelDto; thinkingLevel?: string }[];
	/** 上下文水位（快照 context 提供）。 */
	context?: { usedTokens: number; totalTokens: number; lastCompaction?: number | null };
}

// ── server_snapshot（多 Agent 后的列表）──

export type AgentKind = "coding" | "worker";
export type AgentStatus = "online" | "busy" | "idle" | "stopped";

export interface AgentInfoDto {
	id: string;
	name: string;
	face: string;
	workspace: string;
	kind: AgentKind;
	status: AgentStatus;
	lastAction?: string;
	model?: string;
	skillsCount?: number;
	cronCount?: number;
	/** 已 lazy attach 到本进程（注册表 attached）。 */
	attached?: boolean;
	/** 运行阶段（attached 时有值）。 */
	phase?: "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";
	/** agentDir 绝对路径。 */
	agentDir?: string;
	dingtalkBound?: boolean;
}

export interface SessionListEntryDto {
	id: string;
	name?: string;
	sessionFile?: string;
	active: boolean;
}

// ── 进度事件（progress，非权威）──

export type ProgressEventDto =
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "steer"; text: string }
	| { type: "message_update"; assistantEvent: { type: "text_delta"; contentIndex: number; delta: string } }
	| { type: "message_update"; assistantEvent: { type: "thinking_delta"; contentIndex: number; delta: string } }
	| { type: "message_update"; assistantEvent: { type: "toolcall_delta"; contentIndex: number; delta: string } }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_end"; contentIndex: number }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			name: string;
			arguments?: Record<string, unknown>;
			intent?: string;
			startedAt: number;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			isError: boolean;
			resultText?: string;
			durationMs?: number;
	  }
	| { type: "auto_compaction_start"; reason: string; action: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "todo_reminder" }
	| { type: "todo_auto_clear" };

// ── 帧 ──

/** 权限请求推送（approval：危险命令审批；clarify：Agent 澄清择一）。 */
export type PermissionRequestDto =
	| {
			type: "permission_request";
			requestId: string;
			kind: "approval";
			command: string;
			description: string;
			patternKeys: string[];
	  }
	| {
			type: "permission_request";
			requestId: string;
			kind: "clarify";
			question: string;
			options: string[];
	  };

export type WireServerEventDto =
	| { type: "server_snapshot"; sessions: SessionListEntryDto[] }
	| { type: "session_snapshot"; sessionId: string; snapshot: SessionSnapshotDto }
	| { type: "progress"; sessionId: string; event: ProgressEventDto }
	| PermissionRequestDto;

export interface ConnectionInfoDto {
	connected: boolean;
	reconnecting?: boolean;
	reconnectAttempts?: number;
	connectionId?: string;
	wsUrl: string;
	protocolVersion: number;
}

// ── 模型市场 ──

export interface ModelInfoDto {
	id: string;
	provider: string;
	/** 模型显示名（真实 Model.name）。 */
	name?: string;
	/** 展示用上下文窗口（如 “200K”“1M”）。 */
	contextWindow?: string;
	/** 原始上下文窗口 token 数（排序用）。 */
	contextWindowTokens?: number;
	/** 价格展示（真实 cost 输入价格，$/M tokens）。 */
	price?: string;
	description?: string;
	supportsThinking: boolean;
}

/** 图片附件（对应 pi-ai ImageContent：prompt.images 通道，base64 内联）。 */
export interface ImageContentDto {
	type: "image";
	data: string; // base64 编码图片数据
	mimeType: string; // 如 image/png
}

/** host tool 声明（对应 WireHostToolDefinition；set_host_tools 入参）。 */
export interface HostToolDefinitionDto {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
}

// ── 用量统计（serve get_stats → DashboardStats，W3 D2） ──

/** 聚合行（overall/byModel/byFolder 共用形状，对齐 omp-stats AggregatedStats）。 */
export interface StatsAggregatedDto {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	cacheRate: number;
	totalCost: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
}

/** 按模型聚合行。 */
export interface StatsModelRowDto extends StatsAggregatedDto {
	model: string;
	provider: string;
}

/** 按目录聚合行。 */
export interface StatsFolderRowDto extends StatsAggregatedDto {
	folder: string;
}

/** 小时桶（timeSeries）。 */
export interface StatsTimePointDto {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

/** 日桶请求数（modelSeries）。 */
export interface StatsModelSeriesPointDto {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
}

/** 日桶性能（modelPerformanceSeries）。 */
export interface StatsPerformancePointDto {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
}

/** 日桶费用按模型分解（costSeries）。 */
export interface StatsCostPointDto {
	timestamp: number;
	model: string;
	provider: string;
	cost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	requests: number;
}

/** 模型单价（美元 / 1M tokens；models.json 目录，查不到的模型不出现）。 */
export interface StatsPriceDto {
	provider: string;
	model: string;
	price: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** get_stats 响应（DashboardStats + priceCatalog）。 */
export interface DashboardStatsDto {
	overall: StatsAggregatedDto;
	byModel: StatsModelRowDto[];
	byFolder: StatsFolderRowDto[];
	timeSeries: StatsTimePointDto[];
	modelSeries: StatsModelSeriesPointDto[];
	modelPerformanceSeries: StatsPerformancePointDto[];
	costSeries: StatsCostPointDto[];
	/** 单价目录（models.json，仅含 byModel 出现的模型）。 */
	priceCatalog: StatsPriceDto[];
}

/** get_stats 时间窗口参数。 */
export type StatsPeriodDto = "1d" | "7d" | "30d" | "90d" | "all";

// ── 记忆投影（serve get_memory，W3 D3）──

/** 文本文件投影（>128KB 截断并标记 truncated）。 */
export interface MemoryTextFileDto {
	path: string;
	content: string;
	truncated: boolean;
}

/** 记忆条目（vector_embeddings 行）。 */
export interface MemoryEntryDto {
	id: string;
	content: string;
	importance: number;
	lastAccessedAt: number;
}

/** 记忆分区（namespace 分组，importance 降序）。 */
export interface MemorySectionDto {
	namespace: string;
	entries: MemoryEntryDto[];
}

/** get_memory 响应——三分区：memory（记忆库）/ user（user.md）/ project（项目 MEMORY 文件）。 */
export interface MemoryProjectionDto {
	user: MemoryTextFileDto | null;
	project: {
		memoryRoot: string;
		memoryMd: MemoryTextFileDto | null;
		summaryMd: MemoryTextFileDto | null;
		rawMd: MemoryTextFileDto | null;
	} | null;
	memoryStore: {
		dbPath: string;
		sections: MemorySectionDto[];
		totalEntries: number;
	};
}

// ── 定时任务列表（W3 D4 TasksPanel；数据层 B6 gateway cron 代理命令接入点）──

/**
 * 定时任务行（对齐 omp-gateway ScheduledTask 可见字段；B6 网关代理命令落地前列表渲染空态，
 * 此 DTO 为预留接口——字段名以 gateway scheduler 为准）。
 */
export interface TaskRowDto {
	id: string;
	name: string;
	description?: string;
	/** cron / interval / once。 */
	scheduleType: "cron" | "interval" | "once";
	/** 5 字段 cron 表达式（scheduleType=cron 时）。 */
	cron?: string;
	/** 下次触发（毫秒）。 */
	nextRunAt?: number;
	lastRunAt?: number;
	enabled: boolean;
	accountId?: string;
	/** 执行命令（jobs.json command）。 */
	command?: string;
	runCount?: number;
	failCount?: number;
	consecutiveFailures?: number;
}

/** cron 执行日志条目（P2-W3-1 B6 代理；output/stderr 服务端已截断 2KB）。 */
export interface CronLogEntryDto {
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

// ── 技能列表（serve get_skills，W3 D5；只读，B3 启停协议未到）──

/** 技能项（session.skills 同源；level 供分类折叠）。 */
export interface SkillDto {
	name: string;
	description: string;
	source: string;
	/** user（用户级）/ project（项目级）/ native（内置）。 */
	level: "user" | "project" | "native";
	provider: string;
}

/** 连接后返回（hello_ack 内容 + 环境摘要，Home 用）。 */
export interface EnvironmentSummaryDto {
	repos: string;
	branch: string;
	activeAgentCount: number;
	pendingCronCount: number;
}
