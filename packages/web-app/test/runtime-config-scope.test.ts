import { describe, expect, it } from "bun:test";
import type { ConfigScopeDto, ConfigScopeKeyDto, ModelSelectionDto } from "@cornfield/wire";
import {
	describeModelWrite,
	describeRestore,
	describeWriteResult,
	formatConfigValue,
	parseConfigDraft,
	splitModelRef,
	toModelSelectionView,
	toScopeInheritanceView,
	toScopeKeyView,
} from "../src/pages/models/config/scope-view";

/**
 * 运行时配置 #05 纯逻辑回归（三层取值展示映射、覆盖/继承判定、临时/持久语义分离）。
 * 只测纯映射与文案判定（无 React / 无 store / 无网络）；组件交互由页面渲染层承载。
 */

function keyDto(overrides: Partial<ConfigScopeKeyDto>): ConfigScopeKeyDto {
	return { key: "defaultThinkingLevel", overridden: false, effectiveValue: null, ...overrides };
}

function scopeDto(overrides: Partial<ConfigScopeDto>): ConfigScopeDto {
	return { hasProjectConfig: false, globalConfigPath: "/agents/config.yml", keys: [], ...overrides };
}

function selectionDto(overrides?: {
	sessionSource?: ModelSelectionDto["session"]["source"];
	persisted?: { provider: string; modelId: string } | null;
	session?: { provider: string; modelId: string };
}): ModelSelectionDto {
	return {
		session: {
			provider: overrides?.session?.provider ?? "anthropic",
			modelId: overrides?.session?.modelId ?? "claude-x",
			source: overrides?.sessionSource ?? "persistent",
		},
		persistedDefault:
			overrides?.persisted === undefined ? { provider: "anthropic", modelId: "claude-x" } : overrides.persisted,
	};
}

describe("三层取值展示映射（toScopeKeyView）", () => {
	it("overridden 键：三层齐全，项目值/全局值/生效值逐层呈现，restorable=true", () => {
		const view = toScopeKeyView(
			keyDto({
				key: "modelRoutes",
				overridden: true,
				projectValue: { default: { primary: "p/m1", fallbacks: [] } },
				globalValue: { default: { primary: "g/m2", fallbacks: [] } },
				effectiveValue: { default: { primary: "p/m1", fallbacks: [] } },
			}),
		);
		expect(view.overridden).toBe(true);
		expect(view.restorable).toBe(true);
		expect(view.rows.map(r => r.layer)).toEqual(["project", "global", "effective"]);
		expect(view.rows.map(r => r.present)).toEqual([true, true, true]);
		expect(view.rows[0]?.text).toBe('{"default":{"primary":"p/m1","fallbacks":[]}}');
		expect(view.rows[1]?.text).toBe('{"default":{"primary":"g/m2","fallbacks":[]}}');
		expect(view.rows[2]?.text).toBe('{"default":{"primary":"p/m1","fallbacks":[]}}');
	});

	it("未覆盖键：项目层缺省并说明继承，全局值即生效值，restorable=false", () => {
		const view = toScopeKeyView(
			keyDto({ key: "defaultThinkingLevel", overridden: false, globalValue: "high", effectiveValue: "high" }),
		);
		expect(view.overridden).toBe(false);
		expect(view.restorable).toBe(false);
		const [project, global, effective] = view.rows;
		expect(project?.present).toBe(false);
		expect(project?.absentNote).toContain("继承");
		expect(global?.present).toBe(true);
		expect(global?.text).toBe("high");
		expect(effective?.text).toBe("high");
	});

	it("两层均未设置：生效层说明取 schema 默认", () => {
		const view = toScopeKeyView(keyDto({ overridden: false, effectiveValue: "medium" }));
		const [project, global, effective] = view.rows;
		expect(project?.present).toBe(false);
		expect(global?.present).toBe(false);
		expect(global?.absentNote).toContain("schema 默认");
		expect(effective?.present).toBe(true);
		expect(effective?.text).toBe("medium");
	});

	it("异常防御：overridden=true 但 projectValue 缺省 → 项目层不装作有值，给可诊断说明", () => {
		const view = toScopeKeyView(keyDto({ overridden: true, globalValue: "g", effectiveValue: "g" }));
		const [project] = view.rows;
		expect(project?.present).toBe(false);
		expect(project?.absentNote).toContain("重试刷新");
	});
});

describe("覆盖/继承判定（toScopeInheritanceView）", () => {
	it("hasProjectConfig=false → 正在继承全局，横幅为 ticket 05 要求文案", () => {
		const view = toScopeInheritanceView(scopeDto({ hasProjectConfig: false }));
		expect(view.inheritingGlobal).toBe(true);
		expect(view.inheritanceBanner).toBe("当前项目无项目级配置，正在继承全局");
		expect(view.projectConfigPath).toBeUndefined();
		expect(view.globalConfigPath).toBe("/agents/config.yml");
	});

	it("hasProjectConfig=true → 横幅为空，项目路径透出，overriddenKeys 收集被覆盖键", () => {
		const view = toScopeInheritanceView(
			scopeDto({
				hasProjectConfig: true,
				projectConfigPath: "/repo/.cornfield/config.yml",
				keys: [
					keyDto({ key: "modelRoutes", overridden: true, projectValue: {}, effectiveValue: {} }),
					keyDto({ key: "defaultThinkingLevel", overridden: false, effectiveValue: null }),
				],
			}),
		);
		expect(view.inheritingGlobal).toBe(false);
		expect(view.inheritanceBanner).toBe("");
		expect(view.projectConfigPath).toBe("/repo/.cornfield/config.yml");
		expect(view.overriddenKeys).toEqual(["modelRoutes"]);
	});
});

describe("临时/持久语义分离（toModelSelectionView + describeModelWrite）", () => {
	it("source=temporary → 会话分区标「仅当前会话（临时）」，isTemporary=true，与持久默认 diverged", () => {
		const view = toModelSelectionView(
			selectionDto({ sessionSource: "temporary", persisted: { provider: "anthropic", modelId: "claude-x" } }),
		);
		expect(view.sessionSourceLabel).toBe("仅当前会话（临时）");
		expect(view.sessionSourceNote).toContain("不写入任何配置文件");
		expect(view.isTemporary).toBe(true);
		expect(view.diverged).toBe(true);
		expect(view.persistedLabel).toBe("anthropic/claude-x");
	});

	it("source=persistent 且与持久默认一致 → diverged=false，不可重复「设为持久默认」", () => {
		const view = toModelSelectionView(selectionDto({ sessionSource: "persistent" }));
		expect(view.sessionSourceLabel).toBe("持久默认");
		expect(view.isTemporary).toBe(false);
		expect(view.diverged).toBe(false);
	});

	it("source=registry-default 且从未持久化 → 持久分区明确「未持久化过默认模型」，不与注册表默认混淆", () => {
		const view = toModelSelectionView(selectionDto({ sessionSource: "registry-default", persisted: null }));
		expect(view.sessionSourceLabel).toBe("注册表默认");
		expect(view.persistedLabel).toBe("未持久化过默认模型");
		expect(view.persistedDefault).toBeNull();
		expect(view.diverged).toBe(true);
	});

	it("持久默认存在但与会话模型不同 provider/model → diverged=true", () => {
		const view = toModelSelectionView(
			selectionDto({
				sessionSource: "temporary",
				session: { provider: "openai", modelId: "gpt-y" },
				persisted: { provider: "anthropic", modelId: "claude-x" },
			}),
		);
		expect(view.diverged).toBe(true);
		expect(view.sessionProvider).toBe("openai");
		expect(view.sessionModelId).toBe("gpt-y");
	});

	it("写入文案语义分离：临时=不写文件仅会话；持久=写全局配置非临时", () => {
		const temp = describeModelWrite("temporary", "openai", "gpt-y");
		const persist = describeModelWrite("persist", "openai", "gpt-y");
		expect(temp).toContain("openai/gpt-y");
		expect(temp).toContain("仅当前会话");
		expect(temp).toContain("不写入任何配置文件");
		expect(temp).toContain("持久默认模型不变");
		expect(persist).toContain("openai/gpt-y");
		expect(persist).toContain("持久默认");
		expect(persist).toContain("写入全局配置");
		expect(persist).toContain("这不是会话级临时切换");
	});
});

describe("恢复继承与按作用域写入结果文案", () => {
	it("恢复继承 removed=true：文案明确删除覆盖而非复制全局值，并报回落生效值", () => {
		const text = describeRestore({ key: "modelRoutes", removed: true, effectiveValue: { default: { primary: "g/m2", fallbacks: [] } } });
		expect(text).toContain("modelRoutes");
		expect(text).toContain("删除");
		expect(text).toContain("不会把全局值复制进项目文件");
		expect(text).toContain('{"default":{"primary":"g/m2","fallbacks":[]}}');
	});

	it("恢复继承 removed=false：如实说明幂等（项目本无覆盖）", () => {
		const text = describeRestore({ key: "modelRoutes", removed: false, effectiveValue: "medium" });
		expect(text).toContain("本无覆盖");
		expect(text).toContain("幂等");
		expect(text).toContain("medium");
	});

	it("写入结果：全局/项目作用域分别报实际文件路径与写入后生效值", () => {
		const globalWrite = describeWriteResult({
			key: "defaultThinkingLevel",
			scope: "global",
			scopePath: "/agents/config.yml",
			effectiveValue: "high",
		});
		expect(globalWrite).toContain("全局配置");
		expect(globalWrite).toContain("/agents/config.yml");
		expect(globalWrite).toContain("high");

		const projectWrite = describeWriteResult({
			key: "modelRoutes",
			scope: "project",
			scopePath: "/repo/.cornfield/config.yml",
			effectiveValue: { default: { primary: "p/m1", fallbacks: [] } },
		});
		expect(projectWrite).toContain("项目配置");
		expect(projectWrite).toContain("/repo/.cornfield/config.yml");
		expect(projectWrite).toContain("p/m1");
	});

	it("写入结果：作用域路径缺失时回退哨兵路径而非丢字段", () => {
		const text = describeWriteResult({ key: "k", scope: "project", effectiveValue: 1 });
		expect(text).toContain(".cornfield/config.yml");
	});
});

describe("值格式化与草稿解析（formatConfigValue / parseConfigDraft / splitModelRef）", () => {
	it("formatConfigValue：字符串原样、对象/数组 JSON、null 显式、undefined 未设置", () => {
		expect(formatConfigValue("high")).toBe("high");
		expect(formatConfigValue({ a: 1, b: [true, null] })).toBe('{"a":1,"b":[true,null]}');
		expect(formatConfigValue(null)).toBe("null");
		expect(formatConfigValue(undefined)).toBe("未设置");
	});

	it("parseConfigDraft：合法 JSON 通过（含 null/数字/嵌套），非法输入给可诊断错误", () => {
		expect(parseConfigDraft('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
		expect(parseConfigDraft("null")).toEqual({ ok: true, value: null });
		expect(parseConfigDraft("3")).toEqual({ ok: true, value: 3 });
		const bad = parseConfigDraft("");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("不是合法 JSON");
		const bad2 = parseConfigDraft("{a:1}");
		expect(bad2.ok).toBe(false);
		if (!bad2.ok) expect(bad2.error).toContain("不是合法 JSON");
	});

	it("splitModelRef：首个 `/` 切分 provider/modelId，空段拒绝", () => {
		expect(splitModelRef("openai/gpt-y")).toEqual({ provider: "openai", modelId: "gpt-y" });
		// modelId 可含 `/`（子模型命名空间）：只切首个
		expect(splitModelRef("openai/ns/gpt-y")).toEqual({ provider: "openai", modelId: "ns/gpt-y" });
		expect(splitModelRef("noprovider")).toBeNull();
		expect(splitModelRef("/gpt-y")).toBeNull();
		expect(splitModelRef("openai/")).toBeNull();
	});
});
