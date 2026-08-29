/**
 * squad-programming worker 启动协议测试
 *
 * 测试 bootstrap.ts 的 workerBrief()——写进子 omp 开场 brief 的协议文本：
 *   STARTED 汇报 / ask 带 to / ACK 回复 / GO 闸门与幂等 / CANCEL / 提交铁律
 *
 * 这些断言锁定「父侧调度（reconcile/GO）」与「worker 侧行为」的契约：
 * 文本改了协议语义就变，测试跟着变。
 */
import { describe, test, expect } from "bun:test";

import { workerBrief } from "../scripts/bootstrap.ts";

// 注意：import 不触发 main()（bootstrap.ts 用 import.meta.main 守卫）。
// 若这个守卫被移除，import 会直接执行集结逻辑——下面的第一个 test 就是回归锚点。

const bundle = {
	squadId: "squad-test-protocol",
	taskType: "code",
	baseBranch: "main",
	maxConcurrency: 3,
	squadVersion: 2,
	modelTiers: {
		cheap: "narwal-plan/deepseek-v4-flash",
		mid: "narwal-plan/deepseek-v4-pro",
		high: "narwal-plan/glm-5.3",
		banned: ["narwal-plan/claude-opus-*"],
	},
	parent: { target: "planner", sessionId: "sess-001", cwd: "/tmp" },
	subtasks: [],
	reportProtocol: { status: "send", ask: "ask-with-to" },
};

const subtask = {
	id: "T1",
	title: "协议测试任务",
	kind: "code" as const,
	isolation: "worktree" as const,
	scope: { files: ["packages/foo/**"] },
	deps: [],
	acceptance: "bun test packages/foo",
	gate: { kind: "derived" as const, mergePolicy: "auto" as const },
	modelTier: "cheap" as const,
	branch: "feat/t1",
};

function brief(): string {
	return workerBrief(bundle, subtask, "narwal-plan/deepseek-v4-flash", "/tmp/.worktrees/feat-t1/.squad.json");
}

describe("worker brief: import 安全", () => {
	test("import bootstrap.ts 不执行 main()（import.meta.main 守卫）", () => {
		// 能走到这里说明 import 未触发 process.exit / 集结逻辑
		expect(typeof workerBrief).toBe("function");
	});
});

describe("worker brief: STARTED 汇报协议", () => {
	test("包含 STARTED 发送格式与父 target", () => {
		const b = brief();
		expect(b).toContain("[T1] STARTED");
		expect(b).toContain("planner");
	});

	test("启动窗口期 send 失败不重试不中断（父 ask 拉动确认）", () => {
		const b = brief();
		expect(b).toContain("Session not found");
		expect(b).toContain("不要重试刷屏");
	});

	test("收到父 ask 必须回 ACK（带状态与实际生效模型）", () => {
		const b = brief();
		expect(b).toContain("[T1] ACK");
	});
});

describe("worker brief: GO 闸门", () => {
	test("硬约束：收到 GO 前不得开始实现", () => {
		const b = brief();
		expect(b).toContain("GO");
		expect(b).toContain("不得开始实现");
	});

	test("GO 可能经 ask reply 或 send 到达", () => {
		expect(brief()).toContain("reply 或 send 到达");
	});

	test("GO 幂等：重复 GO 无副作用，不重启任务", () => {
		const b = brief();
		expect(b).toContain("重复 GO 无副作用");
		expect(b).toContain("不要重启任务");
	});
});

describe("worker brief: CANCEL 协议", () => {
	test("收到 CANCEL 停止实现与提交并回 CANCELLED", () => {
		const b = brief();
		expect(b).toContain("CANCEL");
		expect(b).toContain("CANCELLED");
		expect(b).toContain("立即停止实现与提交");
	});
});

describe("worker brief: ask 带 to（路由规则）", () => {
	test("ask 必须带 to=父 target，说明不带 to 的误投风险", () => {
		const b = brief();
		expect(b).toContain("to=planner");
		expect(b).toContain("cwd");
	});

	test("状态汇报用 send 给父 target，格式 [T1] <STATE>", () => {
		const b = brief();
		expect(b).toContain("[T1] <STATE>");
		expect(b).toContain("STARTED/BLOCKED/REVIEWING/COMPLETE/FAILED");
	});
});

describe("worker brief: 提交铁律", () => {
	test("收尾必须提交到分支且排除 .squad.json/node_modules", () => {
		const b = brief();
		expect(b).toContain("git commit");
		expect(b).toContain("排除 .squad.json 和 node_modules");
	});
});
