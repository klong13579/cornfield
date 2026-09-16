/**
 * 技能展示词表的测试（T10B / 56 / 57；T17 补：原因栏、同名落选、演化技能）。
 *
 * 这份词表的价值全在「唯一性」与「完整覆盖」上：
 *   - 唯一性：技能页与 Agent 详情页共用同一个定义处（谁要再写一份映射，就该先让这里的用例红）；
 *   - 覆盖：`@cornfield/wire` 的 scope / activation / status 是封闭联合，新增一个成员而没配显示词，
 *     界面上就会渲染出 `undefined`。类型系统不会拦，这里拦。
 *
 * 另一条被钉住的分界：版本显示不把内容指纹冒充成版本号 —— 前端只翻事实，不重算事实。
 *
 * T17 把这条纪律扩到另外三件事上：
 *   - `row.reason` 必须原样出来（停用来源 / 磁盘找不到）—— 折叠它 = 把 unavailable 与 disabled 又合并回去；
 *   - 演化技能的「读失败」与「空集」是两个态（`evolvedGroupState`），空数组只表示真的没有；
 *   - 域里**没有**的事实不得凭空造出来（技能域没有「权限」，也没有一个叫「冲突状态」的状态）。
 */

import { describe, expect, it } from "bun:test";
import type {
	EvolvedSkillDto,
	EvolvedSkillsDto,
	Scope,
	SkillActivation,
	SkillBlockedDto,
	SkillScopeRowDto,
	SkillStatus,
} from "@cornfield/wire";
import { SCOPE_LABELS } from "../src/lib/scope-display";
import {
	evolvedDeprecationText,
	evolvedGroupState,
	evolvedQualityText,
	evolvedRatingText,
	evolvedUsageText,
	evolvedVersionText,
	SKILL_ACTIVATION_LABELS,
	SKILL_OVERRIDE_RULE,
	SKILL_STATUS_LABELS,
	skillBlockedDetail,
	skillDayText,
	skillReasonText,
	skillStatusClass,
	skillVersionText,
} from "../src/pages/skills/skill-display";

/** wire 的 `Scope` 全集；这里按类型穷举，新增成员时这个数组必须先改。 */
const SCOPES: readonly Scope[] = ["agent", "project", "global"];
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

/** 一条演化技能；缺省值取「刚提炼出来、还没用过」这一真实形态。 */
function evolved(fields: Partial<EvolvedSkillDto>): EvolvedSkillDto {
	return {
		name: "probe",
		description: "desc",
		taskPattern: "pattern",
		approach: "approach",
		tools: [],
		pitfalls: [],
		createdAt: 1_700_000_000_000,
		usageCount: 0,
		lastUsedAt: 1_700_000_000_000,
		successCount: 0,
		failureCount: 0,
		version: 1,
		...fields,
	};
}

describe("技能展示词表", () => {
	it("scope / activation / status 的每一个成员都有显示词（没有 undefined 会渲染出来）", () => {
		expect(Object.keys(SCOPE_LABELS).sort()).toEqual([...SCOPES].sort());
		expect(Object.keys(SKILL_ACTIVATION_LABELS).sort()).toEqual([...ACTIVATIONS].sort());
		expect(Object.keys(SKILL_STATUS_LABELS).sort()).toEqual([...STATUSES].sort());
		for (const labels of [SCOPE_LABELS, SKILL_ACTIVATION_LABELS, SKILL_STATUS_LABELS]) {
			for (const text of Object.values(labels)) expect(text.length).toBeGreaterThan(0);
		}
	});

	it("同一事实在不同页面上是同一个词（词表唯一，不各自维护一套）", () => {
		expect(SCOPE_LABELS.project).toBe("Project");
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

describe("技能行的原因栏（row.reason）", () => {
	it("停用来源原样出来（不折叠成「停用」两个字）", () => {
		expect(skillReasonText(row({ status: "disabled", reason: "settings.skills.ignoredSkills" }))).toBe(
			"settings.skills.ignoredSkills",
		);
	});

	it("磁盘找不到的原因原样出来，且不丢掉前半句的停用来源", () => {
		const reason = "settings.disabledExtensions；磁盘上找不到它的 SKILL.md";
		expect(skillReasonText(row({ status: "unavailable", reason }))).toBe(reason);
	});

	it("读取失败的原文原样出来（serve 的 error 不被摘要）", () => {
		const reason = "SKILL.md 读取失败：EACCES: permission denied";
		expect(skillReasonText(row({ status: "unavailable", reason }))).toBe(reason);
	});

	it("没有原因 = null（不是空字符串，渲染不出空白栏）", () => {
		expect(skillReasonText(row({}))).toBeNull();
		expect(skillReasonText(row({ reason: "" }))).toBeNull();
		expect(skillReasonText(row({ reason: "   " }))).toBeNull();
	});
});

describe("同名落选者与覆盖规则", () => {
	const blocked: SkillBlockedDto = {
		name: "dup",
		path: "/w/project/.cornfield/skills/dup/SKILL.md",
		reason: 'name collision: "dup" already loaded from /w/agent/skills/dup/SKILL.md, skipping this one',
	};

	it("覆盖规则说清了机制：先到者生效（按来源优先级），后到的同名一律不加载", () => {
		expect(SKILL_OVERRIDE_RULE).toContain("先到者生效");
		expect(SKILL_OVERRIDE_RULE).toContain("同名");
		expect(SKILL_OVERRIDE_RULE).toContain("不加载");
	});

	it("落选行给出「落选的是谁」与 serve 的原因，胜出者路径原样留着（不解析英文句子重写）", () => {
		const detail = skillBlockedDetail(blocked);
		expect(detail).toContain(blocked.path);
		expect(detail).toContain(blocked.reason);
		// 胜出者路径只在 reason 里 —— 被摘要掉就没有证据了
		expect(detail).toContain("already loaded from /w/agent/skills/dup/SKILL.md");
	});

	it("技能域没有「权限」，也没有一个叫「冲突状态」的状态；受阻只有原因 + 规则", () => {
		const vocabulary = [
			...Object.values(SCOPE_LABELS),
			...Object.values(SKILL_ACTIVATION_LABELS),
			...Object.values(SKILL_STATUS_LABELS),
			SKILL_OVERRIDE_RULE,
			skillBlockedDetail(blocked),
		].join(" ");
		expect(vocabulary).not.toContain("权限");
		expect(vocabulary).not.toContain("冲突状态");
	});
});

describe("日期显示", () => {
	it("毫秒时间戳 → 本地日期", () => {
		const ts = Date.UTC(2026, 8, 16, 3, 0, 0);
		const date = new Date(ts);
		const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		expect(skillDayText(ts)).toBe(expected);
	});

	it("缺省 / 0 / NaN 都不渲染日期（0 不是 1970-01-01，是「没记录」）", () => {
		expect(skillDayText(undefined)).toBeNull();
		expect(skillDayText(0)).toBeNull();
		expect(skillDayText(-1)).toBeNull();
		expect(skillDayText(Number.NaN)).toBeNull();
	});
});

describe("演化技能分组的状态判决", () => {
	const dto = (skills: EvolvedSkillDto[], error?: string): EvolvedSkillsDto =>
		error === undefined ? { skills } : { skills, error };

	it("未连接：连接态说了算", () => {
		expect(evolvedGroupState({ connected: false, dto: null, error: null }).kind).toBe("disconnected");
	});

	it("读失败绝不落进空态 —— 即使手上有一份「空清单」", () => {
		const state = evolvedGroupState({ connected: true, dto: dto([]), error: "get_evolved_skills 失败：库坏了" });
		expect(state.kind).toBe("error");
		if (state.kind === "error") expect(state.message).toContain("库坏了");
	});

	it("还没读到 = 正在读（不是空组）", () => {
		expect(evolvedGroupState({ connected: true, dto: null, error: null }).kind).toBe("loading");
	});

	it("空数组 = 库读到了、确实没有（这才是「还没演化出技能」）", () => {
		expect(evolvedGroupState({ connected: true, dto: dto([]), error: null }).kind).toBe("empty");
	});

	it("有清单就是 rows，且逐字透传（不补默认值）", () => {
		const skill = evolved({ name: "a" });
		const state = evolvedGroupState({ connected: true, dto: dto([skill]), error: null });
		expect(state.kind).toBe("rows");
		if (state.kind === "rows") expect(state.rows).toEqual([skill]);
	});

	it("降级（个别行没读全）在空集与清单两种情形里都不被吞掉", () => {
		const empty = evolvedGroupState({ connected: true, dto: dto([], "2 条没读全"), error: null });
		expect(empty.kind).toBe("empty");
		if (empty.kind === "empty") expect(empty.degraded).toBe("2 条没读全");
		const rows = evolvedGroupState({ connected: true, dto: dto([evolved({})], "2 条没读全"), error: null });
		expect(rows.kind).toBe("rows");
		if (rows.kind === "rows") expect(rows.degraded).toBe("2 条没读全");
	});
});

describe("演化技能的事实显示", () => {
	it("质量分：没评过 = null；0 分是一个真实分数，必须显示出来", () => {
		expect(evolvedQualityText(evolved({}))).toBeNull();
		expect(evolvedQualityText(evolved({ qualityScore: 0 }))).toBe("质量 0/100");
		expect(evolvedQualityText(evolved({ qualityScore: 82 }))).toBe("质量 82/100");
	});

	it("使用统计：没用过就说没用过，不摆一排 0", () => {
		expect(evolvedUsageText(evolved({}))).toBe("从未使用");
		expect(evolvedUsageText(evolved({ usageCount: 12, successCount: 9, failureCount: 3 }))).toBe(
			"用过 12 次 · 成功 9 / 失败 3",
		);
	});

	it("废弃三态：true / false / 无记录 是三种不同的说法", () => {
		expect(evolvedDeprecationText(evolved({ deprecated: true, deprecationReason: "被新技能取代" }))).toBe(
			"已废弃：被新技能取代",
		);
		expect(evolvedDeprecationText(evolved({ deprecated: true }))).toBe("已废弃");
		expect(evolvedDeprecationText(evolved({ deprecated: false }))).toBe("在用");
		const unknown = evolvedDeprecationText(evolved({}));
		expect(unknown).not.toBe("在用");
		expect(unknown).not.toBe("已废弃");
	});

	it("人工评分：没评过 = null；有分就有星", () => {
		expect(evolvedRatingText(evolved({}))).toBeNull();
		expect(evolvedRatingText(evolved({ userRating: 4 }))).toBe("人工评分 4/5");
	});

	it("版本是演化库里的整数，直接带出来", () => {
		expect(evolvedVersionText(evolved({ version: 3 }))).toBe("v3");
	});
});
