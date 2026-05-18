import { describe, expect, test } from "bun:test";
import { NudgeDetector } from "../src/nudge-detector";
import { crossSessionNudgeToNudge, NudgeSuppressionCache, shouldSuppressNudgeRecord } from "../src/nudge-suppression";
import { TraceRecorder } from "../src/trace";
import type { SessionTrace } from "../src/types";

describe("nudge-suppression", () => {
	test("shouldSuppressNudgeRecord respects acknowledge and dismiss cooldown", () => {
		const now = Date.now();
		expect(shouldSuppressNudgeRecord({ acknowledged: true } as never, now)).toBe(true);
		expect(shouldSuppressNudgeRecord({ dismissedAt: now - 1000 } as never, now)).toBe(true);
		expect(shouldSuppressNudgeRecord({ dismissedAt: now - 8 * 24 * 60 * 60 * 1000 } as never, now)).toBe(false);
	});

	test("NudgeSuppressionCache.refreshFromRecent builds suppressed type set", async () => {
		const store = {
			listRecent: async () => [
				{
					id: "1",
					sessionId: "s",
					project: "/p",
					type: "error-cascade",
					severity: "warn",
					message: "m",
					suggestion: "s",
					detectedAt: Date.now(),
					dismissedAt: Date.now(),
				},
			],
		};
		const cache = new NudgeSuppressionCache();
		await cache.refreshFromRecent(store as never, 10);
		expect(cache.isSuppressed("error-cascade")).toBe(true);
		expect(cache.isSuppressed("slow-loop")).toBe(false);
	});

	test("crossSessionNudgeToNudge maps fields", () => {
		const nudge = crossSessionNudgeToNudge({
			type: "cross-session-error-cascade",
			severity: "warn",
			message: "history",
			suggestion: "slow down",
			detectedAt: 1,
		});
		expect(nudge.type).toBe("cross-session-error-cascade");
		expect(nudge.message).toBe("history");
	});
});

describe("NudgeDetector per-type cooldown", () => {
	test("same type blocked within cooldown but different type can fire", () => {
		const detector = new NudgeDetector();
		const trace: SessionTrace = {
			sessionId: "s",
			cwd: "/t",
			userPrompt: "x",
			startTime: 0,
			endTime: 0,
			entries: [],
			toolCallCount: 6,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: false,
		};
		// slow-loop: 5+ tools, no file mod
		for (let i = 0; i < 5; i++) {
			trace.entries.push({
				type: "tool_call",
				timestamp: i,
				toolName: "grep",
				args: {},
			});
		}
		const first = detector.check(trace);
		expect(first?.type).toBe("slow-loop");

		const second = detector.check(trace);
		expect(second).toBeUndefined();
	});
});

describe("TraceRecorder turn dedup", () => {
	test("only one pending nudge per type per turn", () => {
		const recorder = new TraceRecorder();
		const nudge = {
			type: "error-cascade",
			severity: "warn" as const,
			message: "m",
			suggestion: "s",
		};
		expect(recorder.enqueuePendingAgentNudge(nudge, "h1")).toBe(true);
		expect(recorder.enqueuePendingAgentNudge(nudge, "h2")).toBe(false);
		recorder.beginTurn();
		expect(recorder.enqueuePendingAgentNudge(nudge, "h3")).toBe(true);
	});
});
