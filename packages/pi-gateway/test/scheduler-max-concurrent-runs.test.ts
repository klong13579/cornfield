/**
 * Contract test: scheduler maxConcurrentRuns limit.
 *
 * Contract: When maxConcurrentRuns is set to 1, the scheduler MUST NOT
 * run more than 1 task execution concurrently. If a trigger fires while
 * an execution is in-flight, it MUST be skipped.
 *
 * This test exists because maxConcurrentRuns was defined in config and
 * passed to EngineOptions, but SchedulerEngine's constructor ignored
 * options.config entirely — no concurrency tracking existed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SchedulerEngine } from "../src/scheduler/engine";
import { SchedulerDbStorage } from "../src/scheduler/storage";

describe("scheduler maxConcurrentRuns", () => {
	let testDir: string;
	let storage: SchedulerDbStorage;
	let engine: SchedulerEngine;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-concurrency-"));
		storage = new SchedulerDbStorage(path.join(testDir, "scheduler.db"));
	});

	afterEach(() => {
		engine?.stop();
		storage?.close();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	test("skips trigger when maxConcurrentRuns is reached", async () => {
		let activeCount = 0;
		let maxConcurrent = 0;

		storage.addTask({
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
			storage,
			onTrigger: async (_task, execId) => {
				activeCount++;
				maxConcurrent = Math.max(maxConcurrent, activeCount);
				// Simulate slow execution (longer than the 100ms interval)
				await Bun.sleep(500);
				activeCount--;
				storage.updateExecution(execId, {
					status: "success",
					endedAt: Date.now(),
				});
			},
			config: {
				enabled: true,
				taskDir: testDir,
				maxConcurrentRuns: 1,
			},
		});

		engine.start();

		// Let the interval fire multiple times while the first execution
		// is still running. 100ms interval × 1.5s = ~15 triggers, but only
		// 1 should run at a time if maxConcurrentRuns is respected.
		await Bun.sleep(1500);
		engine.stop();

		// Assert: no more than 1 execution was ever in-flight simultaneously.
		// If the bug exists (maxConcurrentRuns ignored), maxConcurrent will
		// be > 1 because setInterval fires every 100ms regardless of whether
		// the previous handler is still running.
		expect(maxConcurrent).toBe(1);
	});
});
