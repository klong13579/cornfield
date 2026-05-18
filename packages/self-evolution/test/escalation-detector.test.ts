import { describe, expect, test } from "bun:test";
import { detectEscalationCandidates } from "../src/escalation/detector";
import { errorPatternKey, regressionPatternKey } from "../src/escalation/pattern-key";
import type { Learning, RegressionFixture, RegressionTrial, TraceEntry } from "../src/types";

function fixture(id: string, pattern: string, tool = "read"): RegressionFixture {
	return {
		id,
		sessionId: `s-${id}`,
		episodeId: `e-${id}`,
		cwd: "/p",
		userPrompt: "x",
		errorCount: 1,
		completedSuccessfully: false,
		dominantErrorTool: tool,
		dominantErrorPattern: pattern,
		entries: [{ type: "tool_result", timestamp: 1, toolName: tool, result: pattern, isError: true } as TraceEntry],
		createdAt: Date.now(),
	};
}

function learning(overrides: Partial<Learning> = {}): Learning {
	const now = Date.now();
	return {
		id: "l1",
		cwd: "/p",
		kind: "procedure",
		content: "Verify paths exist before calling read; use find when the path is unknown.",
		source: "session_llm",
		confidence: 4,
		lifecycle: "active",
		sessionId: "s1",
		createdAt: now,
		updatedAt: now,
		timesInjected: 0,
		timesHelped: 0,
		timesIgnored: 0,
		...overrides,
	};
}

describe("escalation pattern keys", () => {
	test("stable key for same error pattern", () => {
		const f = fixture("a", "ENOENT: missing.ts");
		expect(regressionPatternKey(f)).toBe(regressionPatternKey(fixture("b", "ENOENT: missing.ts")));
	});

	test("error pattern id key prefix", () => {
		expect(errorPatternKey("file-not-found")).toBe("ep:file-not-found");
	});
});

describe("detectEscalationCandidates", () => {
	test("escalates recurring pattern without active fix", () => {
		const fixtures = [
			fixture("1", "ENOENT: missing.ts"),
			fixture("2", "ENOENT: missing.ts"),
			fixture("3", "ENOENT: missing.ts"),
		];
		const candidates = detectEscalationCandidates({
			fixtures,
			learnings: [],
			trials: [],
		});
		expect(candidates.length).toBe(1);
		expect(candidates[0]!.occurrenceCount).toBe(3);
	});

	test("no escalation when active learning addresses pattern", () => {
		const fixtures = [fixture("1", "ENOENT"), fixture("2", "ENOENT"), fixture("3", "ENOENT")];
		expect(
			detectEscalationCandidates({
				fixtures,
				learnings: [learning({ content: "Check ENOENT before read; verify paths exist." })],
				trials: [],
			}),
		).toHaveLength(0);
	});

	test("counts failed regression trials", () => {
		const fixtures = [fixture("1", "ENOENT"), fixture("2", "ENOENT"), fixture("3", "ENOENT")];
		const trials: RegressionTrial[] = [
			{
				id: "t1",
				targetType: "skill",
				targetId: "bad-skill",
				fixtureId: "1",
				verdict: "discard",
				reason: "no match",
				createdAt: Date.now(),
			},
		];
		const candidates = detectEscalationCandidates({
			fixtures,
			learnings: [learning({ lifecycle: "candidate", content: "Always use tabs instead of spaces." })],
			trials,
		});
		expect(candidates[0]!.failedImprovementCount).toBeGreaterThanOrEqual(1);
	});
});
