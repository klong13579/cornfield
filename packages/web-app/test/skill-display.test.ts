/**
 * 技能展示词表的测试（T10B / 56 / 57）。
 *
 * 这份词表的价值全在「唯一性」与「完整覆盖」上：
 *   - 唯一性：技能页与 Agent 详情页共用同一个定义处（谁要再写一份映射，就该先让这里的用例红）；
 *   - 覆盖：`@cornfield/wire` 的 scope / activation / status 是封闭联合，新增一个成员而没配显示词，
 *     界面上就会渲染出 `undefined`。类型系统不会拦，这里拦。
 *
 * 另一条被钉住的分界：版本显示不把内容指纹冒充成版本号 —— 前端只翻事实，不重算事实。
 */

import { describe, expect, it } from "bun:test";
import type { SkillActivation, SkillScope, SkillScopeRowDto, SkillStatus } from "@cornfield/wire";
import {
	SKILL_ACTIVATION_LABELS,
	SKILL_SCOPE_LABELS,
	SKILL_STATUS_LABELS,
	skillStatusClass,
	skillVersionText,
} from "../src/pages/skills/skill-display";

/** wire 的 `SkillScope` 全集；这里按类型穷举，新增成员时这个数组必须先改。 */
const SCOPES: readonly SkillScope[] = ["agent", "project", "global"];
const ACTIVATIONS: readonly SkillActivation[] = ["loaded", "discoverable", "blocked"];
const STATUSES: readonly SkillStatus[] = ["enabled", "disabled", "deprecated", "unavailable"];

function row(fields: Partial<SkillScopeRowDto>): SkillScopeRowDto {
	return {
		name: "probe",
		description: "",
		origin: "native:agent",
		path: "/tmp/probe/SKILL.md",
		scope: "agent",
		activation: "loaded",
		status: "enabled",
		...fields,
	};
}

describe("技能展示词表", () => {
	it("scope / activation / status 的每一个成员都有显示词（没有 undefined 会渲染出来）", () => {
		expect(Object.keys(SKILL_SCOPE_LABELS).sort()).toEqual([...SCOPES].sort());
		expect(Object.keys(SKILL_ACTIVATION_LABELS).sort()).toEqual([...ACTIVATIONS].sort());
		expect(Object.keys(SKILL_STATUS_LABELS).sort()).toEqual([...STATUSES].sort());
		for (const labels of [SKILL_SCOPE_LABELS, SKILL_ACTIVATION_LABELS, SKILL_STATUS_LABELS]) {
			for (const text of Object.values(labels)) expect(text.length).toBeGreaterThan(0);
		}
	});

	it("同一事实在不同页面上是同一个词（词表唯一，不各自维护一套）", () => {
		expect(SKILL_SCOPE_LABELS.project).toBe("Project");
		expect(SKILL_ACTIVATION_LABELS.blocked).toBe("受阻");
		expect(SKILL_STATUS_LABELS.unavailable).toBe("读不到");
	});

	it("版本显示：声明优先，回 v<声明>", () => {
		expect(skillVersionText(row({ version: "1.4.0", fingerprint: "abcd1234" }))).toBe("v1.4.0");
	});

	it("没声明版本时给指纹，且不把它写成版本号（指纹不是版本）", () => {
		const text = skillVersionText(row({ fingerprint: "abcd1234" }));
		expect(text).toBe("指纹 abcd1234");
		expect(text.startsWith("v")).toBe(false);
	});

	it("两样都没有 = 版本未知（不是空字符串，也不是「vundefined」）", () => {
		expect(skillVersionText(row({}))).toBe("版本未知");
	});

	it("空字符串版本按没声明处理（不渲染「v」）", () => {
		expect(skillVersionText(row({ version: "" }))).toBe("版本未知");
	});

	it("读不到与停用不是一件事，配色也不同", () => {
		expect(skillStatusClass("unavailable")).not.toBe(skillStatusClass("disabled"));
		expect(skillStatusClass("enabled")).not.toBe(skillStatusClass("disabled"));
	});

	it("每个 status 都有配色，且互不相同（没有两个状态长得一样）", () => {
		const classes = STATUSES.map(status => skillStatusClass(status));
		expect(classes.every(value => value.length > 0)).toBe(true);
		expect(new Set(classes).size).toBe(STATUSES.length);
	});
});
