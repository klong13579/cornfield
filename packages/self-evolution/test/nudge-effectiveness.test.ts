import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { didNudgePatternRepeat, scoreNudgeOutcome, sliceTraceAfter } from "../src/nudge-effectiveness";
import { SqliteNudgeHistoryStore } from "../src/storage/nudge-history";
import type { SessionTrace } from "../src/types";

function openNudgeTestDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE nudge_history (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			project TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			severity TEXT NOT NULL,
			message TEXT NOT NULL,
			suggestion TEXT NOT NULL,
			detected_at INTEGER NOT NULL,
			dismissed_at INTEGER,
			acknowledged INTEGER NOT NULL DEFAULT 0,
			context_injected INTEGER NOT NULL DEFAULT 0,
			injected_at INTEGER,
			post_tool_calls INTEGER NOT NULL DEFAULT 0,
			pattern_repeated INTEGER NOT NULL DEFAULT 0,
			outcome_score REAL,
			outcome_recorded_at INTEGER
		)
	`);
	return db;
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	return {
		sessionId: "s1",
		cwd: "/t",
		userPrompt: "fix",
		startTime: 0,
		endTime: 1000,
		entries: [],
		toolCallCount: 0,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		...overrides,
	};
}

describe("nudge-effectiveness", () => {
	test("scoreNudgeOutcome penalizes repeated patterns", () => {
		expect(scoreNudgeOutcome(makeTrace(), true)).toBe(-0.6);
		expect(scoreNudgeOutcome(makeTrace({ completedSuccessfully: true, errorCount: 0 }), false)).toBe(0.5);
	});

	test("didNudgePatternRepeat detects slow-loop again", () => {
		const entries = [];
		for (let i = 0; i < 6; i++) {
			entries.push({ type: "tool_call" as const, timestamp: 100 + i, toolName: "grep", args: {} });
		}
		const slice = makeTrace({ entries, toolCallCount: 6 });
		expect(didNudgePatternRepeat("slow-loop", slice)).toBe(true);
	});

	test("SqliteNudgeHistoryStore records injection and outcome", async () => {
		const db = openNudgeTestDb();
		const store = new SqliteNudgeHistoryStore(db);
		await store.insert({
			id: "n1",
			sessionId: "s1",
			project: "/p",
			type: "error-cascade",
			severity: "warn",
			message: "m",
			suggestion: "s",
			detectedAt: Date.now(),
		});
		await store.markContextInjected(["n1"], 1000);
		await store.recordOutcome("n1", {
			postToolCalls: 3,
			patternRepeated: false,
			outcomeScore: 0.5,
		});
		const row = await store.get("n1");
		expect(row?.contextInjected).toBe(true);
		expect(row?.injectedAt).toBe(1000);
		expect(row?.outcomeScore).toBe(0.5);
		expect(row?.postToolCalls).toBe(3);
	});

	test("sliceTraceAfter filters entries by timestamp", () => {
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: 10, toolName: "read" },
				{ type: "tool_call", timestamp: 50, toolName: "edit" },
			],
			toolCallCount: 2,
		});
		const slice = sliceTraceAfter(trace, 40);
		expect(slice.entries).toHaveLength(1);
		expect(slice.entries[0]?.toolName).toBe("edit");
	});
});
