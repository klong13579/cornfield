/**
 * Unit tests for `buildCronContextPrefixFromStorage`.
 *
 * The function is the I/O-doing entry point used by `onTrigger` to build
 * the cron context prefix with full per-task history. It:
 *   1. Fetches the most recent execution via `storage.getExecutions`.
 *   2. Computes a Tier 1 meta line (status, exit, consecutive failures, delivery error).
 *   3. Optionally adds a Tier 2 last-output block (per `injectLastOutput` config).
 *   4. Optionally adds a Tier 3 tool-calls block (only on failure + non-zero
 *      `injectToolCalls` + present session JSONL).
 *
 * Tests use a minimal in-memory storage mock + real temp files for the
 * OMP session JSONL, so the full path is exercised without needing the
 * gateway running.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCronContextPrefixFromStorage } from "../src/scheduler/cron-service";
import type { ScheduledTask, SchedulerStorage, TaskExecution } from "../src/scheduler/types";

let tempDir = "";

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-prefix-storage-test-"));
});

afterEach(() => {
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// In-memory storage mock — only `getExecutions` is needed by the function
// under test, so the rest can throw to catch accidental misuse.
// ---------------------------------------------------------------------------

function makeStorageMock(executions: TaskExecution[]): SchedulerStorage {
	const store = new Map<string, TaskExecution[]>();
	for (const e of executions) {
		const arr = store.get(e.taskId) ?? [];
		arr.push(e);
		store.set(e.taskId, arr);
	}
	// Sort newest first so getExecutions can return in stable order
	for (const arr of store.values()) {
		arr.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	}
	return {
		addTask: () => {
			throw new Error("not used in tests");
		},
		getTask: () => undefined,
		getTaskByName: () => undefined,
		listTasks: () => [],
		updateTask: () => {},
		deleteTask: () => {},
		recordExecution: exec => ({ ...exec, id: `exec_${Math.random().toString(36).slice(2, 8)}` }),
		updateExecution: () => {},
		getExecutions: (taskId: string, limit?: number) => {
			const arr = store.get(taskId) ?? [];
			return typeof limit === "number" ? arr.slice(0, limit) : arr.slice();
		},
		pruneExecutions: () => 0,
		close: () => {},
	};
}

const baseTask: ScheduledTask = {
	id: "task_abc",
	name: "daily-brief",
	cron: "0 9 * * *",
	command: "summarize today",
	status: "active",
	runCount: 1,
	failCount: 0,
	consecutiveFailures: 0,
};

function makeSessionFile(lines: object[]): string {
	const filePath = path.join(tempDir, `session-${Math.random().toString(36).slice(2, 8)}.jsonl`);
	fs.writeFileSync(filePath, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`, "utf-8");
	return filePath;
}

describe("buildCronContextPrefixFromStorage", () => {
	it("returns the four-rules-only prefix when storage is undefined", () => {
		const out = buildCronContextPrefixFromStorage(baseTask, undefined);
		expect(out).toContain("[CRON-CONTEXT]");
		expect(out).toContain("Task: daily-brief");
		expect(out).toContain("Four rules for this run:");
		expect(out).not.toContain("Last run summary:");
		expect(out).not.toContain("Last run tool calls:");
	});

	it("renders a 'No previous runs.' meta line when storage has no executions", () => {
		const storage = makeStorageMock([]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage);
		expect(out).toContain("No previous runs.");
	});

	it("renders the Tier 1 meta line for a successful last run", () => {
		const now = Date.now();
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 25 * 3600_000,
				endedAt: now - 25 * 3600_000 + 5000,
				exitCode: 0,
				output: "ok",
				status: "success",
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		expect(out).toContain("Last run:");
		expect(out).toContain("Status: ok");
		expect(out).toContain("Exit: 0");
		expect(out).toContain("(1d ago)");
	});

	it("skips the in-flight exec row and uses the previous terminal run", () => {
		// The engine creates the current exec row BEFORE calling onTrigger
		// (engine.ts#runTask: recordExecution at start, then await onTrigger).
		// So at onTrigger time the most recent row IS the in-flight run
		// (status="running", endedAt=undefined). The fix is to filter by
		// `endedAt != null` so we pick up the previous TERMINAL run —
		// otherwise Tier 1 always shows "Status: running" and Tier 2 reads
		// the current run's empty output.
		const now = Date.now();
		const storage = makeStorageMock([
			// Most recent: in-flight current run (engine just created this)
			{
				id: "exec_inflight",
				taskId: "task_abc",
				startedAt: now - 1000,
				// endedAt undefined — current run
				exitCode: undefined,
				output: "",
				status: "running",
			},
			// Previous terminal run from ~65min ago — success
			{
				id: "exec_prev",
				taskId: "task_abc",
				startedAt: now - 65 * 60_000,
				endedAt: now - 65 * 60_000 + 5000,
				exitCode: 0,
				output: "previous brief",
				status: "success",
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		// Should reference the PREVIOUS run, not the in-flight one
		expect(out).toContain("Status: ok");
		expect(out).toContain("Exit: 0");
		expect(out).toContain("(1h ago)");
		expect(out).not.toContain("Status: running");
		// Tier 2 should pull the previous run's output (with injectLastOutput: "always")
		const taskWithTier2: ScheduledTask = { ...baseTask, injectLastOutput: "always" };
		const out2 = buildCronContextPrefixFromStorage(taskWithTier2, storage, { nowMs: () => now });
		expect(out2).toContain("Last run summary:");
		expect(out2).toContain("previous brief");
	});

	it("renders 'No previous runs.' when only the in-flight run exists (very first trigger)", () => {
		// First-ever run: there's no previous terminal exec, only the
		// in-flight one the engine just created. Tier 1 should fall back
		// to the "No previous runs." line, not show the in-flight state.
		const now = Date.now();
		const storage = makeStorageMock([
			{
				id: "exec_inflight",
				taskId: "task_abc",
				startedAt: now,
				// endedAt undefined — current run, no previous
				exitCode: undefined,
				output: "",
				status: "running",
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		expect(out).toContain("No previous runs.");
		expect(out).not.toContain("Status: running");
	});

	it("renders consecutive failures count when the task has been failing", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTask, consecutiveFailures: 3 };
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "",
				status: "failure",
			},
		]);
		const out = buildCronContextPrefixFromStorage(task, storage, { nowMs: () => now });
		expect(out).toContain("Consecutive failures: 3");
	});

	it("renders last delivery error when set", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTask, lastDeliveryError: "channel token expired" };
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 0,
				output: "ok",
				status: "success",
			},
		]);
		const out = buildCronContextPrefixFromStorage(task, storage, { nowMs: () => now });
		expect(out).toContain("Last delivery error: channel token expired");
	});

	// ----- Tier 2 (last output) behavior -----

	it("includes Tier 2 on success when injectLastOutput='always'", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTask, injectLastOutput: "always" };
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 0,
				output: "Yesterday's brief: 12 PRs",
				status: "success",
			},
		]);
		const out = buildCronContextPrefixFromStorage(task, storage, { nowMs: () => now });
		expect(out).toContain("Last run summary:");
		expect(out).toContain("Yesterday's brief: 12 PRs");
	});

	it("omits Tier 2 on success with default 'on_failure' config", () => {
		const now = Date.now();
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 0,
				output: "Yesterday's brief: 12 PRs",
				status: "success",
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		expect(out).not.toContain("Last run summary:");
	});

	it("omits Tier 2 when injectLastOutput='never'", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTask, injectLastOutput: "never" };
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail output",
				status: "failure",
			},
		]);
		const out = buildCronContextPrefixFromStorage(task, storage, { nowMs: () => now });
		expect(out).not.toContain("Last run summary:");
	});

	it("includes Tier 2 on failure with default config (on_failure)", () => {
		const now = Date.now();
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail output",
				status: "failure",
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		expect(out).toContain("Last run summary:");
		expect(out).toContain("fail output");
	});

	it("omits both Tier 2 and Tier 3 when injectFailureContext=false", () => {
		const now = Date.now();
		const sessionPath = makeSessionFile([
			{ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "ls" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "result" }],
				},
			},
		]);
		const task: ScheduledTask = { ...baseTask, injectFailureContext: false };
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail output",
				status: "failure",
				agentSessionPath: sessionPath,
			},
		]);
		const out = buildCronContextPrefixFromStorage(task, storage, { nowMs: () => now });
		expect(out).not.toContain("Last run summary:");
		expect(out).not.toContain("Last run tool calls:");
	});

	it("truncates Tier 2 output longer than 6000 chars with a visible marker", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTask, injectLastOutput: "always" };
		const longOutput = "x".repeat(8000);
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 0,
				output: longOutput,
				status: "success",
			},
		]);
		const out = buildCronContextPrefixFromStorage(task, storage, { nowMs: () => now });
		expect(out).toContain("[...truncated");
		expect(out).toContain("original was 8000 chars");
		// The full long string must NOT be in the output
		expect(out.includes(longOutput)).toBe(false);
	});

	// ----- Tier 3 (last tool calls) behavior -----

	it("includes Tier 3 on failure with default injectToolCalls=10", () => {
		const now = Date.now();
		const sessionPath = makeSessionFile([
			{ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "ls" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "" }],
					details: { stderr: "command failed" },
				},
			},
		]);
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail",
				status: "failure",
				agentSessionPath: sessionPath,
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		expect(out).toContain("Last run tool calls:");
		expect(out).toContain("[tool: bash]");
		expect(out).toContain("[ERROR]");
	});

	it("omits Tier 3 on success even when agentSessionPath is present", () => {
		const now = Date.now();
		const sessionPath = makeSessionFile([
			{ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "ok" }],
				},
			},
		]);
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 0,
				output: "ok",
				status: "success",
				agentSessionPath: sessionPath,
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		expect(out).not.toContain("Last run tool calls:");
	});

	it("omits Tier 3 when injectToolCalls=0", () => {
		const now = Date.now();
		const sessionPath = makeSessionFile([
			{ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "fail" }],
				},
			},
		]);
		const task: ScheduledTask = { ...baseTask, injectToolCalls: 0 };
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail",
				status: "failure",
				agentSessionPath: sessionPath,
			},
		]);
		const out = buildCronContextPrefixFromStorage(task, storage, { nowMs: () => now });
		expect(out).not.toContain("Last run tool calls:");
	});

	it("omits Tier 3 gracefully when agentSessionPath is undefined", () => {
		const now = Date.now();
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail",
				status: "failure",
				// agentSessionPath: undefined
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		expect(out).not.toContain("Last run tool calls:");
		// Should not throw
	});

	it("omits Tier 3 gracefully when agentSessionPath points to a missing file", () => {
		const now = Date.now();
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail",
				status: "failure",
				agentSessionPath: path.join(tempDir, "does-not-exist.jsonl"),
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		expect(out).not.toContain("Last run tool calls:");
		// Should not throw
	});

	it("respects custom injectToolCalls limit (only 2 of 5 tool calls appear)", () => {
		const now = Date.now();
		const lines: object[] = [];
		for (let i = 0; i < 5; i++) {
			lines.push({ type: "tool_execution_start", toolCallId: `tc${i}`, toolName: "bash", args: { i } });
			lines.push({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: `tc${i}`,
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: `result-${i}` }],
				},
			});
		}
		const sessionPath = makeSessionFile(lines);
		const task: ScheduledTask = { ...baseTask, injectToolCalls: 2 };
		const storage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail",
				status: "failure",
				agentSessionPath: sessionPath,
			},
		]);
		const out = buildCronContextPrefixFromStorage(task, storage, { nowMs: () => now });
		expect(out).toContain("result-3");
		expect(out).toContain("result-4");
		expect(out).not.toContain("result-0");
		expect(out).not.toContain("result-1");
		expect(out).not.toContain("result-2");
	});

	// ----- Tier 3 error-priority selection -----

	/** Build a JSONL session with N tool calls, alternating error/success starting from a given offset. */
	function buildMixedSession(total: number, errorIndices: Set<number>): object[] {
		const lines: object[] = [];
		for (let i = 0; i < total; i++) {
			const isError = errorIndices.has(i);
			const tag = isError ? "err" : "ok";
			lines.push({ type: "tool_execution_start", toolCallId: `tc${i}`, toolName: "bash", args: { i } });
			lines.push({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: `tc${i}`,
					toolName: "bash",
					isError,
					content: [{ type: "text", text: `r${i}-${tag}` }],
				},
			});
		}
		return lines;
	}

	function failureExecWithSession(sessionPath: string, startedAt: number): TaskExecution {
		return {
			id: "exec_1",
			taskId: "task_abc",
			startedAt: startedAt - 1000,
			endedAt: startedAt - 500,
			exitCode: 1,
			output: "fail",
			status: "failure",
			agentSessionPath: sessionPath,
		};
	}

	it("Tier 3 error-priority: 3 errors + 7 successes, limit 10 → all 10, no truncation header", () => {
		const now = Date.now();
		const errorIndices = new Set([1, 5, 8]); // tc1, tc5, tc8 are errors
		const sessionPath = makeSessionFile(buildMixedSession(10, errorIndices));
		const storage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		// All 10 should appear
		for (let i = 0; i < 10; i++) expect(out).toContain(`r${i}-`);
		// Errors preserved (3 of them)
		expect(out).toContain("r1-err");
		expect(out).toContain("r5-err");
		expect(out).toContain("r8-err");
		// Successes preserved (7 of them)
		expect(out).toContain("r0-ok");
		expect(out).toContain("r9-ok");
		// No truncation header since 10 of 10 shown
		expect(out).not.toContain("earlier calls dropped");
		expect(out).toContain("Last run tool calls (10 calls):");
	});

	it("Tier 3 error-priority: 20 errors + 5 successes, limit 10 → 10 most recent errors only", () => {
		const now = Date.now();
		// errors at tc0..tc19, successes at tc20..tc24
		const errorIndices = new Set(Array.from({ length: 20 }, (_, i) => i));
		const sessionPath = makeSessionFile(buildMixedSession(25, errorIndices));
		const storage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		// 10 most recent errors: tc10..tc19 (errors are at the front of the
		// chronological list, so the last 10 errors are tc10..tc19)
		for (let i = 10; i < 20; i++) expect(out).toContain(`r${i}-err`);
		// Earlier errors dropped (tc0..tc9)
		for (let i = 0; i < 10; i++) expect(out).not.toContain(`r${i}-err`);
		// No successes selected (quota fully used by errors)
		for (let i = 20; i < 25; i++) expect(out).not.toContain(`r${i}-ok`);
		// Truncation header: 15 dropped (10 earlier errors + 5 successes), 10 of them errors
		expect(out).toContain("Last run tool calls (10 of 25 shown — 15 earlier calls dropped, 10 of them errors):");
	});

	it("Tier 3 error-priority: 3 errors + 50 successes, limit 10 → 3 errors + 7 most recent successes", () => {
		const now = Date.now();
		const errorIndices = new Set([10, 25, 40]); // 3 errors among 53 calls
		const sessionPath = makeSessionFile(buildMixedSession(53, errorIndices));
		const storage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		// All 3 errors preserved
		expect(out).toContain("r10-err");
		expect(out).toContain("r25-err");
		expect(out).toContain("r40-err");
		// 7 most recent successes: tc46..tc52 (excluding the 3 error positions and earlier)
		// 53 calls total, 3 are errors at indices 10, 25, 40.
		// Last 10 calls chronologically: tc43..tc52 = [43,44,45,46,47,48,49,50,51,52]
		// After removing the 1 error in that range (tc40 is BEFORE 43, so actually 0 errors in 43-52)
		// → 7 most recent successes from tail end: tc46..tc52 (7 of the 10 latest)
		// Wait, that's wrong. Let me re-derive:
		// errorSlots = min(3, 10) = 3 → take errors[last 3] = [tc10, tc25, tc40]
		// successSlots = 10 - 3 = 7 → take successes[last 7]
		// The last 7 successes chronologically: tc50, tc51, tc52 + the ones just before
		// Actually need to count: indices 0..52, errors at 10, 25, 40 → successes at 0-9, 11-24, 26-39, 41-52
		// Last 7 successes = tc46, 47, 48, 49, 50, 51, 52
		for (let i = 46; i <= 52; i++) expect(out).toContain(`r${i}-ok`);
		// Earlier successes dropped
		for (let i = 0; i < 46; i++) {
			if (i === 10) continue; // error, not success
			if (i === 25) continue;
			if (i === 40) continue;
			expect(out).not.toContain(`r${i}-ok`);
		}
		// Truncation header
		expect(out).toContain("Last run tool calls (10 of 53 shown — 43 earlier calls dropped, 0 of them errors):");
	});

	it("Tier 3 error-priority: 0 errors + 10 successes, limit 10 → no truncation header", () => {
		const now = Date.now();
		const errorIndices = new Set<number>();
		const sessionPath = makeSessionFile(buildMixedSession(10, errorIndices));
		const storage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		for (let i = 0; i < 10; i++) expect(out).toContain(`r${i}-ok`);
		expect(out).not.toContain("earlier calls dropped");
		expect(out).toContain("Last run tool calls (10 calls):");
	});

	it("Tier 3 error-priority: 0 errors + 50 successes, limit 10 → 10 most recent successes, no error count in header", () => {
		const now = Date.now();
		const errorIndices = new Set<number>();
		const sessionPath = makeSessionFile(buildMixedSession(50, errorIndices));
		const storage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		// Last 10 successes: tc40..tc49
		for (let i = 40; i < 50; i++) expect(out).toContain(`r${i}-ok`);
		for (let i = 0; i < 40; i++) expect(out).not.toContain(`r${i}-ok`);
		// Header: 40 earlier calls dropped, 0 of them errors
		expect(out).toContain("Last run tool calls (10 of 50 shown — 40 earlier calls dropped, 0 of them errors):");
	});

	it("Tier 3 error-priority: respects the original chronological order within each bucket", () => {
		// Errors at indices 2, 5, 8 (chronological order). Limit=10.
		// Expected: errors shown in order [r2-err, r5-err, r8-err] then 7 most recent successes
		// (tc9, 10, 11, ..., 15 → 7 calls).
		const now = Date.now();
		const errorIndices = new Set([2, 5, 8]);
		const sessionPath = makeSessionFile(buildMixedSession(16, errorIndices));
		const storage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTask, storage, { nowMs: () => now });
		const error1 = out.indexOf("r2-err");
		const error2 = out.indexOf("r5-err");
		const error3 = out.indexOf("r8-err");
		expect(error1).toBeGreaterThan(-1);
		expect(error2).toBeGreaterThan(error1);
		expect(error3).toBeGreaterThan(error2);
	});
});
