/**
 * Tests for `cron test-run` — the operator-friendly wrapper that
 * temporarily rewrites a task's schedule, waits for the real scheduler
 * to fire it, and reports the run + delivery verdict.
 *
 * The test avoids actually waiting 70+ seconds by pre-seeding an
 * execution row that matches the function's polling filter. The
 * function then "finds" it on its first poll and proceeds to the
 * delivery verdict + schedule restore. This proves the polling logic
 * + the schedule-snapshot/restore + the delivery-verdict-reading all
 * work end-to-end against a real `SchedulerDbStorage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cronTestRun } from "../src/scheduler/cli-commands";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import type { ScheduledTask } from "../src/scheduler/types";

let testDir: string;
let dbPath: string;
let storage: SchedulerDbStorage;
let homedirSpy: ReturnType<typeof vi.spyOn>;
let consoleLogBuf: string;
let consoleErrorBuf: string;
let origLog: typeof console.log;
let origErr: typeof console.error;

function seedTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return storage.addTask({
		name: "test-task",
		cron: "0 12 * * *",
		command: "echo hello",
		scheduleType: "cron",
		status: "active",
		taskType: "agent",
		timeoutMs: 30_000,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		...overrides,
	});
}

function makeGatewayRunning(): void {
	// cronTestRun checks `isDaemonRunning(getGatewayPidPath())` which
	// reads `<homedir>/.omp/gateway-data/gateway.pid`. We point homedir
	// at testDir via the spy and put our own process pid there so the
	// "process exists" check succeeds.
	const dataDir = path.join(testDir, ".omp", "gateway-data");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, "gateway.pid"), String(process.pid));
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-test-run-"));
	dbPath = path.join(testDir, "scheduler.db");
	storage = new SchedulerDbStorage(dbPath);

	homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(testDir);

	// cronTestRun mutates the global `process.exitCode` to surface
	// failure to the shell. Each test must start with it cleared so a
	// prior test's failure does not leak into this one.
	process.exitCode = 0;

	// Capture console output for assertion.
	consoleLogBuf = "";
	consoleErrorBuf = "";
	origLog = console.log;
	origErr = console.error;
	console.log = (...args: unknown[]) => {
		consoleLogBuf += args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
	};
	console.error = (...args: unknown[]) => {
		consoleErrorBuf += args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
	};
});

afterEach(() => {
	homedirSpy.mockRestore();
	console.log = origLog;
	console.error = origErr;
	try {
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
	storage.close();
});

describe("cronTestRun", () => {
	it("restores the original schedule after the trigger fires", { timeout: 30_000 }, async () => {
		makeGatewayRunning();
		const task = seedTask({ name: "restored", cron: "0 18 * * *" });

		// Pre-seed the execution that the polling loop will pick up.
		// startedAt must be >= function's `startedAt - 5_000` (where
		// the function's startedAt is roughly Date.now() at call time).
		// endedAt must be set so the function's "wait for terminal"
		// filter accepts it.
		const exec = storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 2000,
			exitCode: 0,
			output: "triggered ok",
			status: "success",
		});

		await cronTestRun(["restored", "--in", "5s", "--timeout", "30s"], storage);

		const after = storage.getTaskByName("restored");
		expect(after?.cron).toBe("0 18 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(after?.status).toBe("active");

		// Output reporting
		expect(consoleLogBuf).toContain("restored");
		expect(consoleLogBuf).toContain("Triggered");
		expect(consoleLogBuf).toContain(`exec id:   ${exec.id}`);
		expect(consoleLogBuf).toContain("status:    success");
		expect(consoleLogBuf).toContain("exit:      0");
		expect(consoleLogBuf).toContain("Schedule restored");
		expect(process.exitCode).not.toBe(1);
	});

	it("reports delivery failure (sets exit code 1) when last_delivery_error is set", { timeout: 30_000 }, async () => {
		makeGatewayRunning();
		const task = seedTask({
			name: "failed-delivery",
			cron: "0 0 * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "announce" },
		});
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 1000,
			exitCode: 0,
			output: "ran fine",
			status: "success",
		});
		// Simulate the cron service having recorded a delivery error after the run.
		storage.updateTask(task.id, { lastDeliveryError: "Unknown channel: dingtalk" });

		await cronTestRun(["failed-delivery", "--in", "5s", "--timeout", "30s"], storage);

		expect(consoleLogBuf).toContain("deliver:   FAILED");
		expect(consoleLogBuf).toContain("Unknown channel: dingtalk");
		expect(process.exitCode).toBe(1);

		// Schedule still restored
		const after = storage.getTaskByName("failed-delivery");
		expect(after?.cron).toBe("0 0 * * *");
	});

	it("reports delivery ok when there is a delivery config but no error", { timeout: 30_000 }, async () => {
		makeGatewayRunning();
		const task = seedTask({
			name: "ok-delivery",
			cron: "*/5 * * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "announce" },
		});
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 500,
			exitCode: 0,
			output: "delivered",
			status: "success",
		});
		// lastDeliveryError is null/cleared → success

		await cronTestRun(["ok-delivery", "--in", "5s", "--timeout", "30s"], storage);

		expect(consoleLogBuf).toContain("deliver:   ok");
		expect(process.exitCode).not.toBe(1);
	});

	it("reports deliver=n/a when the task has no delivery config", { timeout: 30_000 }, async () => {
		makeGatewayRunning();
		const task = seedTask({ name: "no-delivery", cron: "0 9 * * *" });
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ran",
			status: "success",
		});

		await cronTestRun(["no-delivery", "--in", "5s", "--timeout", "30s"], storage);

		expect(consoleLogBuf).toContain("deliver:   n/a");
	});

	// Regression: `hadDelivery` used to be `Boolean(task.delivery ?? task.deliver)`,
	// which treated a v2 delivery with `mode: "none"` as "delivery attempted"
	// and reported `delivery.ok: true` despite no push ever happening. The
	// daily-2000-calendar-push incident (no DingTalk message, but the test-run
	// reported success) is the canonical case. Now: mode=none surfaces as
	// `delivery.mode === "none"`, configured: true, and the CLI says "silent".
	it("reports deliver=silent when delivery is configured but mode=none", { timeout: 30_000 }, async () => {
		makeGatewayRunning();
		const task = seedTask({
			name: "silent-delivery",
			cron: "0 9 * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "none" },
		});
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ran fine",
			status: "success",
		});
		// lastDeliveryError stays null — silent mode never attempts a push,
		// so no error is recorded either. The old code reported `ok: true`
		// here and that was the false positive.

		await cronTestRun(["silent-delivery", "--in", "5s", "--timeout", "30s"], storage);

		expect(consoleLogBuf).toContain("deliver:   silent (mode=none");
		expect(consoleLogBuf).not.toContain("deliver:   ok");
		expect(process.exitCode).not.toBe(1);

		// Schedule still restored
		const after = storage.getTaskByName("silent-delivery");
		expect(after?.cron).toBe("0 9 * * *");
	});

	// Companion: with mode=none, even an explicit `lastDeliveryError` is NOT
	// a "delivery_failed" kind — silent mode never tried, so it can't have
	// failed. (Stale error from a prior real run that was later switched to
	// mode=none should not poison the new test-run verdict.)
	it("mode=none never reports delivery_failed even if lastDeliveryError is set", { timeout: 30_000 }, async () => {
		makeGatewayRunning();
		const task = seedTask({
			name: "silent-with-stale-error",
			cron: "0 9 * * *",
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u1", mode: "none" },
		});
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ran",
			status: "success",
		});
		storage.updateTask(task.id, { lastDeliveryError: "stale error from prior run" });

		await cronTestRun(["silent-with-stale-error", "--in", "5s", "--timeout", "30s"], storage);

		expect(consoleLogBuf).toContain("deliver:   silent (mode=none");
		expect(consoleLogBuf).not.toContain("deliver:   FAILED");
		expect(process.exitCode).not.toBe(1);
	});

	it("restores schedule on timeout (no execution appeared)", { timeout: 30_000 }, async () => {
		makeGatewayRunning();
		seedTask({ name: "times-out", cron: "30 8 * * *" });

		// Use a tiny timeout so the test stays fast. Note: we don't
		// pre-seed an execution, so the polling loop will time out.
		await cronTestRun(["times-out", "--in", "1s", "--timeout", "1s"], storage);

		const after = storage.getTaskByName("times-out");
		expect(after?.cron).toBe("30 8 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(consoleErrorBuf).toContain("Timed out");
		expect(process.exitCode).toBe(1);
	});

	it("refuses and does NOT change the task if name is missing", { timeout: 5_000 }, async () => {
		makeGatewayRunning();
		seedTask({ name: "untouched", cron: "0 7 * * *" });
		const before = storage.getTaskByName("untouched");

		await cronTestRun([], storage);

		const after = storage.getTaskByName("untouched");
		expect(after).toEqual(before);
		expect(consoleErrorBuf).toContain("Usage:");
		expect(process.exitCode).toBe(1);
	});

	it("refuses when the task does not exist (no state change possible)", { timeout: 5_000 }, async () => {
		makeGatewayRunning();
		await cronTestRun(["nope-not-a-task", "--in", "1s", "--timeout", "1s"], storage);
		expect(consoleErrorBuf).toContain("not found");
		expect(process.exitCode).toBe(1);
	});

	it("refuses when the gateway is not running", { timeout: 5_000 }, async () => {
		// Deliberately do NOT call makeGatewayRunning() — no pid file.
		const task = seedTask({ name: "needs-gw", cron: "0 6 * * *" });
		const before = storage.getTaskByName("needs-gw");

		await cronTestRun(["needs-gw", "--in", "1s", "--timeout", "1s"], storage);

		const after = storage.getTaskByName("needs-gw");
		expect(after).toEqual(before);
		expect(consoleErrorBuf).toContain("Gateway is not running");
		expect(process.exitCode).toBe(1);
	});

	it("--no-restore leaves the schedule rewritten to one-shot", { timeout: 30_000 }, async () => {
		makeGatewayRunning();
		const task = seedTask({ name: "leave-it", cron: "0 10 * * *" });
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() + 50,
			endedAt: Date.now() + 100,
			exitCode: 0,
			output: "ok",
			status: "success",
		});

		await cronTestRun(["leave-it", "--in", "5s", "--timeout", "30s", "--no-restore"], storage);

		const after = storage.getTaskByName("leave-it");
		expect(after?.cron).toMatch(/^\+\d+s$/);
		expect(after?.scheduleType).toBe("once");
		expect(consoleLogBuf).toContain("Schedule NOT restored");
	});
});
