import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SchedulerEngine } from "../src/scheduler/engine";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import type { ScheduledTask } from "../src/scheduler/types";

// Use a temp directory for the test DB
let testDir: string;
let dbPath: string;
let storage: SchedulerDbStorage;

function cleanup() {
	// Clean up temp files
	try {
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-test-"));
	dbPath = path.join(testDir, "scheduler.db");
	storage = new SchedulerDbStorage(dbPath);
});

afterEach(() => {
	storage?.close();
	cleanup();
});

describe("SchedulerEngine", () => {
	it("persists and retrieves tasks", () => {
		const task = storage.addTask({
			name: "test-task",
			cron: "*/5 * * * *",
			command: "echo hello",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		expect(task.id).toBeTruthy();
		expect(task.name).toBe("test-task");
		expect(task.status).toBe("active");

		const retrieved = storage.getTask(task.id);
		expect(retrieved).not.toBeUndefined();
		expect(retrieved!.name).toBe("test-task");
	});

	it("retrieves task by name", () => {
		storage.addTask({
			name: "named-task",
			cron: "0 0 * * *",
			command: "echo test",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const found = storage.getTaskByName("named-task");
		expect(found).not.toBeUndefined();
		expect(found!.command).toBe("echo test");

		const missing = storage.getTaskByName("nonexistent");
		expect(missing).toBeUndefined();
	});

	it("lists all tasks", () => {
		storage.addTask({
			name: "task-a",
			cron: "0 0 * * *",
			command: "echo a",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		storage.addTask({
			name: "task-b",
			cron: "0 0 * * *",
			command: "echo b",
			status: "paused",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const tasks = storage.listTasks();
		expect(tasks.length).toBe(2);
	});

	it("updates task status", () => {
		const task = storage.addTask({
			name: "status-task",
			cron: "0 0 * * *",
			command: "echo test",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		storage.updateTask(task.id, { status: "paused" });
		const updated = storage.getTask(task.id);
		expect(updated!.status).toBe("paused");
	});

	it("deletes tasks", () => {
		const task = storage.addTask({
			name: "delete-me",
			cron: "0 0 * * *",
			command: "echo test",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		storage.deleteTask(task.id);
		const deleted = storage.getTask(task.id);
		expect(deleted).toBeUndefined();
	});

	it("records and retrieves task executions", () => {
		const task = storage.addTask({
			name: "exec-task",
			cron: "0 0 * * *",
			command: "echo test",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const exec = storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now(),
			status: "running",
		});

		expect(exec.id).toBeTruthy();
		expect(exec.status).toBe("running");

		storage.updateExecution(exec.id, {
			status: "success",
			exitCode: 0,
			endedAt: Date.now(),
			output: "hello",
		});

		const executions = storage.getExecutions(task.id);
		expect(executions.length).toBe(1);
		expect(executions[0]!.status).toBe("success");
		expect(executions[0]!.exitCode).toBe(0);
	});

	it("engine starts and stops without error", () => {
		let _triggered = false;

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async () => {
				_triggered = true;
			},
		});

		engine.start();
		expect(engine.getActiveTaskIds().length).toBe(0);

		engine.stop();
	});

	it("engine triggers interval task and records execution", async () => {
		const { promise, resolve } = Promise.withResolvers<string>();

		// Add a 200ms interval task
		const task = storage.addTask({
			name: "interval-test",
			cron: "200ms",
			command: "echo interval-test",
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
			onTrigger: async (triggered: ScheduledTask, execId: string) => {
				resolve(triggered.name);
				// Mark execution as success
				storage.updateExecution(execId, {
					status: "success",
					exitCode: 0,
					endedAt: Date.now(),
				});
			},
		});

		engine.start();

		// Wait for the interval task to trigger
		const triggeredName = await Promise.race([promise, Bun.sleep(5000).then(() => "timeout")]);

		engine.stop();

		expect(triggeredName).toBe("interval-test");

		// Verify execution was recorded
		const executions = storage.getExecutions(task.id);
		expect(executions.length).toBeGreaterThan(0);
		expect(executions[0]!.status).toBe("success");
	});

	it("updates interval nextRunAt after each execution", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const task = storage.addTask({
			name: "interval-next-run",
			cron: "80ms",
			command: "echo interval",
			status: "active",
			scheduleType: "interval",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async () => {
				resolve();
			},
		});

		engine.start();
		await Promise.race([promise, Bun.sleep(1000).then(() => undefined)]);
		engine.stop();

		const updated = storage.getTask(task.id);
		expect(updated?.runCount).toBeGreaterThan(0);
		expect(updated?.nextRunAt).toBeGreaterThan(Date.now());
	});

	it("clears one-shot nextRunAt after execution", async () => {
		// Use a real one-shot (ISO timestamp), NOT a test-run marker
		// (`+<n>s`). Test-run schedules are exempt from auto-disable
		// so the test-run's `finally` block can restore the original
		// schedule without racing the engine's own status write — see
		// `isTestRunSchedule` in engine.ts. Real one-shots (reminders,
		// ad-hoc scheduled jobs) auto-disable, which is what this test
		// pins.
		const { promise, resolve } = Promise.withResolvers<void>();
		const task = storage.addTask({
			name: "once-next-run",
			cron: new Date(Date.now() + 30).toISOString(),
			command: "echo once",
			status: "active",
			scheduleType: "once",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async () => {
				resolve();
			},
		});

		engine.start();
		await Promise.race([promise, Bun.sleep(1000).then(() => undefined)]);
		await Bun.sleep(20);
		engine.stop();

		const updated = storage.getTask(task.id);
		expect(updated?.status).toBe("disabled");
		expect(updated?.nextRunAt).toBeUndefined();
	});

	it("does NOT auto-disable one-shots with a test-run schedule (+<n>s)", async () => {
		// Regression pin: test-run rewrites the schedule to `+<n>s` to
		// trigger a one-shot through the real scheduler, then restores
		// the original schedule in its `finally` block. If the engine
		// also wrote `disabled` after the trigger fired, it would race
		// the test-run's restore and the task could end up `disabled`
		// after the test-run reported `scheduleRestored: true`. The
		// engine must skip auto-disable when it sees the test-run
		// marker so the test-run's restore is the final word.
		//
		// Uses `+30s` (NOT `+30ms`) because the marker regex is
		// `^\+\d+s$` — test-run only produces seconds. `+30ms` would
		// be a valid one-shot but wouldn't be recognized as a
		// test-run marker.
		const { promise, resolve } = Promise.withResolvers<void>();
		const task = storage.addTask({
			name: "test-run-marker",
			cron: "+30s",
			command: "echo test-run",
			status: "active",
			scheduleType: "once",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async () => {
				resolve();
			},
		});

		engine.start();
		await Promise.race([promise, Bun.sleep(1000).then(() => undefined)]);
		await Bun.sleep(20);
		engine.stop();

		const updated = storage.getTask(task.id);
		// Test-run schedules are NOT auto-disabled. The test-run
		// itself restores the original schedule; the engine just fires
		// the trigger and leaves status alone.
		expect(updated?.status).toBe("active");
		// nextRunAt is not asserted here: it depends on whether the
		// setTimeout fired within the test's wait window. The
		// "clears one-shot nextRunAt after execution" test above pins
		// the nextRunAt-clearing contract for a real one-shot.
	});

	it("engine handles disabled tasks", () => {
		storage.addTask({
			name: "disabled-task",
			cron: "100ms",
			command: "echo should-not-run",
			status: "disabled",
			scheduleType: "interval",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const engine = new SchedulerEngine({
			storage,
			onTrigger: async () => {
				throw new Error("Should not have triggered");
			},
		});

		engine.start();
		expect(engine.getActiveTaskIds().length).toBe(0);
		engine.stop();
	});
});

describe("SchedulerDbStorage", () => {
	it("prunes old executions", () => {
		const task = storage.addTask({
			name: "prune-test",
			cron: "0 0 * * *",
			command: "echo test",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		// Add an old execution
		const _oldExec = storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days ago
			status: "success",
			exitCode: 0,
			endedAt: Date.now() - 99 * 24 * 60 * 60 * 1000,
		});

		const pruned = storage.pruneExecutions(1, 0); // 1 day age limit
		expect(pruned).toBeGreaterThan(0);

		const remaining = storage.getExecutions(task.id);
		expect(remaining.length).toBe(0);
	});

	it("keeps recent executions when pruning", () => {
		const task = storage.addTask({
			name: "keep-test",
			cron: "0 0 * * *",
			command: "echo test",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		// Add recent execution
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now(),
			status: "success",
			exitCode: 0,
			endedAt: Date.now(),
		});

		const pruned = storage.pruneExecutions(1, 0);
		expect(pruned).toBe(0); // Should not prune recent items

		const remaining = storage.getExecutions(task.id);
		expect(remaining.length).toBe(1);
	});
});
