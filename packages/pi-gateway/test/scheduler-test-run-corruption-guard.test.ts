/**
 * scheduler-test-run-corruption-guard.test.ts — auto-heal + disable on
 * detected corruption.
 *
 * Background: the snowball bug. If `runTestRun` is interrupted between
 * writing the marker and the engine's post-fire restore (SIGKILL, OOM,
 * gateway crash mid-handleTrigger), the task is left on `+<n>s once`
 * in storage. The next `runTestRun` would snapshot the corrupted
 * value into a new marker, the restore would write it back unchanged,
 * and the corruption self-perpetuates.
 *
 * The corruption guard at `runTestRun` entry detects this state (cron
 * is a test-run one-shot shape) and self-heals:
 *   - If a marker exists with a CLEAN snapshot, apply it to storage,
 *     clear the marker, fire the caller's `onReload` hook (so the
 *     in-memory engine drops the stale `setTimeout`), and proceed.
 *   - Otherwise, disable the task and return `schedule_corrupted` so
 *     the caller (LLM or CLI) knows to re-enable the task manually.
 *
 * The tests below assert each branch of the guard.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import { runTestRun } from "../src/scheduler/test-run";
import { type TestRunSnapshot, writeTestRunMarker } from "../src/scheduler/test-run-marker";
import type { ScheduledTask } from "../src/scheduler/types";

let testDir: string;
let markerBaseDir: string;
let storage: SchedulerDbStorage;

const cleanSnapshot: TestRunSnapshot = {
	cron: "0 10 * * 1",
	scheduleType: "cron",
	nextRunAt: 1_783_908_000_000,
	status: "active",
	lastRunAt: undefined,
	runCount: 7,
	failCount: 1,
	consecutiveFailures: 0,
	repeatCompleted: undefined,
	lastDeliveryError: undefined,
};

function seedCorruptedTask(name: string): ScheduledTask {
	storage.addTask({
		name,
		// Corrupted: leftover test-run one-shot shape that should
		// never persist past a successful restore.
		cron: "+120s",
		command: "echo test-run",
		scheduleType: "once",
		taskType: "shell",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 7,
		failCount: 1,
		consecutiveFailures: 0,
	});
	return storage.getTaskByName(name)!;
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-corrupt-"));
	markerBaseDir = path.join(testDir, "scheduler");
	fs.mkdirSync(markerBaseDir, { recursive: true });
	storage = new SchedulerDbStorage(path.join(testDir, "scheduler.db"));
});

afterEach(() => {
	storage?.close();
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("runTestRun corruption guard", () => {
	test("auto-heals: clean marker + corrupted task → restores snap, clears marker, fires onReload, proceeds", async () => {
		const task = seedCorruptedTask("weekly-kb-lint");
		// Orphan marker with a clean snapshot (the original cron
		// expression before the previous test-run's SIGKILL).
		writeTestRunMarker(
			task,
			cleanSnapshot,
			Date.now() - 200_000,
			markerBaseDir,
			999_999, // cross-process pid, like a previous gateway instance
			undefined,
		);

		let reloadCount = 0;
		const result = await runTestRun({
			name: "weekly-kb-lint",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
			onReload: () => {
				reloadCount += 1;
			},
		});

		// Should have proceeded with a fresh test-run, not errored.
		expect(result.kind).toBe("started");
		// onReload fired exactly once — the gateway's in-memory
		// engine drops the stale `setTimeout` left behind by the
		// previous failed test-run.
		expect(reloadCount).toBe(1);
		// The new test-run wrote a marker with the CLEAN snap
		// (proves the re-load after auto-heal saw a clean task;
		// otherwise the new marker would carry "+120s" as its
		// snapshot, perpetuating the corruption). Read it back.
		const { readTestRunMarker } = await import("../src/scheduler/test-run-marker");
		const newMarker = readTestRunMarker(markerBaseDir);
		expect(newMarker).not.toBeNull();
		expect(newMarker?.snapshot.cron).toBe("0 10 * * 1");
		expect(newMarker?.snapshot.scheduleType).toBe("cron");
		// Stats carried over from the clean snapshot.
		expect(newMarker?.snapshot.runCount).toBe(7);
		expect(newMarker?.snapshot.failCount).toBe(1);
	});

	test("disables: corrupted task + no marker → schedule_corrupted, task disabled", async () => {
		const _task = seedCorruptedTask("orphaned");
		let reloadCount = 0;

		const result = await runTestRun({
			name: "orphaned",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
			onReload: () => {
				reloadCount += 1;
			},
		});

		expect(result.kind).toBe("schedule_corrupted");
		if (result.kind === "schedule_corrupted") {
			expect(result.name).toBe("orphaned");
			expect(result.currentCron).toBe("+120s");
		}
		const after = storage.getTaskByName("orphaned");
		expect(after?.status).toBe("disabled");
		// No reload on the disable path — there's nothing clean to
		// load into memory; the engine will pick up the disabled
		// state on its next tick.
		expect(reloadCount).toBe(0);
	});

	test("disables: corrupted task + marker with dirty snap (also +<n>s) → schedule_corrupted", async () => {
		const task = seedCorruptedTask("double-corrupted");
		const dirtySnapshot: TestRunSnapshot = {
			// Marker snap is ALSO a test-run shape — meaning a
			// previous test-run already snapshotted the corruption
			// and we have no clean source left.
			cron: "+90s",
			scheduleType: "once",
			nextRunAt: Date.now() - 60_000,
			status: "active",
			lastRunAt: undefined,
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
			repeatCompleted: undefined,
			lastDeliveryError: undefined,
		};
		writeTestRunMarker(task, dirtySnapshot, Date.now() - 60_000, markerBaseDir, 999_999, undefined);

		const result = await runTestRun({
			name: "double-corrupted",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
		});

		expect(result.kind).toBe("schedule_corrupted");
		const after = storage.getTaskByName("double-corrupted");
		expect(after?.status).toBe("disabled");
		// Dirty marker NOT cleared: the next orphan-recovery tick
		// (or operator manual fix) gets to see the full state and
		// make its own decision.
	});

	test("onReload is NOT called when the task is clean (no corruption detected)", async () => {
		// Clean task, no marker.
		storage.addTask({
			name: "clean-task",
			cron: "0 9 * * *",
			command: "echo x",
			scheduleType: "cron",
			taskType: "shell",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});

		let reloadCount = 0;
		const result = await runTestRun({
			name: "clean-task",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
			onReload: () => {
				reloadCount += 1;
			},
		});

		expect(result.kind).toBe("started");
		expect(reloadCount).toBe(0);
	});

	test("works without onReload (CLI path, separate process) — heals storage, no reload", async () => {
		const task = seedCorruptedTask("cli-path");
		writeTestRunMarker(task, cleanSnapshot, Date.now() - 200_000, markerBaseDir, 999_999, undefined);

		// CLI doesn't pass onReload (it can't reach the gateway's
		// in-memory engine). Storage heals; the gateway's own
		// tick picks up the change on the next cycle. The new
		// marker is written with the CLEAN snap.
		const result = await runTestRun({
			name: "cli-path",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
			// onReload: undefined (CLI default)
		});

		expect(result.kind).toBe("started");
		const { readTestRunMarker } = await import("../src/scheduler/test-run-marker");
		const newMarker = readTestRunMarker(markerBaseDir);
		expect(newMarker?.snapshot.cron).toBe("0 10 * * 1");
	});

	test("disables even when onReload throws (caller-side failure doesn't leave the task half-healed)", async () => {
		seedCorruptedTask("throw-on-reload");
		// No marker, no onReload needed for the disable path, but
		// simulate a misuse where the caller wires onReload
		// unconditionally.
		const result = await runTestRun({
			name: "throw-on-reload",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
			onReload: () => {
				throw new Error("reload failed");
			},
		});

		// Disable path doesn't call onReload, so the throw doesn't
		// fire; result is still schedule_corrupted and the task
		// is still disabled. The auto-heal path's onReload call
		// would also be wrapped in a try/catch in production, but
		// for this test we just verify the disable path is
		// independent of the callback.
		expect(result.kind).toBe("schedule_corrupted");
		const after = storage.getTaskByName("throw-on-reload");
		expect(after?.status).toBe("disabled");
	});
});
