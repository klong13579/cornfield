/**
 * T10C · 执行面：调度必须按**自己存下来的绑定**跑，跑不了就不跑。
 *
 * 这三条是同一个问题的一体三面（`docs/client/agent-hub.md` §1.6「绑定目标失效时…不静默」、
 * §1.7「无绑定 agentDir 不执行」）：
 *
 *   1. 没有可用绑定的 agent 任务**不执行**，且要记成失败并留下原因 —— 旧行为是带着空 cwd 退回冷启动
 *      子进程，在 gateway 自己的目录身份下干活，然后报成功；
 *   2. 只有 `agentId` 的任务也能找到家（身份在家在注册表，不在行里）;
 *   3. 已注册但 home 不在的 Agent 不执行；而 `accountId`（废弃字段）仍然当 home 用的 legacy 行
 *      保持可执行 —— 我们不做自动迁移，只在**行被改写时**把废弃字段清掉（见 wire-endpoint 测试）。
 *
 * HOME 隔离：'appendExecutionLog' / 调度器目录都从 HOME 推导，测试把 HOME 指到临时目录再恢复
 * （仓库约定的隔离手法），否则会往真实 `~/.cornfield/gateway-data/` 写运行日志。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type CronLogger, CronService } from "./cron-service";
import { JsonFileStorage } from "./json-file-storage";
import type { ScheduledTask, SchedulerStorage } from "./types";

let tmpHome: string;
let savedHome: string | undefined;
let storage: SchedulerStorage;
let jobSeq = 0;

const silentLog: CronLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
	savedHome = process.env.HOME;
	tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "t10c-run-"));
	process.env.HOME = tmpHome;
});

afterAll(async () => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	storage?.close();
	await fs.rm(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
	jobSeq += 1;
	storage?.close();
	storage = new JsonFileStorage(path.join(tmpHome, `jobs-${jobSeq}.json`));
	// 每个用例一份干净的注册表（默认空 = 所有 agentId 都未注册）。
	await fs.rm(path.join(tmpHome, ".cornfield"), { recursive: true, force: true });
});

/** 写一份 registry.json（v2 形状，见 skeleton/registry.ts）。 */
async function writeRegistry(agents: Record<string, string>): Promise<void> {
	const dir = path.join(tmpHome, ".cornfield", "agent");
	await fs.mkdir(dir, { recursive: true });
	const entries = Object.fromEntries(
		Object.entries(agents).map(([name, agentDir]) => [
			name,
			{ path: agentDir, registeredAt: new Date().toISOString(), template: "default", displayName: name },
		]),
	);
	await Bun.write(path.join(dir, "registry.json"), JSON.stringify({ version: 2, agents: entries }, null, 2));
}

interface RunOutcome {
	/** executeAgent（暖桥）拿到的 agentDir 列表。 */
	executedDirs: string[];
	status: string | undefined;
	exitCode: number | undefined;
	output: string;
	stderr: string;
	/** onTrigger 抛出的错误（失败的运行会抛，让 engine 记账）。 */
	thrown?: string;
}

async function runTask(task: ScheduledTask): Promise<RunOutcome> {
	const executedDirs: string[] = [];
	const service = new CronService({
		storage,
		ompBinary: "cornfield",
		log: silentLog,
		executeAgent: async params => {
			executedDirs.push(params.agentDir);
			return { output: "ok" };
		},
		deliver: async () => ({ ok: true }),
	});
	const exec = storage.recordExecution({
		taskId: task.id,
		startedAt: Date.now(),
		status: "running",
	});
	let thrown: string | undefined;
	try {
		await service.onTrigger(task, exec.id);
	} catch (err) {
		// 失败的运行会抛（engine 据此记账）—— 执行记录在此之前已经写好。
		thrown = err instanceof Error ? err.message : String(err);
	}
	const recorded = storage.getExecutions(task.id, 5)[0];
	const outcome: RunOutcome = {
		executedDirs,
		status: recorded?.status,
		exitCode: recorded?.exitCode,
		output: recorded?.output ?? "",
		stderr: recorded?.stderr ?? "",
	};
	if (thrown !== undefined) outcome.thrown = thrown;
	return outcome;
}

function agentTask(over: Partial<ScheduledTask> & { name: string }): ScheduledTask {
	return storage.addTask({
		cron: "* * * * *",
		command: "干点活",
		taskType: "agent",
		status: "active",
		consecutiveFailures: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		...over,
	});
}

describe("绑定不可用时 agent 任务不执行", () => {
	test("既无 agentId 也无 agentDir → 拒绝执行，记 failure 并留下原因", async () => {
		const task = agentTask({ name: "unbound" });
		const outcome = await runTask(task);
		expect(outcome.executedDirs).toEqual([]);
		expect(outcome.status).toBe("failure");
		expect(outcome.exitCode).toBe(1);
		expect(outcome.output).toContain("[BINDING]");
		expect(outcome.output).toContain("没有绑定 Agent");
	});

	test("已注册但 agentDir 不存在的 Agent → 拒绝执行", async () => {
		await writeRegistry({ gone: path.join(tmpHome, "agents", "gone") });
		const task = agentTask({ name: "dead-agent", agentId: "gone" });
		const outcome = await runTask(storage.getTask(task.id)!);
		expect(outcome.executedDirs).toEqual([]);
		expect(outcome.status).toBe("failure");
		expect(outcome.output).toContain("agentDir 不存在");
	});

	test("拒绝不改调用方的绑定（只是这次不跑）", async () => {
		const task = agentTask({ name: "unbound-keeps-row" });
		const outcome = await runTask(task);
		expect(storage.getTask(task.id)?.agentId).toBeUndefined();
		expect(outcome.thrown).toContain("failed");
	});
});

describe("有绑定就按绑定的身份跑", () => {
	test("只有 agentId → 家取自注册表", async () => {
		const home = path.join(tmpHome, "agents", "hr");
		await fs.mkdir(home, { recursive: true });
		await writeRegistry({ hr: home });
		const task = agentTask({ name: "by-id", agentId: "hr" });
		const outcome = await runTask(storage.getTask(task.id)!);
		expect(outcome.executedDirs).toEqual([home]);
		expect(outcome.status).toBe("success");
	});

	test("legacy：只有 accountId（当 home 用）仍可执行（不做自动迁移）", async () => {
		const legacyHome = path.join(tmpHome, "legacy-account");
		await fs.mkdir(legacyHome, { recursive: true });
		const task = agentTask({ name: "legacy-account", accountId: legacyHome });
		const outcome = await runTask(task);
		expect(outcome.executedDirs).toEqual([legacyHome]);
		expect(outcome.status).toBe("success");
	});

	test("shell 任务不受绑定规则约束（它没有身份可弄错）", async () => {
		const task = storage.addTask({
			name: "shell-no-binding",
			cron: "* * * * *",
			command: "echo ok",
			taskType: "shell",
			status: "active",
			consecutiveFailures: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
		});
		const outcome = await runTask(task);
		expect(outcome.status).toBe("success");
		expect(outcome.output.trim()).toBe("ok");
	});
});
