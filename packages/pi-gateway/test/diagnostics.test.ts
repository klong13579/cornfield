/**
 * Unit tests for structured cron diagnostics (diagnostics.ts).
 *
 * Tests cover normalization bounds, severity/source coercion,
 * summary extraction, merging, and error-to-diagnostic construction.
 */
import { describe, expect, test } from "bun:test";
import {
	createDiagnosticFromError,
	mergeCronRunDiagnostics,
	normalizeCronRunDiagnostics,
	parseAgentSessionForToolFailures,
	summarizeCronRunDiagnostics,
} from "../src/scheduler/diagnostics";

// ---------------------------------------------------------------------------
// normalizeCronRunDiagnostics
// ---------------------------------------------------------------------------

describe("normalizeCronRunDiagnostics", () => {
	test("normalizes valid input with entries", () => {
		const result = normalizeCronRunDiagnostics({
			summary: "Agent RPC failed",
			entries: [{ ts: 1000, source: "agent-run", severity: "error", message: "Connection lost" }],
		});

		expect(result).toBeDefined();
		expect(result!.summary).toBe("Agent RPC failed");
		expect(result!.entries).toHaveLength(1);
		expect(result!.entries[0].source).toBe("agent-run");
		expect(result!.entries[0].severity).toBe("error");
		expect(result!.entries[0].message).toBe("Connection lost");
		expect(result!.entries[0].ts).toBe(1000);
	});

	test("returns undefined for null / undefined / non-object", () => {
		expect(normalizeCronRunDiagnostics(null)).toBeUndefined();
		expect(normalizeCronRunDiagnostics(undefined)).toBeUndefined();
		expect(normalizeCronRunDiagnostics("string")).toBeUndefined();
		expect(normalizeCronRunDiagnostics(42)).toBeUndefined();
	});

	test("filters out entries with empty or non-string message", () => {
		const result = normalizeCronRunDiagnostics({
			entries: [
				{ ts: 1, source: "exec", severity: "error", message: "ok" },
				{ ts: 2, source: "exec", severity: "error", message: "" },
				{ ts: 3, source: "exec", severity: "error", message: "   " },
				{ ts: 4, source: "exec", severity: "error", message: undefined },
			],
		});

		expect(result).toBeDefined();
		expect(result!.entries).toHaveLength(1);
		expect(result!.entries[0].message).toBe("ok");
	});

	test("returns undefined when all entries are filtered out and no summary", () => {
		const result = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "exec", severity: "error", message: "" }],
		});
		expect(result).toBeUndefined();
	});

	test("caps entries at 10, keeping the latest", () => {
		const entries = Array.from({ length: 15 }, (_, i) => ({
			ts: i,
			source: "exec" as const,
			severity: "error" as const,
			message: `entry-${i}`,
		}));

		const result = normalizeCronRunDiagnostics({ entries });
		expect(result!.entries).toHaveLength(10);
		// The first 5 (0-4) should have been shifted out
		expect(result!.entries[0].ts).toBe(5);
		expect(result!.entries[9].ts).toBe(14);
	});

	test("derives summary from last entry when no explicit summary", () => {
		const result = normalizeCronRunDiagnostics({
			entries: [
				{ ts: 1, source: "cron-setup", severity: "info", message: "started" },
				{ ts: 2, source: "exec", severity: "error", message: "timed out" },
			],
		});

		expect(result!.summary).toBe("timed out");
	});

	test("invalid severity defaults to 'error'", () => {
		const result = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "exec", severity: "unknown-severity" as any, message: "fail" }],
		});
		expect(result!.entries[0].severity).toBe("error");
	});

	test("invalid source defaults to 'agent-run'", () => {
		const result = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "mystery-source" as any, severity: "warn", message: "hmm" }],
		});
		expect(result!.entries[0].source).toBe("agent-run");
	});

	test("truncates message longer than 1000 chars", () => {
		const longMsg = "x".repeat(1100);
		const result = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "exec", severity: "error", message: longMsg }],
		});
		expect(result!.entries[0].message).toHaveLength(1000); // 999 chars + '…'
		expect(result!.entries[0].message.endsWith("…")).toBe(true);
		expect(result!.entries[0].truncated).toBe(true);
	});

	test("normalizes invalid timestamp to nowMs()", () => {
		const now = 5000;
		const result = normalizeCronRunDiagnostics(
			{
				entries: [{ ts: -1, source: "exec", severity: "error", message: "err" }],
			},
			{ nowMs: () => now },
		);
		expect(result!.entries[0].ts).toBe(now);
	});

	test("sets truncated flag when entry.truncated is true even before bounds", () => {
		const result = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "exec", severity: "error", message: "short", truncated: true }],
		});
		expect(result!.entries[0].truncated).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// summarizeCronRunDiagnostics
// ---------------------------------------------------------------------------

describe("summarizeCronRunDiagnostics", () => {
	test("returns summary when present", () => {
		const d = normalizeCronRunDiagnostics({
			summary: "main failure",
			entries: [{ ts: 1, source: "exec", severity: "error", message: "detail" }],
		});
		expect(summarizeCronRunDiagnostics(d)).toBe("main failure");
	});

	test("falls back to first entry message when no summary", () => {
		const d = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "exec", severity: "error", message: "first msg" }],
		});
		expect(summarizeCronRunDiagnostics(d)).toBe("first msg");
	});

	test("returns undefined when given undefined", () => {
		expect(summarizeCronRunDiagnostics(undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// mergeCronRunDiagnostics
// ---------------------------------------------------------------------------

describe("mergeCronRunDiagnostics", () => {
	test("merges entries from multiple diagnostics sets", () => {
		const a = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "cron-setup", severity: "info", message: "started" }],
		});
		const b = normalizeCronRunDiagnostics({
			entries: [{ ts: 2, source: "exec", severity: "error", message: "timeout" }],
		});

		const merged = mergeCronRunDiagnostics(a, b);
		expect(merged!.entries).toHaveLength(2);
		expect(merged!.summary).toBe("timeout"); // error > info
	});

	test("prefers higher severity summary", () => {
		const a = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "cron-setup", severity: "error", message: "critical" }],
		});
		const b = normalizeCronRunDiagnostics({
			entries: [{ ts: 2, source: "cron-setup", severity: "info", message: "FYI" }],
		});

		const merged = mergeCronRunDiagnostics(a, b);
		expect(merged!.summary).toBe("critical");
	});

	test("skips undefined inputs", () => {
		const a = normalizeCronRunDiagnostics({
			entries: [{ ts: 1, source: "exec", severity: "error", message: "fail" }],
		});

		const merged = mergeCronRunDiagnostics(a, undefined, undefined);
		expect(merged!.entries).toHaveLength(1);
		expect(merged!.summary).toBe("fail");
	});

	test("returns undefined when all inputs are undefined", () => {
		expect(mergeCronRunDiagnostics(undefined, undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// createDiagnosticFromError
// ---------------------------------------------------------------------------

describe("createDiagnosticFromError", () => {
	test("creates entry from Error instance", () => {
		const d = createDiagnosticFromError("agent-run", new Error("RPC failure"));
		expect(d).toBeDefined();
		expect(d!.entries).toHaveLength(1);
		expect(d!.entries[0].source).toBe("agent-run");
		expect(d!.entries[0].severity).toBe("error");
		expect(d!.entries[0].message).toBe("RPC failure");
	});

	test("creates entry from string", () => {
		const d = createDiagnosticFromError("exec", "something broke");
		expect(d!.entries[0].message).toBe("something broke");
	});

	test("accepts severity override", () => {
		const d = createDiagnosticFromError("cron-preflight", "skipped", { severity: "info" });
		expect(d!.entries[0].severity).toBe("info");
	});

	test("accepts exitCode and toolName options", () => {
		const d = createDiagnosticFromError("exec", "timed out", { exitCode: 124, toolName: "bash" });
		expect(d!.entries[0].exitCode).toBe(124);
		expect(d!.entries[0].toolName).toBe("bash");
	});

	test("uses custom nowMs when provided", () => {
		const fixed = 9999;
		const d = createDiagnosticFromError("cron-setup", "started", { nowMs: () => fixed });
		expect(d!.entries[0].ts).toBe(fixed);
	});

	test("extracts Error.name when message is empty", () => {
		const err = new Error();
		err.name = "CustomError";
		const d = createDiagnosticFromError("cron-setup", err);
		expect(d!.entries[0].message).toBe("CustomError");
	});
});

// ---------------------------------------------------------------------------
// parseAgentSessionForToolFailures
// ---------------------------------------------------------------------------

describe("parseAgentSessionForToolFailures", () => {
	const makeLine = (type: string, role: string, overrides: Record<string, unknown> = {}) =>
		JSON.stringify({
			type,
			id: "e1",
			parentId: null,
			message: { role, isError: false, timestamp: 1000, ...overrides },
		});

	test("returns undefined when session path is undefined", () => {
		expect(parseAgentSessionForToolFailures(undefined)).toBeUndefined();
	});

	test("returns undefined when file does not exist", () => {
		expect(parseAgentSessionForToolFailures("/tmp/nonexistent-session-abc123.jsonl")).toBeUndefined();
	});

	test("returns undefined for session with no tool failures", () => {
		using dir = mkdtemp();
		Bun.write(
			`${dir.path}/session.jsonl`,
			[
				makeLine("message", "user", { content: [{ type: "text", text: "hello" }] }),
				makeLine("message", "assistant", { content: [{ type: "text", text: "ok" }] }),
				makeLine("message", "toolResult", { toolName: "bash", isError: false, details: { exitCode: 0 } }),
			].join("\n"),
		);

		expect(parseAgentSessionForToolFailures(`${dir.path}/session.jsonl`)).toBeUndefined();
	});

	test("detects tool failure from isError flag", () => {
		using dir = mkdtemp();
		Bun.write(
			`${dir.path}/session.jsonl`,
			[
				makeLine("message", "user", { content: [{ type: "text", text: "deploy" }] }),
				makeLine("message", "assistant", {
					content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
				}),
				makeLine("message", "toolResult", {
					toolName: "bash",
					isError: true,
					details: { stderr: "permission denied" },
				}),
			].join("\n"),
		);

		const result = parseAgentSessionForToolFailures(`${dir.path}/session.jsonl`);
		expect(result).toBeDefined();
		expect(result!.entries).toHaveLength(1);
		expect(result!.entries[0].source).toBe("tool");
		expect(result!.entries[0].severity).toBe("error");
		expect(result!.entries[0].toolName).toBe("bash");
		expect(result!.entries[0].message).toContain("permission denied");
	});

	test("detects tool failure from non-zero exitCode even when isError=false", () => {
		using dir = mkdtemp();
		Bun.write(
			`${dir.path}/session.jsonl`,
			[
				makeLine("message", "toolResult", {
					toolName: "bash",
					isError: false,
					details: { exitCode: 1, stderr: "fail" },
				}),
			].join("\n"),
		);

		const result = parseAgentSessionForToolFailures(`${dir.path}/session.jsonl`);
		expect(result).toBeDefined();
		expect(result!.entries).toHaveLength(1);
		expect(result!.entries[0].exitCode).toBe(1);
	});

	test("skips non-message entries", () => {
		using dir = mkdtemp();
		Bun.write(
			`${dir.path}/session.jsonl`,
			[
				JSON.stringify({ type: "compaction", id: "e1", parentId: null, summary: "..." }),
				makeLine("message", "toolResult", { toolName: "bash", isError: true }),
			].join("\n"),
		);

		const result = parseAgentSessionForToolFailures(`${dir.path}/session.jsonl`);
		expect(result).toBeDefined();
		expect(result!.entries).toHaveLength(1);
	});

	test("skips malformed JSON lines", () => {
		using dir = mkdtemp();
		Bun.write(
			`${dir.path}/session.jsonl`,
			["{invalid json}", makeLine("message", "toolResult", { toolName: "bash", isError: true })].join("\n"),
		);

		const result = parseAgentSessionForToolFailures(`${dir.path}/session.jsonl`);
		expect(result).toBeDefined();
		expect(result!.entries).toHaveLength(1);
	});

	test("returns undefined when session file is empty", () => {
		using dir = mkdtemp();
		Bun.write(`${dir.path}/session.jsonl`, "");
		expect(parseAgentSessionForToolFailures(`${dir.path}/session.jsonl`)).toBeUndefined();
	});

	test("reports multiple tool failures", () => {
		using dir = mkdtemp();
		Bun.write(
			`${dir.path}/session.jsonl`,
			[
				makeLine("message", "toolResult", { toolName: "bash", isError: true, details: { exitCode: 127 } }),
				makeLine("message", "toolResult", {
					toolName: "edit",
					isError: true,
					details: { stderr: "file not found" },
				}),
			].join("\n"),
		);

		const result = parseAgentSessionForToolFailures(`${dir.path}/session.jsonl`);
		expect(result!.entries).toHaveLength(2);
		expect(result!.summary).toBe("2 tool failure(s)");
	});

	test("ignores tool success entries (exitCode=0, isError=false)", () => {
		using dir = mkdtemp();
		Bun.write(
			`${dir.path}/session.jsonl`,
			[
				makeLine("message", "toolResult", {
					toolName: "bash",
					isError: false,
					details: { exitCode: 0, stdout: "ok" },
				}),
				makeLine("message", "toolResult", { toolName: "bash", isError: true, details: { exitCode: 1 } }),
			].join("\n"),
		);

		const result = parseAgentSessionForToolFailures(`${dir.path}/session.jsonl`);
		expect(result!.entries).toHaveLength(1);
		expect(result!.entries[0].toolName).toBe("bash");
	});
});

/** Create a disposable temp directory (avoids manual cleanup in afterEach). */
function mkdtemp(): { path: string; [Symbol.dispose](): void } {
	const dir = require("node:fs").mkdtempSync("/tmp/diag-test-");
	return {
		path: dir,
		[Symbol.dispose]() {
			require("node:fs").rmSync(dir, { recursive: true, force: true });
		},
	};
}
