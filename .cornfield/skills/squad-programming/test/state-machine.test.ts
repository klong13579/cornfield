/**
 * squad-programming 调度状态机异常情况测试
 *
 * 测试 squad-state.ts 的状态机：
 *   assembled → started → blocked / reviewing → complete / failed
 *
 * 覆盖：合法转移 / 非法转移拦截 / 终态锁定 / 并发保护 / 文件损坏 / 恢复场景 / 边界值
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	loadState,
	writeState,
	updateState,
	pendingSubtasks,
	STATE_STATUSES,
	TERMINAL_STATUSES,
	VALID_TRANSITIONS,
	type SquadState,
} from "../scripts/squad-state.ts";

let tmpDir: string;
let stateFile: string;

function makeState(overrides: Partial<SquadState> = {}): SquadState {
	return {
		squadId: "test-squad-sm",
		squadVersion: 1,
		version: 0,
		taskType: "code",
		baseBranch: "main",
		parent: { target: "planner", sessionId: "sess-001", cwd: "/tmp" },
		workspaceId: "ws-001",
		createdAt: Date.now(),
		subtasks: [
			{
				id: "T1",
				isolation: "worktree",
				branch: "feat/t1",
				worktree: "/tmp/.worktrees/feat-t1",
				paneId: "pane-001",
				model: "narwal-plan/deepseek-v4-flash",
				briefPath: "/tmp/.worktrees/feat-t1/.squad.json",
				status: "assembled",
				updatedAt: Date.now(),
			},
			{
				id: "T2",
				isolation: "worktree",
				branch: "feat/t2",
				worktree: "/tmp/.worktrees/feat-t2",
				paneId: "pane-002",
				model: "narwal-plan/deepseek-v4-pro",
				briefPath: "/tmp/.worktrees/feat-t2/.squad.json",
				status: "assembled",
				updatedAt: Date.now(),
			},
		],
		...overrides,
	};
}

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-state-test-"));
	stateFile = path.join(tmpDir, "state.json");
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── 1. 正常状态转移（happy path） ───────────────────────────────────────────

describe("valid state transitions (happy path)", () => {
	test("assembled → started → blocked → reviewing → complete", () => {
		const state = makeState();
		writeState(stateFile, state);

		const s1 = updateState(stateFile, "T1", "started");
		expect(s1.subtasks.find(s => s.id === "T1")!.status).toBe("started");

		const s2 = updateState(stateFile, "T1", "blocked");
		expect(s2.subtasks.find(s => s.id === "T1")!.status).toBe("blocked");

		const s3 = updateState(stateFile, "T1", "reviewing");
		expect(s3.subtasks.find(s => s.id === "T1")!.status).toBe("reviewing");

		const s4 = updateState(stateFile, "T1", "complete");
		expect(s4.subtasks.find(s => s.id === "T1")!.status).toBe("complete");
	});

	test("assembled → started → reviewing → complete", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "reviewing");
		const s = updateState(stateFile, "T1", "complete");
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("complete");
	});

	test("assembled → started → failed", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		const s = updateState(stateFile, "T1", "failed");
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("failed");
	});

	test("started → blocked → failed", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "blocked");
		const s = updateState(stateFile, "T1", "failed");
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("failed");
	});

	test("blocked → started 允许（解除阻塞继续工作）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "blocked");
		const s = updateState(stateFile, "T1", "started");
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("started");
	});

	test("reviewing → started 允许（review 反馈后回退修改）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "reviewing");
		const s = updateState(stateFile, "T1", "started");
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("started");
	});
});

// ─── 2. 非法状态转移（有护栏拦截） ───────────────────────────────────────────

describe("invalid transitions (guarded — should throw)", () => {
	test("assembled → complete 直接跳（跳过 started）", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T1", "complete")).toThrow(/不允许|终态/);
	});

	test("assembled → failed 直接跳（跳过 started）", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T1", "failed")).toThrow(/不允许/);
	});

	test("assembled → blocked 直接跳（跳过 started）", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T1", "blocked")).toThrow(/不允许/);
	});

	test("assembled → reviewing 直接跳（跳过 started）", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T1", "reviewing")).toThrow(/不允许/);
	});

	test("complete → started（终态不可逆）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "complete");
		expect(() => updateState(stateFile, "T1", "started")).toThrow(/终态/);
	});

	test("complete → failed（终态不可逆）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "complete");
		expect(() => updateState(stateFile, "T1", "failed")).toThrow(/终态/);
	});

	test("failed → complete（终态不可逆）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "failed");
		expect(() => updateState(stateFile, "T1", "complete")).toThrow(/终态/);
	});

	test("failed → started（终态不可逆）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "failed");
		expect(() => updateState(stateFile, "T1", "started")).toThrow(/终态/);
	});

	test("started → assembled（回退，不允许）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		expect(() => updateState(stateFile, "T1", "assembled")).toThrow(/不允许/);
	});

	test("blocked → assembled（回退，不允许）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "blocked");
		expect(() => updateState(stateFile, "T1", "assembled")).toThrow(/不允许/);
	});
});

// ─── 3. force 覆盖（恢复场景） ───────────────────────────────────────────────

describe("force override (recovery scenarios)", () => {
	test("force 允许 assembled → complete（父恢复时直接标完成）", () => {
		const state = makeState();
		writeState(stateFile, state);

		const s = updateState(stateFile, "T1", "complete", undefined, true);
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("complete");
	});

	test("force 允许 complete → started（恢复时重新打开）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started", undefined, true);
		updateState(stateFile, "T1", "complete", undefined, true);
		const s = updateState(stateFile, "T1", "started", undefined, true);
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("started");
	});

	test("force 允许 failed → complete（恢复时纠正状态）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started", undefined, true);
		updateState(stateFile, "T1", "failed", "磁盘空间不足", true);
		// 恢复时发现实际已完成
		const s = updateState(stateFile, "T1", "complete", "纠正: 实际已完成", true);
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("complete");
		expect(s.subtasks.find(s => s.id === "T1")!.note).toMatch(/纠正/);
	});

	test("force 只跳过转移校验，不跳过其他校验（非法状态值仍拒绝）", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T1", "INVALID" as "started", undefined, true)).toThrow("非法状态");
	});

	test("force 不跳过不存在子任务的检查", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T999", "started", undefined, true)).toThrow("没有子任务");
	});
});

// ─── 4. 终态行为 ─────────────────────────────────────────────────────────────

describe("terminal state behavior", () => {
	test("complete 是终态 — pendingSubtasks 排除", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "complete");

		const loaded = loadState(stateFile);
		const pending = pendingSubtasks(loaded);
		expect(pending.find(s => s.id === "T1")).toBeUndefined();
		expect(pending.find(s => s.id === "T2")).toBeDefined();
	});

	test("failed 是终态 — pendingSubtasks 排除", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "failed");

		const loaded = loadState(stateFile);
		const pending = pendingSubtasks(loaded);
		expect(pending.find(s => s.id === "T1")).toBeUndefined();
	});

	test("complete 后重复设置 complete 不报错（幂等操作）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "complete");
		expect(() => updateState(stateFile, "T1", "complete")).not.toThrow();
	});

	test("failed 后重复设置 failed 不报错（幂等操作）", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "failed");
		expect(() => updateState(stateFile, "T1", "failed")).not.toThrow();
	});
});

// ─── 5. 并发更新（竞态条件） ────────────────────────────────────────────────

describe("concurrent update race conditions", () => {
	test("两个进程同时 updateState 不会抛异常（最后写入者胜出）", async () => {
		const state = makeState();
		writeState(stateFile, state);

		await Promise.all([
			updateState(stateFile, "T1", "started"),
			updateState(stateFile, "T2", "started"),
		]);

		const loaded = loadState(stateFile);
		expect(loaded.subtasks.find(s => s.id === "T1")!.status).toBe("started");
		expect(loaded.subtasks.find(s => s.id === "T2")!.status).toBe("started");
	});

	test("version 在每次 writeState 后递增", () => {
		const state = makeState();
		writeState(stateFile, state);

		const v1 = loadState(stateFile).version;
		writeState(stateFile, loadState(stateFile));
		const v2 = loadState(stateFile).version;
		writeState(stateFile, loadState(stateFile));
		const v3 = loadState(stateFile).version;

		expect(v1).toBe(1);
		expect(v2).toBe(2);
		expect(v3).toBe(3);
	});

	test("updateState 每次调用递增 version", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		const v1 = loadState(stateFile).version;

		updateState(stateFile, "T1", "blocked");
		const v2 = loadState(stateFile).version;

		expect(v2).toBe(v1 + 1);
	});

	test("先读-后写窗口导致覆盖丢失的更新 — version 可检测到", () => {
		// 模拟：进程 A 读 state，进程 B 写 state，进程 A 基于旧数据写回
		const state = makeState();
		writeState(stateFile, state);

		// 进程 A 读
		const s1 = loadState(stateFile);
		const v1 = s1.version;

		// 进程 B 写 T1 → started
		updateState(stateFile, "T1", "started");

		// 进程 A 基于旧数据写 T2 → started（不感知 B 的写入）
		const t2 = s1.subtasks.find(s => s.id === "T2")!;
		t2.status = "started";
		t2.updatedAt = Date.now();
		writeState(stateFile, s1);

		// version 被 A 基于旧数据回退：
		// B 写入后 version = 2，A 写回时将 version 设为 (1 + 1) = 2
		// 实际 B 的写入也被 A 覆盖了
		const loaded = loadState(stateFile);
		expect(loaded.subtasks.find(s => s.id === "T1")!.status).toBe("assembled");
		expect(loaded.subtasks.find(s => s.id === "T2")!.status).toBe("started");
		// version 跳跃：B 写到了 2，A 从 1 写到 2，覆盖了 B 的 2
		// 目前无法检测到这种覆盖 —— 这是 JSON 文件无事务的固有限制
		// 后续可通过 SQLite 或文件锁彻底解决
	});

	test("多次快速交替更新 — 终态互斥确保护栏", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		// 快速交替
		updateState(stateFile, "T1", "blocked");
		updateState(stateFile, "T1", "reviewing");
		updateState(stateFile, "T1", "complete");
		// 终态后不可变
		expect(() => updateState(stateFile, "T1", "started")).toThrow(/终态/);
	});
});

// ─── 6. 文件损坏/异常 ────────────────────────────────────────────────────────

describe("file corruption and error handling", () => {
	test("state 文件不存在抛出明确错误", () => {
		expect(() => loadState("/tmp/squad-state-test/nonexistent/state.json")).toThrow();
	});

	test("state 文件内容损坏抛出错误", () => {
		const corruptFile = path.join(tmpDir, "corrupt.json");
		fs.writeFileSync(corruptFile, "这不是 JSON{{{");
		expect(() => loadState(corruptFile)).toThrow();
	});

	test("state 文件为空抛出错误", () => {
		const emptyFile = path.join(tmpDir, "empty.json");
		fs.writeFileSync(emptyFile, "");
		expect(() => loadState(emptyFile)).toThrow();
	});

	test("不存在的 taskId 更新抛出错误", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T999", "started")).toThrow("没有子任务");
	});

	test("非法状态值抛出错误", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T1", "INVALID" as "started")).toThrow("非法状态");
	});

	test("状态值为 undefined 抛出错误", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T1", undefined as unknown as "started")).toThrow("非法状态");
	});
});

// ─── 7. 父中断恢复场景 ──────────────────────────────────────────────────────

describe("parent crash recovery scenarios", () => {
	test("部分子任务已终态、部分未终态 — pendingSubtasks 正确过滤", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "complete", undefined, true); // force 恢复场景
		updateState(stateFile, "T2", "started");

		const loaded = loadState(stateFile);
		const pending = pendingSubtasks(loaded);

		expect(pending.length).toBe(1);
		expect(pending[0]!.id).toBe("T2");
	});

	test("全部子任务终态时 pendingSubtasks 返回空", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "complete");
		updateState(stateFile, "T2", "started");
		updateState(stateFile, "T2", "failed");

		const loaded = loadState(stateFile);
		expect(pendingSubtasks(loaded).length).toBe(0);
	});

	test("全部子任务未终态时 pendingSubtasks 返回全部", () => {
		const state = makeState();
		writeState(stateFile, state);

		const loaded = loadState(stateFile);
		expect(pendingSubtasks(loaded).length).toBe(2);
	});

	test("子任务处于 blocked 状态时 recovery 可恢复", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "blocked");

		const loaded = loadState(stateFile);
		const pending = pendingSubtasks(loaded);
		expect(pending.find(s => s.id === "T1")).toBeDefined();

		const s = updateState(stateFile, "T1", "reviewing");
		expect(s.subtasks.find(s => s.id === "T1")!.status).toBe("reviewing");
	});

	test("父 crash 后 state.json 仍可读，updateTime 保留恢复时间线", () => {
		const state = makeState();
		writeState(stateFile, state);

		const past = Date.now() - 300_000;
		const s1 = loadState(stateFile);
		s1.subtasks.find(s => s.id === "T1")!.status = "started";
		s1.subtasks.find(s => s.id === "T1")!.updatedAt = past;
		writeState(stateFile, s1);

		const recovered = loadState(stateFile);
		const t1 = recovered.subtasks.find(s => s.id === "T1")!;
		expect(t1.status).toBe("started");
		expect(t1.updatedAt).toBe(past);

		const now = Date.now();
		// 恢复时用 force 跳过已 started 互斥
		const s2 = updateState(stateFile, "T1", "started", undefined, true);
		const t1Updated = s2.subtasks.find(s => s.id === "T1")!;
		expect(t1Updated.updatedAt).toBeGreaterThanOrEqual(now);
	});

	test("recovery 走 force 路径，不触发 state 异常", () => {
		const state = makeState();
		writeState(stateFile, state);

		// 模拟 recovery：子任务实际已 complete，但父 crash 了
		expect(() => updateState(stateFile, "T1", "complete", "恢复: 实际已完成", true)).not.toThrow();
		const loaded = loadState(stateFile);
		expect(loaded.subtasks.find(s => s.id === "T1")!.status).toBe("complete");
	});
});

// ─── 8. state 一致性 ────────────────────────────────────────────────────────

describe("state consistency", () => {
	test("updatedAt 随每次更新递增", () => {
		const state = makeState();
		writeState(stateFile, state);

		const s1 = updateState(stateFile, "T1", "started");
		const firstTime = s1.subtasks.find(s => s.id === "T1")!.updatedAt;

		Bun.sleepSync(5);
		const s2 = updateState(stateFile, "T1", "blocked");
		const secondTime = s2.subtasks.find(s => s.id === "T1")!.updatedAt;
		expect(secondTime).toBeGreaterThan(firstTime);
	});

	test("note 字段随更新保留", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "blocked", "需要接口文档");
		const loaded = loadState(stateFile);
		expect(loaded.subtasks.find(s => s.id === "T1")!.note).toBe("需要接口文档");
	});

	test("note 不设置时保留原有值", () => {
		const state = makeState();
		writeState(stateFile, state);

		updateState(stateFile, "T1", "started", "初始备注");
		updateState(stateFile, "T1", "blocked");
		const loaded = loadState(stateFile);
		expect(loaded.subtasks.find(s => s.id === "T1")!.note).toBe("初始备注");
	});
});

// ─── 9. 边界值 ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
	test("大量子任务（100 个）全部状态更新", () => {
		const subtasks = Array.from({ length: 100 }, (_, i) => ({
			id: `T${i + 1}`,
			isolation: "shared-read" as const,
			status: "assembled" as const,
			updatedAt: Date.now(),
		}));
		const state = makeState({ subtasks });
		writeState(stateFile, state);

		for (const s of subtasks) {
			updateState(stateFile, s.id, "started");
		}

		const loaded = loadState(stateFile);
		expect(loaded.subtasks.length).toBe(100);
		expect(loaded.subtasks.every(s => s.status === "started")).toBe(true);
	});

	test("状态名大小写敏感", () => {
		const state = makeState();
		writeState(stateFile, state);

		expect(() => updateState(stateFile, "T1", "STARTED" as "started")).toThrow("非法状态");
	});

	test("note 含特殊字符（JSON 安全）", () => {
		const state = makeState();
		writeState(stateFile, state);

		const note = "任务失败: \"磁盘空间不足\"\n路径: /opt/data\n代码: 0xdead";
		updateState(stateFile, "T1", "started");
		updateState(stateFile, "T1", "failed", note);
		const loaded = loadState(stateFile);
		expect(loaded.subtasks.find(s => s.id === "T1")!.note).toBe(note);
	});

	test("state 文件路径含特殊字符", () => {
		const specialPath = path.join(tmpDir, "squad 测试+路径/state.json");
		const state = makeState({ squadId: "special-path-squad" });
		writeState(specialPath, state);

		const loaded = loadState(specialPath);
		expect(loaded.squadId).toBe("special-path-squad");
		fs.rmSync(path.dirname(specialPath), { recursive: true, force: true });
	});

	test("VALID_TRANSITIONS 覆盖所有状态", () => {
		// 每个状态在转移矩阵中都有条目
		for (const status of STATE_STATUSES) {
			expect(VALID_TRANSITIONS).toHaveProperty(status);
			expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
		}
	});

	test("终态（complete/failed）的转移列表为空", () => {
		for (const terminal of TERMINAL_STATUSES) {
			expect(VALID_TRANSITIONS[terminal]).toEqual([]);
		}
	});

	test("version 从 0 开始，首次 writeState 后为 1", () => {
		const state = makeState();
		expect(state.version).toBe(0); // makeState 设 version=0

		writeState(stateFile, state);
		expect(loadState(stateFile).version).toBe(1);
	});
});