import { describe, expect, test } from "bun:test";
import type { ConfigScopeKeyDto } from "@cornfield/wire";
import {
	FEATURED_SCOPE_KEY_META,
	FEATURED_SCOPE_KEY_ORDER,
	groupAdvancedKeys,
	splitScopeKeys,
} from "../src/pages/models/config/scope-keys";

function key(key: string, overrides: Partial<ConfigScopeKeyDto> = {}): ConfigScopeKeyDto {
	return {
		key,
		overridden: false,
		effectiveValue: null,
		...overrides,
	};
}

describe("splitScopeKeys", () => {
	test("精选键按精选顺序输出（而非 schema 顺序）", () => {
		const { featured } = splitScopeKeys([key("python.toolMode"), key("temperature"), key("defaultThinkingLevel")]);
		expect(featured.map(k => k.key)).toEqual(["defaultThinkingLevel", "temperature", "python.toolMode"]);
	});

	test("schema 中不存在的精选键自动跳过，不产出幽灵条目", () => {
		const { featured, advanced } = splitScopeKeys([key("defaultThinkingLevel"), key("theme.color")]);
		expect(featured.map(k => k.key)).toEqual(["defaultThinkingLevel"]);
		expect(advanced.map(k => k.key)).toEqual(["theme.color"]);
	});

	test("非精选键全部落入 advanced 且保持原顺序", () => {
		const { advanced } = splitScopeKeys([
			key("b.beta"),
			key("defaultThinkingLevel"),
			key("a.alpha"),
			key("temperature"),
		]);
		expect(advanced.map(k => k.key)).toEqual(["b.beta", "a.alpha"]);
	});

	test("同一键不会同时出现在 featured 与 advanced", () => {
		const all = [...FEATURED_SCOPE_KEY_ORDER.map(k => key(k)), key("extra.x")];
		const { featured, advanced } = splitScopeKeys(all);
		const featuredSet = new Set(featured.map(k => k.key));
		for (const k of advanced) {
			expect(featuredSet.has(k.key)).toBe(false);
		}
		expect(featured.length + advanced.length).toBe(all.length);
	});

	test("空键集 → 两侧皆空", () => {
		const { featured, advanced } = splitScopeKeys([]);
		expect(featured).toEqual([]);
		expect(advanced).toEqual([]);
	});

	test("精选清单不变量：每个精选键都有中文标签与说明，且无重复", () => {
		expect(FEATURED_SCOPE_KEY_META.size).toBe(FEATURED_SCOPE_KEY_ORDER.length);
		for (const k of FEATURED_SCOPE_KEY_ORDER) {
			const meta = FEATURED_SCOPE_KEY_META.get(k);
			expect(meta).toBeDefined();
			expect(meta!.label.length).toBeGreaterThan(0);
			expect(meta!.description.length).toBeGreaterThan(0);
			expect(meta!.label).not.toMatch(/^[\x20-\x7E]+$/); // 标签必须是中文（含非 ASCII）
		}
	});

	test("编辑器元数据不变量：全部精选键都有 editor，且 5 枚举 / 4 布尔 / 3 数字", () => {
		const kinds = { enum: 0, boolean: 0, number: 0 } as Record<string, number>;
		for (const k of FEATURED_SCOPE_KEY_ORDER) {
			const editor = FEATURED_SCOPE_KEY_META.get(k)!.editor;
			expect(editor).toBeDefined();
			kinds[editor!.kind] += 1;
			if (editor!.kind === "enum") {
				expect(editor!.values.length).toBeGreaterThan(0);
				expect(new Set(editor!.values).size).toBe(editor!.values.length); // 无重复取值
			}
		}
		expect(kinds).toEqual({ enum: 5, boolean: 4, number: 3 });
	});
});

describe("groupAdvancedKeys", () => {
	test("按 uiTab 分组：已知 tab 按固定顺序，组内字母序", () => {
		const dto = (key: string, uiTab?: string): ConfigScopeKeyDto => ({
			key,
			...(uiTab ? { uiTab } : {}),
			overridden: false,
			effectiveValue: null,
		});
		const groups = groupAdvancedKeys([
			dto("tools.zeta", "tools"),
			dto("tools.alpha", "tools"),
			dto("model.m1", "model"),
			dto("plain.noTab"),
			dto("tasks.t1", "tasks"),
		]);
		expect(groups.map(g => g.tab)).toEqual(["model", "tools", "tasks", "system"]);
		expect(groups.map(g => g.label)).toEqual(["模型", "工具", "任务", "基础与系统"]);
		expect(groups[0]!.keys.map(k => k.key)).toEqual(["model.m1"]);
		expect(groups[1]!.keys.map(k => k.key)).toEqual(["tools.alpha", "tools.zeta"]);
		expect(groups[3]!.keys.map(k => k.key)).toEqual(["plain.noTab"]);
	});

	test("未知 tab 不丢弃：按字母序排在已知组与 system 之后", () => {
		const groups = groupAdvancedKeys([
			{ key: "a", uiTab: "zebra", overridden: false, effectiveValue: null },
			{ key: "b", uiTab: "alpha-new", overridden: false, effectiveValue: null },
			{ key: "c", overridden: false, effectiveValue: null },
		]);
		expect(groups.map(g => g.tab)).toEqual(["system", "alpha-new", "zebra"]);
	});
});
