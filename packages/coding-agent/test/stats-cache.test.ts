/**
 * stats-cache 单元测试——get_stats 响应缓存（用量面板性能优化）。
 *
 * 纯内存缓存，用注入时钟验证 TTL 命中/过期；无真实 serve 进程依赖。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearStatsCache,
	getCachedStats,
	resetStatsCache,
	STATS_CACHE_TTL_MS,
	type StatsResponse,
	setCachedStats,
} from "../src/server/stats-cache";

const now = { t: 1_000_000 };
const clock = () => now.t;

function fakeStats(patch?: Partial<StatsResponse>): StatsResponse {
	return {
		overall: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			totalInputTokens: 1,
			totalOutputTokens: 1,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			totalPremiumRequests: 0,
			totalCost: 0.01,
			cacheRate: 0,
			errorRate: 0,
			avgDuration: 100,
			avgTtft: 50,
			avgTokensPerSecond: 10,
			firstTimestamp: now.t - 1000,
			lastTimestamp: now.t,
		},
		byModel: [],
		byFolder: [],
		timeSeries: [],
		modelSeries: [],
		modelPerformanceSeries: [],
		costSeries: [],
		priceCatalog: [],
		...(patch ?? {}),
	};
}

beforeEach(() => {
	resetStatsCache(clock);
});

describe("get_stats 响应缓存", () => {
	test('period 省略与 "all" 共用同一 key（parseStatsPeriod 归一化为全量窗口）', () => {
		setCachedStats(undefined, fakeStats());
		expect(getCachedStats("all")).toEqual(getCachedStats(undefined));
	});

	test("TTL 内命中返回缓存值，不同 period 隔离", () => {
		setCachedStats("7d", fakeStats());
		setCachedStats("30d", fakeStats({ overall: { ...fakeStats().overall, totalRequests: 99 } }));

		// 时间未推进 → 命中
		expect(getCachedStats("7d")?.overall.totalRequests).toBe(1);
		expect(getCachedStats("30d")?.overall.totalRequests).toBe(99);
	});

	test("超过 TTL 后 miss 并清除过期条目", () => {
		setCachedStats("7d", fakeStats());
		now.t += STATS_CACHE_TTL_MS + 1;
		expect(getCachedStats("7d")).toBeNull();
		// 过期条目已清除，map 不无限增长
		expect(getCachedStats("7d")).toBeNull();
	});

	test("未写过的 period miss", () => {
		expect(getCachedStats("1d")).toBeNull();
	});

	test("clearStatsCache 整体失效（sync 有新条目的语义）", () => {
		setCachedStats("7d", fakeStats());
		setCachedStats("30d", fakeStats());
		clearStatsCache();
		expect(getCachedStats("7d")).toBeNull();
		expect(getCachedStats("30d")).toBeNull();
	});
});
