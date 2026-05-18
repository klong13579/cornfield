import { describe, expect, test } from "bun:test";
import {
	applyNudgeContextArm,
	formatNudgeAbReportMarkdown,
	mockAgentNextToolAfterContext,
	runNudgeContextAbReport,
	scorePostNudgeTraceEntries,
} from "../src/nudge-context-ab";
import type { Nudge } from "../src/types";

const sampleNudge: Nudge = {
	type: "error-cascade",
	severity: "warn",
	message: "3+ consecutive tool failures detected.",
	suggestion: "Verify paths exist before reading or editing.",
};

describe("AB-02: Nudge context injection", () => {
	test("control omits nudge marker, treatment includes it", () => {
		const base = [{ role: "user", content: "fix bug" }];
		const control = applyNudgeContextArm(base, [], "control");
		const treatment = applyNudgeContextArm(base, [sampleNudge], "treatment");

		expect(control.some(m => m.content.includes("Evolution Nudge"))).toBe(false);
		expect(treatment.some(m => m.content.includes("Evolution Nudge"))).toBe(true);
		expect(treatment.length).toBe(base.length + 1);
	});

	test("mock agent picks guided tool only when nudge is in context", () => {
		const without = [{ role: "user", content: "fix bug" }];
		const withNudge = [
			...without,
			{
				role: "user",
				content:
					"[Evolution Nudge — Warning]\nSuggestion: Verify paths exist before reading. Use find to list matching files first.",
			},
		];

		expect(mockAgentNextToolAfterContext(without)).toBe("read");
		expect(mockAgentNextToolAfterContext(withNudge)).toBe("find");
	});

	test("full AB report: injection delivery and treatment wins on triggered scenarios", () => {
		const report = runNudgeContextAbReport();

		expect(report.summary.scenarioCount).toBe(5);
		expect(report.summary.nudgeTriggeredCount).toBeGreaterThanOrEqual(4);
		expect(report.summary.injectionDeliveryRate).toBe(1);
		expect(report.summary.mockBehaviorWinRate).toBe(1);

		const errorCascade = report.scenarios.find(s => s.scenarioId === "error-cascade");
		expect(errorCascade?.treatmentWins).toBe(true);
		expect(errorCascade?.control.mockNextTool).toBe("read");
		expect(errorCascade?.treatment.mockNextTool).toBe("find");

		const markdown = formatNudgeAbReportMarkdown(report);
		expect(markdown).toContain("Nudge Context Injection A/B Report");
		expect(markdown).toContain("error-cascade");
	});

	test("post-nudge trace compliance scorer", () => {
		const compliant = scorePostNudgeTraceEntries(sampleNudge, [
			{ type: "tool_call", timestamp: 1, toolName: "find", args: {} },
		]);
		const nonCompliant = scorePostNudgeTraceEntries(sampleNudge, [
			{ type: "tool_call", timestamp: 1, toolName: "read", args: {} },
		]);

		expect(compliant.compliant).toBe(true);
		expect(nonCompliant.compliant).toBe(false);
	});
});
