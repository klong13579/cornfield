import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntryDto } from "@cornfield/wire";
import { availableModels, filterModels, groupModelsByProvider } from "../src/pages/models/config/model-options";

function model(provider: string, id: string, overrides: Partial<ModelCatalogEntryDto> = {}): ModelCatalogEntryDto {
	return {
		provider,
		id,
		name: overrides.name ?? `${provider} ${id}`,
		status: overrides.status ?? "available",
	};
}

describe("availableModels", () => {
	test("仅保留 available，其余状态全部剔除", () => {
		const out = availableModels([
			model("a", "1", { status: "available" }),
			model("a", "2", { status: "no-credential" }),
			model("b", "3", { status: "unreachable" }),
			model("b", "4"),
		]);
		expect(out.map(m => `${m.provider}/${m.id}`)).toEqual(["a/1", "b/4"]);
	});
});

describe("filterModels", () => {
	const list = [model("narwal-plan", "claude-haiku-4-5"), model("narwal-plan", "glm-4.7", { name: "智谱 GLM" }), model("kimi-code", "kimi-latest")];

	test("空查询返回原列表（同引用）", () => {
		expect(filterModels(list, "  ")).toBe(list);
	});

	test("按 id / provider / 名称子串过滤，大小写不敏感", () => {
		expect(filterModels(list, "HAIKU").map(m => m.id)).toEqual(["claude-haiku-4-5"]);
		expect(filterModels(list, "narwal").map(m => m.id)).toEqual(["claude-haiku-4-5", "glm-4.7"]);
		expect(filterModels(list, "智谱").map(m => m.id)).toEqual(["glm-4.7"]);
	});

	test("无匹配返回空列表", () => {
		expect(filterModels(list, "nope")).toEqual([]);
	});
});

describe("groupModelsByProvider", () => {
	test("组名字母序，组内保持原顺序", () => {
		const groups = groupModelsByProvider([
			model("zeta", "m1"),
			model("alpha", "m2"),
			model("zeta", "m0"),
			model("alpha", "m3"),
		]);
		expect(groups.map(g => g.provider)).toEqual(["alpha", "zeta"]);
		expect(groups[0]!.models.map(m => m.id)).toEqual(["m2", "m3"]);
		expect(groups[1]!.models.map(m => m.id)).toEqual(["m1", "m0"]);
	});

	test("空列表 → 空分组", () => {
		expect(groupModelsByProvider([])).toEqual([]);
	});
});
