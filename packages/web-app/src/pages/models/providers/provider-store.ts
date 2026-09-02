import type {
	ModelCatalogDto,
	ProviderDisconnectResultDto,
	ProviderListDto,
	ProviderOAuthStartDto,
	ProviderStatusDto,
} from "@cornfield/wire";
import { useSessionStore } from "../../../state/session-store";

/**
 * #03/#04 Provider 管理页依赖的 store 契约面（仅允许调用这些方法）。
 *
 * Phase 2 的单点 cast 收敛已移除：SessionStore 结构性满足本接口（编译器随即接管
 * 签名校验），#04 落地 refreshProvider / refreshCatalog 后不再需要 unknown 转型。
 */
export interface ProviderStoreContract {
	fetchProviders(): Promise<ProviderListDto>;
	fetchProvider(providerId: string): Promise<ProviderStatusDto>;
	startProviderOauth(providerId: string): Promise<ProviderOAuthStartDto>;
	completeProviderOauth(providerId: string, code: string): Promise<ProviderStatusDto>;
	saveProviderApiKey(providerId: string, apiKey: string): Promise<ProviderStatusDto>;
	deleteProviderApiKey(providerId: string): Promise<ProviderStatusDto>;
	setProviderBaseUrl(providerId: string, baseUrl: string | null): Promise<ProviderStatusDto>;
	disconnectProvider(providerId: string, force: boolean): Promise<ProviderDisconnectResultDto>;
	/** #04 单 provider 目录刷新（refresh_provider；online 强制，不影响其他 provider）。 */
	refreshProvider(providerId: string): Promise<ProviderStatusDto>;
	/** #04 全量目录刷新（refresh_catalog；registry 级并行，返回刷新后的完整目录）。 */
	refreshCatalog(): Promise<ModelCatalogDto>;
}

/** 页面内唯一的 store 访问收敛点（ProvidersView 与 ProviderCard 均经此取契约面）。 */
export function useProviderStore(): ProviderStoreContract {
	return useSessionStore();
}
