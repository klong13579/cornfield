import { describe, expect, spyOn, test } from "bun:test";
import { LlmRegressionReplayBackend } from "../src/regression/replay-backend";
import { parseReplayVerdictFromResponse } from "../src/regression/replay-llm";
import { clearRegressionReplayRuntime, setRegressionReplayRuntime } from "../src/regression/replay-runtime";
import type { Convention, RegressionFixture, TraceEntry } from "../src/types";
import * as llmModule from "../src/utils/llm";

describe("parseReplayVerdictFromResponse", () => {
	test("parses JSON passed verdict", () => {
		const result = parseReplayVerdictFromResponse('{"passed": true, "reason": "Addresses ENOENT before read."}');
		expect(result?.passed).toBe(true);
		expect(result?.reason).toContain("ENOENT");
	});

	test("parses VERDICT line from sub-agent style output", () => {
		const result = parseReplayVerdictFromResponse("The rule would help.\n\nVERDICT: DISCARD\n");
		expect(result?.passed).toBe(false);
	});
});

describe("LlmRegressionReplayBackend", () => {
	const fixture: RegressionFixture = {
		id: "fx-1",
		sessionId: "s1",
		episodeId: "e1",
		cwd: "/proj",
		userPrompt: "read config",
		errorCount: 1,
		completedSuccessfully: false,
		dominantErrorTool: "read",
		dominantErrorPattern: "ENOENT",
		entries: [
			{ type: "tool_result", timestamp: 2, toolName: "read", result: "ENOENT", isError: true },
		] as TraceEntry[],
		createdAt: Date.now(),
	};

	const convention: Convention = {
		id: "c1",
		type: "negative_rule",
		content: "Verify paths exist before read.",
		sourceEpisodeId: "e1",
		confidence: 80,
		timesApplied: 5,
		timesViolated: 0,
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
		lifecycleState: "candidate",
	};

	test("uses LLM verdict when model returns JSON", async () => {
		const spy = spyOn(llmModule, "callBackgroundLlm").mockResolvedValue(
			'{"passed": false, "reason": "Unrelated to read errors."}',
		);
		setRegressionReplayRuntime({
			model: { provider: "openai", id: "test", api: "openai-completions" } as import("@oh-my-pi/pi-ai").Model,
		});
		const backend = new LlmRegressionReplayBackend();
		const result = await backend.evaluateConventionOnFixture(convention, fixture);
		expect(result.passed).toBe(false);
		expect(result.reason).toContain("Unrelated");
		spy.mockRestore();
		clearRegressionReplayRuntime();
	});

	test("falls back to heuristic when LLM returns empty", async () => {
		const spy = spyOn(llmModule, "callBackgroundLlm").mockResolvedValue("");
		setRegressionReplayRuntime({
			model: { provider: "openai", id: "test", api: "openai-completions" } as import("@oh-my-pi/pi-ai").Model,
		});
		const backend = new LlmRegressionReplayBackend();
		const result = await backend.evaluateConventionOnFixture(convention, fixture);
		expect(result.passed).toBe(true);
		spy.mockRestore();
		clearRegressionReplayRuntime();
	});
});
