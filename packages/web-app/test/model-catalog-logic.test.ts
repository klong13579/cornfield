import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntryDto, ModelTestOutcome } from "@cornfield/wire";
import {
	countByStatus,
	DEFAULT_QUERY,
	filterCatalog,
	formatContextTokens,
	formatIsoTime,
	formatPriceUsd,
	keyOf,
	matchesSearch,
	STATUS_META,
	sortCatalog,
	visibleCatalog,
} from "../src/pages/models/catalog/catalog-logic";
import {
	canRunConnectivityTest,
	formatLatency,
	TEST_OUTCOME_META,
	testConfirmNotice,
} from "../src/pages/models/catalog/test-outcome";

/**
 * 模型目录 #02 纯逻辑回归：搜索 / 筛选 / 排序（缺失数据排末尾）/ 六态映射 / 格式化。
 * 只测纯函数（不依赖 store/DOM）；组件渲染由壳层测试与 e2e 覆盖。
 */

function entry(overrides: Partial<ModelCatalogEntryDto> & Pick<ModelCatalogEntryDto, "id">): ModelCatalogEntryDto {
	return {
		provider: "test-provider",
		name: overrides.id ?? "model",
		status: "available",
		pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		capabilities: { thinking: false, vision: false, tools: true, inputModalities: ["text"] },
		contextWindowTokens: 200_000,
		roles: [],
		...overrides,
	};
}

const FIXTURES: ModelCatalogEntryDto[] = [
	entry({
		id: "glm-5",
		name: "GLM-5",
		pricing: { input: 3, output: 6, cacheRead: 0, cacheWrite: 0 },
		capabilities: { thinking: true, vision: false, tools: true, inputModalities: ["text"] },
	}),
	entry({
		id: "vision-x",
		name: "Vision X",
		capabilities: { thinking: false, vision: true, tools: true, inputModalities: ["text", "image"] },
	}),
	entry({ id: "tiny-a", name: "alpha", contextWindowTokens: 0, releasedAt: "2025-01-01T00:00:00Z" }),
	entry({
		id: "free-b",
		name: "bravo",
		pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindowTokens: 1_000_000,
	}),
	entry({
		id: "old-c",
		name: "charlie",
		releasedAt: "2023-06-01T00:00:00Z",
		provider: "other-provider",
		status: "provider-not-configured",
	}),
];

describe("模型目录：搜索", () => {
	test("按名称 / 模型 ID / provider 大小写不敏感匹配", () => {
		const target = entry({ id: "Glm-5", name: "GLM-5 智谱", provider: "zai" });
		expect(matchesSearch(target, "glm")).toBe(true);
		expect(matchesSearch(target, "GLM")).toBe(true);
		expect(matchesSearch(target, "智谱")).toBe(true);
		expect(matchesSearch(target, "zai")).toBe(true);
		expect(matchesSearch(target, "zai/glm-5")).toBe(true);
		expect(matchesSearch(target, "kimi")).toBe(false);
	});

	test("空白查询匹配全部", () => {
		for (const q of ["", "   ", "\t"]) {
			expect(FIXTURES.filter(m => matchesSearch(m, q)).length).toBe(FIXTURES.length);
		}
	});

	test("provider/id 全键匹配（含大小写）", () => {
		const target = entry({ id: "m1", provider: "Narwal-Plan" });
		expect(matchesSearch(target, "narwal-plan/m1")).toBe(true);
	});
});

describe("模型目录：筛选", () => {
	test("provider 精确过滤", () => {
		const out = filterCatalog(FIXTURES, { ...DEFAULT_QUERY, provider: "other-provider" });
		expect(out.map(m => m.id)).toEqual(["old-c"]);
	});

	test("能力过滤：thinking / vision / tools", () => {
		expect(filterCatalog(FIXTURES, { ...DEFAULT_QUERY, capability: "thinking" }).map(m => m.id)).toEqual(["glm-5"]);
		expect(filterCatalog(FIXTURES, { ...DEFAULT_QUERY, capability: "vision" }).map(m => m.id)).toEqual(["vision-x"]);
		// 全部 fixture 均支持工具 → tools 过滤不排除任何模型
		expect(filterCatalog(FIXTURES, { ...DEFAULT_QUERY, capability: "tools" }).length).toBe(FIXTURES.length);
		const noTools = entry({
			id: "asr-1",
			capabilities: { thinking: false, vision: false, tools: false, inputModalities: ["text"] },
		});
		expect(filterCatalog([noTools], { ...DEFAULT_QUERY, capability: "tools" })).toEqual([]);
	});

	test("输入模态过滤：image 需出现在 inputModalities", () => {
		expect(filterCatalog(FIXTURES, { ...DEFAULT_QUERY, modality: "image" }).map(m => m.id)).toEqual(["vision-x"]);
		expect(filterCatalog(FIXTURES, { ...DEFAULT_QUERY, modality: "text" }).length).toBe(FIXTURES.length);
	});

	test("上下文阈值边界：128000 达标 / 127999 不达标 / 未知(0) 不满足任何阈值", () => {
		const models = [
			entry({ id: "a-128k", contextWindowTokens: 128_000 }),
			entry({ id: "b-127999", contextWindowTokens: 127_999 }),
			entry({ id: "c-unknown", contextWindowTokens: 0 }),
		];
		expect(filterCatalog(models, { ...DEFAULT_QUERY, context: "ge128k" }).map(m => m.id)).toEqual(["a-128k"]);
		expect(filterCatalog(models, { ...DEFAULT_QUERY, context: "ge200k" })).toEqual([]);
		expect(filterCatalog(models, { ...DEFAULT_QUERY, context: "ge1m" })).toEqual([]);
		const big = [entry({ id: "m", contextWindowTokens: 1_000_000 })];
		expect(filterCatalog(big, { ...DEFAULT_QUERY, context: "ge1m" }).length).toBe(1);
	});

	test("接入状态过滤", () => {
		const out = filterCatalog(FIXTURES, { ...DEFAULT_QUERY, status: "provider-not-configured" });
		expect(out.map(m => m.id)).toEqual(["old-c"]);
		expect(filterCatalog(FIXTURES, { ...DEFAULT_QUERY, status: "available" }).length).toBe(4);
	});

	test("组合过滤叠加（搜索 + provider + 状态）", () => {
		const out = filterCatalog(FIXTURES, {
			...DEFAULT_QUERY,
			search: "charlie",
			provider: "other-provider",
			status: "provider-not-configured",
		});
		expect(out.map(m => m.id)).toEqual(["old-c"]);
		// 任一条件不满足即排除
		expect(filterCatalog(FIXTURES, { ...DEFAULT_QUERY, search: "charlie", provider: "test-provider" })).toEqual([]);
	});
});

describe("模型目录：排序（缺失数据排末尾）", () => {
	test("价格：输入价升序，免费(0)在最前，同输入价按输出价决胜", () => {
		const models = [
			entry({ id: "p3", pricing: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } }),
			entry({ id: "free", pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
			entry({ id: "p1-tie", pricing: { input: 1, output: 9, cacheRead: 0, cacheWrite: 0 } }),
			entry({ id: "p1-low", pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
		];
		expect(sortCatalog(models, "price").map(m => m.id)).toEqual(["free", "p1-low", "p1-tie", "p3"]);
	});

	test("上下文：大→小，未知(0)恒排末尾", () => {
		const models = [
			entry({ id: "unknown", contextWindowTokens: 0 }),
			entry({ id: "small", contextWindowTokens: 8_000 }),
			entry({ id: "big", contextWindowTokens: 1_000_000 }),
		];
		expect(sortCatalog(models, "context").map(m => m.id)).toEqual(["big", "small", "unknown"]);
	});

	test("发布时间：新→旧，缺失/非法 ISO 恒排末尾", () => {
		const models = [
			entry({ id: "no-date" }),
			entry({ id: "old", releasedAt: "2023-01-01T00:00:00Z" }),
			entry({ id: "new", releasedAt: "2026-08-30T00:00:00Z" }),
			entry({ id: "bad-date", releasedAt: "not-a-date" }),
		];
		// 两个缺失项并列 → 按名称决胜（bad-date < no-date）
		expect(sortCatalog(models, "released").map(m => m.id)).toEqual(["new", "old", "bad-date", "no-date"]);
	});

	test("全部缺失发布时间 → 按名称决胜（不伪装顺序）", () => {
		const models = [entry({ id: "b" }), entry({ id: "a" })];
		expect(sortCatalog(models, "released").map(m => m.id)).toEqual(["a", "b"]);
	});

	test("名称排序：字典序，同 name 按 id 决胜", () => {
		const models = [
			entry({ id: "z2", name: "same" }),
			entry({ id: "a1", name: "same" }),
			entry({ id: "m", name: "Beta" }),
		];
		// localeCompare 大小写不敏感：Beta < same；同 name 按 id 决胜
		expect(sortCatalog(models, "name").map(m => m.id)).toEqual(["m", "a1", "z2"]);
	});

	test("排序不改入参顺序", () => {
		const models = [entry({ id: "b" }), entry({ id: "a" })];
		sortCatalog(models, "name");
		expect(models.map(m => m.id)).toEqual(["b", "a"]);
	});

	test("visibleCatalog = 筛选 + 排序组合", () => {
		const out = visibleCatalog(FIXTURES, { ...DEFAULT_QUERY, status: "available", sort: "context" });
		expect(out.map(m => m.id)).toEqual(["free-b", "glm-5", "vision-x", "tiny-a"]);
	});
});

describe("模型目录：六态状态映射", () => {
	test("六态齐全、互斥键、文案与语义色非空", () => {
		const keys = Object.keys(STATUS_META);
		expect(keys).toEqual([
			"available",
			"provider-not-configured",
			"credential-invalid",
			"disabled",
			"local-offline",
			"catalog-stale",
		]);
		const validBadges = new Set(["done", "fail", "run", "neutral", "info"]);
		for (const [status, meta] of Object.entries(STATUS_META)) {
			expect(meta.label.length, `${status} 需有展示文案`).toBeGreaterThan(0);
			expect(meta.hint.length, `${status} 需有状态释义`).toBeGreaterThan(0);
			expect(validBadges.has(meta.badge), `${status} 徽章须映射既有色板`).toBe(true);
		}
	});

	test("countByStatus：缺态为 0，计数正确", () => {
		const counts = countByStatus(FIXTURES);
		expect(counts.available).toBe(4);
		expect(counts["provider-not-configured"]).toBe(1);
		expect(counts["credential-invalid"]).toBe(0);
		expect(counts.disabled).toBe(0);
		expect(counts["local-offline"]).toBe(0);
		expect(counts["catalog-stale"]).toBe(0);
		expect(countByStatus([])).toEqual({
			available: 0,
			"provider-not-configured": 0,
			"credential-invalid": 0,
			disabled: 0,
			"local-offline": 0,
			"catalog-stale": 0,
		});
	});
});

describe("模型目录：格式化", () => {
	test("价格：0/小数去尾零/非法值", () => {
		expect(formatPriceUsd(0)).toBe("$0");
		expect(formatPriceUsd(0.15)).toBe("$0.15");
		expect(formatPriceUsd(3)).toBe("$3");
		expect(formatPriceUsd(12.3456)).toBe("$12.346");
		expect(formatPriceUsd(Number.NaN)).toBe("—");
		expect(formatPriceUsd(Number.POSITIVE_INFINITY)).toBe("—");
	});

	test("上下文紧凑展示与边界", () => {
		expect(formatContextTokens(0)).toBe("未知");
		expect(formatContextTokens(-5)).toBe("未知");
		expect(formatContextTokens(Number.NaN)).toBe("未知");
		expect(formatContextTokens(500)).toBe("500");
		expect(formatContextTokens(200_000)).toBe("200K");
		expect(formatContextTokens(131_072)).toBe("131K");
		expect(formatContextTokens(1_000_000)).toBe("1M");
		expect(formatContextTokens(1_500_000)).toBe("1.5M");
		expect(formatContextTokens(999_999)).toBe("1M");
	});

	test("ISO 时间：缺失 —、非法原样、合法本地化", () => {
		expect(formatIsoTime(undefined)).toBe("—");
		expect(formatIsoTime("not-a-date")).toBe("not-a-date");
		expect(formatIsoTime("2026-08-30T06:00:00Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});
});

describe("模型目录：工具函数", () => {
	test("keyOf 与 disabledModels pattern 同形", () => {
		expect(keyOf({ provider: "openai", id: "gpt-x" })).toBe("openai/gpt-x");
	});

	test("DEFAULT_QUERY 默认值", () => {
		expect(DEFAULT_QUERY).toEqual({
			search: "",
			provider: "all",
			capability: "all",
			modality: "all",
			context: "all",
			status: "all",
			sort: "name",
		});
	});
});

// ── #04 连通性测试展示映射（test-outcome.ts）──

describe("连通性测试：outcome 展示映射", () => {
	test("六类 outcome 全覆盖：label/hint 非空，badge 映射既有色板", () => {
		const outcomes: ModelTestOutcome[] = ["success", "auth", "permission", "rate-limit", "network", "timeout"];
		expect(Object.keys(TEST_OUTCOME_META)).toEqual(outcomes);
		const validBadges = new Set(["done", "fail", "run", "neutral", "info"]);
		for (const [outcome, meta] of Object.entries(TEST_OUTCOME_META)) {
			expect(meta.label.length, `${outcome} 需有展示文案`).toBeGreaterThan(0);
			expect(meta.hint.length, `${outcome} 需有释义`).toBeGreaterThan(0);
			expect(validBadges.has(meta.badge), `${outcome} 徽章须映射既有色板`).toBe(true);
		}
	});

	test("成功与失败使用不同语义色（不把失败伪装成成功）", () => {
		expect(TEST_OUTCOME_META.success.badge).toBe("done");
		expect(TEST_OUTCOME_META.auth.badge).toBe("fail");
		expect(TEST_OUTCOME_META.network.badge).toBe("fail");
	});
});

describe("连通性测试：确认流与可用性", () => {
	test("确认文案包含模型键与费用提示（执行入口前必须可见）", () => {
		const notice = testConfirmNotice("narwal-plan/minimax-m3");
		expect(notice).toContain("narwal-plan/minimax-m3");
		expect(notice).toContain("真实调用");
		expect(notice).toContain("费用");
	});

	test("canRunConnectivityTest：仅 provider-not-configured 禁用（凭据无效/离线/停用仍可测）", () => {
		expect(canRunConnectivityTest({ status: "available" })).toBe(true);
		expect(canRunConnectivityTest({ status: "credential-invalid" })).toBe(true);
		expect(canRunConnectivityTest({ status: "local-offline" })).toBe(true);
		expect(canRunConnectivityTest({ status: "disabled" })).toBe(true);
		expect(canRunConnectivityTest({ status: "catalog-stale" })).toBe(true);
		expect(canRunConnectivityTest({ status: "provider-not-configured" })).toBe(false);
	});

	test("formatLatency 边界：ms/秒换算与非法值", () => {
		expect(formatLatency(0)).toBe("0 ms");
		expect(formatLatency(843)).toBe("843 ms");
		expect(formatLatency(999)).toBe("999 ms");
		expect(formatLatency(1000)).toBe("1 s");
		expect(formatLatency(1234)).toBe("1.2 s");
		expect(formatLatency(20000)).toBe("20 s");
		expect(formatLatency(Number.NaN)).toBe("—");
		expect(formatLatency(-1)).toBe("—");
		expect(formatLatency(Number.POSITIVE_INFINITY)).toBe("—");
	});
});
