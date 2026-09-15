/**
 * T10C · 定时任务工作台的 gateway 写面与行形状（集成）。
 *
 * 用真实 `JsonFileStorage`（临时目录）+ 注入的绑定解析器（fixture 注册表），所以断言的是
 * 「网关落盘了什么、回报了什么」，而不是某个 HOME 下恰好存在的 registry.json。
 *
 * 覆盖 gate 要求的场景：
 *   无 Project      行只带 projectIds（声明才有），没声明就是 undefined —— 不编一个项目
 *   禁用 Agent      已注册但 home 不在 → 写面拒绝；旧行读取报 registered + agentEnabled:false + 原因
 *   恢复            未绑定的旧行改绑（cron_update）后 agentId 落盘；重启后（新 storage 实例）身份还在
 *   过期 Schedule   once 类型 + nextRunAt 在过去 → 原样上报，不由展示层编造 enabled
 *   重复执行        repeatCount/repeatCompleted/runCount 上报（执行语义归 engine）
 *   失败重试        retry/consecutiveFailures/lastDeliveryError 上报（投递失败 ≠ 任务失败）
 *   scope 隔离      每行只带自己的 agentId；无绑定的行不带任何 Agent 身份
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDirectoryEntry } from "@cornfield/coding-agent/agent-domain/agent-directory";
import { JsonFileStorage } from "./scheduler/json-file-storage";
import type { ScheduledTask, SchedulerStorage } from "./scheduler/types";
import { type GatewayWireDeps, handleGatewayWireCommand } from "./wire-endpoint";

const HR_DIR = "/Users/me/.cornfield/agents/hr";
const CODING_DIR = "/Users/me/.cornfield/agents/coding";
const GONE_DIR = "/Users/me/.cornfield/agents/gone";

const ENTRIES: AgentDirectoryEntry[] = [
	{
		agent: {
			agentId: "hr",
			agentDir: HR_DIR,
			displayName: "HR 助理",
			enabled: true,
			projectIds: ["proj-hr"],
		},
	},
	{ agent: { agentId: "coding", agentDir: CODING_DIR, displayName: "Coding", enabled: true } },
	{ agent: { agentId: "gone", agentDir: GONE_DIR, displayName: "Gone", enabled: false } },
];

let tmpDir: string;
let storage: SchedulerStorage;
let deps: GatewayWireDeps;

function makeDeps(s: SchedulerStorage): GatewayWireDeps {
	return {
		storage: s,
		gatewayStatus: () => ({ pid: 1, statusWrittenAt: Date.now(), stale: false, accounts: [], scheduler: null }),
		// 注入的是注册表内容（fixture），三态判定仍然走生产那份 resolveScheduleAgentBinding。
		loadAgentDirectory: async () => ENTRIES,
	};
}

/** 造一条旧数据（直接写 storage，绕过写面 —— 模拟迁移前落盘的 jobs.json 行）。 */
function seedLegacyTask(s: SchedulerStorage, task: Partial<ScheduledTask> & { name: string }): ScheduledTask {
	return s.addTask({
		cron: "* * * * *",
		command: "echo legacy",
		status: "active",
		consecutiveFailures: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		...task,
	});
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "t10c-cron-"));
	storage = new JsonFileStorage(path.join(tmpDir, "jobs.json"));
	deps = makeDeps(storage);
});

afterEach(async () => {
	storage.close();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("cron_create：落盘的是解析后的 Agent 身份", () => {
	test("按 agentId 创建 → agentId + agentDir + 显示名 + 项目绑定都落在行上", async () => {
		const res = await handleGatewayWireCommand(
			{
				type: "cron_create",
				name: "daily-hr",
				cron: "0 9 * * *",
				command: "汇总今天的假勤",
				taskType: "agent",
				agentId: "hr",
			},
			deps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const task = (res.result as { task: Record<string, unknown> }).task;
		expect(task.agentId).toBe("hr");
		expect(task.agentDir).toBe(HR_DIR);
		expect(task.agentDisplayName).toBe("HR 助理");
		expect(task.agentResolution).toBe("registered");
		expect(task.agentEnabled).toBe(true);
		expect(task.projectIds).toEqual(["proj-hr"]);

		// 落盘：重启（新实例读同一个 jobs.json）后身份还在 —— Schedule 不靠 UI 当前选中
		const reopened = new JsonFileStorage(path.join(tmpDir, "jobs.json"));
		const persisted = reopened.getTaskByName("daily-hr");
		expect(persisted?.agentId).toBe("hr");
		expect(persisted?.agentDir).toBe(HR_DIR);
		reopened.close();
	});

	test("只给 legacy agentDir（不是任何注册 Agent 的家）→ 允许创建，行上报 unregistered 且点名原因", async () => {
		const legacyDir = "/Users/me/OMP-workspace-test/omp-atomix";
		const res = await handleGatewayWireCommand(
			{ type: "cron_create", name: "legacy", cron: "0 9 * * *", command: "echo 1", agentDir: legacyDir },
			deps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const task = (res.result as { task: Record<string, unknown> }).task;
		expect(task.agentResolution).toBe("unregistered");
		expect(task.agentId).toBeUndefined();
		expect(task.agentDir).toBe(legacyDir);
		expect(String(task.agentError)).toContain("不是任何已注册 Agent 的家");
	});

	test("完全不给绑定 → 允许创建（行上报 unbound），这是合法状态而非错误", async () => {
		const res = await handleGatewayWireCommand(
			{ type: "cron_create", name: "unbound", cron: "0 9 * * *", command: "echo 1" },
			deps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const task = (res.result as { task: Record<string, unknown> }).task;
		expect(task.agentResolution).toBe("unbound");
		expect(task.agentId).toBeUndefined();
		expect(task.agentDir).toBeUndefined();
	});

	test("声明了未注册的 agentId → 拒绝（不静默改用别的 home，也不写半条）", async () => {
		const res = await handleGatewayWireCommand(
			{
				type: "cron_create",
				name: "ghost",
				cron: "0 9 * * *",
				command: "echo 1",
				agentId: "ghost",
				agentDir: "/tmp/x",
			},
			deps,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("ghost");
		expect(storage.getTaskByName("ghost")).toBeUndefined();
	});

	test("绑到 home 已不在的已注册 Agent → 拒绝（调度跑不起来，不能报成功）", async () => {
		const res = await handleGatewayWireCommand(
			{ type: "cron_create", name: "dead", cron: "0 9 * * *", command: "echo 1", agentId: "gone" },
			deps,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("agentDir 不存在");
		expect(storage.getTaskByName("dead")).toBeUndefined();
	});

	test("重名拒绝", async () => {
		await handleGatewayWireCommand(
			{ type: "cron_create", name: "dup", cron: "0 9 * * *", command: "echo 1", agentId: "hr" },
			deps,
		);
		const again = await handleGatewayWireCommand(
			{ type: "cron_create", name: "dup", cron: "0 9 * * *", command: "echo 2", agentId: "coding" },
			deps,
		);
		expect(again.ok).toBe(false);
	});
});

describe("cron_update：恢复旧行的绑定", () => {
	test("未绑定的旧行改绑到注册 Agent → agentId + agentDir 落盘，行翻成 registered", async () => {
		const legacy = seedLegacyTask(storage, { name: "old-unbound", agentDir: "/Users/me/legacy-dir" });
		expect(legacy.agentId).toBeUndefined();

		const res = await handleGatewayWireCommand({ type: "cron_update", taskId: legacy.id, agentId: "coding" }, deps);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const task = (res.result as { task: Record<string, unknown> }).task;
		expect(task.agentResolution).toBe("registered");
		expect(task.agentId).toBe("coding");
		expect(task.agentDir).toBe(CODING_DIR);

		const persisted = storage.getTask(legacy.id);
		expect(persisted?.agentId).toBe("coding");
		expect(persisted?.agentDir).toBe(CODING_DIR);
	});

	test("改绑到未注册的 id → 拒绝，且原绑定一个字都不动（不留半套）", async () => {
		const task = seedLegacyTask(storage, { name: "keep-binding", agentId: "hr", agentDir: HR_DIR });
		const res = await handleGatewayWireCommand({ type: "cron_update", taskId: task.id, agentId: "ghost" }, deps);
		expect(res.ok).toBe(false);
		expect(storage.getTask(task.id)?.agentId).toBe("hr");
		expect(storage.getTask(task.id)?.agentDir).toBe(HR_DIR);
	});

	test("改调度字段不影响绑定", async () => {
		const task = seedLegacyTask(storage, { name: "fields", agentId: "hr", agentDir: HR_DIR });
		const res = await handleGatewayWireCommand({ type: "cron_update", taskId: task.id, cron: "0 12 * * *" }, deps);
		expect(res.ok).toBe(true);
		const persisted = storage.getTask(task.id);
		expect(persisted?.cron).toBe("0 12 * * *");
		expect(persisted?.agentId).toBe("hr");
	});

	test("未知 taskId → ok:false", async () => {
		const res = await handleGatewayWireCommand({ type: "cron_update", taskId: "nope", cron: "0 1 * * *" }, deps);
		expect(res.ok).toBe(false);
	});
});

describe("get_cron_tasks：工作台要的事实都在行上", () => {
	test("生命周期/可靠性字段（过期、重复执行、失败重试、投递失败）原样上报", async () => {
		const past = Date.now() - 3_600_000;
		seedLegacyTask(storage, {
			name: "once-expired",
			scheduleType: "once",
			nextRunAt: past,
			status: "disabled",
			taskType: "agent",
			timeoutMs: 120_000,
			repeatCount: 5,
			repeatCompleted: 5,
			runCount: 5,
			failCount: 2,
			consecutiveFailures: 2,
			retry: { maxAttempts: 3, backoffMs: [1000, 5000] },
			lastDeliveryError: "Unknown channel: dingtalk",
			delivery: { channel: "dingtalk", mode: "announce", toUserId: "u1" },
			agentId: "hr",
			agentDir: HR_DIR,
		});

		const res = await handleGatewayWireCommand({ type: "get_cron_tasks" }, deps);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const rows = (res.result as { tasks: Array<Record<string, unknown>> }).tasks;
		const row = rows.find(r => r.name === "once-expired")!;
		expect(row.scheduleType).toBe("once");
		expect(row.nextRunAt).toBe(past);
		expect(row.status).toBe("disabled");
		expect(row.enabled).toBe(false);
		expect(row.repeatCount).toBe(5);
		expect(row.repeatCompleted).toBe(5);
		expect(row.consecutiveFailures).toBe(2);
		expect(row.retry).toEqual({ maxAttempts: 3, backoffMs: [1000, 5000] });
		expect(row.lastDeliveryError).toBe("Unknown channel: dingtalk");
		expect(row.delivery).toEqual({ channel: "dingtalk", mode: "announce", toUserId: "u1" });
		expect(row.timeoutMs).toBe(120_000);
	});

	test("无 Project：没声明项目绑定的行不携带 projectIds（不编一个「无项目」值）", async () => {
		const res = await handleGatewayWireCommand(
			{ type: "cron_create", name: "no-proj", cron: "0 9 * * *", command: "echo 1", agentId: "coding" },
			deps,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const task = (res.result as { task: Record<string, unknown> }).task;
		expect("projectIds" in task).toBe(false);
	});

	test("scope 隔离：每行只带自己的 agentId，未绑定的行不带任何身份", async () => {
		await handleGatewayWireCommand(
			{ type: "cron_create", name: "hr-task", cron: "0 9 * * *", command: "echo 1", agentId: "hr" },
			deps,
		);
		await handleGatewayWireCommand(
			{ type: "cron_create", name: "coding-task", cron: "0 10 * * *", command: "echo 2", agentId: "coding" },
			deps,
		);
		seedLegacyTask(storage, { name: "orphan-task" });

		const res = await handleGatewayWireCommand({ type: "get_cron_tasks" }, deps);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const rows = (res.result as { tasks: Array<Record<string, unknown>> }).tasks;
		const byName = new Map(rows.map(r => [r.name as string, r]));
		expect(byName.get("hr-task")?.agentId).toBe("hr");
		expect(byName.get("coding-task")?.agentId).toBe("coding");
		expect(byName.get("orphan-task")?.agentId).toBeUndefined();
		expect(byName.get("orphan-task")?.agentResolution).toBe("unbound");
	});

	test("禁用 Agent：已注册但 home 不在的旧行读取报 registered + agentEnabled:false + 原因", async () => {
		seedLegacyTask(storage, { name: "dead-agent", agentId: "gone", agentDir: GONE_DIR });
		const res = await handleGatewayWireCommand({ type: "get_cron_tasks" }, deps);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const row = (res.result as { tasks: Array<Record<string, unknown>> }).tasks.find(r => r.name === "dead-agent")!;
		expect(row.agentResolution).toBe("registered");
		expect(row.agentId).toBe("gone");
		expect(row.agentEnabled).toBe(false);
		expect(String(row.agentError)).toContain("agentDir 不存在");
	});
});

describe("cron_remove / cron_test_run", () => {
	test("删除未知任务失败，删除已知任务返回被删掉的名字", async () => {
		const task = seedLegacyTask(storage, { name: "bye", agentId: "hr", agentDir: HR_DIR });
		const missing = await handleGatewayWireCommand({ type: "cron_remove", taskId: "nope" }, deps);
		expect(missing.ok).toBe(false);
		const res = await handleGatewayWireCommand({ type: "cron_remove", taskId: task.id }, deps);
		expect(res.ok).toBe(true);
		if (res.ok) expect((res.result as { removed: string }).removed).toBe("bye");
		expect(storage.getTask(task.id)).toBeUndefined();
	});

	test("无绑定的任务不给 test-run 起跑（否则操作者只等到超时，看不到真实原因）", async () => {
		seedLegacyTask(storage, { name: "cannot-run" });
		const res = await handleGatewayWireCommand({ type: "cron_test_run", name: "cannot-run", inMs: 5_000 }, deps);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("绑定");
	});

	test("已注册且 home 在的任务可以 test-run", async () => {
		seedLegacyTask(storage, { name: "can-run", agentId: "hr", agentDir: HR_DIR });
		const res = await handleGatewayWireCommand({ type: "cron_test_run", name: "can-run", inMs: 5_000 }, deps);
		expect(res.ok).toBe(true);
		if (res.ok) expect((res.result as { kind: string }).kind).toBe("started");
	});
});

describe("get_cron_logs：Session scope 的链接", () => {
	test("执行记录把 agentSessionPath 透出（会话文件是执行归属的权威链接）", async () => {
		const task = seedLegacyTask(storage, {
			name: "with-session",
			taskType: "agent",
			agentId: "hr",
			agentDir: HR_DIR,
		});
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() - 1_000,
			endedAt: Date.now(),
			status: "success",
			exitCode: 0,
			output: "ok",
			stderr: "",
			agentSessionPath: "/Users/me/.cornfield/agents/hr/sessions/cron_1.jsonl",
		});

		const res = await handleGatewayWireCommand({ type: "get_cron_logs", taskId: "with-session", limit: 5 }, deps);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const logs = (res.result as { logs: Array<Record<string, unknown>> }).logs;
		expect(logs[0]?.agentSessionPath).toBe("/Users/me/.cornfield/agents/hr/sessions/cron_1.jsonl");
	});
});
