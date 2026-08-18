/**
 * W3 D2 单价目录 —— buildModelPriceCatalog 查价回落（精确 (provider, model) →
 * 跨 provider 按 model id）。只读 models.json 目录，无 DB 依赖。
 */
import { describe, expect, it } from "bun:test";
import { buildModelPriceCatalog } from "../src/aggregator";

describe("buildModelPriceCatalog", () => {
	it("精确 (provider, model) 命中返回单价", () => {
		const cat = buildModelPriceCatalog([{ provider: "anthropic", model: "claude-sonnet-4-5" }]);
		expect(cat.length).toBe(1);
		expect(cat[0]?.provider).toBe("anthropic");
		expect(cat[0]?.model).toBe("claude-sonnet-4-5");
		expect(cat[0]?.price.input).toBeGreaterThan(0);
	});

	it("代理 provider（不在 models.json 命名空间）按 model id 跨 provider 回落", () => {
		const cat = buildModelPriceCatalog([{ provider: "alibaba-coding-plan", model: "deepseek-v4-flash" }]);
		expect(cat.length).toBe(1);
		expect(cat[0]?.provider).toBe("alibaba-coding-plan");
		expect(cat[0]?.model).toBe("deepseek-v4-flash");
		expect(cat[0]?.price.input).toBeGreaterThan(0);
	});

	it("目录里没有的模型（自定义/未收录）不出现在 catalog（UI 显示一次为能力验证）", () => {
		const cat = buildModelPriceCatalog([
			{ provider: "anthropic", model: "claude-sonnet-4-5" },
			{ provider: "narwal-plan", model: "__not-a-real-model-id-xyz__" },
		]);
		expect(cat.length).toBe(1);
		expect(cat[0]?.model).toBe("claude-sonnet-4-5");
	});

	it("重复 (provider, model) 去重；空输入返回空数组", () => {
		const dup = buildModelPriceCatalog([
			{ provider: "anthropic", model: "claude-sonnet-4-5" },
			{ provider: "anthropic", model: "claude-sonnet-4-5" },
		]);
		expect(dup.length).toBe(1);
		expect(buildModelPriceCatalog([])).toEqual([]);
	});
});
