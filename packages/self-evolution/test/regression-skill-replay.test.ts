import { describe, expect, test } from "bun:test";
import { evaluateSkillOnFixture, runSkillRegressionGate } from "../src/regression/replay";
import type { EvolvedSkill, RegressionFixture, TraceEntry } from "../src/types";

function failedFixture(entries: TraceEntry[]): RegressionFixture {
	return {
		id: "fx1",
		sessionId: "s1",
		episodeId: "e1",
		cwd: "/tmp",
		userPrompt: "fix read error",
		errorCount: 1,
		completedSuccessfully: false,
		dominantErrorTool: "read",
		entries,
		createdAt: Date.now(),
	};
}

function skill(overrides: Partial<EvolvedSkill> = {}): EvolvedSkill {
	return {
		name: "path-verify",
		description: "Verify path exists before calling read",
		taskPattern: "read failures",
		approach: "Use find to confirm the file path before read when ENOENT occurs",
		tools: ["read", "find"],
		pitfalls: [],
		createdAt: Date.now(),
		usageCount: 1,
		lastUsedAt: Date.now(),
		successCount: 1,
		failureCount: 0,
		version: 1,
		...overrides,
	};
}

describe("skill regression replay", () => {
	test("passes when skill addresses ENOENT read failures", () => {
		const fx = failedFixture([
			{ type: "tool_result", toolName: "read", isError: true, result: "ENOENT", timestamp: 1 },
		]);
		const result = evaluateSkillOnFixture(skill(), fx);
		expect(result.passed).toBe(true);
	});

	test("gate keep when majority fixtures pass", () => {
		const fx = failedFixture([
			{ type: "tool_result", toolName: "read", isError: true, result: "ENOENT", timestamp: 1 },
		]);
		const gate = runSkillRegressionGate(skill(), [fx, fx, fx]);
		expect(gate.verdict).toBe("keep");
	});
});
