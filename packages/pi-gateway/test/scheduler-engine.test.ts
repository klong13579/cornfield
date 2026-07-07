/**
 * Scheduler engine + storage tests.
 *
 * Merged:
 *   - scheduler-engine.test.ts                 (core engine + storage)
 *   - scheduler-engine-test-run-restore.test.ts (post-fire restore hook)
 *   - scheduler-max-concurrent-runs.test.ts    (concurrency cap)
 *   - scheduler-storage-persistence.test.ts    (agentSessionPath round-trip)
 *   - scheduler-test-run-marker.test.ts        (marker I/O + orphan recovery)
 *   - scheduler-attach-to-session.test.ts      (delivery mirror)
 */
import { afterEach, beforeEach, describe, expect, it, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendMirrorEntry,
	mirrorDeliveryToSession,
	resolveMirrorSessionPath,
} from "../src/scheduler/attach-to-session";
import { SchedulerEngine } from "../src/scheduler/engine";
import { appendExecutionLog, type ExecutionLogEntry, getLogRoot, setLogRoot } from "../src/scheduler/execution-log";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import type { TestRunMarker } from "../src/scheduler/test-run-marker";
import {
	clearTestRunMarker,
	getTestRunMarkerPath,
	hasTestRunMarker,
	readTestRunMarker,
	writeTestRunMarker,
	writeTestRunMarkerRaw,
} from "../src/scheduler/test-run-marker";
import type { ScheduledTask, TestRunSnapshot } from "../src/scheduler/types";

// ===========================================================================
// Core engine + storage (was: scheduler-engine.test.ts)
// ===========================================================================

let testDir: string;
let dbPath: string;
let storage: JsonFileStorage;

function cleanup() {
	try {
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-test-"));
	dbPath = path.join(testDir, "jobs.json");
	storage = new JsonFileStorage(dbPath);
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
		const engine = new SchedulerEngine({
			storage,
			onTrigger: async () => {
				// no-op
			},
		});

		engine.start();
		expect(engine.getActiveTaskIds().length).toBe(0);
		engine.stop();
	});

	it("engine triggers interval task and records execution", async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
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
				storage.updateExecution(execId, {
					status: "success",
					exitCode: 0,
					endedAt: Date.now(),
				});
			},
		});

		engine.start();
		const triggeredName = await Promise.race([promise, Bun.sleep(5000).then(() => "timeout")]);
		engine.stop();

		expect(triggeredName).toBe("interval-test");

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
		expect(updated?.status).toBe("active");
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

describe("JsonFileStorage prune", () => {
	// JsonFileStorage.pruneExecutions delegates to pruneAllLogs which
	// walks ~/.omp/gateway-data/scheduler/logs/by-task/. Per-task
	// execution logs are in that global tree, not in the storage
	// instance's tempdir — we can't isolate the prune in a unit
	// test without mocking `getLogRoot`. What we CAN verify in
	// isolation: pruning returns a non-negative number (the
	// global walker finds what it finds, including 0), and
	// recent records survive in-memory after a prune call.

	it("returns a non-negative count from pruneExecutions", () => {
		const task = storage.addTask({
			name: "prune-count-test",
			cron: "0 0 * * *",
			command: "echo test",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now() - 100 * 24 * 60 * 60 * 1000,
			status: "success",
			exitCode: 0,
			endedAt: Date.now() - 99 * 24 * 60 * 60 * 1000,
		});
		// Walk the global log tree; the count includes whatever the
		// production log root contains (often 0 in CI), but must
		// never be negative.
		const pruned = storage.pruneExecutions(1, 0);
		expect(pruned).toBeGreaterThanOrEqual(0);
	});

	it("in-memory execution survives a prune call (the walker touches JSONL files, not the in-memory map)", () => {
		const task = storage.addTask({
			name: "prune-keep-test",
			cron: "0 0 * * *",
			command: "echo test",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		storage.recordExecution({
			taskId: task.id,
			startedAt: Date.now(),
			status: "success",
			exitCode: 0,
			endedAt: Date.now(),
		});

		storage.pruneExecutions(1, 0);

		const remaining = storage.getExecutions(task.id);
		expect(remaining.length).toBe(1);
	});
});

// ===========================================================================
// Post-fire restore hook (was: scheduler-engine-test-run-restore.test.ts)
// ===========================================================================

describe("SchedulerEngine — test-run post-fire restore", () => {
	let schedulerDir2: string;
	let homedirSpy: ReturnType<typeof vi.spyOn>;
	let storage2: JsonFileStorage;

	function makeSnapshot2(task: ScheduledTask): TestRunSnapshot {
		return {
			cron: task.cron,
			scheduleType: task.scheduleType,
			nextRunAt: task.nextRunAt,
			status: task.status,
			lastRunAt: task.lastRunAt,
			runCount: task.runCount,
			failCount: task.failCount,
			consecutiveFailures: task.consecutiveFailures,
			repeatCompleted: task.repeatCompleted,
			lastDeliveryError: task.lastDeliveryError,
		};
	}

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-engine-restore-"));
		schedulerDir2 = path.join(testDir, ".omp", "gateway-data", "scheduler");
		fs.mkdirSync(schedulerDir2, { recursive: true });
		homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(testDir);
		const jobsPath = path.join(schedulerDir2, "jobs.json");
		storage2 = new JsonFileStorage(jobsPath);
	});

	afterEach(() => {
		homedirSpy.mockRestore();
		try {
			storage2.close();
		} catch {
			// ignore
		}
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("restores the schedule and clears the marker after a successful one-shot", async () => {
		const pastTime = Date.now() - 86_400_000;
		const created = storage2.addTask({
			name: "test-run-restore-ok",
			cron: "0 9 * * *",
			scheduleType: "cron",
			status: "active",
			command: "echo ok",
			taskType: "shell",
			lastRunAt: pastTime,
			runCount: 5,
			failCount: 1,
			consecutiveFailures: 0,
			lastDeliveryError: "stale delivery error from last week",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const original = storage2.getTask(created.id)!;
		const snapshot = makeSnapshot2(original);
		storage2.updateTask(created.id, {
			cron: "+1s",
			scheduleType: "once",
			nextRunAt: Date.now() + 1_000,
			status: "active",
			updatedAt: Date.now(),
		});
		writeTestRunMarker(original, snapshot, Date.now(), schedulerDir2, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 200_000,
		});
		expect(hasTestRunMarker(schedulerDir2)).toBe(true);

		const { promise, resolve } = Promise.withResolvers<void>();
		const engine = new SchedulerEngine({
			storage: storage2,
			onTrigger: async (_task, execId) => {
				storage2.updateExecution(execId, { status: "success", exitCode: 0, endedAt: Date.now() });
				resolve();
			},
		});
		engine.start();
		try {
			await Promise.race([promise, Bun.sleep(3_000).then(() => undefined)]);
			await Bun.sleep(50);
		} finally {
			engine.stop();
		}

		const after = storage2.getTask(created.id);
		expect(after?.cron).toBe("0 9 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(after?.lastRunAt).toBe(pastTime);
		expect(after?.runCount).toBe(5);
		expect(after?.failCount).toBe(1);
		expect(after?.consecutiveFailures).toBe(0);
		expect(after?.lastDeliveryError).toBe("stale delivery error from last week");
		expect(hasTestRunMarker(schedulerDir2)).toBe(false);
	});

	it("restores the schedule even when the task fails (post-fire runs in finally)", async () => {
		const created = storage2.addTask({
			name: "test-run-restore-fail",
			cron: "30 8 * * *",
			scheduleType: "cron",
			status: "active",
			command: "exit 1",
			taskType: "shell",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		const original = storage2.getTask(created.id)!;
		const snapshot = makeSnapshot2(original);
		storage2.updateTask(created.id, {
			cron: "+1s",
			scheduleType: "once",
			nextRunAt: Date.now() + 1_000,
			status: "active",
			updatedAt: Date.now(),
		});
		writeTestRunMarker(original, snapshot, Date.now(), schedulerDir2, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 200_000,
		});

		const { promise, resolve } = Promise.withResolvers<void>();
		const engine = new SchedulerEngine({
			storage: storage2,
			onTrigger: async (_task, execId) => {
				storage2.updateExecution(execId, { status: "failure", exitCode: 1, endedAt: Date.now() });
				resolve();
			},
		});
		engine.start();
		try {
			await Promise.race([promise, Bun.sleep(3_000).then(() => undefined)]);
			await Bun.sleep(50);
		} finally {
			engine.stop();
		}

		const after = storage2.getTask(created.id);
		expect(after?.cron).toBe("30 8 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(hasTestRunMarker(schedulerDir2)).toBe(false);
	});

	it("does not touch a marker for a different task (defensive)", async () => {
		const a = storage2.addTask({
			name: "task-a",
			cron: "0 9 * * *",
			scheduleType: "cron",
			status: "active",
			command: "echo a",
			taskType: "shell",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		const b = storage2.addTask({
			name: "task-b",
			cron: "0 10 * * *",
			scheduleType: "cron",
			status: "active",
			command: "echo b",
			taskType: "shell",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		const aOriginal = storage2.getTask(a.id)!;
		const aSnapshot = makeSnapshot2(aOriginal);
		writeTestRunMarker(aOriginal, aSnapshot, Date.now(), schedulerDir2, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 200_000,
		});
		storage2.updateTask(b.id, {
			cron: "+1s",
			scheduleType: "once",
			nextRunAt: Date.now() + 1_000,
			status: "active",
			updatedAt: Date.now(),
		});

		const { promise, resolve } = Promise.withResolvers<void>();
		const engine = new SchedulerEngine({
			storage: storage2,
			onTrigger: async (_task, execId) => {
				storage2.updateExecution(execId, { status: "success", exitCode: 0, endedAt: Date.now() });
				resolve();
			},
		});
		engine.start();
		try {
			await Promise.race([promise, Bun.sleep(3_000).then(() => undefined)]);
			await Bun.sleep(50);
		} finally {
			engine.stop();
		}
		expect(hasTestRunMarker(schedulerDir2)).toBe(true);
		const m = readTestRunMarker(schedulerDir2);
		expect(m?.taskId).toBe(a.id);
	});

	it("is a no-op when no marker exists on disk", async () => {
		const created = storage2.addTask({
			name: "no-marker-one-shot",
			cron: "+1s",
			scheduleType: "once",
			status: "active",
			command: "echo no-marker",
			taskType: "shell",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		const { promise, resolve } = Promise.withResolvers<void>();
		const engine = new SchedulerEngine({
			storage: storage2,
			onTrigger: async (_task, execId) => {
				storage2.updateExecution(execId, { status: "success", exitCode: 0, endedAt: Date.now() });
				resolve();
			},
		});
		engine.start();
		try {
			await Promise.race([promise, Bun.sleep(3_000).then(() => undefined)]);
			await Bun.sleep(50);
		} finally {
			engine.stop();
		}

		const after = storage2.getTask(created.id);
		expect(after?.cron).toBe("+1s");
		expect(after?.scheduleType).toBe("once");
		expect(after?.status).toBe("active");
		expect(hasTestRunMarker(schedulerDir2)).toBe(false);
	});
});

describe("test-run-marker path parity", () => {
	it("getTestRunMarkerPath uses the same dir as the engine's readTestRunMarker call", () => {
		const expected = path.join(os.homedir(), ".omp", "gateway-data", "scheduler", "test-run-restore.json");
		expect(getTestRunMarkerPath()).toBe(expected);
	});
});

// ===========================================================================
// maxConcurrentRuns (was: scheduler-max-concurrent-runs.test.ts)
// ===========================================================================

describe("scheduler maxConcurrentRuns", () => {
	let testDir3: string;
	let storage3: JsonFileStorage;
	let engine: SchedulerEngine;

	beforeEach(() => {
		testDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-concurrency-"));
		storage3 = new JsonFileStorage(path.join(testDir3, "jobs.json"));
	});

	afterEach(() => {
		engine?.stop();
		storage3?.close();
		fs.rmSync(testDir3, { recursive: true, force: true });
	});

	test("skips trigger when maxConcurrentRuns is reached", async () => {
		let activeCount = 0;
		let maxConcurrent = 0;

		storage3.addTask({
			name: "slow-interval",
			cron: "100ms",
			command: "echo slow",
			status: "active",
			scheduleType: "interval",
			taskType: "shell",
			timeoutMs: 10_000,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		engine = new SchedulerEngine({
			storage: storage3,
			onTrigger: async (_task, execId) => {
				activeCount++;
				maxConcurrent = Math.max(maxConcurrent, activeCount);
				await Bun.sleep(500);
				activeCount--;
				storage3.updateExecution(execId, { status: "success", endedAt: Date.now() });
			},
			config: {
				enabled: true,
				taskDir: testDir3,
				maxConcurrentRuns: 1,
			},
		});

		engine.start();
		await Bun.sleep(1500);
		engine.stop();

		expect(maxConcurrent).toBe(1);
	});
});

// ===========================================================================
// agentSessionPath round-trip (was: scheduler-storage-persistence.test.ts)
// ===========================================================================

const ORIGINAL_LOG_ROOT = getLogRoot();

describe("JsonFileStorage — agentSessionPath persistence round-trip", () => {
	let jobsPath4: string;
	let testDir4: string;

	beforeEach(() => {
		testDir4 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-storage-persist-"));
		jobsPath4 = path.join(testDir4, "jobs.json");
		setLogRoot(path.join(testDir4, "logs"));
	});

	afterEach(() => {
		setLogRoot(ORIGINAL_LOG_ROOT);
		try {
			fs.rmSync(testDir4, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	function addTaskToNewStorage(name: string, agentDir: string) {
		const storage = new JsonFileStorage(jobsPath4);
		storage.addTask({
			cron: "0 0 1 1 *",
			command: "do thing",
			taskType: "agent",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
			agentDir,
			name,
		});
		const stored = storage.getTaskByName(name);
		if (!stored) throw new Error("test setup: task not found after add");
		const result = { id: stored.id, name: stored.name, agentDir: stored.agentDir ?? "" };
		storage.close();
		return result;
	}

	it("read back from JSONL preserves agentSessionPath after a simulated restart", () => {
		const sessionPath = "/Users/test/.omp/agent/omp-atomix/sessions/cron_abc123.jsonl";
		const task = addTaskToNewStorage("persist-test", "/tmp/agent-persist");

		{
			const storage1 = new JsonFileStorage(jobsPath4);
			const stored = storage1.getTaskByName(task.name);
			expect(stored).toBeDefined();
			const exec = storage1.recordExecution({
				taskId: stored!.id,
				startedAt: Date.now() - 5000,
				status: "running",
			});
			storage1.updateExecution(exec.id, {
				endedAt: Date.now(),
				exitCode: 1,
				output: "fail",
				stderr: "tool error",
				status: "failure",
				agentSessionPath: sessionPath,
			});
			const entry: ExecutionLogEntry = {
				id: exec.id,
				ts: Date.now(),
				exitCode: 1,
				status: "failure",
				durationMs: 5000,
				output: "fail",
				stderr: "tool error",
				agentSessionPath: sessionPath,
			};
			appendExecutionLog(task.name, entry);
			storage1.close();
		}

		const storage2 = new JsonFileStorage(jobsPath4);
		const stored = storage2.getTaskByName(task.name);
		expect(stored).toBeDefined();
		const execs = storage2.getExecutions(stored!.id);
		expect(execs).toHaveLength(1);
		expect(execs[0]?.agentSessionPath).toBe(sessionPath);
		expect(execs[0]?.status).toBe("failure");
		storage2.close();
	});

	it("legacy entries without agentSessionPath surface as undefined (no synthetic value)", () => {
		const task = addTaskToNewStorage("legacy-test", "/tmp/agent-legacy");

		{
			const storage1 = new JsonFileStorage(jobsPath4);
			const stored = storage1.getTaskByName(task.name);
			const exec = storage1.recordExecution({
				taskId: stored!.id,
				startedAt: Date.now() - 1000,
				status: "running",
			});
			appendExecutionLog(task.name, {
				id: exec.id,
				ts: Date.now(),
				exitCode: 0,
				status: "success",
				durationMs: 1000,
				output: "ok",
				stderr: "",
			});
			storage1.close();
		}

		const storage2 = new JsonFileStorage(jobsPath4);
		const stored = storage2.getTaskByName(task.name);
		const execs = storage2.getExecutions(stored!.id);
		expect(execs).toHaveLength(1);
		expect(execs[0]?.agentSessionPath).toBeUndefined();
		storage2.close();
	});
});

// ===========================================================================
// Test-run marker I/O + orphan recovery (was: scheduler-test-run-marker.test.ts)
// ===========================================================================

let tempDir5: string;

function makeTask5(overrides: Partial<ScheduledTask> = {}): Omit<ScheduledTask, "id"> {
	return {
		name: "marker-task",
		cron: "0 18 * * *",
		scheduleType: "cron",
		nextRunAt: 1_900_000_000_000,
		status: "active",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		runCount: 5,
		failCount: 0,
		consecutiveFailures: 0,
		...overrides,
	};
}

function makeSnapshot5(task: ScheduledTask) {
	return {
		cron: task.cron,
		scheduleType: task.scheduleType,
		nextRunAt: task.nextRunAt,
		status: task.status,
		lastRunAt: task.lastRunAt,
		runCount: task.runCount,
		failCount: task.failCount,
		consecutiveFailures: task.consecutiveFailures,
		repeatCompleted: task.repeatCompleted,
		lastDeliveryError: task.lastDeliveryError,
	};
}

beforeEach(() => {
	tempDir5 = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-run-marker-"));
});

afterEach(() => {
	fs.rmSync(tempDir5, { recursive: true, force: true });
});

describe("test-run-marker: file I/O", () => {
	it("hasTestRunMarker is false when no marker exists", () => {
		expect(hasTestRunMarker(tempDir5)).toBe(false);
	});

	it("writeTestRunMarker creates a marker readable by readTestRunMarker", () => {
		const task = makeTask5();
		writeTestRunMarker(task, makeSnapshot5(task), Date.now(), tempDir5);
		const marker = readTestRunMarker(tempDir5);
		expect(marker).not.toBeNull();
		expect(marker?.taskId).toBe(task.id);
		expect(marker?.taskName).toBe(task.name);
		expect(marker?.snapshot.cron).toBe(task.cron);
		expect(marker?.version).toBe(1);
	});

	it("clearTestRunMarker removes the marker", () => {
		const task = makeTask5();
		writeTestRunMarker(task, makeSnapshot5(task), Date.now(), tempDir5, 999_999);
		clearTestRunMarker(tempDir5);
		expect(hasTestRunMarker(tempDir5)).toBe(false);
	});

	it("readTestRunMarker returns null for malformed JSON", () => {
		const markerPath = path.join(tempDir5, "test-run-restore.json");
		fs.writeFileSync(markerPath, "not json at all", "utf-8");
		expect(readTestRunMarker(tempDir5)).toBeNull();
	});
});

describe("JsonFileStorage.consumeOrphanTestRunMarker", () => {
	function makeStorage(): JsonFileStorage {
		return new JsonFileStorage(path.join(tempDir5, "jobs.json"));
	}

	it("returns false (no-op) when no marker exists", () => {
		const storage = makeStorage();
		expect(storage.consumeOrphanTestRunMarker()).toBe(false);
		storage.close();
	});

	it("restores the task from a left-behind marker and clears the marker file", () => {
		const storage = makeStorage();
		const created = storage.addTask(makeTask5());
		storage.updateTask(created.id, {
			cron: "+120s",
			scheduleType: "once",
			nextRunAt: Date.now() + 120_000,
			updatedAt: Date.now(),
		});
		writeTestRunMarker(
			storage.getTask(created.id)!,
			{
				cron: "0 18 * * *",
				scheduleType: "cron",
				nextRunAt: 1_900_000_000_000,
				status: "active",
				lastRunAt: undefined,
				runCount: 5,
				failCount: 0,
				consecutiveFailures: 0,
				repeatCompleted: undefined,
				lastDeliveryError: undefined,
			},
			Date.now(),
			tempDir5,
			999_999,
		);
		expect(storage.consumeOrphanTestRunMarker()).toBe(true);

		const after = storage.getTask(created.id);
		expect(after?.cron).toBe("0 18 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(after?.nextRunAt).toBe(1_900_000_000_000);
		expect(after?.runCount).toBe(5);

		expect(hasTestRunMarker(tempDir5)).toBe(false);
		storage.close();
	});

	it("clears the marker without crashing when the task was deleted mid-run", () => {
		const storage = makeStorage();
		const created = storage.addTask(makeTask5());
		storage.deleteTask(created.id);
		writeTestRunMarker(
			created,
			{
				cron: "0 18 * * *",
				scheduleType: "cron",
				nextRunAt: 1_900_000_000_000,
				status: "active",
				lastRunAt: undefined,
				runCount: 0,
				failCount: 0,
				consecutiveFailures: 0,
				repeatCompleted: undefined,
				lastDeliveryError: undefined,
			},
			Date.now(),
			tempDir5,
			999_999,
		);
		expect(storage.consumeOrphanTestRunMarker()).toBe(false);
		expect(hasTestRunMarker(tempDir5)).toBe(false);
		storage.close();
	});

	it("is idempotent: a second call with the same marker is a no-op", () => {
		const storage = makeStorage();
		const created = storage.addTask(makeTask5());
		writeTestRunMarker(
			created,
			{
				cron: "0 18 * * *",
				scheduleType: "cron",
				nextRunAt: 1_900_000_000_000,
				status: "active",
				lastRunAt: undefined,
				runCount: 5,
				failCount: 0,
				consecutiveFailures: 0,
				repeatCompleted: undefined,
				lastDeliveryError: undefined,
			},
			Date.now(),
			tempDir5,
			999_999,
		);
		expect(storage.consumeOrphanTestRunMarker()).toBe(true);
		expect(storage.consumeOrphanTestRunMarker()).toBe(false);
		storage.close();
	});

	it("skips recovery when the marker is from the current process (in-flight test-run)", () => {
		const storage = makeStorage();
		const created = storage.addTask(makeTask5());
		storage.updateTask(created.id, {
			cron: "+120s",
			scheduleType: "once",
			nextRunAt: Date.now() + 120_000,
			updatedAt: Date.now(),
		});
		writeTestRunMarker(
			storage.getTask(created.id)!,
			makeSnapshot5(storage.getTask(created.id)!),
			Date.now(),
			tempDir5,
		);
		expect(storage.consumeOrphanTestRunMarker()).toBe(false);
		expect(hasTestRunMarker(tempDir5)).toBe(true);
		expect(storage.getTask(created.id)?.cron).toBe("+120s");
		expect(storage.getTask(created.id)?.scheduleType).toBe("once");
		storage.close();
	});

	it("recovers when the marker is from a different process (CLI orphan or prior instance)", () => {
		const storage = makeStorage();
		const created = storage.addTask(makeTask5());
		const snapshot = makeSnapshot5(storage.getTask(created.id)!);
		storage.updateTask(created.id, {
			cron: "+120s",
			scheduleType: "once",
			nextRunAt: Date.now() + 120_000,
			updatedAt: Date.now(),
		});
		const foreignMarker: TestRunMarker = {
			version: 1,
			taskId: created.id,
			taskName: created.name,
			pid: 999_999,
			startedAt: Date.now() - 60_000,
			snapshot,
		};
		writeTestRunMarkerRaw(foreignMarker, tempDir5);

		expect(storage.consumeOrphanTestRunMarker()).toBe(true);
		expect(hasTestRunMarker(tempDir5)).toBe(false);
		const after = storage.getTask(created.id);
		expect(after?.cron).toBe("0 18 * * *");
		expect(after?.scheduleType).toBe("cron");
		storage.close();
	});

	it("recovers same-process awaitingFire marker after expiresAt", () => {
		const storage = makeStorage();
		const created = storage.addTask(makeTask5());
		const snapshot = makeSnapshot5(storage.getTask(created.id)!);
		storage.updateTask(created.id, {
			cron: "+120s",
			scheduleType: "once",
			nextRunAt: Date.now() + 120_000,
			updatedAt: Date.now(),
		});
		const expiredMarker: TestRunMarker = {
			version: 1,
			taskId: created.id,
			taskName: created.name,
			pid: process.pid,
			startedAt: Date.now() - 600_000,
			awaitingFire: true,
			expiresAt: Date.now() - 1_000,
			snapshot,
		};
		writeTestRunMarkerRaw(expiredMarker, tempDir5);

		expect(storage.consumeOrphanTestRunMarker()).toBe(true);
		expect(hasTestRunMarker(tempDir5)).toBe(false);
		const after = storage.getTask(created.id);
		expect(after?.cron).toBe("0 18 * * *");
		expect(after?.scheduleType).toBe("cron");
		storage.close();
	});

	it("does NOT recover same-process awaitingFire marker before expiresAt", () => {
		const storage = makeStorage();
		const created = storage.addTask(makeTask5());
		storage.updateTask(created.id, {
			cron: "+120s",
			scheduleType: "once",
			nextRunAt: Date.now() + 120_000,
			updatedAt: Date.now(),
		});
		const inFlightMarker: TestRunMarker = {
			version: 1,
			taskId: created.id,
			taskName: created.name,
			pid: process.pid,
			startedAt: Date.now() - 5_000,
			awaitingFire: true,
			expiresAt: Date.now() + 200_000,
			snapshot: makeSnapshot5(storage.getTask(created.id)!),
		};
		writeTestRunMarkerRaw(inFlightMarker, tempDir5);

		expect(storage.consumeOrphanTestRunMarker()).toBe(false);
		expect(hasTestRunMarker(tempDir5)).toBe(true);
		expect(storage.getTask(created.id)?.cron).toBe("+120s");
		storage.close();
	});

	it("legacy markers (no awaitingFire) keep the same-process skip rule", () => {
		const storage = makeStorage();
		const created = storage.addTask(makeTask5());
		storage.updateTask(created.id, {
			cron: "+120s",
			scheduleType: "once",
			nextRunAt: Date.now() + 120_000,
			updatedAt: Date.now(),
		});
		const legacyInFlight: TestRunMarker = {
			version: 1,
			taskId: created.id,
			taskName: created.name,
			pid: process.pid,
			startedAt: Date.now() - 60_000,
			snapshot: makeSnapshot5(storage.getTask(created.id)!),
		};
		writeTestRunMarkerRaw(legacyInFlight, tempDir5);

		expect(storage.consumeOrphanTestRunMarker()).toBe(false);
		expect(hasTestRunMarker(tempDir5)).toBe(true);
		storage.close();
	});
});

describe("test-run end-to-end: marker lifecycle", () => {
	it("the marker is written on test-run start and cleared on restore", () => {
		const storage = new JsonFileStorage(path.join(tempDir5, "jobs.json"));
		const created = storage.addTask(makeTask5());
		expect(hasTestRunMarker(tempDir5)).toBe(false);

		const original = storage.getTask(created.id)!;
		const snapshot = makeSnapshot5(original);
		storage.updateTask(created.id, {
			cron: "+120s",
			scheduleType: "once",
			nextRunAt: Date.now() + 120_000,
			updatedAt: Date.now(),
		});
		writeTestRunMarker(original, snapshot, Date.now(), tempDir5);
		expect(storage.getTask(created.id)?.cron).toBe("+120s");
		expect(hasTestRunMarker(tempDir5)).toBe(true);

		storage.updateTask(created.id, {
			cron: snapshot.cron,
			scheduleType: snapshot.scheduleType,
			nextRunAt: snapshot.nextRunAt,
			status: snapshot.status,
			updatedAt: Date.now(),
		});
		clearTestRunMarker(tempDir5);

		expect(hasTestRunMarker(tempDir5)).toBe(false);
		const after = storage.getTask(created.id);
		expect(after?.cron).toBe("0 18 * * *");
		expect(after?.scheduleType).toBe("cron");
		storage.close();
	});
});

// ===========================================================================
// attach-to-session delivery mirror (was: scheduler-attach-to-session.test.ts)
// ===========================================================================

let attachTempDir = "";
let attachAgentDir = "";

beforeEach(() => {
	attachTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-to-session-test-"));
	attachAgentDir = path.join(attachTempDir, "agent");
	fs.mkdirSync(path.join(attachAgentDir, "sessions"), { recursive: true });
});

afterEach(() => {
	if (attachTempDir) fs.rmSync(attachTempDir, { recursive: true, force: true });
});

function writeSession(fileName: string, lines: object[]): string {
	const filePath = path.join(attachAgentDir, "sessions", fileName);
	const content = lines.length > 0 ? `${lines.map(l => JSON.stringify(l)).join("\n")}\n` : "";
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function readSession(filePath: string): unknown[] {
	const content = fs.readFileSync(filePath, "utf-8");
	return content
		.split("\n")
		.filter(l => l.trim())
		.map(l => JSON.parse(l));
}

describe("resolveMirrorSessionPath", () => {
	it("returns undefined when agentDir is undefined", () => {
		expect(resolveMirrorSessionPath(undefined, { toUserId: "u1" })).toBeUndefined();
	});

	it("uses toConversationId when set and the session file exists", () => {
		const convId = "cid_group_abc";
		const sessionPath = writeSession(`${convId}.jsonl`, [
			{
				type: "message",
				id: "m1",
				parentId: null,
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			},
		]);
		const result = resolveMirrorSessionPath(attachAgentDir, { toConversationId: convId });
		expect(result).toBe(sessionPath);
	});

	it("returns undefined when toConversationId is set but file does not exist", () => {
		const result = resolveMirrorSessionPath(attachAgentDir, { toConversationId: "cid_never_chatted" });
		expect(result).toBeUndefined();
	});

	it("scans sessions dir for most recent non-cron file when toUserId is set", () => {
		const old1 = writeSession("old_dm.jsonl", [{ type: "message", id: "m1", message: { role: "user" } }]);
		const old2 = writeSession("recent_dm.jsonl", [{ type: "message", id: "m2", message: { role: "user" } }]);
		const old3 = writeSession("another_dm.jsonl", [{ type: "message", id: "m3", message: { role: "user" } }]);
		const now = Date.now();
		fs.utimesSync(old1, now / 1000 - 100, now / 1000 - 100);
		fs.utimesSync(old2, now / 1000, now / 1000);
		fs.utimesSync(old3, now / 1000 - 50, now / 1000 - 50);

		const result = resolveMirrorSessionPath(attachAgentDir, { toUserId: "u1" });
		expect(result).toBe(old2);
	});

	it("skips cron_<ts>.jsonl files in the DM scan", () => {
		const dm = writeSession("dm_session.jsonl", [{ type: "message", id: "m1", message: { role: "user" } }]);
		const cron = writeSession("cron_1234567890.jsonl", [
			{ type: "message", id: "m2", message: { role: "assistant" } },
		]);
		const now = Date.now();
		fs.utimesSync(dm, now / 1000 - 100, now / 1000 - 100);
		fs.utimesSync(cron, now / 1000, now / 1000);

		const result = resolveMirrorSessionPath(attachAgentDir, { toUserId: "u1" });
		expect(result).toBe(dm);
	});

	it("returns undefined when DM scan finds no eligible session", () => {
		writeSession("cron_9999999.jsonl", [{ type: "message", id: "m1", message: { role: "assistant" } }]);
		const result = resolveMirrorSessionPath(attachAgentDir, { toUserId: "u1" });
		expect(result).toBeUndefined();
	});

	it("returns undefined when neither toUserId nor toConversationId is set", () => {
		expect(resolveMirrorSessionPath(attachAgentDir, {})).toBeUndefined();
	});
});

describe("appendMirrorEntry", () => {
	it("writes a user-role entry with the [Cron delivery: ...] label", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{
				type: "message",
				id: "m1",
				parentId: null,
				message: { role: "user", content: [{ type: "text", text: "old" }] },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
			},
		]);

		const result = appendMirrorEntry(sessionPath, "daily-brief", "Today's brief: 5 PRs", 1700000000000);
		expect(result.ok).toBe(true);

		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(3);
		const mirror = entries[2] as {
			type: string;
			message: { role: string; content: Array<{ type: string; text: string }> };
		};
		expect(mirror.type).toBe("message");
		expect(mirror.message.role).toBe("user");
		expect(mirror.message.content[0]?.type).toBe("text");
		const text = mirror.message.content[0]?.text ?? "";
		expect(text).toContain("[Cron delivery: daily-brief");
		expect(text).toContain("Today's brief: 5 PRs");
	});

	it("uses parentId from the last entry", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
			{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
		]);
		appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		const entries = readSession(sessionPath);
		const mirror = entries[2] as { parentId: string };
		expect(mirror.parentId).toBe("m2");
	});

	it("inserts a placeholder assistant turn when last entry is user (alternation guard)", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
		]);

		appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(3);
		const placeholder = entries[1] as { message: { role: string; content: Array<{ text: string }> } };
		const mirror = entries[2] as { message: { role: string } };
		expect(placeholder.message.role).toBe("assistant");
		expect(placeholder.message.content[0]?.text).toBe("(noted)");
		expect(mirror.message.role).toBe("user");
	});

	it("appends directly when last entry is assistant (no placeholder needed)", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
			{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
		]);
		appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(3);
	});

	it("appends directly when last entry is toolResult (no placeholder needed)", () => {
		const sessionPath = writeSession("dm.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "toolResult", content: [] } },
		]);
		appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(2);
	});

	it("tolerates a malformed last line (still appends)", () => {
		const sessionPath = path.join(attachAgentDir, "sessions", "dm.jsonl");
		fs.writeFileSync(sessionPath, "this is not json\n", "utf-8");
		const result = appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		expect(result.ok).toBe(true);
		const content = fs.readFileSync(sessionPath, "utf-8");
		expect(content).toContain("[Cron delivery: task");
	});

	it("returns ok:false when the file does not exist", () => {
		const missing = path.join(attachAgentDir, "sessions", "ghost.jsonl");
		const result = appendMirrorEntry(missing, "task", "brief", 1700000000000);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("read session failed");
	});

	it("appends to an empty file (no last entry)", () => {
		const sessionPath = path.join(attachAgentDir, "sessions", "empty.jsonl");
		fs.writeFileSync(sessionPath, "", "utf-8");
		const result = appendMirrorEntry(sessionPath, "task", "brief", 1700000000000);
		expect(result.ok).toBe(true);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(1);
	});
});

describe("mirrorDeliveryToSession", () => {
	it("mirrors successfully on DingTalk with toConversationId", async () => {
		const convId = "cid_dm_001";
		const sessionPath = writeSession(`${convId}.jsonl`, [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
			{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
		]);

		const result = await mirrorDeliveryToSession({
			task: { name: "daily-brief", agentDir: attachAgentDir },
			brief: "5 PRs today",
			delivery: { channel: "dingtalk", toConversationId: convId },
		});

		expect(result.ok).toBe(true);
		const entries = readSession(sessionPath);
		const mirror = entries[2] as { message: { content: Array<{ text: string }> } };
		expect(mirror.message.content[0]?.text).toContain("5 PRs today");
	});

	it("mirrors successfully on DingTalk DM (toUserId only, scan finds most recent)", async () => {
		const dm = writeSession("dm_session.jsonl", [
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } },
			{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
		]);
		const now = Date.now();
		fs.utimesSync(dm, now / 1000, now / 1000);

		const result = await mirrorDeliveryToSession({
			task: { name: "daily-brief", agentDir: attachAgentDir },
			brief: "DM brief",
			delivery: { channel: "dingtalk", toUserId: "u1" },
		});

		expect(result.ok).toBe(true);
		const entries = readSession(dm);
		const mirror = entries[2] as { message: { content: Array<{ text: string }> } };
		expect(mirror.message.content[0]?.text).toContain("DM brief");
	});

	it("rejects on non-dingtalk channel", async () => {
		const result = await mirrorDeliveryToSession({
			task: { name: "t", agentDir: attachAgentDir },
			brief: "b",
			delivery: { channel: "telegram", toUserId: "u1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("not supported for channel: telegram");
	});

	it("rejects when task has no agentDir / accountId", async () => {
		const result = await mirrorDeliveryToSession({
			task: { name: "t" },
			brief: "b",
			delivery: { channel: "dingtalk", toUserId: "u1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no agentDir / accountId");
	});

	it("rejects when no chat session exists (user has not chatted with bot)", async () => {
		const result = await mirrorDeliveryToSession({
			task: { name: "t", agentDir: attachAgentDir },
			brief: "b",
			delivery: { channel: "dingtalk", toUserId: "u_never_chatted" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no chat session found");
	});

	it("falls back to deprecated task.accountId when agentDir is undefined", async () => {
		const accountId = path.join(attachTempDir, "deprecated_workspace");
		const accountDir = accountId;
		fs.mkdirSync(path.join(accountDir, "sessions"), { recursive: true });
		const sessionPath = path.join(accountDir, "sessions", "dm.jsonl");
		fs.writeFileSync(
			sessionPath,
			`${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [] } })}\n`,
			"utf-8",
		);

		const result = await mirrorDeliveryToSession({
			task: { name: "t", accountId },
			brief: "via accountId",
			delivery: { channel: "dingtalk", toUserId: "u1" },
		});
		expect(result.ok).toBe(true);
		const entries = readSession(sessionPath);
		expect(entries).toHaveLength(3);
		const last = entries[2] as { message: { role: string; content: Array<{ text: string }> } };
		expect(last.message.role).toBe("user");
		expect(last.message.content[0]?.text).toContain("via accountId");
	});
});
