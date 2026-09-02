/**
 * 模型市场 / 连接 / 附件 / host tool 结果形状。
 */

/** 模型市场条目（get_available_models）。 */
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

/**
 * get_available_models 响应（W3 模型禁用：附加停用名单，前端「已停用」分区恢复入口用）。
 * models 已按 disabledProviders（整 provider）+ disabledModels（`provider/modelId` 精确）过滤。
 */
export interface AvailableModelsDto {
	models: ModelInfoDto[];
	/** 已停用 provider（settings.disabledProviders）。 */
	disabledProviders: string[];
	/** 已停用模型 pattern（`provider/modelId`，settings.disabledModels）。 */
	disabledModels: string[];
}

/** 单个工具的开关项（get_tool_switches）。 enabled 为目标 agent 的生效值（未配置 = 内核默认）；path 为 config.yml 写入键（set_config 用）。 */
export interface ToolSwitchDto {
	tool: string;
	label: string;
	/** config.yml 写入键（如 "search.enabled"），set_config 修改用。 */
	path: string;
	enabled: boolean;
}

/** get_tool_switches 响应（工具开关语义视图，与 createTools isToolAllowed 的 settings 路径同源）。 */
export interface ToolSwitchesDto {
	tools: ToolSwitchDto[];
	/** python 工具模式（bash-only / ipy-only / both）；bash 开关由它派生，不单独列。 */
	pythonToolMode: "bash-only" | "ipy-only" | "both";
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

/** 连接信息（hello_ack 内容）。 */
export interface ConnectionInfoDto {
	connected: boolean;
	reconnecting?: boolean;
	reconnectAttempts?: number;
	connectionId?: string;
	wsUrl: string;
	protocolVersion: number;
}

/** 连接后返回（hello_ack 环境摘要，Home 用）。 */
export interface EnvironmentSummaryDto {
	repos: string;
	branch: string;
	activeAgentCount: number;
	pendingCronCount: number;
}

// ── v2 全量模型目录（模型控制中心 #02：get_model_catalog）──

/**
 * 模型目录状态（六态，互斥；v2 全量目录按 status 区分而非过滤）。推导优先级：
 * disabled → provider-not-configured → credential-invalid → local-offline → catalog-stale → available。
 */
export type ModelCatalogStatus =
	/** 可用：provider 已接入、凭据有效、未停用、目录权威。 */
	| "available"
	/** provider 未接入（存储/env/runtime 均无凭据）。 */
	| "provider-not-configured"
	/** 有凭据但已知失效（401/token 刷新失败）。 */
	| "credential-invalid"
	/** 被 settings.disabledProviders（整 provider）或 disabledModels（`provider/modelId`）停用。 */
	| "disabled"
	/** 本地 provider（ollama/lm-studio/llama.cpp 类）进程不可达。 */
	| "local-offline"
	/** 目录非权威（ModelResolutionResult.stale 同源——未拿到该 provider 的权威数据）。 */
	| "catalog-stale";

/** 模型价格（美元 / 1M tokens；与 Model.cost、StatsPriceDto 同源）。 */
export interface ModelPricingDto {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 模型能力位（从 Model.reasoning / Model.input / 目录标注推导）。 */
export interface ModelCapabilitiesDto {
	/** 思考/推理（Model.reasoning）。 */
	thinking: boolean;
	/** 视觉输入（Model.input 含 "image"）。 */
	vision: boolean;
	/** 工具调用（目录未显式标注时按 true；仅 asr/tts/embedding 类为 false）。 */
	tools: boolean;
	/** 输入模态。 */
	inputModalities: Array<"text" | "image">;
}

/**
 * v2 目录单模型条目（全量已知模型——含未接入 Provider）。
 * 对 v1 ModelInfoDto 的升级：结构化 pricing/capabilities 替代展示字符串，新增 status/发布时间/角色引用。
 */
export interface ModelCatalogEntryDto {
	provider: string;
	id: string;
	/** 显示名（Model.name）。 */
	name: string;
	/** 可用状态（六态，推导优先级见 ModelCatalogStatus）。 */
	status: ModelCatalogStatus;
	/** 状态补充说明（凭据失效原因/本地不可达错误等；available 时省略）。 */
	statusDetail?: string;
	/** 价格（美元 / 1M tokens）。 */
	pricing: ModelPricingDto;
	/** 能力位。 */
	capabilities: ModelCapabilitiesDto;
	/** 上下文窗口 token 数（排序用）。 */
	contextWindowTokens: number;
	/** 发布时间（目录元数据提供时才有，可缺失；ISO）。 */
	releasedAt?: string;
	/** 引用该模型的角色名列表（settings.modelRoles 值按 `provider/modelId` 前缀命中；无则空数组）。 */
	roles: string[];
	/** 模型分类（Model.category；目录未标注省略）。 */
	category?: "chat" | "coding" | "reasoning" | "vision" | "asr" | "tts" | "image" | "video" | "embedding";
	/** 目录描述（models.json / models.dev 提供时）。 */
	description?: string;
}

/**
 * Provider 目录元数据（#02 目录数据来源与新鲜度）。
 * source 为 resolveProviderModels 优先级链（static → models-dev → cache → dynamic）的实际胜出者。
 */
export interface ProviderCatalogMetaDto {
	providerId: string;
	/** Provider 显示名。 */
	displayName?: string;
	/** 目录主要数据来源（bundled 静态目录 / models.dev 回落 / 本地缓存 / provider API 动态发现）。 */
	source: "static" | "models-dev" | "cache" | "dynamic";
	/** 上次成功刷新时间（ISO；从未刷新省略）。 */
	lastRefreshAt?: string;
	/** 目录是否非权威（ModelResolutionResult.stale 同源）。 */
	stale: boolean;
	/** 该 provider 发现的模型条目数（全量，未按停用过滤）。 */
	discoveredCount: number;
	/** 上次刷新的错误信息（成功或从未刷新省略）。 */
	refreshError?: string;
}

/**
 * get_model_catalog 响应（AvailableModelsDto 的 v2）——返回全部已知模型而非仅可用集，
 * 前端模型中心主数据源。v1 get_available_models（AvailableModelsDto）保持不动，旧端不受影响。
 */
export interface ModelCatalogDto {
	/** 全量已知模型条目（未按停用/凭据过滤，由 status 区分）。 */
	models: ModelCatalogEntryDto[];
	/** 每个 provider 的目录元数据（来源/刷新时间/stale/发现数/刷新错误）。 */
	providers: ProviderCatalogMetaDto[];
	/** 已停用 provider（settings.disabledProviders，恢复入口）。 */
	disabledProviders: string[];
	/** 已停用模型 pattern（`provider/modelId`，恢复入口）。 */
	disabledModels: string[];
	/** 目录生成时间（ISO）。 */
	generatedAt: string;
}

// ── 模型连通性测试（模型控制中心 #04：test_model）──

/**
 * 连通性测试结果分类（六类，互斥）。失败不伪装成功：非 success 均带可诊断 message；
 * 分类优先级：HTTP 状态（401→auth / 403·404→permission / 429→rate-limit / 408→timeout）
 * > 错误文本模式（timeout / rate-limit / auth / permission / network）> network 兜底。
 */
export type ModelTestOutcome = "success" | "auth" | "permission" | "rate-limit" | "network" | "timeout";

/** test_model 响应（#04）：对单模型一次最小真实调用的结果。 */
export interface ModelTestResultDto {
	provider: string;
	modelId: string;
	/** 结果分类（六类；语义见 ModelTestOutcome）。 */
	outcome: ModelTestOutcome;
	/** 端到端耗时（含 provider 内部重试，ms）。 */
	latencyMs: number;
	/** 可诊断消息（成功为确认文案；失败带原始错误摘要，截断防刷屏）。 */
	message: string;
	/** HTTP 状态码（可提取时；供 UI 精确归因）。 */
	httpStatus?: number;
}
