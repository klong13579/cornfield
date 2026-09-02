import type { ModelCatalogEntryDto, ModelCatalogStatus, ProviderCatalogMetaDto } from "@cornfield/wire";

/**
 * 模型目录纯逻辑（模型控制中心 #02）——搜索 / 筛选 / 排序 / 六态映射 / 展示格式化。
 * 不依赖 store 与 DOM：CatalogView 消费，单测直接覆盖（test/model-catalog-logic.test.ts）。
 * 排序契约：缺失排序数据的模型（未知上下文、未标注/非法发布时间）恒排末尾，不伪装成最小值。
 */

/** 六态互斥徽章（与 ModelCatalogStatus 一一对应；badge 色板见 index.css）。 */
export const STATUS_META: Record<ModelCatalogStatus, { label: string; badge: string; hint: string }> = {
	available: { label: "可用", badge: "done", hint: "Provider 已接入、凭据有效且未被停用" },
	"provider-not-configured": {
		label: "未接入",
		badge: "neutral",
		hint: "Provider 未配置凭据（存储 / env / runtime 均无），暂不可调用",
	},
	"credential-invalid": { label: "凭据失效", badge: "fail", hint: "已配置凭据但已失效（401 / token 刷新失败）" },
	disabled: { label: "已停用", badge: "neutral", hint: "已被设置停用（整 Provider 或单模型）" },
	"local-offline": { label: "本地离线", badge: "run", hint: "本地 Provider 进程不可达" },
	"catalog-stale": { label: "目录过期", badge: "info", hint: "目录非权威数据（未取得该 Provider 的权威列表）" },
};

/** 目录数据来源展示文案（ProviderCatalogMetaDto.source，resolveProviderModels 优先级链的实际胜出者）。 */
export const SOURCE_LABELS: Record<ProviderCatalogMetaDto["source"], string> = {
	static: "静态目录",
	"models-dev": "models.dev",
	cache: "本地缓存",
	dynamic: "Provider API",
};

export type CapabilityFilter = "all" | "thinking" | "vision" | "tools";
export type ModalityFilter = "all" | "text" | "image";
export type ContextFilter = "all" | "ge128k" | "ge200k" | "ge1m";
export type StatusFilter = "all" | ModelCatalogStatus;
export type SortKey = "price" | "context" | "name" | "released";

export interface CatalogQuery {
	/** 名称 / 模型 ID / provider（含 `provider/id` 全键）大小写不敏感子串。 */
	search: string;
	/** providerId；"all" 不过滤。 */
	provider: string;
	capability: CapabilityFilter;
	modality: ModalityFilter;
	context: ContextFilter;
	status: StatusFilter;
	sort: SortKey;
}

export const DEFAULT_QUERY: CatalogQuery = {
	search: "",
	provider: "all",
	capability: "all",
	modality: "all",
	context: "all",
	status: "all",
	sort: "name",
};

/** 上下文筛选阈值（token）。 */
const CONTEXT_MIN_TOKENS: Record<Exclude<ContextFilter, "all">, number> = {
	ge128k: 128_000,
	ge200k: 200_000,
	ge1m: 1_000_000,
};

/** 目录条目唯一键（与 disabledModels 的 `provider/modelId` pattern 同形）。 */
export function keyOf(entry: Pick<ModelCatalogEntryDto, "provider" | "id">): string {
	return `${entry.provider}/${entry.id}`;
}

/** 搜索匹配：名称 / 模型 ID / provider（含全键 `provider/id`），大小写不敏感；空白查询匹配全部。 */
export function matchesSearch(entry: ModelCatalogEntryDto, rawSearch: string): boolean {
	const q = rawSearch.trim().toLowerCase();
	if (!q) return true;
	return (
		entry.name.toLowerCase().includes(q) ||
		entry.id.toLowerCase().includes(q) ||
		entry.provider.toLowerCase().includes(q) ||
		keyOf(entry).toLowerCase().includes(q)
	);
}

/** 筛选（不含排序）；各条件独立叠加。上下文未知（<=0）的模型不满足任何长度阈值。 */
export function filterCatalog(entries: ModelCatalogEntryDto[], query: CatalogQuery): ModelCatalogEntryDto[] {
	return entries.filter(m => {
		if (!matchesSearch(m, query.search)) return false;
		if (query.provider !== "all" && m.provider !== query.provider) return false;
		if (query.capability !== "all" && !m.capabilities[query.capability]) return false;
		if (query.modality !== "all" && !m.capabilities.inputModalities.includes(query.modality)) return false;
		if (query.context !== "all" && !(m.contextWindowTokens >= CONTEXT_MIN_TOKENS[query.context])) return false;
		if (query.status !== "all" && m.status !== query.status) return false;
		return true;
	});
}

/** 名称排序（同 name 按 id 决胜，保证确定性）。 */
function byName(a: ModelCatalogEntryDto, b: ModelCatalogEntryDto): number {
	return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** 上下文排序值：未知（<=0）恒为 -1，排末尾。 */
function contextRank(m: ModelCatalogEntryDto): number {
	return m.contextWindowTokens > 0 ? m.contextWindowTokens : -1;
}

/** 发布时间排序值：缺失 / 非法 ISO 恒为 -1，排末尾。 */
function releasedRank(m: ModelCatalogEntryDto): number {
	const t = Date.parse(m.releasedAt ?? "");
	return Number.isNaN(t) ? -1 : t;
}

/**
 * 排序（返回新数组，不改入参）。价格 = 输入价升序（0 = 免费属真实数据，排最前；
 * 同输入价按输出价）；上下文大→小；发布时间新→旧；全部以名称决胜。
 */
export function sortCatalog(entries: ModelCatalogEntryDto[], sort: SortKey): ModelCatalogEntryDto[] {
	const sorted = [...entries];
	switch (sort) {
		case "price":
			sorted.sort(
				(a, b) => a.pricing.input - b.pricing.input || a.pricing.output - b.pricing.output || byName(a, b),
			);
			break;
		case "context":
			sorted.sort((a, b) => contextRank(b) - contextRank(a) || byName(a, b));
			break;
		case "released":
			sorted.sort((a, b) => releasedRank(b) - releasedRank(a) || byName(a, b));
			break;
		case "name":
			sorted.sort(byName);
			break;
	}
	return sorted;
}

/** 筛选 + 排序组合（目录列表主入口）。 */
export function visibleCatalog(entries: ModelCatalogEntryDto[], query: CatalogQuery): ModelCatalogEntryDto[] {
	return sortCatalog(filterCatalog(entries, query), query.sort);
}

/** 六态计数（全键初始化，缺态为 0）——状态筛选下拉与分布展示用。 */
export function countByStatus(entries: ModelCatalogEntryDto[]): Record<ModelCatalogStatus, number> {
	const counts: Record<ModelCatalogStatus, number> = {
		available: 0,
		"provider-not-configured": 0,
		"credential-invalid": 0,
		disabled: 0,
		"local-offline": 0,
		"catalog-stale": 0,
	};
	for (const m of entries) counts[m.status] += 1;
	return counts;
}

/** 价格展示（$/1M tokens）：小数四舍五入到 3 位并去尾零；非法值 "—"。 */
export function formatPriceUsd(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return `$${String(Math.round(value * 1000) / 1000)}`;
}

/** 上下文紧凑展示：200000 → "200K"、1048576 → "1M"、999999 → "1M"；未知（<=0/非法）→ "未知"。 */
export function formatContextTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "未知";
	const k = tokens / 1_000;
	if (k < 1) return String(Math.round(tokens));
	const kk = Math.round(k);
	if (kk < 1_000) return `${kk}K`;
	const m = kk / 1_000;
	return `${Number.isInteger(m) ? m : Math.round(m * 10) / 10}M`;
}

/** ISO 时间本地化展示（YYYY-MM-DD HH:mm）；缺失 → "—"，非法原样返回（不伪装成有效时间）。 */
export function formatIsoTime(iso: string | undefined): string {
	if (!iso) return "—";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
