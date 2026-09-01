import { describe, expect, test } from "bun:test";
import { brandKeyOfModel, ProviderLogo } from "../src/components/ProviderLogo";

/**
 * 转录头像品牌推断（回归：每回合模型名前缀 logo 一直是 π，未按模型品牌显示）。
 *
 * 根因：AssistantTurn 头像硬编码 π，未消费 ProviderLogo/brandKeyOfModel。
 * 修复：识别出品牌的模型显示对应 logo，未识别的保留 π 占位。
 * 本测试锁定 brandKeyOfModel 的匹配语义（含 provider 前缀归一）。
 */

describe("brandKeyOfModel", () => {
	test("裸模型 id 命中品牌", () => {
		expect(brandKeyOfModel("deepseek-v4-flash")).toBe("deepseek");
		expect(brandKeyOfModel("deepseek-v4-flash-0731")).toBe("deepseek");
		expect(brandKeyOfModel("qwen3-coder-next")).toBe("qwen");
		expect(brandKeyOfModel("minimax-m3")).toBe("minimax");
		expect(brandKeyOfModel("kimi-k2")).toBe("kimi");
		expect(brandKeyOfModel("glm-5.2")).toBe("glm");
		expect(brandKeyOfModel("claude-opus-4-5")).toBe("claude");
		expect(brandKeyOfModel("gpt-5")).toBe("openai");
		expect(brandKeyOfModel("gemini-2.5-pro")).toBe("googlegemini");
	});

	test("带 provider 前缀的模型串（网关/回放会话形状）先归一再匹配", () => {
		expect(brandKeyOfModel("narwal-plan/deepseek-v4-flash")).toBe("deepseek");
		expect(brandKeyOfModel("narwal-plan/minimax-m3")).toBe("minimax");
		expect(brandKeyOfModel("google/gemini-2.5-pro")).toBe("googlegemini");
		expect(brandKeyOfModel("openai/gpt-5.1")).toBe("openai");
	});

	test("显示名（空格）大小写不敏感命中", () => {
		expect(brandKeyOfModel("DeepSeek V4")).toBe("deepseek");
		expect(brandKeyOfModel("GLM 5.2")).toBe("glm");
		expect(brandKeyOfModel("Kimi K2")).toBe("kimi");
	});

	test("未识别模型返回 null（走 π 占位）", () => {
		expect(brandKeyOfModel("x-unknown-token")).toBeNull();
		expect(brandKeyOfModel("")).toBeNull();
	});
});

describe("ProviderLogo 品牌路由", () => {
	test("识别品牌 → 有 SVG 资产走 img，无资产走品牌色初始徽章（不落 π 无关分支）", () => {
		expect(ProviderLogo({ provider: "deepseek", modelId: "deepseek-v4-flash" }).type).toBe("img");
		expect(ProviderLogo({ provider: "narwal-plan", modelId: "narwal-plan/glm-5.2" }).type).toBe("span");
	});
});
