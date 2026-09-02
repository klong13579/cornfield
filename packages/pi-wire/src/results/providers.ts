/**
 * Provider 接入结果形状（模型控制中心 #03：get_providers / get_provider / 凭据与连接命令）。
 * 响应一律不回显明文密钥——只允许掩码片段（maskedKey）；apiKey 只出现在写命令的请求载荷里。
 * 语义来源：@cornfield/ai AuthStorage（api_key/oauth 凭据、runtime override、env 回落）与
 * stream.ts serviceProviderMap（env 变量候选）。
 */

/** Provider 连接状态（六态，互斥）。 */
export type ProviderConnectionStatus =
	/** 已接入且凭据可用。 */
	| "connected"
	/** 未接入（存储/env/runtime 均无凭据）。 */
	| "not-configured"
	/** OAuth token 临近过期（expires 在阈值内，UI 提示续期）。 */
	| "oauth-expiring"
	/** 有凭据但已知失效（401/token 刷新失败）。 */
	| "credential-invalid"
	/** 远端 provider 不可达（网络/网关错误）。 */
	| "unreachable"
	/** 本地 provider（ollama/lm-studio/llama.cpp 类）进程不可达。 */
	| "local-offline";

/** Provider 凭据来源（当前生效的密钥从哪来；none = 未配置）。 */
export type ProviderCredentialSource = "api-key" | "oauth" | "env" | "none";

/**
 * Provider 状态条目（列表/详情/写命令响应共用）。
 * 不回显明文密钥：api-key 来源只给 maskedKey 掩码片段，oauth 来源只给过期时间。
 */
export interface ProviderStatusDto {
	/** Provider id（如 "anthropic"）。 */
	providerId: string;
	/** 显示名。 */
	displayName?: string;
	/** 连接状态（六态）。 */
	status: ProviderConnectionStatus;
	/** 当前生效凭据来源。 */
	credentialSource: ProviderCredentialSource;
	/** 掩码密钥片段（如 "sk-…f3a2"；仅 credentialSource=api-key 时提供）。 */
	maskedKey?: string;
	/** 已知的环境变量密钥名候选（getEnvApiKey serviceProviderMap 同源；目录未声明省略）。 */
	envVarNames?: string[];
	/** 任一环境变量候选当前已设置。 */
	envVarPresent?: boolean;
	/** OAuth 过期时间（ISO；仅 credentialSource=oauth 时提供）。 */
	oauthExpiresAt?: string;
	/** 本地 provider 标记（ollama/lm-studio/llama.cpp 类；unreachable 与 local-offline 的区分依据）。 */
	local?: boolean;
	/** 自定义 Base URL（覆盖目录默认时返回；未覆盖省略 = 目录默认）。 */
	baseUrl?: string;
	/** 该 provider 目录内模型数（全量，未按停用过滤）。 */
	modelCount: number;
	/** 上次目录刷新时间（ISO；从未刷新省略）。 */
	lastRefreshAt?: string;
	/** 目录是否非权威（与 ModelCatalogStatus 的 catalog-stale 推导同源）。 */
	catalogStale: boolean;
}

/** get_providers 响应（全部已知 provider 的状态列表）。 */
export interface ProviderListDto {
	providers: ProviderStatusDto[];
}

/**
 * start_provider_oauth 响应：发起 OAuth 登录。requiresManualCode=true 的流（手输 code 类
 * provider）需随后调 complete_provider_oauth 提交 code；其余流由 serve 端后台轮询完成，
 * 前端以 get_provider 轮询状态收口。
 */
export interface ProviderOAuthStartDto {
	/** 授权页 URL（login onAuth 提供；纯轮询流可能省略）。 */
	authUrl?: string;
	/** 操作说明（如 "在浏览器完成授权后粘贴 code"）。 */
	instructions?: string;
	/** 是否需要用户回填 code（onManualCodeInput 流）。 */
	requiresManualCode: boolean;
}

/** 断开依赖检查条目（谁还在引用该 provider 的模型）。 */
export interface ProviderDependencyDto {
	/** 依赖类型：会话当前模型 / 角色主模型（settings.modelRoutes[].primary）/ 回退链（settings.modelRoutes[].fallbacks）。 */
	kind: "session-model" | "role-binding" | "model-fallback";
	/** 依赖者标识（sessionId / 角色名 / `角色[index]` 回退位）。 */
	ref: string;
	/** 引用的模型（`provider/modelId`）。 */
	model: string;
}

/**
 * disconnect_provider 响应。force 缺省 false 且存在依赖时不执行断开——依赖检查结果是
 * 命令的正常结果（ok:true + disconnected:false），不是错误通道；前端确认后带 force=true 重发。
 */
export interface ProviderDisconnectResultDto {
	/** 是否已实际断开。 */
	disconnected: boolean;
	/** 依赖检查结果（无依赖为空数组）。 */
	dependencies: ProviderDependencyDto[];
	/** 断开后（或未断开时当前）的 provider 状态。 */
	provider: ProviderStatusDto;
}
