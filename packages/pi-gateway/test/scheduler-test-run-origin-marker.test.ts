/**
 * scheduler-test-run-origin-marker.test.ts — round-trip + forward compat
 *
 * Asserts that TestRunMarker can carry an `origin` field and that
 * existing markers (no `origin`) parse correctly. Foundation for
 * B 方案 — cron.test-run result notification to origin LLM.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearTestRunMarker, readTestRunMarker, writeTestRunMarker } from "../src/scheduler/test-run-marker";
import type { ScheduledTask } from "../src/scheduler/types";

const baseDir = path.join(os.tmpdir(), `omp-b-marker-${process.pid}-${Date.now()}`);

const sampleTask: ScheduledTask = {
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

const sampleSnapshot = {
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
		fs.mkdirSync(baseDir, { recursive: true });
	});
	afterEach(() => {
		clearTestRunMarker(baseDir);
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	test("writes origin field when present", () => {
		const origin = { sessionPath: "/Users/test/.omp/agent/sessions/cron_session.jsonl" };
		writeTestRunMarker(sampleTask, sampleSnapshot, Date.now(), baseDir, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 300_000,
			origin,
		});
		const marker = readTestRunMarker(baseDir);
		expect(marker).not.toBeNull();
		expect(marker!.origin).toEqual(origin);
	});

	test("reads legacy marker without origin field (forward compat)", () => {
		// Write a marker JSON that matches the pre-B schema (no `origin`).
		// Simulates a marker left on disk by an older gateway build
		// (before B方案 shipped).
		const legacyMarker = {
			version: 1,
			taskId: sampleTask.id,
			taskName: sampleTask.name,
			snapshot: sampleSnapshot,
			startedAt: Date.now() - 60_000,
			pid: 99999,
			awaitingFire: true,
			expiresAt: Date.now() - 1_000,
		};
		const markerPath = path.join(baseDir, "test-run-restore.json");
		fs.writeFileSync(markerPath, JSON.stringify(legacyMarker), "utf-8");
		const marker = readTestRunMarker(baseDir);
		expect(marker).not.toBeNull();
		expect(marker!.origin).toBeUndefined();
		// Existing fields still parsed correctly
		expect(marker!.pid).toBe(99999);
		expect(marker!.awaitingFire).toBe(true);
	});

	test("origin field is omitted from JSON when undefined (no null pollution)", () => {
		writeTestRunMarker(sampleTask, sampleSnapshot, Date.now(), baseDir, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 300_000,
			// origin intentionally omitted
		});
		const markerPath = path.join(baseDir, "test-run-restore.json");
		const raw = fs.readFileSync(markerPath, "utf-8");
		expect(raw).not.toContain('"origin"');
	});

	test("origin + awaitingFire + expiresAt co-exist (full fire-and-forget shape)", () => {
		const origin = { sessionPath: "/path/to/origin_session.jsonl" };
		writeTestRunMarker(sampleTask, sampleSnapshot, Date.now(), baseDir, process.pid, {
			awaitingFire: true,
			expiresAt: Date.now() + 300_000,
			origin,
		});
		const marker = readTestRunMarker(baseDir);
		expect(marker!.origin).toEqual(origin);
		expect(marker!.awaitingFire).toBe(true);
		expect(marker!.expiresAt).toBeGreaterThan(Date.now());
	});

	test("writeTestRunMarkerRaw (test helper) preserves origin", () => {
		const { writeTestRunMarkerRaw } = require("../src/scheduler/test-run-marker");
		const origin = { sessionPath: "/path/from/test/helper.jsonl" };
		writeTestRunMarkerRaw(
			{
				version: 1,
				taskId: sampleTask.id,
				taskName: sampleTask.name,
				snapshot: sampleSnapshot,
				startedAt: Date.now(),
				pid: 12345,
				awaitingFire: true,
				expiresAt: Date.now() + 60_000,
				origin,
			},
			baseDir,
		);
		const marker = readTestRunMarker(baseDir);
		expect(marker!.origin).toEqual(origin);
		expect(marker!.pid).toBe(12345); // cross-process pid
	});
});
