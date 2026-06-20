/**
 * Unit tests for the cron list formatter.
 *
 * The formatter is what `cron list` renders. Two contracts:
 *   1. Every task row has a fixed column layout so columns line up across rows
 *      regardless of which fields are populated.
 *   2. The CHANNEL column shows the deliver target so a user can see at a
 *      glance which DingTalk bot the result will land in.
 */
import { describe, expect, it } from "bun:test";
import type { ScheduledTask } from "../src/scheduler/types";
import { formatChannel, formatTaskRow, truncateName } from "../src/scheduler/types";

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
		];
		const counts = variants.map(t => formatTaskRow(t).split(/\s{2,}/).length);
		// All rows should have the same field count. If they don't, columns
		// will misalign across rows in the rendered table.
		expect(new Set(counts).size).toBe(1);
	});

	it("includes the deliver value in the rendered row", () => {
		const row = formatTaskRow(makeTask({ name: "x", deliver: "dingtalk:hr" }));
		expect(row).toContain("dingtalk:hr");
	});

	it("renders the long dingtalk:user:NNN form without truncation", () => {
		// Real data shape from the existing scheduler.db
		const row = formatTaskRow(
			makeTask({ name: "x", deliver: "dingtalk:user:601590212" }),
		);
		expect(row).toContain("dingtalk:user:601590212");
	});

	it("renders an em-dash when deliver is unset (no blank cell)", () => {
		const row = formatTaskRow(makeTask({ name: "x" }));
		expect(row).toContain("—");
	});

	it("keeps the LAST RUN column at the end even when channel is at max width", () => {
		// Regression: an over-long channel value (longer than the padEnd
		// width) used to push the next column into the LAST RUN slot. After
		// the simplification (deliverUser is no longer inlined), the only
		// realistic value that could overflow is a pathologically long
		// deliver. The formatter must keep LAST RUN in the rightmost slot.
		const task = makeTask({
			deliver: "dingtalk:user:601590212",
		});
		const row = formatTaskRow(task);
		const fields = row.split(/\s{2,}/);
		const lastField = fields[fields.length - 1]!;
		expect(lastField).toBe("never"); // lastField is the LAST RUN timestamp
	});

	it("truncates over-long names with an ellipsis instead of overflowing the next column", () => {
		// Real data: omp-atomix:wiki-changelog:01-算法模块 is 36 chars.
		// Without truncation, the name would overflow into the TYPE column.
		const row = formatTaskRow(makeTask({ name: "this-name-is-way-longer-than-eighteen-chars" }));
		const fields = row.split(/\s{2,}/);
		// Truncation keeps the field count stable.
		expect(fields.length).toBe(8);
		// The truncated name contains an ellipsis.
		expect(row).toContain("\u2026");
		// And the original full name is NOT in the row (it was truncated).
		expect(row).not.toContain("eighteen-chars");
	});

	it("renders rows with a fixed leading width of 130 chars (matches the table header)", () => {
		// Regression: the table header in cronList is built as 130 chars
		// (19+1+7+1+11+1+9+1+19+1+29+1+21+1+8 = 130, where 8 is "LAST RUN").
		// formatTaskRow produces the same fixed prefix and appends an
		// unpadded LAST RUN value. The header underline must equal the
		// header line length; rows can extend past it for long timestamps.
		// This test pins the fixed prefix length so a future padEnd change
		// can't silently desync header and data rows.
		const fixedWidth = 19 + 1 + 7 + 1 + 11 + 1 + 9 + 1 + 19 + 1 + 29 + 1 + 21;
		const header = "NAME".padEnd(19) + " " + "TYPE".padEnd(7) + " " + "STATUS".padEnd(11) + " " +
			"SCHED".padEnd(9) + " " + "CRON".padEnd(19) + " " + "CHANNEL".padEnd(29) + " " +
			"NEXT RUN".padEnd(21) + " " + "LAST RUN";
		expect(header.length).toBe(130);
		// For a task with no lastRunAt, the rendered row ends exactly at
		// the header width (no trailing LAST RUN characters).
		const row = formatTaskRow(makeTask({ name: "x" }));
		const lastFieldLen = row.split(/\s{2,}/).pop()!.length;
		expect(fixedWidth + 1 + lastFieldLen).toBe(row.length);
		// And a 21-char timestamp (typical toLocaleString) lands the row
		// at 130 + 21 = 151 chars — a stable upper bound for visual checks.
		const tsLen = "6/20/2026, 1:01:21 PM".length;
		expect(tsLen).toBe(21);
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
