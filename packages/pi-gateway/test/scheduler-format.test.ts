/**
 * Scheduler formatter + session tool-call parser tests.
 *
 *   - `scheduler-format.test.ts` — Cron-list formatter:
 *     formatChannel / formatAgent / formatTaskRow / truncateName /
 *     formatDeliveryFailureCount. Pin the fixed column widths so the
 *     CLI table header and rows stay in lockstep.
 *   - `scheduler-parse-tool-calls.test.ts` — Session JSONL parser:
 *     parseAgentSessionForToolCalls correlates `tool_execution_start`
 *     events and inline `toolCall` content with `toolResult`
 *     messages, surfaces errors with [ERROR] tag, truncates long
 *     previews.
 *
 * Both feed into Tier 3 of the cron context prefix — the formatter
 * renders rows for the `cron list` CLI; the parser feeds the
 * `buildCronContextPrefixFromStorage` Tier 3 block. Co-located here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatToolCallSummary,
	parseAgentSessionForToolCalls,
	type ToolCallSummary,
} from "../src/scheduler/diagnostics";
import { appendDeliveryFailureLog, clearDeliveryFailureCache, setLogRoot } from "../src/scheduler/execution-log";
import type { ScheduledTask } from "../src/scheduler/types";
import {
	formatAgent,
	formatChannel,
	formatDeliveryFailureCount,
	formatTaskRow,
	truncateName,
} from "../src/scheduler/types";

// ===========================================================================
// formatChannel / formatAgent / formatTaskRow / truncateName
// ===========================================================================

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return {
		id: "task_test",
		name: "test",
		cron: "0 0 * * *",
		command: "echo hi",
		status: "active",
		scheduleType: "cron",
		taskType: "shell",
		timeoutMs: 30_000,
		consecutiveFailures: 0,
		createdAt: 0,
		updatedAt: 0,
		runCount: 0,
		failCount: 0,
		...overrides,
	};
}

describe("formatChannel", () => {
	it("returns em-dash when deliver is unset", () => {
		expect(formatChannel(undefined)).toBe("—");
	});

	it("returns em-dash when deliver is the empty string (DB default)", () => {
		expect(formatChannel("")).toBe("—");
	});

	it("returns the deliver value as-is when set", () => {
		expect(formatChannel("dingtalk:hr")).toBe("dingtalk:hr");
	});

	it("preserves long deliver values like dingtalk:user:601590212", () => {
		expect(formatChannel("dingtalk:user:601590212")).toBe("dingtalk:user:601590212");
	});

	it("does NOT include deliverUser in the cell (orthogonal field, use --json)", () => {
		const cell = formatChannel("dingtalk:hr");
		expect(cell).not.toContain("→");
	});
});

describe("formatAgent", () => {
	it("returns em-dash when agentDir is unset", () => {
		expect(formatAgent(undefined)).toBe("—");
	});

	it("returns em-dash when agentDir is the empty string", () => {
		expect(formatAgent("")).toBe("—");
	});

	it("extracts the last path segment as the agent label", () => {
		expect(formatAgent("~/.omp/agents/hr")).toBe("hr");
	});

	it("extracts the last segment of a nested agent path", () => {
		expect(formatAgent("~/.omp/agents/ops/hr")).toBe("hr");
	});

	it("truncates the label with an ellipsis when it exceeds the default max (12)", () => {
		const cell = formatAgent("~/.omp/agents/way-too-long-account-id");
		expect(cell.length).toBe(12);
		expect(cell.endsWith("\u2026")).toBe(true);
	});

	it("respects a custom max width", () => {
		expect(formatAgent("~/.omp/agents/ops-team", 4)).toBe("ops…");
	});

	it("returns the label as-is when it equals the max", () => {
		const id = "a".repeat(15);
		expect(formatAgent(`~/.omp/agents/${id}`, 15)).toBe(id);
	});
});

describe("formatTaskRow column layout", () => {
	it("renders the same number of space-separated fields for every task shape", () => {
		const variants: ScheduledTask[] = [
			makeTask(),
			makeTask({ name: "a-long-task-name-123" }),
			makeTask({ name: "短" }),
			makeTask({ taskType: "agent" }),
			makeTask({ scheduleType: "interval", cron: "3s" }),
			makeTask({ status: "disabled" }),
			makeTask({ deliver: "dingtalk:hr" }),
			makeTask({ deliver: "dingtalk:user:601590212" }),
			makeTask({ accountId: "hr" }),
			makeTask({ accountId: "ops/hr" }),
			makeTask({ accountId: "way-too-long-account-id" }),
			makeTask({ agentDir: "~/.omp/agents/hr" }),
			makeTask({ agentDir: "~/.omp/agents/ops/hr" }),
			makeTask({ agentDir: "~/.omp/agents/way-too-long-account-id" }),
			makeTask({ delivery: { channel: "dingtalk:hr", mode: "announce" } }),
			makeTask({ delivery: { channel: "dingtalk:user:601590212", mode: "announce" } }),
		];
		const widths = [21, 6, 12, 8, 16, 15, 7, 20, 8, 8] as const;
		const splitByWidth = (row: string): string[] => {
			const out: string[] = [];
			let pos = 0;
			for (const w of widths) {
				out.push(row.slice(pos, pos + w));
				pos += w + 1;
			}
			out.push(row.slice(pos));
			return out;
		};
		const counts = variants.map(t => splitByWidth(formatTaskRow(t)).length);
		expect(new Set(counts).size).toBe(1);
		expect(counts[0]).toBe(11);
	});

	it("renders an em-dash when deliver is unset (no blank cell)", () => {
		const row = formatTaskRow(makeTask({ name: "x" }));
		expect(row).toContain("—");
	});

	it("truncates over-long names with an ellipsis instead of overflowing the next column", () => {
		const row = formatTaskRow(makeTask({ name: "this-name-is-way-longer-than-eighteen-chars" }));
		const widths = [21, 6, 12, 8, 16, 15, 7, 20, 8, 8] as const;
		const splitByWidth = (row: string): string[] => {
			const out: string[] = [];
			let pos = 0;
			for (const w of widths) {
				out.push(row.slice(pos, pos + w));
				pos += w + 1;
			}
			out.push(row.slice(pos));
			return out;
		};
		expect(splitByWidth(row).length).toBe(11);
		expect(row).toContain("\u2026");
		expect(row).not.toContain("eighteen-chars");
	});

	it("renders rows that match the table header width", () => {
		const header =
			"NAME".padEnd(21) +
			" " +
			"TYPE".padEnd(6) +
			" " +
			"AGENT".padEnd(12) +
			" " +
			"STATUS".padEnd(8) +
			" " +
			"CRON".padEnd(16) +
			" " +
			"MODEL".padEnd(15) +
			" " +
			"REPEAT".padEnd(7) +
			" " +
			"CHANNEL".padEnd(20) +
			" " +
			"LAST".padEnd(8) +
			" " +
			"DELIV".padEnd(8) +
			" " +
			"NEXT RUN".padEnd(21);
		expect(header.length).toBe(152);
		const row = formatTaskRow(makeTask({ name: "x" }));
		expect(row.length).toBe(178);
	});

	it("renders the agentDir label in the row when set", () => {
		const row = formatTaskRow(makeTask({ name: "x", agentDir: "~/.omp/agents/hr" }));
		expect(row).toContain("hr");
	});

	it("renders the model in the row when set", () => {
		const row = formatTaskRow(makeTask({ name: "x", model: "minimax-m3" }));
		expect(row).toContain("minimax-m3");
	});

	it("renders an em-dash in the AGENT column when accountId is unset", () => {
		const row = formatTaskRow(makeTask({ name: "x" }));
		const fields = row.split(/\s{2,}/);
		expect(fields[2]).toBe("—");
	});
});

describe("truncateName", () => {
	it("returns the name as-is when it fits", () => {
		expect(truncateName("short", 18)).toBe("short");
	});

	it("returns the name as-is when it equals the max", () => {
		expect(truncateName("a".repeat(18), 18)).toBe("a".repeat(18));
	});

	it("truncates to max-1 + ellipsis when over the max", () => {
		const result = truncateName("a".repeat(20), 18);
		expect(result.length).toBe(18);
		expect(result.endsWith("\u2026")).toBe(true);
	});

	it("handles a real-world CJK name", () => {
		const result = truncateName("omp-atomix:wiki-changelog:01-算法模块", 18);
		expect(result.length).toBe(18);
		expect(result.endsWith("\u2026")).toBe(true);
		expect(result.startsWith("omp-atomix:wiki")).toBe(true);
	});
});

describe("formatDeliveryFailureCount", () => {
	let tmpLogRoot: string;

	beforeEach(async () => {
		tmpLogRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pi-gateway-fmt-delivery-"));
		setLogRoot(tmpLogRoot);
		clearDeliveryFailureCache();
	});

	afterEach(async () => {
		clearDeliveryFailureCache();
		await fsPromises.rm(tmpLogRoot, { recursive: true, force: true });
	});

	it("returns a check mark when there are no recent failures", () => {
		expect(formatDeliveryFailureCount("task-1")).toBe("\u2713");
	});

	it("returns \u00d7 N when there is a recent failure", () => {
		appendDeliveryFailureLog({
			ts: Date.now(),
			taskId: "task-1",
			taskName: "n",
			channel: "dingtalk:hr",
			userId: "u",
			reason: "x",
			attempts: 2,
			exitCode: 0,
		});
		clearDeliveryFailureCache();
		expect(formatDeliveryFailureCount("task-1")).toBe("\u00d7 1");
	});

	it("counts only failures within the sinceMs window", () => {
		appendDeliveryFailureLog({
			ts: Date.now() - 5 * 24 * 60 * 60 * 1000,
			taskId: "task-old",
			taskName: "n",
			channel: "dingtalk:hr",
			userId: "u",
			reason: "x",
			attempts: 2,
			exitCode: 0,
		});
		appendDeliveryFailureLog({
			ts: Date.now() - 60_000,
			taskId: "task-old",
			taskName: "n",
			channel: "dingtalk:hr",
			userId: "u",
			reason: "x",
			attempts: 2,
			exitCode: 0,
		});
		clearDeliveryFailureCache();
		expect(formatDeliveryFailureCount("task-old")).toBe("\u00d7 1");
	});

	it("only counts failures for the queried task", () => {
		appendDeliveryFailureLog({
			ts: Date.now(),
			taskId: "task-A",
			taskName: "A",
			channel: "dingtalk:hr",
			userId: "u",
			reason: "x",
			attempts: 2,
			exitCode: 0,
		});
		appendDeliveryFailureLog({
			ts: Date.now(),
			taskId: "task-B",
			taskName: "B",
			channel: "dingtalk:hr",
			userId: "u",
			reason: "x",
			attempts: 2,
			exitCode: 0,
		});
		clearDeliveryFailureCache();
		expect(formatDeliveryFailureCount("task-A")).toBe("\u00d7 1");
		expect(formatDeliveryFailureCount("task-B")).toBe("\u00d7 1");
		expect(formatDeliveryFailureCount("task-C")).toBe("\u2713");
	});

	it("includes the delivery indicator in the rendered task row", () => {
		appendDeliveryFailureLog({
			ts: Date.now(),
			taskId: "task_xyz",
			taskName: "xyz",
			channel: "dingtalk:hr",
			userId: "u",
			reason: "x",
			attempts: 2,
			exitCode: 0,
		});
		clearDeliveryFailureCache();
		const row = formatTaskRow(makeTask({ name: "x", id: "task_xyz" }));
		expect(row).toContain("\u00d7 1");
	});
});

// ===========================================================================
// parseAgentSessionForToolCalls / formatToolCallSummary
// ===========================================================================

let tempDir = "";

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-tool-calls-test-"));
});

afterEach(() => {
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeSession(fileName: string, lines: object[]): string {
	const filePath = path.join(tempDir, fileName);
	const content = `${lines.map(l => JSON.stringify(l)).join("\n")}\n`;
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

describe("parseAgentSessionForToolCalls", () => {
	it("returns undefined when path is undefined", () => {
		expect(parseAgentSessionForToolCalls(undefined)).toBeUndefined();
	});

	it("returns undefined when the file does not exist", () => {
		const missing = path.join(tempDir, "does-not-exist.jsonl");
		expect(parseAgentSessionForToolCalls(missing)).toBeUndefined();
	});

	it("returns undefined when the file is empty", () => {
		const sessionPath = path.join(tempDir, "empty.jsonl");
		fs.writeFileSync(sessionPath, "", "utf-8");
		expect(parseAgentSessionForToolCalls(sessionPath)).toBeUndefined();
	});

	it("returns undefined when no toolResult messages exist", () => {
		const sessionPath = writeSession("no-tools.jsonl", [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
		]);
		expect(parseAgentSessionForToolCalls(sessionPath)).toBeUndefined();
	});

	it("returns a single entry for a session with one tool call", () => {
		const sessionPath = writeSession("one-call.jsonl", [
			{ type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: { path: "/etc/hosts" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "127.0.0.1 localhost" }],
					timestamp: 1000,
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(1);
		expect(result![0]?.toolName).toBe("read");
		expect(result![0]?.argsPreview).toBe('{"path":"/etc/hosts"}');
		expect(result![0]?.resultPreview).toBe("127.0.0.1 localhost");
		expect(result![0]?.isError).toBe(false);
		expect(result![0]?.ts).toBe(1000);
	});

	it("returns all entries in chronological order when caller does not select", () => {
		const sessionPath = writeSession("few-calls.jsonl", [
			{ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "ls" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "file1\nfile2" }],
				},
			},
			{ type: "tool_execution_start", toolCallId: "tc2", toolName: "bash", args: { command: "pwd" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc2",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "/home" }],
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(2);
		expect(result!.map(r => r.toolName)).toEqual(["bash", "bash"]);
		expect(result![0]?.resultPreview).toBe("file1\nfile2");
		expect(result![1]?.resultPreview).toBe("/home");
	});

	it("returns all entries without truncation (selection is the caller's job)", () => {
		const lines: object[] = [];
		for (let i = 0; i < 25; i++) {
			lines.push({ type: "tool_execution_start", toolCallId: `tc${i}`, toolName: "bash", args: { i } });
			lines.push({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: `tc${i}`,
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: `result-${i}` }],
				},
			});
		}
		const sessionPath = writeSession("many-calls.jsonl", lines);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(25);
		expect(result![0]?.resultPreview).toBe("result-0");
		expect(result![24]?.resultPreview).toBe("result-24");
	});

	it("marks failed tool calls and includes stderr in result preview", () => {
		const sessionPath = writeSession("error-call.jsonl", [
			{ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "false" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "" }],
					details: { exitCode: 1, stderr: "command failed" },
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(1);
		expect(result![0]?.isError).toBe(true);
		expect(result![0]?.resultPreview).toContain("[stderr] command failed");
	});

	it("skips malformed JSONL lines and continues", () => {
		const filePath = path.join(tempDir, "malformed.jsonl");
		fs.writeFileSync(
			filePath,
			[
				"not json at all",
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "tc1",
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: "ok" }],
					},
				}),
				"{ broken",
				"",
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "tc2",
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: "ok2" }],
					},
				}),
			].join("\n"),
			"utf-8",
		);
		const result = parseAgentSessionForToolCalls(filePath);
		expect(result).toHaveLength(2);
		expect(result!.map(r => r.resultPreview)).toEqual(["ok", "ok2"]);
	});

	it("returns empty argsPreview when no preceding tool_execution_start", () => {
		const sessionPath = writeSession("orphan-result.jsonl", [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc_orphan",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "result" }],
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(1);
		expect(result![0]?.argsPreview).toBe("");
		expect(result![0]?.resultPreview).toBe("result");
	});

	it("truncates long args and result previews to ~200 chars", () => {
		const longText = "x".repeat(500);
		const sessionPath = writeSession("long.jsonl", [
			{
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: longText },
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: longText }],
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(1);
		expect(result![0]?.argsPreview.length).toBeLessThanOrEqual(201);
		expect(result![0]?.resultPreview.length).toBeLessThanOrEqual(201);
	});

	it("returns '(no output)' when content is empty and no stderr", () => {
		const sessionPath = writeSession("empty-result.jsonl", [
			{ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: {} },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					isError: false,
					content: [],
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result![0]?.resultPreview).toBe("(no output)");
	});

	it("correlates inline toolCall (in assistant message) with toolResult by id", () => {
		const sessionPath = writeSession("inline-format.jsonl", [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "fetch the date" },
						{
							type: "toolCall",
							id: "call_abc123",
							name: "bash",
							arguments: { command: "date +%Y-%m-%d", _i: "get date" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_abc123",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "2026-07-07" }],
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(1);
		expect(result![0]?.toolName).toBe("bash");
		expect(result![0]?.argsPreview).toContain("date");
		expect(result![0]?.resultPreview).toBe("2026-07-07");
		expect(result![0]?.isError).toBe(false);
	});

	it("handles a session that mixes legacy and inline tool-call formats", () => {
		const sessionPath = writeSession("mixed-format.jsonl", [
			{ type: "tool_execution_start", toolCallId: "tc_legacy", toolName: "read", args: { path: "/etc/hosts" } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc_legacy",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "127.0.0.1 localhost" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_inline",
							name: "bash",
							arguments: { command: "whoami" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_inline",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "root" }],
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(2);
		expect(result!.map(r => r.toolName).sort()).toEqual(["bash", "read"]);
	});

	it("preserves [ERROR] tagging for inline-format failures", () => {
		const sessionPath = writeSession("inline-error.jsonl", [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_fail",
							name: "bash",
							arguments: { command: "false" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_fail",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "command failed" }],
					details: { stderr: "exit 1" },
				},
			},
		]);
		const result = parseAgentSessionForToolCalls(sessionPath);
		expect(result).toHaveLength(1);
		expect(result![0]?.isError).toBe(true);
		expect(formatToolCallSummary(result![0]!)).toContain("[ERROR]");
	});
});

describe("formatToolCallSummary", () => {
	it("formats a successful call with tool name, args, and result", () => {
		const s: ToolCallSummary = {
			toolName: "read",
			argsPreview: '{"path":"/etc/hosts"}',
			resultPreview: "127.0.0.1 localhost",
			isError: false,
			ts: 1000,
		};
		const out = formatToolCallSummary(s);
		expect(out).toContain("[tool: read]");
		expect(out).toContain('{"path":"/etc/hosts"}');
		expect(out).toContain("127.0.0.1 localhost");
		expect(out).not.toContain("[ERROR]");
	});

	it("appends [ERROR] tag for failed calls", () => {
		const s: ToolCallSummary = {
			toolName: "bash",
			argsPreview: '{"command":"false"}',
			resultPreview: "exit 1",
			isError: true,
			ts: 2000,
		};
		const out = formatToolCallSummary(s);
		expect(out).toContain("[ERROR]");
	});
});
