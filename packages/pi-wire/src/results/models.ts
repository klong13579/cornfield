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
