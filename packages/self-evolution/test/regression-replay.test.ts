import { describe, expect, test } from "bun:test";
import { buildRegressionFixtureFromTrace } from "../src/regression/fixture-from-trace";
import { evaluateSkillOnFixture, runSkillRegressionGate } from "../src/regression/replay";
import type { EvolvedSkill, RegressionFixture, SessionTrace, TraceEntry } from "../src/types";

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	return {
		sessionId: "s1",
		cwd: "/proj",
		userPrompt: "read config",
		startTime: 1,
		endTime: 2,
		entries: [],
		toolCallCount: 1,
		errorCount: 1,
		hadRecovery: false,
		completedSuccessfully: false,
		...overrides,
	};
}

function skill(name: string, body: string): EvolvedSkill {
	return {
		name,
		description: body,
		taskPattern: body,
		approach: body,
		tools: ["read"],
		pitfalls: [],
		createdAt: Date.now(),
		usageCount: 0,
		lastUsedAt: 0,
		successCount: 0,
		failureCount: 0,
		version: 1,
		deprecated: false,
	};
}

describe("regression fixture from trace", () => {
	test("creates fixture only for failed sessions", () => {
		const trace = makeTrace({
			entries: [
				{ type: "tool_result", timestamp: 2, toolName: "read", result: "ENOENT", isError: true },
			] as TraceEntry[],
		});
		const fixture = buildRegressionFixtureFromTrace(trace, "ep1");
		expect(fixture).toBeDefined();
		expect(fixture?.dominantErrorTool).toBe("read");
	});

	test("skips successful sessions", () => {
		const trace = makeTrace({ completedSuccessfully: true, errorCount: 0 });
		expect(buildRegressionFixtureFromTrace(trace, "ep1")).toBeNull();
	});
});

const readEnoentFixture: RegressionFixture = {
	id: "fx-1",
	sessionId: "s1",
	episodeId: "e1",
	cwd: "/proj",
	userPrompt: "read config",
	errorCount: 1,
	completedSuccessfully: false,
	dominantErrorTool: "read",
	dominantErrorPattern: "ENOENT",
	entries: [{ type: "tool_result", timestamp: 2, toolName: "read", result: "ENOENT", isError: true }] as TraceEntry[],
	createdAt: Date.now(),
};

describe("regression replay skill", () => {
	test("passes when skill addresses path/read errors", () => {
		const s = skill("safe-read", "Verify paths exist before read.");
		expect(evaluateSkillOnFixture(s, readEnoentFixture).passed).toBe(true);
	});

	test("fails when skill is unrelated", () => {
		const s = skill("unrelated", "Always use tabs for indentation.");
		expect(evaluateSkillOnFixture(s, readEnoentFixture).passed).toBe(false);
	});
});

describe("regression gate keep/discard", () => {
	test("keep when majority of fixtures pass", () => {
		const s = skill("safe-read", "Verify paths exist before read.");
		const result = runSkillRegressionGate(s, [readEnoentFixture, readEnoentFixture], { minPassRate: 0.5 });
		expect(result.verdict).toBe("keep");
	});

	test("discard when no fixtures", () => {
		const s = skill("safe-read", "Verify paths exist before read.");
		const result = runSkillRegressionGate(s, [], { minPassRate: 0.6 });
		expect(result.verdict).toBe("discard");
	});
});
