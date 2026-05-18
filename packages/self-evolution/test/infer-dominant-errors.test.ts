import { describe, expect, test } from "bun:test";
import { inferDominantErrorsFromTrace, inferToolHintFromUserPrompt } from "../src/trace-analyzer";
import type { SessionTrace } from "../src/types";

describe("inferDominantErrorsFromTrace", () => {
	test("falls back to user prompt tool hint when trace entries are empty", () => {
		const trace: SessionTrace = {
			sessionId: "s1",
			cwd: "/tmp",
			userPrompt: "Use only the read tool. Read /tmp/missing.ts",
			startTime: 1,
			endTime: 2,
			toolCallCount: 0,
			errorCount: 1,
			hadRecovery: false,
			completedSuccessfully: false,
			entries: [],
		};
		expect(inferToolHintFromUserPrompt(trace.userPrompt)).toBe("read");
		expect(inferDominantErrorsFromTrace(trace).dominantErrorTool).toBe("read");
	});
});
