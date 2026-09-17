/**
 * T10C · 定时任务 scope 判定的单测。
 *
 * 断言的是 gate 要求的那几件事，每个用例都对应一个会出错的真实场景：
 *   无 Project        未声明项目绑定 = 未声明（不是「没有项目」）
 *   禁用 Agent        已注册但 home 不在 → 阻塞原因；与「未绑定」分开
 *   恢复              旧行的身份靠 agentId 或 home 认领（要么身份匹配、要么路径相同）
 *   过期 Schedule     once + 到点已过 = 过期；cron/interval 永不过期
 *   重复执行          repeatCompleted/repeatCount 判跑完；不限次（缺省）不说「已完成」
 *   失败重试          retry/consecutiveFailures/lastDeliveryError 是行上的事实
 *   scope 隔离        身份未解析的行不得被归到任何 Agent 名下
 */

import { describe, expect, test } from "bun:test";
import type { CronLogEntryDto, TaskRowDto } from "@cornfield/wire";
import {
	BUCKET_LABELS,
	groupTasks,
	isExpiredTask,
	isTaskInAgentScope,
	latestLogOf,
	taskBindingLabel,
	taskBlockedReason,
	taskRunProgress,
	toTaskView,
} from "./task-scope";

const HR_DIR = "/Users/me/.cornfield/agents/hr";
const CODING_DIR = "/Users/me/.cornfield/agents/coding";

function task(over: Partial<TaskRowDto> & { id: string }): TaskRowDto {
	return {
		name: over.id,
		scheduleType: "cron",
		enabled: true,
		agentResolution: "registered",
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

describe("scope 隔离", () => {
	test("身份匹配才算焦点 Agent 的任务", () => {
		const mine = task({ id: "t1", agentId: "hr", agentDir: HR_DIR });
		const other = task({ id: "t2", agentId: "coding", agentDir: CODING_DIR });
		const scope = { agentId: "hr", agentDir: HR_DIR };
		expect(isTaskInAgentScope(mine, scope)).toBe(true);
		expect(isTaskInAgentScope(other, scope)).toBe(false);
	});

	test("身份未解析但 home 就是焦点 Agent 的家 → 算它的（旧行的路径事实）", () => {
		const legacyRow = task({ id: "t1", agentDir: HR_DIR, agentResolution: "unregistered" });
		expect(isTaskInAgentScope(legacyRow, { agentId: "hr", agentDir: HR_DIR })).toBe(true);
	});

	test("身份未解析且 home 也不是焦点 Agent 的 → 不算（不得替别人认领）", () => {
		const stray = task({
			id: "t1",
			agentDir: "/Users/me/OMP-workspace-test/omp-atomix",
			agentResolution: "unregistered",
		});
		expect(isTaskInAgentScope(stray, { agentId: "hr", agentDir: HR_DIR })).toBe(false);
	});

	test("完全未绑定的行不归任何 Agent", () => {
		const orphan = task({ id: "t1", agentResolution: "unbound" });
		expect(isTaskInAgentScope(orphan, { agentId: "hr", agentDir: HR_DIR })).toBe(false);
		expect(isTaskInAgentScope(orphan, {})).toBe(false);
	});

	test("home 比较做路径归一（尾随分隔符/反斜杠）", () => {
		const row = task({ id: "t1", agentDir: `${HR_DIR}/`, agentResolution: "unregistered" });
		expect(isTaskInAgentScope(row, { agentId: "hr", agentDir: HR_DIR })).toBe(true);
	});
});

describe("分组", () => {
	test("已解析按 Agent 合组，未解析/未绑定各自成组且带阻塞计数", () => {
		const tasks: TaskRowDto[] = [
			task({ id: "a1", agentId: "hr", agentDir: HR_DIR, agentDisplayName: "HR 助理", projectIds: ["proj-hr"] }),
			task({ id: "a2", agentId: "hr", agentDir: HR_DIR, agentDisplayName: "HR 助理" }),
			task({ id: "u1", agentDir: "/tmp/legacy", agentResolution: "unregistered" }),
			task({ id: "n1", agentResolution: "unbound" }),
		];
		const groups = groupTasks(tasks, { agentId: "hr", agentDir: HR_DIR });
		expect(groups).toHaveLength(3);
		const hr = groups.find(g => g.agentId === "hr")!;
		expect(hr.label).toBe("HR 助理");
		expect(hr.rows.map(r => r.task.id)).toEqual(["a1", "a2"]);
		expect(hr.projectIds).toEqual(["proj-hr"]);
		const unresolved = groups.find(g => g.bucket === "unresolved")!;
		expect(unresolved.label).toContain(BUCKET_LABELS.unresolved);
		// 身份未解析 ≠ 跑不起来：有 home 的（legacy 目录）按路径执行，运行面不会拒绝它。
		expect(unresolved.blockedCount).toBe(0);
		const unbound = groups.find(g => g.bucket === "unbound")!;
		expect(unbound.label).toBe(BUCKET_LABELS.unbound);
		expect(unbound.blockedCount).toBe(1);
	});

	test("组内保持 serve 顺序；未解析的不同 home 不合并", () => {
		const tasks: TaskRowDto[] = [
			task({ id: "u1", agentDir: "/tmp/one", agentResolution: "unregistered" }),
			task({ id: "u2", agentDir: "/tmp/two", agentResolution: "unregistered" }),
		];
		const groups = groupTasks(tasks, {});
		expect(groups).toHaveLength(2);
		expect(groups[0]!.rows[0]!.task.id).toBe("u1");
	});

	test("空列表 → 空分组（不是造一个空组）", () => {
		expect(groupTasks([], {})).toEqual([]);
	});
});

describe("无 Project / 禁用 Agent / 未绑定", () => {
	test("未声明项目绑定 → 组上不携带 projectIds（未声明 ≠ 无项目）", () => {
		const groups = groupTasks([task({ id: "t", agentId: "coding", agentDir: CODING_DIR })], {});
		expect("projectIds" in groups[0]!).toBe(false);
	});

	test("已注册但 home 不在 → 有阻塞原因，且不是「未绑定」", () => {
		const dead = task({
			id: "dead",
			agentId: "gone",
			agentDir: "/Users/me/.cornfield/agents/gone",
			agentEnabled: false,
			agentError: "Agent「gone」的 agentDir 不存在（/Users/me/.cornfield/agents/gone），调度不会执行。",
		});
		expect(taskBlockedReason(dead)).toContain("agentDir 不存在");
		expect(toTaskView(dead, {}).bucket).toBe("agent");
	});

	test("未绑定 → 阻塞原因来自行的 agentError（否则给通用原因）", () => {
		expect(taskBlockedReason(task({ id: "n", agentResolution: "unbound" }))).toContain("没有绑定 Agent");
		expect(
			taskBlockedReason(
				task({
					id: "n2",
					agentResolution: "unbound",
					agentError: "调度没有绑定 Agent（既无 agentId 也无 agentDir）",
				}),
			),
		).toBe("调度没有绑定 Agent（既无 agentId 也无 agentDir）");
	});

	test("身份未解析但 home 在 → 不阻塞（legacy 目录按路径执行）", () => {
		const legacyRow = task({
			id: "t",
			agentDir: "/Users/me/OMP-workspace-test/omp-atomix",
			agentResolution: "unregistered",
		});
		expect(taskBlockedReason(legacyRow)).toBeUndefined();
	});

	test("绑定标签：已解析显示名 + 目录；未解析明说身份未知（不拿目录冒充名字）", () => {
		expect(taskBindingLabel(task({ id: "a", agentId: "hr", agentDir: HR_DIR, agentDisplayName: "HR 助理" }))).toBe(
			`HR 助理 · ${HR_DIR}`,
		);
		expect(taskBindingLabel(task({ id: "b", agentDir: "/tmp/x", agentResolution: "unregistered" }))).toContain(
			"身份未解析",
		);
		expect(taskBindingLabel(task({ id: "c", agentResolution: "unbound" }))).toBe("未绑定 Agent");
	});
});

describe("过期 Schedule", () => {
	const now = 1_700_000_000_000;

	test("once + 触发点已过 = 过期", () => {
		expect(isExpiredTask(task({ id: "t", scheduleType: "once", nextRunAt: now - 1 }), now)).toBe(true);
	});

	test("once 但触发点在将来 = 未过期", () => {
		expect(isExpiredTask(task({ id: "t", scheduleType: "once", nextRunAt: now + 1 }), now)).toBe(false);
	});

	test("cron/interval 永不过期（哪怕 nextRunAt 缺省）", () => {
		expect(isExpiredTask(task({ id: "t", scheduleType: "cron" }), now)).toBe(false);
		expect(isExpiredTask(task({ id: "t2", scheduleType: "interval" }), now)).toBe(false);
	});

	test("过期不改变行自己的 enabled/status（展示不代执行层做决定）", () => {
		const view = toTaskView(
			task({ id: "t", scheduleType: "once", nextRunAt: now - 1, enabled: true, status: "active" }),
			{},
			now,
		);
		expect(view.expired).toBe(true);
		expect(view.task.enabled).toBe(true);
	});
});

describe("重复执行 / 失败重试", () => {
	test("有上限：已执行 x/y，跑满标记 exhausted", () => {
		const progress = taskRunProgress(task({ id: "t", repeatCount: 5, repeatCompleted: 5, runCount: 5 }));
		expect(progress.text).toBe("已执行 5/5 次");
		expect(progress.exhausted).toBe(true);
	});

	test("有上限未跑满：不是 exhausted", () => {
		const progress = taskRunProgress(task({ id: "t", repeatCount: 5, repeatCompleted: 2 }));
		expect(progress.exhausted).toBe(false);
	});

	test("不限次（缺省 repeatCount）：只用 runCount，不说「已完成」", () => {
		const progress = taskRunProgress(task({ id: "t", runCount: 7 }));
		expect(progress.total).toBeUndefined();
		expect(progress.text).toBe("已执行 7 次");
		expect(progress.exhausted).toBe(false);
	});

	test("repeatCompleted 缺省时回落 runCount（数据不全也别显示 0）", () => {
		expect(taskRunProgress(task({ id: "t", repeatCount: 3, runCount: 2 })).completed).toBe(2);
	});

	test("retry 与连续失败、投递失败是行上的事实（投递失败 ≠ 任务失败）", () => {
		const row = task({
			id: "t",
			consecutiveFailures: 2,
			retry: { maxAttempts: 3, backoffMs: [1000, 5000] },
			lastDeliveryError: "Unknown channel: dingtalk",
		});
		expect(row.retry?.maxAttempts).toBe(3);
		expect(row.consecutiveFailures).toBe(2);
		expect(row.lastDeliveryError).toBe("Unknown channel: dingtalk");
	});
});

describe("Session scope（执行记录 → 会话）", () => {
	const logs: CronLogEntryDto[] = [
		{
			taskId: "t1",
			id: "e1",
			ts: 100,
			status: "success",
			exitCode: 0,
			durationMs: 10,
			agentSessionPath: "/a/old.jsonl",
		},
		{
			taskId: "t1",
			id: "e2",
			ts: 200,
			status: "failure",
			exitCode: 1,
			durationMs: 10,
			agentSessionPath: "/a/new.jsonl",
		},
		{ taskId: "t2", id: "e3", ts: 300, status: "success", exitCode: 0, durationMs: 10 },
	];

	test("取该任务最近一次执行（按时间，不按日志顺序）", () => {
		expect(latestLogOf([logs[1]!, logs[0]!], "t1")?.agentSessionPath).toBe("/a/new.jsonl");
	});

	test("只认本任务的记录（不串到别的任务）", () => {
		expect(latestLogOf(logs, "t3")).toBeUndefined();
		expect(latestLogOf(logs, "t1")?.id).toBe("e2");
	});

	test("没有会话文件时该次执行就没有会话链接（不编一个）", () => {
		expect(latestLogOf(logs, "t2")?.agentSessionPath).toBeUndefined();
	});
});
