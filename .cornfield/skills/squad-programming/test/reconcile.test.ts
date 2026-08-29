/**
 * squad-programming reconcile 调度测试
 *
 * 测试 squad-state.ts 的 reconcilePlan()（纯函数）与 CLI reconcile 动词：
 *   GO 发放 = started + deps 全 complete + 并发槽位空闲（running/reviewing/blocked 占槽）
 *
 * 覆盖：needAsk / needGo / waitingDeps / waitingConcurrency / unrunnable /
 *       maxConcurrency 槽位口径 / 父崩溃恢复（needGo 补发 GO）/ CLI JSON 输出
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	writeState,
	reconcilePlan,
	DEFAULT_MAX_CONCURRENCY,
	type SquadState,
	type SubtaskState,
} from "../scripts/squad-state.ts";

const SCRIPT = path.resolve(import.meta.dirname!, "..", "scripts", "squad-state.ts");

let tmpDir: string;
let stateFile: string;

function sub(overrides: Partial<SubtaskState> & { id: string }): SubtaskState {
	return {
		isolation: "worktree",
		branch: `feat/${overrides.id.toLowerCase()}`,
		status: "assembled",
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeState(subtasks: SubtaskState[], overrides: Partial<SquadState> = {}): SquadState {
	return {
		squadId: "test-squad-reconcile",
		squadVersion: 2,
		version: 0,
		taskType: "code",
		baseBranch: "main",
		parent: { target: "planner", sessionId: "sess-001", cwd: "/tmp" },
		createdAt: Date.now(),
		subtasks,
		...overrides,
	};
}

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-reconcile-test-"));
	stateFile = path.join(tmpDir, "state.json");
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── needAsk：assembled 待确认 ───────────────────────────────────────────────

describe("needAsk (assembled)", () => {
	test("全部 assembled → needAsk 全量，needGo 空", () => {
		const plan = reconcilePlan(makeState([sub({ id: "T1" }), sub({ id: "T2" })]));
		expect(plan.needAsk).toEqual(["T1", "T2"]);
		expect(plan.needGo).toEqual([]);
	});

	test("assembled 不占并发槽位", () => {
		const plan = reconcilePlan(makeState([sub({ id: "T1" }), sub({ id: "T2" })]));
		expect(plan.freeSlots).toBe(DEFAULT_MAX_CONCURRENCY);
	});
});

// ─── needGo：GO 发放 ─────────────────────────────────────────────────────────

describe("needGo (started, deps satisfied, slots free)", () => {
	test("started 无 deps → 全部进 needGo", () => {
		const plan = reconcilePlan(
			makeState([sub({ id: "T1", status: "started" }), sub({ id: "T2", status: "started" })]),
		);
		expect(plan.needGo).toEqual(["T1", "T2"]);
		expect(plan.waitingConcurrency).toEqual([]);
	});

	test("started 有 deps 且全部 complete → needGo", () => {
		const plan = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "complete" }),
				sub({ id: "T2", status: "started", deps: ["T1"] }),
			]),
		);
		expect(plan.needGo).toEqual(["T2"]);
	});

	test("terminal 子任务不参与发放", () => {
		const plan = reconcilePlan(
			makeState([sub({ id: "T1", status: "complete" }), sub({ id: "T2", status: "failed" })]),
		);
		expect(plan.terminal).toEqual(["T1", "T2"]);
		expect(plan.needGo).toEqual([]);
	});
});

// ─── waitingDeps：依赖未满足 ─────────────────────────────────────────────────

describe("waitingDeps", () => {
	test("dep 未 complete → waitingDeps 且 blockedBy 列出未完成依赖", () => {
		const plan = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "started" }),
				sub({ id: "T2", status: "started", deps: ["T1"] }),
			]),
		);
		expect(plan.waitingDeps).toEqual([{ id: "T2", blockedBy: ["T1"] }]);
	});

	test("dep 是 running 也算未完成（要 complete 才放行）", () => {
		const plan = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "running" }),
				sub({ id: "T2", status: "started", deps: ["T1"] }),
			]),
		);
		expect(plan.needGo).toEqual([]);
		expect(plan.waitingDeps).toEqual([{ id: "T2", blockedBy: ["T1"] }]);
	});

	test("多个 dep 部分完成 → blockedBy 只列未完成的", () => {
		const plan = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "complete" }),
				sub({ id: "T2", status: "started" }),
				sub({ id: "T3", status: "started", deps: ["T1", "T2"] }),
			]),
		);
		expect(plan.waitingDeps).toEqual([{ id: "T3", blockedBy: ["T2"] }]);
	});

	test("未知 dep id 视为未完成（state 层兜底；bundle 层已校验）", () => {
		const plan = reconcilePlan(makeState([sub({ id: "T1", status: "started", deps: ["TX"] })]));
		expect(plan.waitingDeps).toEqual([{ id: "T1", blockedBy: ["TX"] }]);
	});
});

// ─── unrunnable：依赖已 failed ───────────────────────────────────────────────

describe("unrunnable (failed deps)", () => {
	test("dep failed → unrunnable 而非 waitingDeps", () => {
		const plan = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "failed" }),
				sub({ id: "T2", status: "started", deps: ["T1"] }),
			]),
		);
		expect(plan.unrunnable).toEqual([{ id: "T2", failedDeps: ["T1"] }]);
		expect(plan.needGo).toEqual([]);
	});

	test("dep 混合 complete 与 failed → 仍 unrunnable", () => {
		const plan = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "complete" }),
				sub({ id: "T2", status: "failed" }),
				sub({ id: "T3", status: "started", deps: ["T1", "T2"] }),
			]),
		);
		expect(plan.unrunnable).toEqual([{ id: "T3", failedDeps: ["T2"] }]);
	});
});

// ─── 并发槽位（maxConcurrency） ──────────────────────────────────────────────

describe("concurrency slots", () => {
	test("默认 3：3 个 running 占满 → 第 4 个 started 进 waitingConcurrency", () => {
		const plan = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "running" }),
				sub({ id: "T2", status: "running" }),
				sub({ id: "T3", status: "running" }),
				sub({ id: "T4", status: "started" }),
			]),
		);
		expect(plan.freeSlots).toBe(0);
		expect(plan.needGo).toEqual([]);
		expect(plan.waitingConcurrency).toEqual(["T4"]);
	});

	test("reviewing 占槽", () => {
		const plan = reconcilePlan(
			makeState([sub({ id: "T1", status: "reviewing" }), sub({ id: "T2", status: "started" })], {
				maxConcurrency: 1,
			}),
		);
		expect(plan.needGo).toEqual([]);
		expect(plan.waitingConcurrency).toEqual(["T2"]);
	});

	test("blocked 占槽", () => {
		const plan = reconcilePlan(
			makeState([sub({ id: "T1", status: "blocked" }), sub({ id: "T2", status: "started" })], {
				maxConcurrency: 1,
			}),
		);
		expect(plan.needGo).toEqual([]);
		expect(plan.waitingConcurrency).toEqual(["T2"]);
	});

	test("state.maxConcurrency 生效（=1 串行）", () => {
		const plan = reconcilePlan(
			makeState([sub({ id: "T1", status: "running" }), sub({ id: "T2", status: "started" })], {
				maxConcurrency: 1,
			}),
		);
		expect(plan.needGo).toEqual([]);
	});

	test("显式参数覆盖 state.maxConcurrency", () => {
		const plan = reconcilePlan(
			makeState([sub({ id: "T1", status: "running" }), sub({ id: "T2", status: "started" })], {
				maxConcurrency: 1,
			}),
			2,
		);
		expect(plan.needGo).toEqual(["T2"]);
	});

	test("槽位释放后 waitingConcurrency 晋级 needGo（按数组序）", () => {
		const before = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "running" }),
				sub({ id: "T2", status: "started" }),
				sub({ id: "T3", status: "started" }),
			], { maxConcurrency: 1 }),
		);
		expect(before.needGo).toEqual([]);
		expect(before.waitingConcurrency).toEqual(["T2", "T3"]);

		const after = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "complete" }),
				sub({ id: "T2", status: "started" }),
				sub({ id: "T3", status: "started" }),
			], { maxConcurrency: 1 }),
		);
		expect(after.needGo).toEqual(["T2"]);
		expect(after.waitingConcurrency).toEqual(["T3"]);
	});

	test("inFlight/blocked 全景列表", () => {
		const plan = reconcilePlan(
			makeState([
				sub({ id: "T1", status: "running" }),
				sub({ id: "T2", status: "reviewing" }),
				sub({ id: "T3", status: "blocked" }),
			]),
		);
		expect(plan.inFlight).toEqual(["T1", "T2"]);
		expect(plan.blocked).toEqual(["T3"]);
	});
});

// ─── 父崩溃恢复（reconcile 即恢复入口） ──────────────────────────────────────

describe("parent crash recovery via reconcile", () => {
	test("父在发 GO 后、落账 running 前崩溃 → state 仍 started → needGo 补发（幂等）", () => {
		// worker 实际已收到 GO 在干活，但 state.json 还是 started——
		// reconcile 报 needGo，父补发 GO（重复 GO 无副作用），然后落 running。
		const state = makeState([
			sub({ id: "T1", status: "started" }),
			sub({ id: "T2", status: "assembled" }),
		]);
		const plan = reconcilePlan(state);
		expect(plan.needGo).toEqual(["T1"]);
		expect(plan.needAsk).toEqual(["T2"]);
	});

	test("父崩溃前已确认 STARTED 并落账 → needGo 全量重建", () => {
		const plan = reconcilePlan(
			makeState([sub({ id: "T1", status: "started" }), sub({ id: "T2", status: "started" })]),
		);
		expect(plan.needGo).toEqual(["T1", "T2"]);
	});

	test("恢复时 running 子任务不重发 GO（inFlight）", () => {
		const plan = reconcilePlan(makeState([sub({ id: "T1", status: "running" })]));
		expect(plan.needGo).toEqual([]);
		expect(plan.inFlight).toEqual(["T1"]);
	});

	test("state.json 落盘后重读 → 计划一致（底账可恢复）", () => {
		const state = makeState([
			sub({ id: "T1", status: "complete" }),
			sub({ id: "T2", status: "started", deps: ["T1"] }),
		]);
		writeState(stateFile, state);
		const reloaded = JSON.parse(fs.readFileSync(stateFile, "utf8")) as SquadState;
		const plan = reconcilePlan(reloaded);
		expect(plan.needGo).toEqual(["T2"]);
	});
});

// ─── CLI reconcile 动词 ──────────────────────────────────────────────────────

describe("CLI reconcile verb", () => {
	async function runReconcile(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["bun", "run", SCRIPT, stateFile, "reconcile", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { code: code ?? 1, stdout, stderr };
	}

	test("stdout 输出 JSON 计划，stderr 输出人读指引", async () => {
		writeState(
			stateFile,
			makeState([sub({ id: "T1", status: "started" }), sub({ id: "T2", status: "assembled" })]),
		);
		const { code, stdout, stderr } = await runReconcile([]);
		expect(code).toBe(0);
		const plan = JSON.parse(stdout) as { needAsk: string[]; needGo: string[] };
		expect(plan.needGo).toEqual(["T1"]);
		expect(plan.needAsk).toEqual(["T2"]);
		expect(stderr).toMatch(/needGo/);
		expect(stderr).toMatch(/needAsk/);
	});

	test("--max-concurrency 覆盖生效", async () => {
		writeState(
			stateFile,
			makeState([sub({ id: "T1", status: "started" }), sub({ id: "T2", status: "started" })]),
		);
		const { code, stdout } = await runReconcile(["--max-concurrency=1"]);
		expect(code).toBe(0);
		const plan = JSON.parse(stdout) as { needGo: string[]; waitingConcurrency: string[] };
		expect(plan.needGo).toEqual(["T1"]);
		expect(plan.waitingConcurrency).toEqual(["T2"]);
	});

	test("未知参数拒绝", async () => {
		writeState(stateFile, makeState([sub({ id: "T1" })]));
		const { code } = await runReconcile(["--bogus"]);
		expect(code).not.toBe(0);
	});
});
