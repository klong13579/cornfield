/**
 * Scheduler test-run — corruption guard, notify integration, origin marker.
 *
 * Merged:
 *   - scheduler-test-run-corruption-guard.test.ts
 *   - scheduler-test-run-notify-integration.test.ts
 *   - scheduler-test-run-origin-marker.test.ts
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CronLifecycle } from "../src/gateway-cron-lifecycle";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import { runTestRun } from "../src/scheduler/test-run";
import {
	clearTestRunMarker,
	readTestRunMarker,
	type TestRunSnapshot,
	writeTestRunMarker,
} from "../src/scheduler/test-run-marker";
import type { ScheduledTask } from "../src/scheduler/types";

// ═══════════════════════════════════════════════════════════════════════
// Corruption guard
// ═══════════════════════════════════════════════════════════════════════
//
// Background: the snowball bug. If `runTestRun` is interrupted between
// writing the marker and the engine's post-fire restore (SIGKILL, OOM,
// gateway crash mid-handleTrigger), the task is left on `+<n>s once`
// in storage. The next `runTestRun` would snapshot the corrupted
// value into a new marker, the restore would write it back unchanged,
// and the corruption self-perpetuates.
//
// The corruption guard at `runTestRun` entry detects this state (cron
// is a test-run one-shot shape) and self-heals:
//   - If a marker exists with a CLEAN snapshot, apply it to storage,
//     clear the marker, fire the caller's `onReload` hook (so the
//     in-memory engine drops the stale `setTimeout`), and proceed.
//   - Otherwise, disable the task and return `schedule_corrupted` so
//     the caller (LLM or CLI) knows to re-enable the task manually.

let corruptTestDir: string;
let corruptMarkerBaseDir: string;
let corruptStorage: JsonFileStorage;

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
	corruptStorage.addTask({
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
	return corruptStorage.getTaskByName(name)!;
}

beforeEach(() => {
	corruptTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-corrupt-"));
	corruptMarkerBaseDir = path.join(corruptTestDir, "scheduler");
	fs.mkdirSync(corruptMarkerBaseDir, { recursive: true });
	corruptStorage = new JsonFileStorage(path.join(corruptTestDir, "jobs.json"));
});

afterEach(() => {
	corruptStorage?.close();
	try {
		fs.rmSync(corruptTestDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("runTestRun corruption guard", () => {
	test("auto-heals: clean marker + corrupted task → restores snap, clears marker, fires onReload, proceeds", async () => {
		const task = seedCorruptedTask("weekly-kb-lint");
		writeTestRunMarker(
			task,
			cleanSnapshot,
			Date.now() - 200_000,
			corruptMarkerBaseDir,
			999_999,
			undefined,
		);

		let reloadCount = 0;
		const result = await runTestRun({
			name: "weekly-kb-lint",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage: corruptStorage,
			markerBaseDir: corruptMarkerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
			onReload: () => {
				reloadCount += 1;
			},
		});

		expect(result.kind).toBe("started");
		expect(reloadCount).toBe(1);
		const newMarker = readTestRunMarker(corruptMarkerBaseDir);
		expect(newMarker).not.toBeNull();
		expect(newMarker?.snapshot.cron).toBe("0 10 * * 1");
		expect(newMarker?.snapshot.scheduleType).toBe("cron");
		expect(newMarker?.snapshot.runCount).toBe(7);
		expect(newMarker?.snapshot.failCount).toBe(1);
	});

	test("disables: corrupted task + no marker → schedule_corrupted, task disabled", async () => {
		seedCorruptedTask("orphaned");
		let reloadCount = 0;

		const result = await runTestRun({
			name: "orphaned",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage: corruptStorage,
			markerBaseDir: corruptMarkerBaseDir,
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
		const after = corruptStorage.getTaskByName("orphaned");
		expect(after?.status).toBe("disabled");
		expect(reloadCount).toBe(0);
	});

	test("disables: corrupted task + marker with dirty snap (also +<n>s) → schedule_corrupted", async () => {
		const task = seedCorruptedTask("double-corrupted");
		const dirtySnapshot: TestRunSnapshot = {
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
		writeTestRunMarker(task, dirtySnapshot, Date.now() - 60_000, corruptMarkerBaseDir, 999_999, undefined);

		const result = await runTestRun({
			name: "double-corrupted",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage: corruptStorage,
			markerBaseDir: corruptMarkerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
		});

		expect(result.kind).toBe("schedule_corrupted");
		const after = corruptStorage.getTaskByName("double-corrupted");
		expect(after?.status).toBe("disabled");
	});

	test("onReload is NOT called when the task is clean (no corruption detected)", async () => {
		corruptStorage.addTask({
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
			storage: corruptStorage,
			markerBaseDir: corruptMarkerBaseDir,
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
		writeTestRunMarker(task, cleanSnapshot, Date.now() - 200_000, corruptMarkerBaseDir, 999_999, undefined);

		const result = await runTestRun({
			name: "cli-path",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage: corruptStorage,
			markerBaseDir: corruptMarkerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
		});

		expect(result.kind).toBe("started");
		const newMarker = readTestRunMarker(corruptMarkerBaseDir);
		expect(newMarker?.snapshot.cron).toBe("0 10 * * 1");
	});

	test("disables even when onReload throws (caller-side failure doesn't leave the task half-healed)", async () => {
		seedCorruptedTask("throw-on-reload");
		const result = await runTestRun({
			name: "throw-on-reload",
			inMs: 120_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage: corruptStorage,
			markerBaseDir: corruptMarkerBaseDir,
			awaitResult: false,
			pollIntervalMs: 25,
			onReload: () => {
				throw new Error("reload failed");
			},
		});

		expect(result.kind).toBe("schedule_corrupted");
		const after = corruptStorage.getTaskByName("throw-on-reload");
		expect(after?.status).toBe("disabled");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// notifyOriginSessionIfPending (CronLifecycle integration)
// ═══════════════════════════════════════════════════════════════════════
//
// Verifies that `CronLifecycle.notifyOriginSessionIfPending` correctly:
//   1. No-ops when no `origin` is passed (regular cron fire, not a test-run).
//   2. No-ops when the bridge is not running.
//   3. No-ops (logs warn) when bridge.executePrompt throws.
//   4. Dispatches bridge.executePrompt with the correct sessionPath and
//      rendered prompt on the happy path.

interface FakeBridge {
	isRunning: boolean;
	executePrompt: ReturnType<typeof mock>;
	setModel: ReturnType<typeof mock>;
	setDisabledToolsets: ReturnType<typeof mock>;
}

const sampleOrigin = { sessionPath: "/path/to/origin_session.jsonl", accountId: "algorithm" };

function makeBridge(opts: { running?: boolean; throwOnExecute?: Error } = {}): FakeBridge {
	return {
		isRunning: opts.running ?? true,
		executePrompt: mock(async () => {
			if (opts.throwOnExecute) throw opts.throwOnExecute;
			return "ok";
		}),
		setModel: mock(async () => {}),
		setDisabledToolsets: mock(async () => {}),
	};
}

function makeNotifyLifecycle(bridge: FakeBridge): CronLifecycle {
	const fakeRegistry = { sendMessage: mock(async () => {}) };
	const fakeConfig = {
		cron: { deliveryMode: "text" },
		agent: { ompPath: "/usr/bin/true" },
	} as any;
	return new CronLifecycle({
		config: fakeConfig,
		bridge: bridge as any,
		accountBridges: new Map([["algorithm", bridge as any]]),
		accountAgentDirs: new Map(),
		registry: fakeRegistry as any,
		getAccountBridge: (id: string) => (id === "algorithm" ? (bridge as any) : undefined),
		writeStatusFile: async () => {},
	});
}

describe("notifyOriginSessionIfPending", () => {
	test("no origin supplied → no bridge call (not a test-run)", () => {
		const bridge = makeBridge();
		const lifecycle = makeNotifyLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: "3 warnings",
			},
			true,
			undefined,
		);
		expect(bridge.executePrompt).not.toHaveBeenCalled();
	});

	test("bridge not running → no bridge call (logs warn)", () => {
		const bridge = makeBridge({ running: false });
		const lifecycle = makeNotifyLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: "3 warnings",
			},
			true,
			sampleOrigin,
		);
		expect(bridge.executePrompt).not.toHaveBeenCalled();
	});

	test("bridge.executePrompt throws (session closed / circuit open) → log warn, no crash", async () => {
		const bridge = makeBridge({ throwOnExecute: new Error("Failed to switch to cron session: ENOENT") });
		const lifecycle = makeNotifyLifecycle(bridge);
		expect(() =>
			(lifecycle as any).notifyOriginSessionIfPending(
				{
					taskName: "weekly-kb-lint",
					taskId: "task_001",
					slug: "weekly-kb-lint",
					status: "success",
					exitCode: 0,
					durationMs: 124_000,
					output: "3 warnings",
				},
				true,
				sampleOrigin,
			),
		).not.toThrow();
		await new Promise(r => setTimeout(r, 20));
		expect(bridge.executePrompt).toHaveBeenCalledTimes(1);
	});

	test("happy path — bridge.executePrompt called with origin sessionPath + rendered prompt", async () => {
		const bridge = makeBridge();
		const lifecycle = makeNotifyLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: "3 warnings found in lint",
			},
			true,
			sampleOrigin,
		);
		await new Promise(r => setTimeout(r, 20));
		expect(bridge.executePrompt).toHaveBeenCalledTimes(1);
		const [promptText, opts] = bridge.executePrompt.mock.calls[0];
		expect(opts.sessionPath).toBe(sampleOrigin.sessionPath);
		expect(opts.timeoutMs).toBe(60_000);
		expect(promptText).toContain("weekly-kb-lint");
		expect(promptText).toContain("success");
		expect(promptText).toContain("124.0s");
		expect(promptText).toContain("3 warnings found in lint");
	});

	test("happy path — failure status renders error block", async () => {
		const bridge = makeBridge();
		const lifecycle = makeNotifyLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "failure",
				exitCode: 1,
				durationMs: 30_000,
				output: "",
				error: "command not found: ripgrep",
			},
			true,
			sampleOrigin,
		);
		await new Promise(r => setTimeout(r, 20));
		const [promptText] = bridge.executePrompt.mock.calls[0];
		expect(promptText).toContain("failure");
		expect(promptText).toContain("command not found: ripgrep");
	});

	test("happy path — card delivery failure surfaces in prompt", async () => {
		const bridge = makeBridge();
		const lifecycle = makeNotifyLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: "ok",
			},
			false,
			sampleOrigin,
		);
		await new Promise(r => setTimeout(r, 20));
		const [promptText] = bridge.executePrompt.mock.calls[0];
		expect(promptText).toContain("推送失败");
	});

	test("output preview is truncated to 200 chars", async () => {
		const bridge = makeBridge();
		const lifecycle = makeNotifyLifecycle(bridge);
		const longOutput = "x".repeat(500);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: longOutput,
			},
			true,
			sampleOrigin,
		);
		await new Promise(r => setTimeout(r, 20));
		const [promptText] = bridge.executePrompt.mock.calls[0];
		expect(promptText).toContain("x".repeat(200));
		expect(promptText).toContain("…");
		expect(promptText).not.toContain("x".repeat(201));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// TestRunMarker — origin field (B 方案)
// ═══════════════════════════════════════════════════════════════════════
//
// Asserts that TestRunMarker can carry an `origin` field and that
// existing markers (no `origin`) parse correctly. Foundation for
// B 方案 — cron.test-run result notification to origin LLM.

const markerBaseDir = path.join(os.tmpdir(), `omp-b-marker-${process.pid}-${Date.now()}`);

const sampleMarkerTask: ScheduledTask = {
	id: "task_test_001",
	name: "weekly-kb-lint",
	createdByAccountId: "algorithm",
	command: null,
	prompt: "lint the kb",
	taskType: "agent",
	cron: "0 10 * * 1",
	scheduleType: "cron",
	nextRunAt: 1_783_908_000_000,
	status: "active",
	enabled: true,
	createdAt: 1_780_000_000_000,
	updatedAt: 1_780_000_000_000,
	lastRunAt: undefined,
	runCount: 0,
	failCount: 0,
	consecutiveFailures: 0,
	repeatCount: undefined,
	repeatCompleted: undefined,
	lastDeliveryError: undefined,
	delivery: undefined,
	timeoutMs: undefined,
	agentDir: undefined,
	workingDir: undefined,
	disableToolSets: undefined,
	model: undefined,
	provider: undefined,
	tags: [],
	notes: undefined,
	metadata: {},
};

const sampleMarkerSnapshot = {
	cron: "0 10 * * 1",
	scheduleType: "cron" as const,
	nextRunAt: 1_783_908_000_000,
	status: "active" as const,
	lastRunAt: undefined,
	runCount: 0,
	failCount: 0,
	consecutiveFailures: 0,
	repeatCompleted: undefined,
	lastDeliveryError: undefined,
};

describe("TestRunMarker — origin field (B方案)", () => {
	beforeEach(() => {
		fs.mkdirSync(markerBaseDir, { recursive: true });
	});
	afterEach(() => {
		clearTestRunMarker(markerBaseDir);
		fs.rmSync(markerBaseDir, { recursive: true, force: true });
	});

	test("writes origin field when present", () => {
		const origin = { sessionPath: "/Users/test/.omp/agent/sessions/cron_session.jsonl" };
		writeTestRunMarker(sampleMarkerTask, sampleMarkerSnapshot, Date.now(), markerBaseDir, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 300_000,
			origin,
		});
		const marker = readTestRunMarker(markerBaseDir);
		expect(marker).not.toBeNull();
		expect(marker!.origin).toEqual(origin);
	});

	test("reads legacy marker without origin field (forward compat)", () => {
		const legacyMarker = {
			version: 1,
			taskId: sampleMarkerTask.id,
			taskName: sampleMarkerTask.name,
			snapshot: sampleMarkerSnapshot,
			startedAt: Date.now() - 60_000,
			pid: 99999,
			awaitingFire: true,
			expiresAt: Date.now() - 1_000,
		};
		const markerPath = path.join(markerBaseDir, "test-run-restore.json");
		fs.writeFileSync(markerPath, JSON.stringify(legacyMarker), "utf-8");
		const marker = readTestRunMarker(markerBaseDir);
		expect(marker).not.toBeNull();
		expect(marker!.origin).toBeUndefined();
		expect(marker!.pid).toBe(99999);
		expect(marker!.awaitingFire).toBe(true);
	});

	test("origin field is omitted from JSON when undefined (no null pollution)", () => {
		writeTestRunMarker(sampleMarkerTask, sampleMarkerSnapshot, Date.now(), markerBaseDir, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 300_000,
		});
		const markerPath = path.join(markerBaseDir, "test-run-restore.json");
		const raw = fs.readFileSync(markerPath, "utf-8");
		expect(raw).not.toContain('"origin"');
	});

	test("origin + awaitingFire + expiresAt co-exist (full fire-and-forget shape)", () => {
		const origin = { sessionPath: "/path/to/origin_session.jsonl" };
		writeTestRunMarker(sampleMarkerTask, sampleMarkerSnapshot, Date.now(), markerBaseDir, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 300_000,
			origin,
		});
		const marker = readTestRunMarker(markerBaseDir);
		expect(marker!.origin).toEqual(origin);
		expect(marker!.awaitingFire).toBe(true);
		expect(marker!.expiresAt).toBeGreaterThan(Date.now());
	});

	test("writeTestRunMarkerRaw (test helper) preserves origin", () => {
		// Dynamic import to keep the helper test-only; avoids the
		// require() of the original test (which Bun's module loader
		// handles fine but the type checker dislikes).
		const { writeTestRunMarkerRaw } = require("../src/scheduler/test-run-marker") as {
			writeTestRunMarkerRaw: (
				marker: {
					version: number;
					taskId: string;
					taskName: string;
					snapshot: typeof sampleMarkerSnapshot;
					startedAt: number;
					pid: number;
					awaitingFire: boolean;
					expiresAt: number;
					origin: { sessionPath: string };
				},
				baseDir: string,
			) => void;
		};
		const origin = { sessionPath: "/path/from/test/helper.jsonl" };
		writeTestRunMarkerRaw(
			{
				version: 1,
				taskId: sampleMarkerTask.id,
				taskName: sampleMarkerTask.name,
				snapshot: sampleMarkerSnapshot,
				startedAt: Date.now(),
				pid: 12345,
				awaitingFire: true,
				expiresAt: Date.now() + 60_000,
				origin,
			},
			markerBaseDir,
		);
		const marker = readTestRunMarker(markerBaseDir);
		expect(marker!.origin).toEqual(origin);
		expect(marker!.pid).toBe(12345);
	});
});
