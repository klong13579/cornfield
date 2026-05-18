import { describe, expect, test } from "bun:test";
import {
	classifyLearningLifecycle,
	isLearningEligibleForInjection,
	validateLearningContent,
} from "../src/learning-admission";
import type { Learning } from "../src/types";

function learning(overrides: Partial<Learning> = {}): Learning {
	return {
		id: "lrn_test",
		cwd: "/proj",
		kind: "preference",
		content: "Always ask before running destructive commands",
		source: "session_llm",
		confidence: 5,
		lifecycle: "candidate",
		sessionId: "ep1",
		createdAt: 1,
		updatedAt: 1,
		timesInjected: 0,
		timesHelped: 0,
		timesIgnored: 0,
		...overrides,
	};
}

describe("learning-admission", () => {
	test("rejects tool-failure template content", () => {
		expect(validateLearningContent("bash 失败后不要立即用 read 补救")).toBe(false);
	});

	test("manual_pin is always injectable", () => {
		expect(isLearningEligibleForInjection(learning({ source: "manual_pin", lifecycle: "active" }))).toBe(true);
	});

	test("promotes to active after helpful injections", () => {
		const l = learning({
			timesInjected: 5,
			timesHelped: 4,
			timesIgnored: 0,
			confidence: 5,
		});
		expect(classifyLearningLifecycle(l)).toBe("active");
		expect(isLearningEligibleForInjection({ ...l, lifecycle: "active" })).toBe(true);
	});
});
