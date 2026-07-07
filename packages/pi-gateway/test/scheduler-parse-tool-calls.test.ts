/**
 * Unit tests for `parseAgentSessionForToolCalls` and `formatToolCallSummary`.
 *
 * The function reads an OMP agent session JSONL and returns the last N
 * tool calls (regardless of outcome) as compact summaries. It correlates
 * `tool_execution_start` events (which carry the tool's input arguments)
 * with `toolResult` messages (which carry the result + error flag) by
 * `toolCallId`. Tool calls that never received a result are dropped.
 *
 * Tests use real temp files to exercise the JSONL parsing path end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatToolCallSummary,
	parseAgentSessionForToolCalls,
	type ToolCallSummary,
} from "../src/scheduler/diagnostics";

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
		// Selection / count-cap is the cron-service's responsibility
		// (see `buildCronContextPrefixFromStorage`); this function only
		// parses. Verify we get every correlated call in order.
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
		// Some unusual sessions may have a toolResult without a start event.
		// We must not throw and must produce a valid (empty args) entry.
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
		// 200 chars + ellipsis (1 char) = 201
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

	// ----- New format: assistant content[].type=toolCall inline -----
	// Modern OMP clients emit the tool_use inline within the assistant
	// message rather than as a separate `tool_execution_start` event.
	// The parser must correlate the inline toolCall.id with the
	// toolResult.toolCallId and surface the call in the summary list;
	// without this branch every modern session would silently return no
	// tool calls, defeating Tier 3 of the cron context prefix.

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
		// The parser should not assume a single format; it should
		// correlate each toolResult with whichever first-pass entry
		// (legacy event or inline toolCall) shares its toolCallId.
		const sessionPath = writeSession("mixed-format.jsonl", [
			// Legacy format
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
			// Inline format
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
		expect(result!.find(r => r.toolName === "read")?.argsPreview).toContain("/etc/hosts");
		expect(result!.find(r => r.toolName === "bash")?.resultPreview).toBe("root");
	});

	it("preserves [ERROR] tagging for inline-format failures", () => {
		// isError on the toolResult must propagate to the summary
		// regardless of which first-pass format provided the args.
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
