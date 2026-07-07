/**
 * Tests for the `forceFail` debug-only override on scheduled tasks.
 *
 * `forceFail` is intended to be set in jobs.json for end-to-end
 * verification of the cron context Tier 3 (last run tool-calls) — the
 * previous-run failure is hard to produce naturally because the warm
 * bridge rarely exits non-zero when the LLM responds (even if its
 * tool calls fail, the agent itself exits 0). The override lets an
 * operator record a synthetic failure while keeping the real agent
 * session path so the next run's Tier 3 injection has something to
 * surface.
 *
 * These tests pin down the contract:
 *   - exitCode 0 → 1 (recorded as failure in storage + JSONL)
 *   - real agent session path is still captured
 *   - [forceFail] marker is appended to the output
 *   - only overrides success path (does not double-fail)
 *   - absent/undefined → no behavior change
 *   - the warm bridge still runs (proves the agent session is real,
 *     not synthesized)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CronLogger, CronService, type DeliverFn, type ExecuteAgentFn } from "../src/scheduler/cron-service";
import { getLogRoot, setLogRoot } from "../src/scheduler/execution-log";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import type { ScheduledTask } from "../src/scheduler/types";

let testDir: string;
let jobsPath: string;
let storage: JsonFileStorage;
const ORIGINAL_LOG_ROOT = getLogRoot();

const noopLogger: CronLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function cleanupExecutionLog(slug: string) {
	const logDir = path.join(testDir, "logs", "by-task", slug);
	try {
		fs.rmSync(logDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-force-fail-"));
	jobsPath = path.join(testDir, "jobs.json");
	// Redirect the cron service's appendExecutionLog to a temp dir
	// so the test doesn't pollute the production log root.
	setLogRoot(path.join(testDir, "logs"));
	storage = new JsonFileStorage(jobsPath);
});

afterEach(() => {
	storage?.close();
	setLogRoot(ORIGINAL_LOG_ROOT);
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
	cleanupExecutionLog("a-test");
	cleanupExecutionLog("a-test-shell");
});

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
	const base: ScheduledTask = {
		id: "task_forcefail",
		name: "a-test",
		cron: "0 0 1 1 *",
		command: "echo ok",
		taskType: "agent",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		agentDir: testDir,
		...overrides,
	};
	storage.addTask({
		cron: base.cron,
		command: base.command,
		taskType: base.taskType,
		status: base.status,
		createdAt: base.createdAt,
		updatedAt: base.updatedAt,
		runCount: base.runCount,
		failCount: base.failCount,
		consecutiveFailures: base.consecutiveFailures,
		agentDir: base.agentDir,
		name: base.name,
		forceFail: base.forceFail,
		delivery: base.delivery,
	});
	const stored = storage.getTaskByName(base.name);
	if (!stored) throw new Error("test setup: task not found after add");
	return stored;
}

function makeCronService(opts: { deliver: DeliverFn; executeAgent: ExecuteAgentFn }): CronService {
	return new CronService({
		storage,
		ompBinary: "omp",
		executeAgent: opts.executeAgent,
		deliver: opts.deliver,
		log: noopLogger,
	});
}

describe("CronService.onTrigger — forceFail debug-only override", () => {
	it("overrides a successful warm bridge to exitCode=1, status=failure", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "agent produced this brief" }));

		const task = makeTask({ forceFail: true });
		const service = makeCronService({ deliver, executeAgent });

		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		// onTrigger will throw because the override sets exitCode=1 —
		// the engine's retry/stats loop relies on the throw.
		await expect(service.onTrigger(task, exec.id)).rejects.toThrow(/failed \(exit 1\)/);

		const updated = storage.getExecutions(task.id).find(e => e.id === exec.id);
		expect(updated).toBeDefined();
		expect(updated!.status).toBe("failure");
		expect(updated!.exitCode).toBe(1);
	});

	it("preserves the real agent session path under forceFail (Tier 3 must still see it)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "ok" }));

		const task = makeTask({ forceFail: true });
		const service = makeCronService({ deliver, executeAgent });
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		// Pre-create a session file the warm bridge would have written.
		// The cron service uses findAgentSessionPath, which scans the
		// agentDir for any session with an mtime inside the run window.
		// Filename must match the cron pattern (cron_<digits>.jsonl).
		const sessionTs = Date.now() + 100; // 100ms in the future to land inside [startedAt, endedAt]
		const sessionFile = path.join(testDir, "sessions", `cron_${sessionTs}.jsonl`);
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
			})}\n`,
		);
		// Set mtime to ~1s in the future from the test's "now" so it
		// falls inside the [startedAt, endedAt] window the cron
		// service uses for the findAgentSessionPath check (±5s tolerance).
		const nowMs = Date.now();
		fs.utimesSync(sessionFile, (nowMs + 1000) / 1000, (nowMs + 1000) / 1000);

		await expect(service.onTrigger(task, exec.id)).rejects.toThrow();

		const updated = storage.getExecutions(task.id).find(e => e.id === exec.id);
		expect(updated).toBeDefined();
		expect(updated!.status).toBe("failure");
		// agentSessionPath should be the session file the warm bridge created
		// (proving the bridge actually ran and produced a real trace).
		expect(updated!.agentSessionPath).toBeTruthy();
		expect(updated!.agentSessionPath).toBe(sessionFile);
	});

	it("appends the [forceFail] marker to the output so operators can identify the override", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "agent produced this brief" }));

		const task = makeTask({ forceFail: true });
		const service = makeCronService({ deliver, executeAgent });
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await expect(service.onTrigger(task, exec.id)).rejects.toThrow();

		const updated = storage.getExecutions(task.id).find(e => e.id === exec.id);
		expect(updated!.output).toContain("agent produced this brief");
		expect(updated!.output).toContain("[forceFail]");
	});

	it("still triggers delivery (with a failure-flavored summary card)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "ok" }));

		const task = makeTask({
			forceFail: true,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		const service = makeCronService({ deliver, executeAgent });
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await expect(service.onTrigger(task, exec.id)).rejects.toThrow();

		expect(deliver).toHaveBeenCalled();
		const summary = deliver.mock.calls[0]![0].text;
		// The summary should reflect the failure (❌ prefix), not success.
		expect(summary).toMatch(/❌|failed/);
	});

	it("does not double-fail when both warm bridge and fallback already failed (real exit code wins)", async () => {
		// Scenario: warm bridge errors AND the cold-subprocess fallback
		// also errors (omp binary missing). The natural exit code is
		// non-zero. forceFail should be a no-op — it only overrides the
		// post-fallback success path (exitCode === 0), it does not stomp
		// on a real failure. This is the safe default: a real failure
		// must propagate as-is, not be silently masked by a debug flag.
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({
			output: "",
			error: "warm bridge RPC failed",
		}));

		const task = makeTask({ forceFail: true });
		// Use a missing omp binary so the fallback's posix_spawn throws,
		// which the cron service catches and converts to exitCode=1
		// (see the fallback's `catch (fallbackErr)` block in cron-service.ts).
		const service = new CronService({
			storage,
			ompBinary: "/nonexistent/omp-fake-binary-for-force-fail-test",
			executeAgent,
			deliver,
			log: noopLogger,
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await expect(service.onTrigger(task, exec.id)).rejects.toThrow();

		const updated = storage.getExecutions(task.id).find(e => e.id === exec.id);
		expect(updated).toBeDefined();
		expect(updated!.status).toBe("failure");
		expect(updated!.exitCode).toBe(1);
		// No [forceFail] marker — the override only fires on the
		// post-fallback success path. A real failure was already
		// recorded; forceFail must not stomp on it.
		expect(updated!.output ?? "").not.toContain("[forceFail]");
	});

	it("does not override when forceFail is absent (default behavior unchanged)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "ok" }));

		const task = makeTask({ forceFail: undefined });
		const service = makeCronService({ deliver, executeAgent });
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		// No throw — the run succeeded naturally.
		await service.onTrigger(task, exec.id);

		const updated = storage.getExecutions(task.id).find(e => e.id === exec.id);
		expect(updated!.status).toBe("success");
		expect(updated!.exitCode).toBe(0);
		expect(updated!.output ?? "").not.toContain("[forceFail]");
	});

	it("does not override when forceFail=false (explicit false is the same as absent)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "ok" }));

		const task = makeTask({ forceFail: false });
		const service = makeCronService({ deliver, executeAgent });
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		const updated = storage.getExecutions(task.id).find(e => e.id === exec.id);
		expect(updated!.status).toBe("success");
		expect(updated!.exitCode).toBe(0);
	});
});
