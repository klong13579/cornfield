import { describe, expect, test } from "bun:test";
import { formatFixtureToolChainSummary } from "../src/regression/fixture-tool-chain";
import {
	fixtureReplayResultFromInterpretation,
	interpretSubagentReplayOutcome,
	parseReplayVerdictFromResponse,
} from "../src/regression/replay-contract";
import type { RegressionFixture } from "../src/types";

describe("formatFixtureToolChainSummary", () => {
	test("renders ordered tool calls and error results", () => {
		const fixture: RegressionFixture = {
			id: "fx",
			sessionId: "s",
			episodeId: "e",
			cwd: "/p",
			userPrompt: "fix",
			errorCount: 1,
			completedSuccessfully: false,
			entries: [
				{ type: "tool_call", timestamp: 1, toolName: "read", args: { path: "x.ts" } },
				{ type: "tool_result", timestamp: 2, toolName: "read", result: "ENOENT", isError: true },
			],
			createdAt: Date.now(),
		};
		const summary = formatFixtureToolChainSummary(fixture);
		expect(summary).toContain("→ read");
		expect(summary).toContain("[ERROR]");
		expect(summary).toContain("ENOENT");
	});
});

describe("parseReplayVerdictFromResponse", () => {
	test("rejects passed when addresses_dominant_error is false", () => {
		const result = parseReplayVerdictFromResponse(
			'{"passed": true, "addresses_dominant_error": false, "reason": "Only style guidance."}',
		);
		expect(result?.passed).toBe(false);
		expect(result?.reason).toContain("dominant error");
	});
});

describe("interpretSubagentReplayOutcome", () => {
	test("maps VERDICT line to passed result", () => {
		const out = interpretSubagentReplayOutcome({
			exitCode: 0,
			combinedOutput: "Would help.\nVERDICT: KEEP\n",
		});
		expect(out.status).toBe("verdict");
		expect(fixtureReplayResultFromInterpretation(out)?.passed).toBe(true);
	});

	test("timeout when exit code is -1", () => {
		expect(interpretSubagentReplayOutcome({ exitCode: -1, combinedOutput: "" }).status).toBe("timeout");
	});

	test("spawn_error on non-zero exit with empty output", () => {
		expect(interpretSubagentReplayOutcome({ exitCode: 1, combinedOutput: "   " }).status).toBe("spawn_error");
	});
});
