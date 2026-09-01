/**
 * gateway wire endpoint — 传输无关 cron/gateway 命令核心集成测试（P2-4）。
 * 真实 SQLite storage（临时 DB）：CRUD 往返 + 只读形状保持（TaskRowDto /
 * CronLogEntryDto / GatewayStatusDto）+ test-run 拒绝未知任务。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import { type GatewayWireDeps, handleGatewayWireCommand } from "../src/wire-endpoint";

describe("gateway wire endpoint", () => {
	let dir: string;
	let storage: SchedulerDbStorage;
	let deps: GatewayWireDeps;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-wire-"));
		storage = new SchedulerDbStorage(path.join(dir, "scheduler.db"));
		deps = {
			storage,
			gatewayStatus: () => ({
				pid: 4242,
				statusWrittenAt: Date.now(),
				stale: false,
				accounts: [
					{
						accountId: "hr",
						bridgeRunning: true,
						bridgeState: "idle",
						channelConnected: true,
						agentDir: dir,
					},
				],
				scheduler: { running: true, taskCount: storage.listTasks().length },
			}),
		};
	});

	afterEach(async () => {
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("get_cron_tasks returns empty initially, then the created task with TaskRowDto shape", async () => {
		const empty = await handleGatewayWireCommand({ type: "get_cron_tasks" }, deps);
		expect(empty.ok).toBe(true);
		if (empty.ok) expect(empty.result).toEqual({ tasks: [] });

		const created = await handleGatewayWireCommand(
			{ type: "cron_create", name: "daily-report", cron: "0 9 * * *", command: "hello" },
			deps,
		);
		expect(created.ok).toBe(true);

		const listed = await handleGatewayWireCommand({ type: "get_cron_tasks" }, deps);
		expect(listed.ok).toBe(true);
		if (listed.ok) {
			const tasks = (listed.result as { tasks: Array<Record<string, unknown>> }).tasks;
			expect(tasks).toHaveLength(1);
			const t = tasks[0]!;
			expect(t.name).toBe("daily-report");
			expect(t.cron).toBe("0 9 * * *");
			expect(t.status).toBe("active");
			expect(t.scheduleType).toBe("cron");
			// web-app TaskRowDto 形状：enabled 来自 status != disabled
			expect(t.enabled).toBe(true);
			expect(typeof t.id).toBe("string");
		}
	});

	test("cron_create rejects duplicates and missing fields", async () => {
		const ok = await handleGatewayWireCommand(
			{ type: "cron_create", name: "x", cron: "* * * * *", command: "echo hi" },
			deps,
		);
		expect(ok.ok).toBe(true);

		const dup = await handleGatewayWireCommand(
			{ type: "cron_create", name: "x", cron: "* * * * *", command: "echo again" },
			deps,
		);
		expect(dup.ok).toBe(false);

		const missing = await handleGatewayWireCommand({ type: "cron_create", name: "y" }, deps);
		expect(missing.ok).toBe(false);
	});

	test("cron_update mutates fields and cron_remove deletes", async () => {
		const created = await handleGatewayWireCommand(
			{ type: "cron_create", name: "t", cron: "* * * * *", command: "echo 1" },
			deps,
		);
		expect(created.ok).toBe(true);
		const taskId = created.ok ? (created.result as { task: { id: string } }).task.id : "";

		const updated = await handleGatewayWireCommand(
			{ type: "cron_update", id: taskId, cron: "0 12 * * *", status: "paused" },
			deps,
		);
		expect(updated.ok).toBe(true);
		if (updated.ok) {
			const task = (updated.result as { task: { cron: string; status: string } }).task;
			expect(task.cron).toBe("0 12 * * *");
			expect(task.status).toBe("paused");
		}

		const removed = await handleGatewayWireCommand({ type: "cron_remove", id: taskId }, deps);
		expect(removed.ok).toBe(true);

		const missing = await handleGatewayWireCommand({ type: "cron_remove", id: taskId }, deps);
		expect(missing.ok).toBe(false);
	});

	test("get_cron_logs maps executions to CronLogEntryDto shape with truncation", async () => {
		const created = await handleGatewayWireCommand(
			{ type: "cron_create", name: "t", cron: "* * * * *", command: "echo 1" },
			deps,
		);
		expect(created.ok).toBe(true);
		const taskId = created.ok ? (created.result as { task: { id: string } }).task.id : "";
		expect(taskId).not.toBe("");

		const big = "x".repeat(4096);
		storage.recordExecution({
			taskId,
			startedAt: Date.now() - 5_000,
			endedAt: Date.now() - 1_000,
			status: "success",
			exitCode: 0,
			output: big,
			stderr: "boom",
		});

		// 按任务名（web-app 传 name）过滤；未知任务 → 空列表
		const res = await handleGatewayWireCommand({ type: "get_cron_logs", taskId: "t", limit: 10 }, deps);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const logs = (res.result as { logs: Array<Record<string, unknown>> }).logs;
			expect(logs).toHaveLength(1);
			const log = logs[0]!;
			expect(log.taskId).toBe(taskId);
			expect(typeof log.id).toBe("string");
			expect(typeof log.ts).toBe("number");
			expect(log.status).toBe("success");
			expect(log.exitCode).toBe(0);
			expect(log.durationMs).toBe(4_000);
			expect((log.output as string).length).toBe(2048);
			expect(log.outputTruncated).toBe(true);
			expect(log.stderr).toBe("boom");
		}

		const unknown = await handleGatewayWireCommand(
			{ type: "get_cron_logs", taskId: "__no_such_task__", limit: 10 },
			deps,
		);
		expect(unknown.ok).toBe(true);
		if (unknown.ok) expect((unknown.result as { logs: unknown[] }).logs).toEqual([]);
	});

	test("cron_test_run rejects unknown task", async () => {
		const res = await handleGatewayWireCommand({ type: "cron_test_run", name: "nope" }, deps);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("unknown task");
	});

	test("gateway_status reports storage-backed scheduler state", async () => {
		const res = await handleGatewayWireCommand({ type: "gateway_status" }, deps);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const status = res.result as { pid: number; stale: boolean; accounts: unknown[]; scheduler: unknown };
			expect(status.pid).toBe(4242);
			expect(status.stale).toBe(false);
			expect(status.accounts).toHaveLength(1);
			expect(status.scheduler).toEqual({ running: true, taskCount: 0 });
		}
	});

	test("unknown command returns ok:false", async () => {
		const res = await handleGatewayWireCommand({ type: "bogus" }, deps);
		expect(res.ok).toBe(false);
	});

	test("set_gateway_account requires accountId and patch object", async () => {
		const noId = await handleGatewayWireCommand({ type: "set_gateway_account", patch: {} }, deps);
		expect(noId.ok).toBe(false);
		if (!noId.ok) expect(noId.error).toContain("accountId");

		const noPatch = await handleGatewayWireCommand({ type: "set_gateway_account", accountId: "hr" }, deps);
		expect(noPatch.ok).toBe(false);
		if (!noPatch.ok) expect(noPatch.error).toContain("patch");

		// empty whitelist patch → rejected at the wire layer
		const empty = await handleGatewayWireCommand({ type: "set_gateway_account", accountId: "hr", patch: {} }, deps);
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error).toContain("whitelisted");
	});

	test("set_gateway_account forwards whitelisted fields and drops credentials", async () => {
		let received: { accountId: string; patch: Record<string, unknown> } | null = null;
		deps.applyGatewayAccountPatch = async (accountId, patch) => {
			received = { accountId, patch: patch as Record<string, unknown> };
			return { ok: true, result: { accountId, account: {} } };
		};

		const res = await handleGatewayWireCommand(
			{
				type: "set_gateway_account",
				accountId: "hr",
				patch: {
					enabled: false,
					robotName: "M-Code",
					deniedTools: ["ast_edit"],
					hideThinkingBlock: true,
					// 凭证注入必须被白名单过滤掉
					appSecret: "pwned",
					appKey: "pwned",
				},
			},
			deps,
		);

		expect(res.ok).toBe(true);
		expect(received).not.toBeNull();
		expect(received?.accountId).toBe("hr");
		expect(received?.patch).toEqual({
			enabled: false,
			robotName: "M-Code",
			deniedTools: ["ast_edit"],
			hideThinkingBlock: true,
		});
		expect(received?.patch).not.toHaveProperty("appSecret");
		expect(received?.patch).not.toHaveProperty("appKey");
	});

	test("set_gateway_account errors when patch deps not wired", async () => {
		const res = await handleGatewayWireCommand(
			{ type: "set_gateway_account", accountId: "hr", patch: { enabled: false } },
			deps,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("not available");
	});

	test("reload_gateway calls the reload deps and errors when unwired", async () => {
		let reloaded = false;
		deps.reloadGateway = async () => {
			reloaded = true;
			return { ok: true, result: { reloaded: true } };
		};
		const res = await handleGatewayWireCommand({ type: "reload_gateway" }, deps);
		expect(res.ok).toBe(true);
		expect(reloaded).toBe(true);

		delete deps.reloadGateway;
		const unwired = await handleGatewayWireCommand({ type: "reload_gateway" }, deps);
		expect(unwired.ok).toBe(false);
		if (!unwired.ok) expect(unwired.error).toContain("not available");
	});
});
