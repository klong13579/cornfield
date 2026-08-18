import { describe, expect, test } from "bun:test";
import { groupModelsByProvider } from "../src/pages/workspace/ComposerBar";

/**
 * 模型下拉分组（BUG: 模型对话框只显示第一个 provider）——回归单测。
 *
 * 根因：下拉是整树弹出、无 max-h/滚动，视口截断后只剩第一个 provider 组可见
 * （serve 返回顺序 alibaba 在前 → 用户只见 alibaba plan）。修复 = provider 分组 +
 * 滚动 + 当前模型 provider 置顶。本测试锁定分组/置顶/顺序语义。
 */

const SERVE_ORDER = [
	{ id: "qwen3-coder-next", provider: "alibaba-coding-plan" },
	{ id: "qwen3-coder-plus", provider: "alibaba-coding-plan" },
	{ id: "glm-5", provider: "bailian-coding-plan" },
	{ id: "kimi-k2", provider: "kimi-code" },
	{ id: "glm-5.2", provider: "narwal-plan" },
	{ id: "deepseek-v4-flash", provider: "narwal-plan" },
];

describe("groupModelsByProvider", () => {
	test("按 provider 分组，组内保持 serve 顺序，组间保持首现顺序", () => {
		const groups = groupModelsByProvider(SERVE_ORDER, null);
		expect(groups.map(([provider]) => provider)).toEqual([
			"alibaba-coding-plan",
			"bailian-coding-plan",
			"kimi-code",
			"narwal-plan",
		]);
		expect(groups[0]?.[1].map(m => m.id)).toEqual(["qwen3-coder-next", "qwen3-coder-plus"]);
		expect(groups[3]?.[1].map(m => m.id)).toEqual(["glm-5.2", "deepseek-v4-flash"]);
	});

	test("当前模型所在 provider 置顶（其余保持首现顺序）", () => {
		const groups = groupModelsByProvider(SERVE_ORDER, "deepseek-v4-flash");
		expect(groups.map(([provider]) => provider)[0]).toBe("narwal-plan");
		expect(groups.map(([provider]) => provider)).toEqual([
			"narwal-plan",
			"alibaba-coding-plan",
			"bailian-coding-plan",
			"kimi-code",
		]);
	});

	test("当前模型不在列表中时回退 serve 首现顺序", () => {
		const groups = groupModelsByProvider(SERVE_ORDER, "not-in-list");
		expect(groups.map(([provider]) => provider)).toEqual([
			"alibaba-coding-plan",
			"bailian-coding-plan",
			"kimi-code",
			"narwal-plan",
		]);
	});

	test("空列表 → 空分组", () => {
		expect(groupModelsByProvider([], "deepseek-v4-flash")).toEqual([]);
	});

	test("同 id 不同 provider 各自成组不合并", () => {
		const rows = [
			{ id: "qwen3.6-plus", provider: "alibaba-coding-plan" },
			{ id: "qwen3.6-plus", provider: "narwal-plan" },
		];
		const groups = groupModelsByProvider(rows, null);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.[0]).toBe("alibaba-coding-plan");
		expect(groups[1]?.[0]).toBe("narwal-plan");
	});

	test("provider 缺失（空串）成独立组，不与其它组混淆", () => {
		const groups = groupModelsByProvider(
			[
				{ id: "a", provider: "" },
				{ id: "b", provider: "narwal-plan" },
			],
			null,
		);
		expect(groups[0]?.[0]).toBe("");
		expect(groups[0]?.[1].map(m => m.id)).toEqual(["a"]);
		expect(groups[1]?.[0]).toBe("narwal-plan");
	});
});
