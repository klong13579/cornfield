import { describe, expect, test } from "bun:test";
import { validateLearningContent } from "../src/learning-admission";
import type { SessionTrace } from "../src/types";

describe("session-learner contract", () => {
	test("validates minimum content length for learnings", () => {
		expect(validateLearningContent("short")).toBe(false);
		expect(validateLearningContent("必须先向用户确认之后再执行任何破坏性 shell 操作")).toBe(true);
	});

	test("user explicit extractor respects cap", async () => {
		const { extractUserExplicitLearnings } = await import("../src/user-explicit-learnings");
		const trace: SessionTrace = {
			sessionId: "s1",
			cwd: "/proj",
			userPrompt: "请记住：改代码前必须先向我确认再执行任何破坏性操作",
			startTime: 1,
			endTime: 2,
			entries: [],
			toolCallCount: 1,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
		};
		const items = extractUserExplicitLearnings(trace, "ep1");
		expect(items.length).toBeGreaterThanOrEqual(1);
		expect(items[0]?.source).toBe("user_explicit");
		expect(items[0]?.confidence).toBeGreaterThanOrEqual(4);
	});
});
