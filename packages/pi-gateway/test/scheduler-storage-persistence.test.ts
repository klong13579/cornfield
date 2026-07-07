/**
 * Tests for the agentSessionPath persistence round-trip via
 * JsonFileStorage.
 *
 * The bug: `storage.updateExecution(...)` set agentSessionPath on the
 * in-memory Map, but `appendExecutionLog(...)` did not include it, so
 * a gateway restart between a failed run and the next scheduled
 * trigger lost the path. The next run's `buildCronContextPrefixFromStorage`
 * then silently skipped Tier 3 (which requires a non-null session
 * path). The fix: persist the field in the JSONL log entry and read
 * it back through `getExecutions` so a fresh storage (post-restart)
 * sees the same data.
 *
 * These tests verify the round-trip end-to-end:
 *   - storage #1 records a failed execution with agentSessionPath
 *   - the JSONL log is written with the path
 *   - storage #2 (fresh in-memory) reads it back via getExecutions
 *   - the path is preserved exactly
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendExecutionLog, type ExecutionLogEntry, getLogRoot, setLogRoot } from "../src/scheduler/execution-log";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";

const ORIGINAL_LOG_ROOT = getLogRoot();

let testDir: string;
let jobsPath: string;

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-storage-persist-"));
	jobsPath = path.join(testDir, "jobs.json");
	// Use a logs subdir under the test dir so cleanup is one rm -rf.
	setLogRoot(path.join(testDir, "logs"));
});

afterEach(() => {
	setLogRoot(ORIGINAL_LOG_ROOT);
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

function addTaskToNewStorage(name: string, agentDir: string): { id: string; name: string; agentDir: string } {
	const storage = new JsonFileStorage(jobsPath);
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

describe("JsonFileStorage — agentSessionPath persistence round-trip", () => {
	it("read back from JSONL preserves agentSessionPath after a simulated restart", () => {
		// Storage #1: add task, record execution, append to JSONL
		const sessionPath = "/Users/test/.omp/agent/omp-atomix/sessions/cron_abc123.jsonl";
		const task = addTaskToNewStorage("persist-test", "/tmp/agent-persist");

		{
			const storage1 = new JsonFileStorage(jobsPath);
			const stored = storage1.getTaskByName(task.name);
			expect(stored).toBeDefined();
			const exec = storage1.recordExecution({
				taskId: stored!.id,
				startedAt: Date.now() - 5000,
				status: "running",
			});
			// Mirror the cron-service flow: updateExecution + appendExecutionLog
			// both must record agentSessionPath. The appendExecutionLog call
			// is what we changed — the bug was that the path was not written
			// to the log, so a fresh storage (next test) would not see it.
			storage1.updateExecution(exec.id, {
				endedAt: Date.now(),
				exitCode: 1,
				output: "fail",
				stderr: "tool error",
				status: "failure",
				agentSessionPath: sessionPath,
			});
			// Use the same call shape CronService uses post-fix: pass
			// agentSessionPath via the spread. This is the regression test.
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

		// Storage #2: fresh in-memory state. The only source of
		// agentSessionPath for the previous run is the JSONL log.
		// Pre-fix, the field would be undefined here → Tier 3 silent skip.
		// Post-fix, the field round-trips and Tier 3 can surface the path.
		const storage2 = new JsonFileStorage(jobsPath);
		const stored = storage2.getTaskByName(task.name);
		expect(stored).toBeDefined();
		const execs = storage2.getExecutions(stored!.id);
		expect(execs).toHaveLength(1);
		expect(execs[0]?.agentSessionPath).toBe(sessionPath);
		expect(execs[0]?.status).toBe("failure");
		storage2.close();
	});

	it("legacy entries without agentSessionPath surface as undefined (no synthetic value)", () => {
		// Pre-fix entries lack the field. Reader must not invent a value —
		// that would mask the original bug from operators debugging an
		// upgrade. Tier 3 should skip silently for those rows.
		const task = addTaskToNewStorage("legacy-test", "/tmp/agent-legacy");

		{
			const storage1 = new JsonFileStorage(jobsPath);
			const stored = storage1.getTaskByName(task.name);
			const exec = storage1.recordExecution({
				taskId: stored!.id,
				startedAt: Date.now() - 1000,
				status: "running",
			});
			// Pre-fix path: appendExecutionLog WITHOUT agentSessionPath.
			// Note: omit the field entirely to model a legacy line.
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

		const storage2 = new JsonFileStorage(jobsPath);
		const stored = storage2.getTaskByName(task.name);
		const execs = storage2.getExecutions(stored!.id);
		expect(execs).toHaveLength(1);
		expect(execs[0]?.agentSessionPath).toBeUndefined();
		storage2.close();
	});
});
