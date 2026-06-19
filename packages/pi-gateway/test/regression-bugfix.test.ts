import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SchedulerEngine } from "../src/scheduler/engine";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import { SchedulerFileStore } from "../src/scheduler/file-store";
import type { ScheduledTask } from "../src/scheduler/types";

let testDir: string;
let dbPath: string;
let storage: SchedulerDbStorage;

function cleanup() {
	try {
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-regression-"));
	dbPath = path.join(testDir, "scheduler.db");
	storage = new SchedulerDbStorage(dbPath);
});

afterEach(() => {
	storage?.close();
	cleanup();
});

describe("C1: failing tasks record correct status and statistics", () => {
	it("records failure status and increments failCount when command fails", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const task = storage.addTask({
			name: "c1-fail",
			cron: "100ms",
			command: "exit 7",
			status: "active",
			scheduleType: "interval",
			taskType: "shell",
			timeoutMs: 5000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async (t, execId) => {
				// Simulate what a real onTrigger does: execute command,
				// record result, and throw on failure.
				const { exitCode, output, stderr, timedOut } = await (
					await import("../src/scheduler/executor")
				).executeScheduledCommand(t.command, { taskType: t.taskType, timeoutMs: t.timeoutMs });
				const endedAt = Date.now();
				storage.updateExecution(execId, {
					status: exitCode === 0 ? "success" : "failure",
					exitCode,
					output,
					stderr,
					endedAt,
				});
				if (exitCode !== 0 || timedOut) {
					throw new Error(`Task failed (exit ${exitCode})`);
				}
				resolve();
			},
		});

		engine.start();
		// Let the 100ms interval fire at least once then wait a bit for the retry to settle
		await Bun.sleep(400);
		engine.stop();

		const updated = storage.getTask(task.id)!;
		const execs = storage.getExecutions(task.id);

		// At least one execution should be recorded
		expect(execs.length).toBeGreaterThan(0);

		// The last execution should show failure (exit 7), NOT success
		const lastExec = execs[0]!;
		expect(lastExec.exitCode).toBe(7);
		expect(lastExec.status).toBe("failure");

		// failCount should be > 0
		expect(updated.failCount).toBeGreaterThan(0);
		expect(updated.runCount).toBeGreaterThan(0);
	});

	it("records success status when command succeeds", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const task = storage.addTask({
			name: "c1-pass",
			cron: "100ms",
			command: "echo ok",
			status: "active",
			scheduleType: "interval",
			taskType: "shell",
			timeoutMs: 5000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async (t, execId) => {
				const { exitCode } = await (await import("../src/scheduler/executor")).executeScheduledCommand(t.command, {
					taskType: t.taskType,
					timeoutMs: t.timeoutMs,
				});
				storage.updateExecution(execId, {
					status: exitCode === 0 ? "success" : "failure",
					exitCode,
					endedAt: Date.now(),
				});
				if (exitCode !== 0) throw new Error("failed");
				resolve();
			},
		});

		engine.start();
		await Bun.sleep(400);
		engine.stop();

		const execs = storage.getExecutions(task.id);
		const last = execs.at(-1);
		expect(last?.exitCode).toBe(0);
	});
});

describe("C2: file-store correctly parses scheduleType; engine handles bad cron", () => {
	it("stores correct scheduleType for interval tasks from file definitions", () => {
		const taskDir = path.join(testDir, "tasks");
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(
			path.join(taskDir, "ping.json5"),
			JSON.stringify({ name: "ping", cron: "5m", command: "echo hi" }),
		);

		const fileStore = new SchedulerFileStore(taskDir, storage);
		fileStore.syncToDb();

		const t = storage.getTaskByName("ping")!;
		expect(t.scheduleType).toBe("interval");
	});

	it("stores correct scheduleType for one-shot tasks from file definitions", () => {
		const taskDir = path.join(testDir, "tasks");
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(
			path.join(taskDir, "once.json5"),
			JSON.stringify({ name: "once", cron: "+30s", command: "echo hi" }),
		);

		const fileStore = new SchedulerFileStore(taskDir, storage);
		fileStore.syncToDb();

		const t = storage.getTaskByName("once")!;
		expect(t.scheduleType).toBe("once");
	});

	it("stores cron scheduleType for standard cron expressions", () => {
		const taskDir = path.join(testDir, "tasks");
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(
			path.join(taskDir, "daily.json5"),
			JSON.stringify({ name: "daily", cron: "0 9 * * *", command: "echo hi" }),
		);

		const fileStore = new SchedulerFileStore(taskDir, storage);
		fileStore.syncToDb();

		const t = storage.getTaskByName("daily")!;
		expect(t.scheduleType).toBe("cron");
	});

	it("engine start does not crash on a task with invalid cron expression", async () => {
		storage.addTask({
			name: "bad-cron",
			cron: "not-a-cron",
			command: "echo hi",
			status: "active",
			scheduleType: "cron",
			taskType: "shell",
			timeoutMs: 5000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async () => {},
		});

		// Must not throw
		engine.start();
		engine.stop();

		// Bad task should be disabled
		const t = storage.getTaskByName("bad-cron")!;
		expect(t.status).toBe("disabled");
	});

	it("engine start does not crash with a mix of valid and invalid tasks", async () => {
		storage.addTask({
			name: "good",
			cron: "0 9 * * *",
			command: "echo hi",
			status: "active",
			scheduleType: "cron",
			taskType: "shell",
			timeoutMs: 5000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		storage.addTask({
			name: "bad",
			cron: "5m", // interval expression stored as cron
			command: "echo hi",
			status: "active",
			scheduleType: "cron",
			taskType: "shell",
			timeoutMs: 5000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async () => {},
		});

		engine.start();
		engine.stop();

		// Bad task should be disabled, good task should remain active
		expect(storage.getTaskByName("good")!.status).toBe("active");
		expect(storage.getTaskByName("bad")!.status).toBe("disabled");
	});
});
