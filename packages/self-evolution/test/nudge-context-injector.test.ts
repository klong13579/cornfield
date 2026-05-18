import { describe, expect, test } from "bun:test";
import {
	buildNudgeContextUserMessage,
	formatNudgeContextContent,
	formatPendingNudgesContextContent,
} from "../src/nudge-context-injector";
import { TraceRecorder } from "../src/trace";
import type { Nudge } from "../src/types";

const sampleNudge: Nudge = {
	type: "error-cascade",
	severity: "warn",
	message: "3+ consecutive tool failures detected.",
	suggestion: "Verify paths exist before reading or editing.",
};

describe("nudge-context-injector", () => {
	test("formatNudgeContextContent includes message, suggestion, and pattern type", () => {
		const text = formatNudgeContextContent(sampleNudge);
		expect(text).toContain("Evolution Nudge");
		expect(text).toContain("error-cascade");
		expect(text).toContain(sampleNudge.message);
		expect(text).toContain(sampleNudge.suggestion);
	});

	test("buildNudgeContextUserMessage returns undefined when queue is empty", () => {
		expect(buildNudgeContextUserMessage([] as never)).toBeUndefined();
	});

	test("formatPendingNudgesContextContent joins multiple nudges", () => {
		const text = formatPendingNudgesContextContent([
			sampleNudge,
			{ ...sampleNudge, type: "slow-loop", message: "spinning" },
		]);
		expect(text).toContain("error-cascade");
		expect(text).toContain("slow-loop");
	});
});

describe("TraceRecorder pending agent nudges", () => {
	test("queues nudge on checkForNudges and drains once for context injection", () => {
		const recorder = new TraceRecorder();
		recorder.onAgentStart({ type: "agent_start" }, {
			cwd: "/test",
			sessionManager: { getSessionId: () => "s1" },
		} as never);

		for (let i = 0; i < 3; i++) {
			recorder.onToolExecutionStart({
				type: "tool_execution_start",
				toolCallId: String(i),
				toolName: "read",
				args: {},
			} as never);
			recorder.onToolExecutionEnd({
				type: "tool_execution_end",
				toolCallId: String(i),
				toolName: "read",
				result: "ENOENT",
				isError: true,
			} as never);
		}

		const nudge = recorder.checkForNudges();
		expect(nudge?.type).toBe("error-cascade");
		recorder.enqueuePendingAgentNudge(nudge!, "test-history-1");

		const firstDrain = recorder.drainPendingAgentNudges();
		expect(firstDrain).toHaveLength(1);
		expect(firstDrain[0]!.nudge.type).toBe("error-cascade");

		expect(recorder.drainPendingAgentNudges()).toHaveLength(0);
	});
});
