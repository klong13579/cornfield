/**
 * gateway wire endpoint — 传输无关 cron 命令核心集成测试（P2-4）。
 * 真实 SQLite storage（临时 DB）：CRUD 往返 + test-run 拒绝未知任务。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import { handleGatewayWireCommand, type GatewayWireDeps } from "../src/wire-endpoint";

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
				accounts: [{ accountId: "hr", agentDir: dir, running: true }],
				scheduler: { running: true, taskCount: storage.listTasks().length },
			}),
		};
	});

	afterEach(async () => {
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("get_cron_tasks returns empty initially, then the created task", async () => {
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
			const tasks = (listed.result as { tasks: Array<{ name: string; cron: string; status: string }> }).tasks;
			expect(tasks).toHaveLength(1);
			expect(tasks[0].name).toBe("daily-report");
			expect(tasks[0].cron).toBe("0 9 * * *");
			expect(tasks[0].status).toBe("active");
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

	test("cron_test_run rejects unknown task", async () => {
		const res = await handleGatewayWireCommand({ type: "cron_test_run", name: "nope" }, deps);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("unknown task");
	});

	test("gateway_status reports storage-backed scheduler state", async () => {
		const res = await handleGatewayWireCommand({ type: "gateway_status" }, deps);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const status = res.result as { pid: number; accounts: unknown[]; scheduler: { running: boolean } };
			expect(status.pid).toBe(4242);
			expect(status.accounts).toHaveLength(1);
			expect(status.scheduler.running).toBe(true);
		}
	});

	test("unknown command returns ok:false", async () => {
		const res = await handleGatewayWireCommand({ type: "bogus" }, deps);
		expect(res.ok).toBe(false);
	});
});
