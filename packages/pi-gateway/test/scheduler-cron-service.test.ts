/**
 * Scheduler cron service tests.
 *
 *   - `scheduler-cron-context-prefix.test.ts` — buildCronContextPrefix
 *     formatting: tiered header, "four rules", [SILENT], markdown hint.
 *   - `scheduler-cron-context-prefix-from-storage.test.ts` — the
 *     I/O-doing buildCronContextPrefixFromStorage: in-flight exec
 *     filter, Tier 1/2/3 selection, error-priority, truncation.
 *   - `scheduler-cron-failure-notify.test.ts` — resolveDelivery
 *     agentDir-based lookup, CronService.onTrigger notifyFailure
 *     on executeAgent error / delivery failure / exit code.
 *   - `scheduler-cron-force-fail.test.ts` — forceFail debug override:
 *     exit 0→1, preserves real agent session, [forceFail] marker.
 *   - `scheduler-outbound-delivery-smoke.test.ts` — delivery routing,
 *     [SILENT] suppression, structured `delivery` field round-trip.
 *
 * All test the cron service / cron prefix / cron delivery — the
 * one-stop surface between the scheduler engine and the channel
 * layer. Co-located here.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCronContextPrefix,
	buildCronContextPrefixFromStorage,
	type CronLogger,
	CronService,
	type DeliverFn,
	type ExecuteAgentFn,
	type MirrorToSessionFn,
	type NotifyCronFailureFn,
	type ResolveAccountIdFn,
	resolveDelivery,
} from "../src/scheduler/cron-service";
import { getLogRoot, setLogRoot } from "../src/scheduler/execution-log";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import type { ScheduledTask, SchedulerStorage, TaskExecution } from "../src/scheduler/types";

let testDir: string;
let dbPath: string;
let storage: JsonFileStorage;

const noopLogger: CronLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function cleanupExecutionLog(slug: string) {
	const logDir = path.join(os.homedir(), ".omp", "gateway-data", "scheduler", "logs", "by-task", slug);
	try {
		fs.rmSync(logDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

beforeEach(() => {
	testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gateway-cron-svc-"));
	dbPath = path.join(testDir, "jobs.json");
	storage = new JsonFileStorage(dbPath);
});

afterEach(() => {
	storage?.close();
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
	// Tidy execution logs from various tests below.
	for (const slug of [
		"_t_fail_resolveAccountId",
		"_t_fail_legacy_resolveAccountId",
		"_t_fail_executeAgent",
		"_t_fail_timedOut",
		"_t_fail_exitCode",
		"_t_fail_delivery",
		"a-test",
		"a-test-shell",
		"_t_smoke_roundtrip",
		"_t_smoke_legacy",
		"_t_smoke_deliver",
		"_t_smoke_nodeliver",
		"_t_smoke_silent",
	]) {
		cleanupExecutionLog(slug);
	}
});

// ===========================================================================
// buildCronContextPrefix (pure: format only)
// ===========================================================================

const baseTask: ScheduledTask = {
	id: "task_test",
	name: "test",
	cron: "0 12 * * *",
	command: "do the thing",
	status: "active",
	runCount: 0,
	failCount: 0,
};

describe("buildCronContextPrefix", () => {
	it("marks the run as cron and names the agent", () => {
		const task: ScheduledTask = { ...baseTask, agentDir: "/tmp/agents/hr3" };
		const out = buildCronContextPrefix(task);
		expect(out).toStartWith("[CRON-CONTEXT]");
		expect(out).toContain("hr3");
	});

	it("explicitly forbids the `cron` host tool and names the disabled toolset", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("`cron` host tool");
		expect(out).toContain("cronjob");
	});

	it("forbids proactive messaging tools and names concrete examples", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("messaging");
		expect(out).toContain("dws chat message send");
		expect(out).toContain("chat_post");
	});

	it("states that the reply text IS the delivery (the anti-ambiguity rule)", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("reply text IS the delivery");
		expect(out).toMatch(/just write your answer in the reply body/i);
		expect(out).toMatch(/发给用户|send to user|notify/i);
	});

	it("Rule 3 mentions markdown formatting so the agent writes card-friendly output", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("##");
		expect(out).toContain("headings");
		expect(out).toContain("bullets");
		expect(out).toContain("fenced code blocks");
		expect(out).toContain("`inline code`");
	});

	it("does NOT contain the old ambiguous wording", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).not.toContain("Do not create new cron jobs or send messages");
	});

	it("teaches the agent about [SILENT] to suppress delivery when there's nothing to report", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("[SILENT]");
		expect(out).toContain("nothing new to report");
		expect(out).toContain("suppresses delivery");
		expect(out).toContain("Never combine [SILENT] with other content");
	});

	it("uses agentDir basename when present, falls back to accountId", () => {
		const withAgentDir: ScheduledTask = { ...baseTask, agentDir: "/var/data/agents/alpha" };
		expect(buildCronContextPrefix(withAgentDir)).toContain("alpha");
		const withAccount: ScheduledTask = { ...baseTask, accountId: "ops" };
		expect(buildCronContextPrefix(withAccount)).toContain("ops");
	});

	it("includes the task name and schedule in the header", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("Task: test");
		expect(out).toContain("Schedule: 0 12 * * *");
		expect(out).toContain("Type: agent");
	});

	it("emits the metaLine when provided", () => {
		const out = buildCronContextPrefix(baseTask, { metaLine: "Last run: 2026-07-05 09:00 (24h ago)  Status: ok" });
		expect(out).toContain("Last run: 2026-07-05 09:00 (24h ago)  Status: ok");
	});

	it("emits the Tier 2 last-output block when provided", () => {
		const out = buildCronContextPrefix(baseTask, { lastOutput: "Yesterday's brief: 12 PRs, 3 merged." });
		expect(out).toContain("Last run summary:");
		expect(out).toContain("Yesterday's brief: 12 PRs, 3 merged.");
	});

	it("emits the Tier 3 tool-calls block when provided", () => {
		const calls = '[tool: bash] {"command":"ls"} → "file1"';
		const out = buildCronContextPrefix(baseTask, { lastToolCalls: calls });
		expect(out).toContain("Last run tool calls:");
		expect(out).toContain(calls);
	});

	it("emits all three tiers in the order meta → output → toolCalls", () => {
		const out = buildCronContextPrefix(baseTask, {
			metaLine: "META",
			lastOutput: "OUTPUT",
			lastToolCalls: "TOOLCALLS",
		});
		const metaIdx = out.indexOf("META");
		const outputIdx = out.indexOf("OUTPUT");
		const toolsIdx = out.indexOf("TOOLCALLS");
		const rulesIdx = out.indexOf("Four rules for this run:");
		expect(metaIdx).toBeGreaterThan(-1);
		expect(outputIdx).toBeGreaterThan(metaIdx);
		expect(toolsIdx).toBeGreaterThan(outputIdx);
		expect(rulesIdx).toBeGreaterThan(toolsIdx);
	});

	it("places a '---' separator between context and the four rules", () => {
		const out = buildCronContextPrefix(baseTask, { metaLine: "META" });
		const sepIdx = out.indexOf("---");
		const rulesIdx = out.indexOf("Four rules for this run:");
		expect(sepIdx).toBeGreaterThan(-1);
		expect(rulesIdx).toBeGreaterThan(sepIdx);
	});

	it("with no context, output still contains the four rules and the header", () => {
		const out = buildCronContextPrefix(baseTask);
		expect(out).toContain("[CRON-CONTEXT]");
		expect(out).toContain("Task: test");
		expect(out).toContain("Four rules for this run:");
		expect(out).toContain("`cron` host tool");
		expect(out).toContain("[SILENT]");
	});
});

// ===========================================================================
// buildCronContextPrefixFromStorage (I/O: per-task history lookup)
// ===========================================================================

let tempDirCpf = "";

beforeEach(() => {
	tempDirCpf = fs.mkdtempSync(path.join(os.tmpdir(), "cron-prefix-storage-test-"));
});

afterEach(() => {
	if (tempDirCpf) fs.rmSync(tempDirCpf, { recursive: true, force: true });
});

// In-memory storage mock — only `getExecutions` is needed.
function makeStorageMock(executions: TaskExecution[]): SchedulerStorage {
	const store = new Map<string, TaskExecution[]>();
	for (const e of executions) {
		const arr = store.get(e.taskId) ?? [];
		arr.push(e);
		store.set(e.taskId, arr);
	}
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
		getRecentExecutions: (query: { limit?: number; taskName?: string; sinceMs?: number } = {}) => {
			const all: Array<TaskExecution & { taskName: string }> = [];
			for (const arr of store.values()) {
				for (const e of arr) {
					if (query.sinceMs !== undefined && e.startedAt < query.sinceMs) continue;
					all.push({ ...e, taskName: "mock-task" });
				}
			}
			all.sort((a, b) => b.startedAt - a.startedAt);
			const limit = Number.isFinite(query.limit) && query.limit! > 0 ? Math.floor(query.limit!) : 5;
			return all.slice(0, limit);
		},
		pruneExecutions: () => 0,
		close: () => {},
	};
}

const baseTaskCpf: ScheduledTask = {
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
	const filePath = path.join(tempDirCpf, `session-${Math.random().toString(36).slice(2, 8)}.jsonl`);
	fs.writeFileSync(filePath, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`, "utf-8");
	return filePath;
}

describe("buildCronContextPrefixFromStorage", () => {
	it("returns the four-rules-only prefix when storage is undefined", () => {
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, undefined);
		expect(out).toContain("[CRON-CONTEXT]");
		expect(out).toContain("Task: daily-brief");
		expect(out).toContain("Four rules for this run:");
		expect(out).not.toContain("Last run summary:");
		expect(out).not.toContain("Last run tool calls:");
	});

	it("renders a 'No previous runs.' meta line when storage has no executions", () => {
		const mockStorage = makeStorageMock([]);
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage);
		expect(out).toContain("No previous runs.");
	});

	it("renders the Tier 1 meta line for a successful last run", () => {
		const now = Date.now();
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
		expect(out).toContain("Last run:");
		expect(out).toContain("Status: ok");
		expect(out).toContain("Exit: 0");
		expect(out).toContain("(1d ago)");
	});

	it("skips the in-flight exec row and uses the previous terminal run", () => {
		const now = Date.now();
		const mockStorage = makeStorageMock([
			{
				id: "exec_inflight",
				taskId: "task_abc",
				startedAt: now - 1000,
				exitCode: undefined,
				output: "",
				status: "running",
			},
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
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
		expect(out).toContain("Status: ok");
		expect(out).toContain("Exit: 0");
		expect(out).toContain("(1h ago)");
		expect(out).not.toContain("Status: running");
		const taskWithTier2: ScheduledTask = { ...baseTaskCpf, injectLastOutput: "always" };
		const out2 = buildCronContextPrefixFromStorage(taskWithTier2, mockStorage, { nowMs: () => now });
		expect(out2).toContain("Last run summary:");
		expect(out2).toContain("previous brief");
	});

	it("renders 'No previous runs.' when only the in-flight run exists (very first trigger)", () => {
		const now = Date.now();
		const mockStorage = makeStorageMock([
			{
				id: "exec_inflight",
				taskId: "task_abc",
				startedAt: now,
				exitCode: undefined,
				output: "",
				status: "running",
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
		expect(out).toContain("No previous runs.");
		expect(out).not.toContain("Status: running");
	});

	it("renders consecutive failures count when the task has been failing", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTaskCpf, consecutiveFailures: 3 };
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(task, mockStorage, { nowMs: () => now });
		expect(out).toContain("Consecutive failures: 3");
	});

	it("renders last delivery error when set", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTaskCpf, lastDeliveryError: "channel token expired" };
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(task, mockStorage, { nowMs: () => now });
		expect(out).toContain("Last delivery error: channel token expired");
	});

	it("includes Tier 2 on success when injectLastOutput='always'", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTaskCpf, injectLastOutput: "always" };
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(task, mockStorage, { nowMs: () => now });
		expect(out).toContain("Last run summary:");
		expect(out).toContain("Yesterday's brief: 12 PRs");
	});

	it("omits Tier 2 on success with default 'on_failure' config", () => {
		const now = Date.now();
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
		expect(out).not.toContain("Last run summary:");
	});

	it("omits Tier 2 when injectLastOutput='never'", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTaskCpf, injectLastOutput: "never" };
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(task, mockStorage, { nowMs: () => now });
		expect(out).not.toContain("Last run summary:");
	});

	it("includes Tier 2 on failure with default config (on_failure)", () => {
		const now = Date.now();
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
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
		const task: ScheduledTask = { ...baseTaskCpf, injectFailureContext: false };
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(task, mockStorage, { nowMs: () => now });
		expect(out).not.toContain("Last run summary:");
		expect(out).not.toContain("Last run tool calls:");
	});

	it("truncates Tier 2 output longer than 6000 chars with a visible marker", () => {
		const now = Date.now();
		const task: ScheduledTask = { ...baseTaskCpf, injectLastOutput: "always" };
		const longOutput = "x".repeat(8000);
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(task, mockStorage, { nowMs: () => now });
		expect(out).toContain("[...truncated");
		expect(out).toContain("original was 8000 chars");
		expect(out.includes(longOutput)).toBe(false);
	});

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
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
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
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
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
		const task: ScheduledTask = { ...baseTaskCpf, injectToolCalls: 0 };
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(task, mockStorage, { nowMs: () => now });
		expect(out).not.toContain("Last run tool calls:");
	});

	it("omits Tier 3 gracefully when agentSessionPath is undefined or missing", () => {
		const now = Date.now();
		const mockStorage = makeStorageMock([
			{
				id: "exec_1",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail",
				status: "failure",
			},
		]);
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
		expect(out).not.toContain("Last run tool calls:");

		// Also when the file is missing
		const mockStorage2 = makeStorageMock([
			{
				id: "exec_2",
				taskId: "task_abc",
				startedAt: now - 1000,
				endedAt: now - 500,
				exitCode: 1,
				output: "fail",
				status: "failure",
				agentSessionPath: path.join(tempDirCpf, "does-not-exist.jsonl"),
			},
		]);
		const out2 = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage2, { nowMs: () => now });
		expect(out2).not.toContain("Last run tool calls:");
	});

	it("respects custom injectToolCalls limit (only N of M tool calls appear)", () => {
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
		const task: ScheduledTask = { ...baseTaskCpf, injectToolCalls: 2 };
		const mockStorage = makeStorageMock([
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
		const out = buildCronContextPrefixFromStorage(task, mockStorage, { nowMs: () => now });
		// With error-priority, the most recent 2 errors (the only 2 of 5)
		// are selected: tc3 + tc4.
		expect(out).toContain("result-3");
		expect(out).toContain("result-4");
	});

	// Error-priority selection tests
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

	it("Tier 3 error-priority: 3 errors + 7 successes, limit 10 → all 10", () => {
		const now = Date.now();
		const errorIndices = new Set([1, 5, 8]);
		const sessionPath = makeSessionFile(buildMixedSession(10, errorIndices));
		const mockStorage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
		for (let i = 0; i < 10; i++) expect(out).toContain(`r${i}-`);
		expect(out).toContain("r1-err");
		expect(out).toContain("r5-err");
		expect(out).toContain("r8-err");
		expect(out).not.toContain("earlier calls dropped");
		expect(out).toContain("Last run tool calls (10 calls):");
	});

	it("Tier 3 error-priority: 20 errors + 5 successes, limit 10 → 10 most recent errors only", () => {
		const now = Date.now();
		const errorIndices = new Set(Array.from({ length: 20 }, (_, i) => i));
		const sessionPath = makeSessionFile(buildMixedSession(25, errorIndices));
		const mockStorage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
		for (let i = 10; i < 20; i++) expect(out).toContain(`r${i}-err`);
		for (let i = 0; i < 10; i++) expect(out).not.toContain(`r${i}-err`);
		for (let i = 20; i < 25; i++) expect(out).not.toContain(`r${i}-ok`);
		expect(out).toContain("Last run tool calls (10 of 25 shown — 15 earlier calls dropped, 10 of them errors):");
	});

	it("Tier 3 error-priority: respects the original chronological order within each bucket", () => {
		const now = Date.now();
		const errorIndices = new Set([2, 5, 8]);
		const sessionPath = makeSessionFile(buildMixedSession(16, errorIndices));
		const mockStorage = makeStorageMock([failureExecWithSession(sessionPath, now)]);
		const out = buildCronContextPrefixFromStorage(baseTaskCpf, mockStorage, { nowMs: () => now });
		const error1 = out.indexOf("r2-err");
		const error2 = out.indexOf("r5-err");
		const error3 = out.indexOf("r8-err");
		expect(error1).toBeGreaterThan(-1);
		expect(error2).toBeGreaterThan(error1);
		expect(error3).toBeGreaterThan(error2);
	});
});

// ===========================================================================
// resolveDelivery + CronService.onTrigger (failure-notify path)
// ===========================================================================

function makeTask(overrides: Partial<ScheduledTask> & { name: string }): ScheduledTask {
	const base: ScheduledTask = {
		id: "task_test",
		name: overrides.name,
		cron: "0 0 1 1 *",
		command: "echo hello",
		taskType: "shell",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: 30_000,
		...overrides,
	};
	storage.addTask({
		cron: base.cron,
		command: base.command,
		taskType: base.taskType,
		status: base.status,
		createdAt: base.createdAt,
		updatedAt: base.updatedAt,
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: base.timeoutMs,
		name: base.name,
		agentDir: base.agentDir,
		delivery: base.delivery,
		deliver: base.deliver,
		deliverUser: base.deliverUser,
		accountId: base.accountId,
		attachToSession: base.attachToSession,
	});
	const stored = storage.getTaskByName(base.name);
	if (!stored) throw new Error("test setup: task not found after add");
	return stored;
}

const accountDirMap = new Map<string, string>([
	["/Users/test/agent-atomix", "algorithm"],
	["/Users/test/agent-hr", "hr"],
]);

function makeResolveAccountId(): ResolveAccountIdFn {
	return (agentDir: string) => accountDirMap.get(agentDir);
}

describe("resolveDelivery — agentDir-based accountId lookup", () => {
	it("uses resolveAccountId(agentDir) when delivery.accountId is missing", () => {
		const task = makeTask({
			name: "_t_fail_resolveAccountId",
			agentDir: "/Users/test/agent-atomix",
			delivery: { channel: "dingtalk", toUserId: "u_1", mode: "announce" },
		});
		const result = resolveDelivery(task, makeResolveAccountId());
		expect(result).toBeDefined();
		expect(result!.accountId).toBe("algorithm");
		expect(result!.channel).toBe("dingtalk");
	});

	it("prefers an explicit delivery.accountId over the agentDir reverse-lookup", () => {
		const task = makeTask({
			name: "_t_fail_resolveAccountId",
			agentDir: "/Users/test/agent-atomix",
			delivery: { channel: "dingtalk", accountId: "explicit-account", toUserId: "u_1", mode: "announce" },
		});
		const result = resolveDelivery(task, makeResolveAccountId());
		expect(result!.accountId).toBe("explicit-account");
	});

	it("falls back to deprecated task.accountId only when reverse-lookup misses", () => {
		const task = makeTask({
			name: "_t_fail_resolveAccountId",
			agentDir: "/Users/test/unmapped",
			delivery: { channel: "dingtalk", toUserId: "u_1", mode: "announce" },
		});
		const result = resolveDelivery(task, makeResolveAccountId());
		expect(result!.accountId).toBeUndefined();
	});
});

function makeCronService(opts: {
	deliver: DeliverFn;
	executeAgent: ExecuteAgentFn;
	notifyFailure: NotifyCronFailureFn;
	resolveAccountId?: ResolveAccountIdFn;
}): CronService {
	return new CronService({
		storage,
		ompBinary: "omp",
		executeAgent: opts.executeAgent,
		deliver: opts.deliver,
		log: noopLogger,
		notifyFailure: opts.notifyFailure,
		resolveAccountId: opts.resolveAccountId,
	});
}

describe("CronService.onTrigger — notifyFailure on failure paths", () => {
	it("notifies on executeAgent error (warm-bridge path errored, no output)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const notify = mock<NotifyCronFailureFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({
			output: "",
			error: "Agent RPC inactive for 60000ms (no session event for 60000ms)",
		}));
		const brokenService = new CronService({
			storage,
			ompBinary: "/nonexistent/omp-fake-binary-for-test",
			executeAgent,
			deliver,
			log: noopLogger,
			notifyFailure: notify,
		});

		const task = makeTask({
			name: "_t_fail_executeAgent",
			taskType: "agent",
			agentDir: testDir,
			command: "do something",
			timeoutMs: 1000,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await expect(brokenService.onTrigger(task, exec.id)).rejects.toThrow();

		expect(notify).toHaveBeenCalled();
		const call = notify.mock.calls[0]![0];
		expect(call.taskName).toBe("_t_fail_executeAgent");
		expect(call.toUserId).toBe("u_1");
		expect(call.reason).toBeTruthy();
	});

	it("notifies on summary delivery failure with kind=delivery_failed", async () => {
		const deliver = mock<DeliverFn>(async () => ({
			ok: false,
			error: "Unknown channel: dingtalk:test",
		}));
		const notify = mock<NotifyCronFailureFn>(async () => ({ ok: true }));
		const service = makeCronService({
			deliver,
			executeAgent: async () => ({ output: "agent ran fine" }),
			notifyFailure: notify,
		});

		const task = makeTask({
			name: "_t_fail_delivery",
			taskType: "shell",
			agentDir: testDir,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_2", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(notify).toHaveBeenCalled();
		const call = notify.mock.calls[0]![0];
		expect(call.kind).toBe("delivery_failed");
		expect(call.taskName).toBe("_t_fail_delivery");
		expect(call.reason).toBe("Unknown channel: dingtalk:test");
		expect(call.toUserId).toBe("u_2");
	});

	it("does not notify when the task succeeds and delivery succeeds", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const notify = mock<NotifyCronFailureFn>(async () => ({ ok: true }));
		const service = makeCronService({
			deliver,
			executeAgent: async () => ({ output: "ok" }),
			notifyFailure: notify,
		});

		const task = makeTask({
			name: "_t_fail_delivery",
			taskType: "shell",
			agentDir: testDir,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_3", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(notify).not.toHaveBeenCalled();
	});

	it("notifyFailure channel uses the resolved accountId, not the workspace basename", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: false, error: "Unknown channel" }));
		const notify = mock<NotifyCronFailureFn>(async () => ({ ok: true }));
		const service = makeCronService({
			deliver,
			executeAgent: async () => ({ output: "ok" }),
			notifyFailure: notify,
			resolveAccountId: (agentDir: string) => (agentDir === testDir ? "algorithm" : undefined),
		});

		const task = makeTask({
			name: "_t_fail_delivery",
			agentDir: testDir,
			delivery: { channel: "dingtalk", toUserId: "u_4", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(notify).toHaveBeenCalled();
		const call = notify.mock.calls[0]![0];
		expect(call.accountId).toBe("algorithm");
	});
});

// ===========================================================================
// forceFail debug override
// ===========================================================================

const ORIGINAL_LOG_ROOT = getLogRoot();

describe("CronService.onTrigger — forceFail debug-only override", () => {
	beforeEach(() => {
		setLogRoot(path.join(testDir, "logs"));
	});

	afterEach(() => {
		setLogRoot(ORIGINAL_LOG_ROOT);
	});

	// Use the main `storage` (JsonFileStorage) — the cron service's
	// onTrigger needs the task + execution in the same file.
	// Use a separate JsonFileStorage for the cron service and
	// task/exec — forceFail is a debug-only field that the
	// gateway's flow writes via jobs.json. The cron service is
	// constructed with that JsonFileStorage, and the task/exec
	// lifecycle runs against it.
	function makeForceTask(overrides: Partial<ScheduledTask>): {
		task: ScheduledTask;
		storage: JsonFileStorage;
	} {
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
		const ffStorage = new JsonFileStorage(path.join(testDir, "jobs-ff.json"));
		ffStorage.addTask({
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
		const stored = ffStorage.getTaskByName(base.name);
		if (!stored) throw new Error("test setup: task not found after add");
		return { task: stored, storage: ffStorage };
	}

	// Helper: run a forceFail test with the JsonFileStorage swapped
	// in for the cron service. Saves + restores the module-scope
	// `storage` so the other tests in the file still see the
	// shared JsonFileStorage.
	async function withForceFail<T>(overrides: Partial<ScheduledTask>, fn: () => Promise<T>): Promise<T> {
		const { task, storage: ffStorage } = makeForceTask(overrides);
		const originalStorage = storage;
		storage = ffStorage as unknown as JsonFileStorage;
		try {
			return await fn();
		} finally {
			storage = originalStorage;
			ffStorage.close();
		}
	}

	// Each test uses a fresh JsonFileStorage — forceFail is a
	// debug-only field stored only in jobs.json (the SQLite storage
	// hasn't grown a column for it, by design). The cron service
	// is constructed with that JsonFileStorage, and the task/exec
	// lifecycle runs against it.
	function setupForceFailTask(overrides: Partial<ScheduledTask>): {
		task: ScheduledTask;
		storage: JsonFileStorage;
	} {
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
		const ffStorage = new JsonFileStorage(
			path.join(testDir, `jobs-ff-${Math.random().toString(36).slice(2, 8)}.json`),
		);
		ffStorage.addTask({
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
		const stored = ffStorage.getTaskByName(base.name);
		if (!stored) throw new Error("test setup: task not found after add");
		return { task: stored, storage: ffStorage };
	}

	it("overrides a successful warm bridge to exitCode=1, status=failure", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "agent produced this brief" }));

		const { task, storage: ffStorage } = setupForceFailTask({ forceFail: true });
		try {
			const service = new CronService({
				storage: ffStorage,
				ompBinary: "omp",
				executeAgent,
				deliver,
				log: noopLogger,
			});
			const exec = ffStorage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

			await expect(service.onTrigger(task, exec.id)).rejects.toThrow(/failed \(exit 1\)/);

			const updated = ffStorage.getExecutions(task.id).find(e => e.id === exec.id);
			expect(updated!.status).toBe("failure");
			expect(updated!.exitCode).toBe(1);
		} finally {
			ffStorage.close();
		}
	});

	it("appends the [forceFail] marker to the output so operators can identify the override", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "agent produced this brief" }));

		const { task, storage: ffStorage } = setupForceFailTask({ forceFail: true });
		try {
			const service = new CronService({
				storage: ffStorage,
				ompBinary: "omp",
				executeAgent,
				deliver,
				log: noopLogger,
			});
			const exec = ffStorage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

			await expect(service.onTrigger(task, exec.id)).rejects.toThrow();

			const updated = ffStorage.getExecutions(task.id).find(e => e.id === exec.id);
			expect(updated!.output).toContain("agent produced this brief");
			expect(updated!.output).toContain("[forceFail]");
		} finally {
			ffStorage.close();
		}
	});

	it("still triggers delivery (with a failure-flavored summary card)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "ok" }));

		const { task, storage: ffStorage } = setupForceFailTask({
			forceFail: true,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		try {
			const service = new CronService({
				storage: ffStorage,
				ompBinary: "omp",
				executeAgent,
				deliver,
				log: noopLogger,
			});
			const exec = ffStorage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

			await expect(service.onTrigger(task, exec.id)).rejects.toThrow();

			expect(deliver).toHaveBeenCalled();
			const summary = deliver.mock.calls[0]![0].text;
			expect(summary).toMatch(/❌|failed/);
		} finally {
			ffStorage.close();
		}
	});

	it("does not double-fail when both warm bridge and fallback already failed", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({
			output: "",
			error: "warm bridge RPC failed",
		}));

		const { task, storage: ffStorage } = setupForceFailTask({ forceFail: true });
		try {
			const service = new CronService({
				storage: ffStorage,
				ompBinary: "/nonexistent/omp-fake-binary-for-force-fail-test",
				executeAgent,
				deliver,
				log: noopLogger,
			});
			const exec = ffStorage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

			await expect(service.onTrigger(task, exec.id)).rejects.toThrow();

			const updated = ffStorage.getExecutions(task.id).find(e => e.id === exec.id);
			expect(updated!.status).toBe("failure");
			expect(updated!.exitCode).toBe(1);
			expect(updated!.output ?? "").not.toContain("[forceFail]");
		} finally {
			ffStorage.close();
		}
	});

	it("does not override when forceFail is absent (default behavior unchanged)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "ok" }));

		const { task, storage: ffStorage } = setupForceFailTask({ forceFail: undefined });
		try {
			const service = new CronService({
				storage: ffStorage,
				ompBinary: "omp",
				executeAgent,
				deliver,
				log: noopLogger,
			});
			const exec = ffStorage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

			await service.onTrigger(task, exec.id);

			const updated = ffStorage.getExecutions(task.id).find(e => e.id === exec.id);
			expect(updated!.status).toBe("success");
			expect(updated!.exitCode).toBe(0);
			expect(updated!.output ?? "").not.toContain("[forceFail]");
		} finally {
			ffStorage.close();
		}
	});

	it("does not override when forceFail=false (explicit false is the same as absent)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const executeAgent = mock<ExecuteAgentFn>(async () => ({ output: "ok" }));

		const { task, storage: ffStorage } = setupForceFailTask({ forceFail: false });
		try {
			const service = new CronService({
				storage: ffStorage,
				ompBinary: "omp",
				executeAgent,
				deliver,
				log: noopLogger,
			});
			const exec = ffStorage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

			await service.onTrigger(task, exec.id);

			const updated = ffStorage.getExecutions(task.id).find(e => e.id === exec.id);
			expect(updated!.status).toBe("success");
			expect(updated!.exitCode).toBe(0);
		} finally {
			ffStorage.close();
		}
	});
});

// ===========================================================================
// outbound delivery smoke (storage round-trip + [SILENT] suppression)
// ===========================================================================

function addShellTaskSmoke(overrides: Partial<Parameters<JsonFileStorage["addTask"]>[0]> & { name: string }) {
	return storage.addTask({
		cron: "0 0 1 1 *",
		command: `echo hello from ${overrides.name}`,
		taskType: "shell",
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runCount: 0,
		failCount: 0,
		consecutiveFailures: 0,
		timeoutMs: 30_000,
		...overrides,
	});
}

function makeSmokeCronService(deliver: DeliverFn): CronService {
	return new CronService({
		storage,
		ompBinary: "omp",
		executeAgent: async () => {
			throw new Error("executeAgent should not be called for shell tasks");
		},
		deliver,
		log: noopLogger,
	});
}

describe("cron outbound delivery smoke test", () => {
	it("round-trips the new `delivery` + `agentDir` fields through storage", () => {
		const created = addShellTaskSmoke({
			name: "_t_smoke_roundtrip",
			agentDir: "/tmp/fake-agent-dir",
			delivery: { channel: "dingtalk:hr", accountId: "hr", toUserId: "u_smoke_test", mode: "announce" },
		});

		const read = storage.getTaskByName("_t_smoke_roundtrip");
		expect(read).toBeDefined();
		expect(read!.id).toBe(created.id);
		expect(read!.agentDir).toBe("/tmp/fake-agent-dir");
		expect(read!.delivery).toEqual({
			channel: "dingtalk:hr",
			accountId: "hr",
			toUserId: "u_smoke_test",
			toConversationId: undefined,
			mode: "announce",
		});
	});

	it("CronService.onTrigger forwards the configured channel/accountId/toUserId to `deliver` and includes the task output", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const service = makeSmokeCronService(deliver);

		const task = addShellTaskSmoke({
			name: "_t_smoke_deliver",
			agentDir: testDir,
			delivery: { channel: "dingtalk:hr", accountId: "hr", toUserId: "u_smoke_test", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		try {
			await service.onTrigger(task, exec.id);

			expect(deliver).toHaveBeenCalledTimes(1);
			const call = deliver.mock.calls[0]![0];
			expect(call.channel).toBe("dingtalk:hr");
			expect(call.accountId).toBe("hr");
			expect(call.toUserId).toBe("u_smoke_test");
			expect(call.text).toContain("hello from _t_smoke_deliver");
		} finally {
			const t = storage.getTaskByName("_t_smoke_deliver");
			if (t) storage.deleteTask(t.id);
		}
	});

	it("CronService.onTrigger does not call `deliver` when no delivery is configured", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const service = makeSmokeCronService(deliver);

		const task = addShellTaskSmoke({ name: "_t_smoke_nodeliver", agentDir: testDir });
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		try {
			await service.onTrigger(task, exec.id);
			expect(deliver).not.toHaveBeenCalled();
		} finally {
			const t = storage.getTaskByName("_t_smoke_nodeliver");
			if (t) storage.deleteTask(t.id);
		}
	});

	it("CronService.onTrigger does not call `deliver` when the output is [SILENT]", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const service = makeSmokeCronService(deliver);

		const task = addShellTaskSmoke({
			name: "_t_smoke_silent",
			command: "echo '[SILENT]'",
			agentDir: testDir,
			delivery: { channel: "dingtalk:hr", accountId: "hr", toUserId: "u_smoke_test", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		try {
			await service.onTrigger(task, exec.id);
			expect(deliver).not.toHaveBeenCalled();
		} finally {
			const t = storage.getTaskByName("_t_smoke_silent");
			if (t) storage.deleteTask(t.id);
		}
	});
});

// ===========================================================================
// attachToSession default-on (was: scheduler-attach-to-session-default.test.ts)
// ===========================================================================
//
// The mirror is supposed to be the ROOT-CAUSE fix for "user DMs the bot
// about the last cron report and the chat LLM has no idea what the report
// said". An opt-in flag (`attachToSession: true`) buried in task config
// meant most tasks never had it set, so the chat agent kept starting cold.
//
// New contract: mirror runs by default for DingTalk tasks. Set
// `attachToSession: false` to opt out. Non-DingTalk channels skip the
// mirror entirely (no warn noise) — the cron `recent` host tool is the
// cross-channel fallback.

describe("CronService.onTrigger — mirrorToSession default-on", () => {
	const ORIGINAL_LOG_ROOT = getLogRoot();

	beforeEach(() => {
		setLogRoot(path.join(testDir, "logs"));
	});

	afterEach(() => {
		setLogRoot(ORIGINAL_LOG_ROOT);
	});

	function makeServiceWithMirror(opts: {
		deliver: DeliverFn;
		executeAgent: ExecuteAgentFn;
		mirror: MirrorToSessionFn;
	}): CronService {
		return new CronService({
			storage,
			ompBinary: "omp",
			executeAgent: opts.executeAgent,
			deliver: opts.deliver,
			log: noopLogger,
			mirrorToSession: opts.mirror,
		});
	}

	it("calls mirror by default when attachToSession is undefined (DingTalk)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const mirror = mock<MirrorToSessionFn>(async () => ({ ok: true }));
		const service = makeServiceWithMirror({
			deliver,
			executeAgent: async () => ({ output: "agent ran fine" }),
			mirror,
		});

		const task = makeTask({
			name: "_t_mirror_default",
			taskType: "agent",
			agentDir: testDir,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		// attachToSession intentionally NOT set — default-on contract.
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(mirror).toHaveBeenCalledTimes(1);
		const call = mirror.mock.calls[0]![0];
		expect(call.task.name).toBe("_t_mirror_default");
		expect(call.brief).toContain("agent ran fine");
		expect(call.delivery.channel).toBe("dingtalk");
	});

	it("calls mirror when attachToSession is explicitly true (DingTalk)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const mirror = mock<MirrorToSessionFn>(async () => ({ ok: true }));
		const service = makeServiceWithMirror({
			deliver,
			executeAgent: async () => ({ output: "ok" }),
			mirror,
		});

		const task = makeTask({
			name: "_t_mirror_explicit_true",
			taskType: "agent",
			agentDir: testDir,
			attachToSession: true,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(mirror).toHaveBeenCalledTimes(1);
	});

	it("skips mirror when attachToSession is explicitly false (DingTalk opt-out)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const mirror = mock<MirrorToSessionFn>(async () => ({ ok: true }));
		const service = makeServiceWithMirror({
			deliver,
			executeAgent: async () => ({ output: "ok" }),
			mirror,
		});

		const task = makeTask({
			name: "_t_mirror_explicit_false",
			taskType: "agent",
			agentDir: testDir,
			attachToSession: false,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(mirror).not.toHaveBeenCalled();
	});

	it("skips mirror on non-DingTalk channels (no warn noise; cron.recent is the fallback)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const mirror = mock<MirrorToSessionFn>(async () => ({ ok: true }));
		const service = makeServiceWithMirror({
			deliver,
			executeAgent: async () => ({ output: "ok" }),
			mirror,
		});

		const task = makeTask({
			name: "_t_mirror_nondingtalk",
			taskType: "agent",
			agentDir: testDir,
			// attachToSession: true would normally trigger, but the
			// channel gate stops non-DingTalk tasks.
			attachToSession: true,
			delivery: { channel: "telegram", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(mirror).not.toHaveBeenCalled();
	});

	it("does not call mirror when delivery fails (mirror is success-path only)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: false, error: "channel offline" }));
		const mirror = mock<MirrorToSessionFn>(async () => ({ ok: true }));
		const service = makeServiceWithMirror({
			deliver,
			executeAgent: async () => ({ output: "ok" }),
			mirror,
		});

		const task = makeTask({
			name: "_t_mirror_delivery_failed",
			taskType: "agent",
			agentDir: testDir,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		try {
			await service.onTrigger(task, exec.id);
		} catch {
			// delivery_failed does not throw — it returns normally and
			// the failure is recorded. But if the warm bridge also
			// throws in this fallback test setup, swallow it.
		}

		expect(mirror).not.toHaveBeenCalled();
	});

	it("does not call mirror when task is [SILENT] (delivery suppressed, mirror is downstream of delivery)", async () => {
		const deliver = mock<DeliverFn>(async () => ({ ok: true }));
		const mirror = mock<MirrorToSessionFn>(async () => ({ ok: true }));
		const service = makeServiceWithMirror({
			deliver,
			executeAgent: async () => ({ output: "[SILENT]" }),
			mirror,
		});

		const task = makeTask({
			name: "_t_mirror_silent",
			taskType: "agent",
			agentDir: testDir,
			delivery: { channel: "dingtalk", accountId: "test", toUserId: "u_1", mode: "announce" },
		});
		const exec = storage.recordExecution({ taskId: task.id, startedAt: Date.now(), status: "running" });

		await service.onTrigger(task, exec.id);

		expect(deliver).not.toHaveBeenCalled();
		expect(mirror).not.toHaveBeenCalled();
	});
});
