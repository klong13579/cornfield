/**
 * W3 D4 —— cron 预设逻辑单测（纯函数，不依赖 DOM/server）。
 * 覆盖：预设→表达式、表达式→预设反向识别、croner 预览（校验 + 下次触发）、字段边界。
 */
import { describe, expect, it } from "bun:test";
import type { TaskRowDto } from "../src/lib/wire-dto";
import {
	buildCronExpression,
	normalizeCronField,
	previewCronExpression,
	stateFromCronExpression,
} from "../src/pages/tasks/cron-schedule";
import { groupTasksByAccount, UNSPECIFIED_AGENT_LABEL } from "../src/pages/tasks/TasksView";

describe("buildCronExpression（预设 → 5 字段表达式，hermes 规格）", () => {
	it("hourly: <minute> * * * *", () => {
		expect(buildCronExpression("hourly", { minute: 15 })).toBe("15 * * * *");
	});

	it("daily: <minute> <hour> * * *", () => {
		expect(buildCronExpression("daily", { hour: 9, minute: 0 })).toBe("0 9 * * *");
	});

	it("weekdays: <minute> <hour> * * 1-5", () => {
		expect(buildCronExpression("weekdays", { hour: 9, minute: 30 })).toBe("30 9 * * 1-5");
	});

	it("weekly: <minute> <hour> * * <weekday>（cron 编号，1=周一）", () => {
		expect(buildCronExpression("weekly", { hour: 9, minute: 0, weekday: 1 })).toBe("0 9 * * 1");
		expect(buildCronExpression("weekly", { hour: 18, minute: 5, weekday: 5 })).toBe("5 18 * * 5");
	});

	it("monthly: <minute> <hour> <monthDay> * *", () => {
		expect(buildCronExpression("monthly", { hour: 9, minute: 0, monthDay: 1 })).toBe("0 9 1 * *");
	});

	it("custom / unknown 返回空字符串", () => {
		expect(buildCronExpression("custom", {})).toBe("");
		expect(buildCronExpression("bogus" as never, {})).toBe("");
	});

	it("字段默认值（省略 = 9:00 / 1 号 / 周一）", () => {
		expect(buildCronExpression("daily", {})).toBe("0 9 * * *");
		expect(buildCronExpression("weekly", {})).toBe("0 9 * * 1");
		expect(buildCronExpression("monthly", {})).toBe("0 9 1 * *");
	});
});

describe("normalizeCronField（边界钳制）", () => {
	it("非法/空值回退 fallback，越界钳到边界", () => {
		expect(normalizeCronField("hour", 99)).toBe(23);
		expect(normalizeCronField("hour", -1)).toBe(0);
		expect(normalizeCronField("minute", "abc")).toBe(0);
		expect(normalizeCronField("minute", undefined, 30)).toBe(30);
		expect(normalizeCronField("monthDay", 0)).toBe(1);
		expect(normalizeCronField("monthDay", 32)).toBe(31);
	});
});

describe("stateFromCronExpression（表达式 → 预设反向识别）", () => {
	it("daily / weekdays / hourly / weekly / monthly 识别", () => {
		expect(stateFromCronExpression("0 9 * * *")).toEqual({ presetId: "daily", values: { minute: 0, hour: 9 } });
		expect(stateFromCronExpression("30 9 * * 1-5")).toEqual({
			presetId: "weekdays",
			values: { minute: 30, hour: 9 },
		});
		expect(stateFromCronExpression("15 * * * *")).toEqual({ presetId: "hourly", values: { minute: 15 } });
		expect(stateFromCronExpression("0 9 * * 5")).toEqual({
			presetId: "weekly",
			values: { minute: 0, hour: 9, weekday: 5 },
		});
		expect(stateFromCronExpression("0 9 * * 7")).toEqual({
			presetId: "weekly",
			values: { minute: 0, hour: 9, weekday: 0 },
		});
		expect(stateFromCronExpression("5 18 1 * *")).toEqual({
			presetId: "monthly",
			values: { minute: 5, hour: 18, monthDay: 1 },
		});
	});

	it("识别不出（自定义/怪表达式）回落 custom", () => {
		expect(stateFromCronExpression("*/10 * * * *")).toEqual({ presetId: "custom", values: {} });
		expect(stateFromCronExpression("0 9 * * 1,3")).toEqual({ presetId: "custom", values: {} });
		expect(stateFromCronExpression("not cron")).toEqual({ presetId: "custom", values: {} });
		expect(stateFromCronExpression("")).toEqual({ presetId: "custom", values: {} });
	});
});

describe("previewCronExpression（croner 校验 + 下次触发）", () => {
	it("合法表达式：返回升序 nextRuns，且都在 now 之后", () => {
		const before = Date.now();
		const p = previewCronExpression("0 * * * *", 3);
		expect(p.valid).toBe(true);
		expect(p.nextRuns.length).toBe(3);
		expect(p.nextRuns[0]! > before).toBe(true);
		expect(p.nextRuns[0]! < p.nextRuns[1]!).toBe(true);
		expect(p.nextRuns[1]! < p.nextRuns[2]!).toBe(true);
		// 整点小时 cron：下一次触发秒数为 0
		expect(new Date(p.nextRuns[0]!).getMinutes()).toBe(0);
	});

	it("非法表达式：valid=false + error，不抛", () => {
		const p = previewCronExpression("99 25 * * *", 3);
		expect(p.valid).toBe(false);
		expect(p.error).toBeTruthy();
		const q = previewCronExpression("not-a-cron", 3);
		expect(q.valid).toBe(false);
	});

	it("空表达式：invalid（UI 空态）", () => {
		expect(previewCronExpression("", 3).valid).toBe(false);
		expect(previewCronExpression("   ", 3).valid).toBe(false);
	});
});

describe("groupTasksByAccount（定时任务按 agent 分组）", () => {
	const row = (id: string, accountId?: string): TaskRowDto => ({
		id,
		name: id,
		scheduleType: "cron",
		enabled: true,
		accountId,
	});

	it("多 accountId 分桶：同 accountId 归一组，组间保持首现顺序", () => {
		const groups = groupTasksByAccount([row("a", "hr"), row("b", "algorithm"), row("c", "hr")]);
		expect(groups.map(g => g.accountId)).toEqual(["hr", "algorithm"]);
		expect(groups[0]?.tasks.map(t => t.id)).toEqual(["a", "c"]);
		expect(groups[1]?.tasks.map(t => t.id)).toEqual(["b"]);
	});

	it("无 accountId（缺失/空串/空白）归「未指定」组并垫底", () => {
		const groups = groupTasksByAccount([row("a", "hr"), row("b"), row("c", ""), row("d", "   ")]);
		expect(groups.map(g => g.accountId)).toEqual(["hr", ""]);
		expect(groups.at(-1)?.label).toBe(UNSPECIFIED_AGENT_LABEL);
		expect(groups.at(-1)?.tasks.map(t => t.id)).toEqual(["b", "c", "d"]);
	});

	it("组内保持 serve 顺序，不被重排", () => {
		const groups = groupTasksByAccount([row("z", "hr"), row("a", "hr"), row("m", "hr")]);
		expect(groups[0]?.tasks.map(t => t.id)).toEqual(["z", "a", "m"]);
	});

	it("空列表 → 空分组", () => {
		expect(groupTasksByAccount([])).toEqual([]);
	});

	it("group label：有 accountId 用 accountId，未指定用固定标识", () => {
		const groups = groupTasksByAccount([row("a", "hr"), row("b")]);
		expect(groups.map(g => g.label)).toEqual(["hr", UNSPECIFIED_AGENT_LABEL]);
	});
});
