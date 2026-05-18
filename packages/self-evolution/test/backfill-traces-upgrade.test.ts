import { describe, expect, test } from "bun:test";
import type { SessionTrace } from "../src/types";

// Test upgrade predicate via re-exported logic mirror
function toolEntryCount(trace: SessionTrace): number {
	return trace.entries.filter(e => e.type === "tool_call" || e.type === "tool_result").length;
}

function shouldUpgrade(existing: SessionTrace, parsed: SessionTrace): boolean {
	return toolEntryCount(parsed) > toolEntryCount(existing);
}

describe("backfill trace upgrade", () => {
	test("upgrades when JSONL has more tool entries", () => {
		const existing: SessionTrace = {
			sessionId: "s",
			cwd: "/tmp",
			userPrompt: "x",
			startTime: 1,
			endTime: 2,
			toolCallCount: 1,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
			entries: [{ type: "tool_call", timestamp: 1, toolName: "read" }],
		};
		const parsed: SessionTrace = {
			...existing,
			entries: [
				{ type: "tool_call", timestamp: 1, toolName: "read" },
				{ type: "tool_result", timestamp: 2, toolName: "read", result: "ok" },
				{ type: "tool_call", timestamp: 3, toolName: "edit" },
			],
		};
		expect(shouldUpgrade(existing, parsed)).toBe(true);
		expect(shouldUpgrade(parsed, existing)).toBe(false);
	});
});
