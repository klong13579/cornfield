import type { DashboardStats, ModelPriceEntry } from "@cornfield/stats";

/**
 * get_stats 响应缓存（用量面板性能优化）。
 *
 * 聚合查询会扫全量 messages 表（~12M 行）做多遍扫描，单次 ~700ms-1s；用量页
 * 打开、切 period 会高频触发，但 stats.db 数据变化慢（由增量同步驱动）。
 * 机制：按 period 分 key 缓存响应，TTL 10s；sync 处理到新条目时调用方 clear()。
 * 固定窗口序列（timeSeries/modelSeries/costSeries 等）与 period 无关，命中即整包复用。
 */

export type StatsResponse = DashboardStats & { priceCatalog: ModelPriceEntry[] };

/** period 分 key 缓存条目。 */
interface StatsCacheEntry {
	fetchedAt: number;
	value: StatsResponse;
}

/** 缓存条目生命周期。 */
export const STATS_CACHE_TTL_MS = 10_000;

/** 当前 epoch 毫秒（可注入 clock 便于测试）。 */
let nowMs: () => number = () => Date.now();

export const statsCache = new Map<string, StatsCacheEntry>();

/** period → 缓存 key（省略与 "all" 等价，因为 parseStatsPeriod 会把两者都归一化为 undefined 窗口）。 */
function cacheKeyOf(period: string | undefined): string {
	return period ?? "all";
}

/**
 * 读缓存：命中且未过期 → 返回缓存值；否则 null。
 * TTL 过期条目会被清除，避免 map 无限增长。
 */
export function getCachedStats(period: string | undefined, now: () => number = nowMs): StatsResponse | null {
	const key = cacheKeyOf(period);
	const entry = statsCache.get(key);
	if (!entry) return null;
	if (now() - entry.fetchedAt > STATS_CACHE_TTL_MS) {
		statsCache.delete(key);
		return null;
	}
	return entry.value;
}

/** 写入/更新某个 period 的缓存。 */
export function setCachedStats(period: string | undefined, value: StatsResponse, now: () => number = nowMs): void {
	statsCache.set(cacheKeyOf(period), { fetchedAt: now(), value });
}

/** sync 处理到新条目时整体失效（数据已变化，任何 period 的缓存都不可信）。 */
export function clearStatsCache(): void {
	statsCache.clear();
}

/** 测试钩子：替换时钟与清空缓存。 */
export function resetStatsCache(clock?: () => number): void {
	statsCache.clear();
	if (clock) nowMs = clock;
}
