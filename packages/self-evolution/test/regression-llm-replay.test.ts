import { describe, expect, spyOn, test } from "bun:test";
import { LlmRegressionReplayBackend } from "../src/regression/replay-backend";
import { parseReplayVerdictFromResponse } from "../src/regression/replay-llm";
import { clearRegressionReplayRuntime, setRegressionReplayRuntime } from "../src/regression/replay-runtime";
import type { EvolvedSkill, RegressionFixture, TraceEntry } from "../src/types";
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

	const skill: EvolvedSkill = {
		name: "safe-read",
		description: "Read files safely",
		taskPattern: "read before edit",
		approach: "Verify paths exist before read.",
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

	test("uses LLM verdict when model returns JSON", async () => {
		const spy = spyOn(llmModule, "callBackgroundLlm").mockResolvedValue(
			'{"passed": false, "reason": "Unrelated to read errors."}',
		);
		setRegressionReplayRuntime({
			model: { provider: "openai", id: "test", api: "openai-completions" } as import("@oh-my-pi/pi-ai").Model,
		});
		const backend = new LlmRegressionReplayBackend();
		const result = await backend.evaluateSkillOnFixture(skill, fixture);
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
		const result = await backend.evaluateSkillOnFixture(skill, fixture);
		expect(result.passed).toBe(true);
		spy.mockRestore();
		clearRegressionReplayRuntime();
	});
});
