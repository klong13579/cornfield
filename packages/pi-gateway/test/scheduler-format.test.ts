/**
 * Unit tests for the cron list formatter.
 *
 * The formatter is what `cron list` renders. Two contracts:
 *   1. Every task row has a fixed column layout so columns line up across rows
 *      regardless of which fields are populated.
 *   2. The CHANNEL column shows the deliver target so a user can see at a
 *      glance which DingTalk bot the result will land in.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendDeliveryFailureLog, clearDeliveryFailureCache, setLogRoot } from "../src/scheduler/execution-log";
import type { ScheduledTask } from "../src/scheduler/types";
import {
	formatAgent,
	formatChannel,
	formatDeliveryFailureCount,
	formatTaskRow,
	truncateName,
} from "../src/scheduler/types";

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
		// Real data: tasks may store a user-routed deliver in the field itself.
		expect(formatChannel("dingtalk:user:601590212")).toBe("dingtalk:user:601590212");
	});

	it("does NOT include deliverUser in the cell (orthogonal field, use --json)", () => {
		// Regression: the first implementation tried to fold deliverUser into
		// the channel cell with an arrow separator, but that pushed the
		// NEXT RUN column. deliverUser is for proactive send only and is
		// available via --json.
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
		// last segment "way-too-long-account-id" is 23 chars, well over 12.
		const cell = formatAgent("~/.omp/agents/way-too-long-account-id");
		expect(cell.length).toBe(12);
		expect(cell.endsWith("\u2026")).toBe(true);
	});

	it("respects a custom max width", () => {
		// truncateName contract: first (max-1) chars + "…". For max=4
		// and last segment "ops-team" (8 chars), it returns "ops" + "…" = "ops…".
		expect(formatAgent("~/.omp/agents/ops-team", 4)).toBe("ops…");
	});

	it("returns the label as-is when it equals the max", () => {
		// "aaaaaaaaaaaaaaa" is 15 chars, exactly max=15.
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
		// Columns: NAME(21) TYPE(6) AGENT(12) STATUS(8) CRON(16)
		//          MODEL(15) REPEAT(7) CHANNEL(20) LAST(8) DELIV(8) NEXT RUN(21)
		// Total width: 21+1+6+1+12+1+8+1+16+1+15+1+7+1+20+1+8+1+8+1+21 = 152 chars
		const widths = [21, 6, 12, 8, 16, 15, 7, 20, 8, 8] as const;
		const splitByWidth = (row: string): string[] => {
			const out: string[] = [];
			let pos = 0;
			for (const w of widths) {
				out.push(row.slice(pos, pos + w));
				pos += w + 1; // +1 for the single-space separator
			}
			out.push(row.slice(pos)); // NEXT RUN is unpadded
			return out;
		};
		const counts = variants.map(t => splitByWidth(formatTaskRow(t)).length);
		// All rows should have the same field count. 10 fixed columns +
		// unpadded NEXT RUN tail = 11 fields.
		expect(new Set(counts).size).toBe(1);
		expect(counts[0]).toBe(11);
	});

	it("includes the deliver value in the rendered row", () => {
		const row = formatTaskRow(makeTask({ name: "x", deliver: "dingtalk:hr" }));
		expect(row).toContain("dingtalk:hr");
	});

	it("renders the long dingtalk:user:NNN form without truncation", () => {
		// Real data shape from the existing scheduler.db
		const row = formatTaskRow(makeTask({ name: "x", deliver: "dingtalk:user:601590212" }));
		expect(row).toContain("dingtalk:user:601590212");
	});

	it("renders an em-dash when deliver is unset (no blank cell)", () => {
		const row = formatTaskRow(makeTask({ name: "x" }));
		expect(row).toContain("—");
	});

	it("truncates over-long names with an ellipsis instead of overflowing the next column", () => {
		const row = formatTaskRow(makeTask({ name: "this-name-is-way-longer-than-eighteen-chars" }));
		// Truncation keeps the field count stable across all 10 fixed columns.
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
		// The truncated name contains an ellipsis.
		expect(row).toContain("\u2026");
		// And the original full name is NOT in the row (it was truncated).
		expect(row).not.toContain("eighteen-chars");
	});
	it("renders rows that match the table header width", () => {
		// Regression: the table header in cronList is built as
		// NAME(21) TYPE(6) AGENT(12) STATUS(8) CRON(16) MODEL(15)
		// REPEAT(7) CHANNEL(20) LAST(8) DELIV(8) NEXT RUN(21) = 152 chars.
		// formatTaskRow produces the same fixed prefix and appends
		// an unpadded NEXT RUN value. The header underline must equal
		// the header line length; rows extend past it for long
		// timestamps. This test pins the fixed prefix length so a
		// future padEnd change can't silently desync header and data.
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
		// For a task with no lastRunAt and no last failures, the
		// rendered row has the same length as the header (DELIV
		// column is "✓" — a single char; everything else is padded
		// to column width). Verify both line lengths match.
		const row = formatTaskRow(makeTask({ name: "x" }));
		expect(row.length).toBe(152);
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
		// AGENT is the 3rd column (index 2).
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
		// omp-atomix:wiki-changelog:01-算法模块 is 36 chars.
		const result = truncateName("omp-atomix:wiki-changelog:01-算法模块", 18);
		expect(result.length).toBe(18);
		expect(result.endsWith("\u2026")).toBe(true);
		// The leading prefix is preserved so users can still identify the task.
		expect(result.startsWith("omp-atomix:wiki")).toBe(true);
	});
});

describe("formatDeliveryFailureCount", () => {
	let tmpLogRoot: string;

	beforeEach(async () => {
		tmpLogRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-fmt-delivery-"));
		setLogRoot(tmpLogRoot);
		clearDeliveryFailureCache();
	});

	afterEach(async () => {
		clearDeliveryFailureCache();
		await fs.rm(tmpLogRoot, { recursive: true, force: true });
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
		// Insert an old failure (5 days ago) — should be filtered out by
		// the default 24h window.
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
		// And a recent one (1 minute ago).
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
		// Regression: the DELIVERY column must show the failure count
		// (or \u2713) so operators can see at a glance which tasks
		// are failing delivery without grepping the JSONL log.
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
