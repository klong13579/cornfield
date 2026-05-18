import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { countPostToolCalls, NudgeEffectivenessTracker } from "../src/nudge-effectiveness";
import { initSchema } from "../src/storage/db";
import { SqliteNudgeHistoryStore } from "../src/storage/nudge-history";
import type { SessionTrace } from "../src/types";

function makeTrace(sessionId: string): SessionTrace {
	return {
		sessionId,
		cwd: "/p",
		userPrompt: "fix",
		startTime: 0,
		endTime: 5000,
		entries: [
			{ type: "tool_call", timestamp: 100, toolName: "read" },
			{ type: "tool_result", timestamp: 200, toolName: "read", result: "ok", isError: false },
			{ type: "tool_call", timestamp: 1500, toolName: "edit" },
		],
		toolCallCount: 2,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
	};
}

describe("nudge outcome backfill", () => {
	test("finalizeSession scores injected nudges missing from active tracker", async () => {
		const db = new Database(":memory:");
		initSchema(db);
		const store = new SqliteNudgeHistoryStore(db);
		await store.insert({
			id: "n-backfill",
			sessionId: "sess-a",
			project: "/p",
			type: "slow-loop",
			severity: "warn",
			message: "m",
			suggestion: "s",
			detectedAt: 50,
		});
		await store.markContextInjected(["n-backfill"], 1000);

		const tracker = new NudgeEffectivenessTracker();
		await tracker.finalizeSession(makeTrace("sess-a"), store);

		const row = await store.get("n-backfill");
		expect(row?.outcomeRecordedAt).toBeDefined();
		expect(row?.outcomeScore).toBeDefined();
		expect(row?.postToolCalls).toBe(1);
	});

	test("countPostToolCalls counts only after injection timestamp", () => {
		const trace = makeTrace("sess-b");
		expect(countPostToolCalls(trace, 1000)).toBe(1);
		expect(countPostToolCalls(trace, 2000)).toBe(0);
	});
});
