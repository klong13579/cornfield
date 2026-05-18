import { describe, expect, test } from "bun:test";
import { applyToolChainCompareToVerdict, compareFixtureToReplayChain } from "../src/regression/compare-tool-chains";
import type { RegressionFixture } from "../src/types";

const fixture: RegressionFixture = {
	id: "fx",
	sessionId: "s",
	episodeId: "e",
	cwd: "/p",
	userPrompt: "read config",
	errorCount: 1,
	completedSuccessfully: false,
	dominantErrorTool: "read",
	dominantErrorPattern: "ENOENT",
	entries: [
		{ type: "tool_call", timestamp: 1, toolName: "read", args: {} },
		{ type: "tool_result", timestamp: 2, toolName: "read", result: "ENOENT", isError: true },
	],
	createdAt: Date.now(),
};

describe("compareFixtureToReplayChain", () => {
	test("detects avoided dominant error when replay uses different failing tool", () => {
		const compare = compareFixtureToReplayChain(fixture, [
			{ type: "tool_call", timestamp: 1, toolName: "find", args: {} },
			{ type: "tool_result", timestamp: 2, toolName: "find", result: "ok", isError: false },
			{ type: "tool_call", timestamp: 3, toolName: "read", args: {} },
			{ type: "tool_result", timestamp: 4, toolName: "read", result: "ok", isError: false },
		]);
		expect(compare.avoidedDominantError).toBe(true);
		expect(compare.replayFirstErrorTool).toBeUndefined();
	});

	test("detects repeated failure path", () => {
		const compare = compareFixtureToReplayChain(fixture, [
			{ type: "tool_call", timestamp: 1, toolName: "read", args: {} },
			{ type: "tool_result", timestamp: 2, toolName: "read", result: "ENOENT", isError: true },
		]);
		expect(compare.avoidedDominantError).toBe(false);
		expect(compare.score).toBe(1);
	});
});

describe("applyToolChainCompareToVerdict", () => {
	test("overturns KEEP when replay repeats same error chain", () => {
		const compare = compareFixtureToReplayChain(fixture, fixture.entries);
		const { result } = applyToolChainCompareToVerdict({ passed: true, reason: "LLM said keep" }, compare);
		expect(result.passed).toBe(false);
	});
});
