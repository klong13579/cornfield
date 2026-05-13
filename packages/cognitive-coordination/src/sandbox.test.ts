import { describe, expect, test } from "bun:test";
import { validateSkill } from "./sandbox";
import type { UnifiedSkill } from "./types";

describe("validateSkill (Virtual Sandbox)", () => {
	const makeSkill = (name: string, content: string, description?: string): UnifiedSkill => ({
		id: `evolution_extraction:${name}`,
		source: "evolution_extraction",
		name,
		content,
		confidenceScore: 0.8,
		lastUsedAt: Date.now(),
		version: "1.0",
		status: "active",
		metadata: { description },
	});

	test("skill with fix keywords + error log → passes (scoreDelta > 0)", () => {
		// Skill content must share words with log for relevance > 0.1
		// AND contain fix/avoid/ensure for error correlation
		const skill = makeSkill(
			"error-handler",
			"Always fix the root cause before patching. Error handling is critical. Ensure proper timeout handling to avoid bash failures.",
		);
		const logContent = JSON.stringify({
			type: "tool_result",
			toolName: "bash",
			isError: true,
			error: "timeout failed with error code 1",
		});

		const report = validateSkill(skill, logContent);

		expect(report.passed).toBe(true);
		expect(report.scoreDelta).toBe(0.15);
		expect(report.reason).toContain("addresses errors");
	});

	test("relevant skill + successful log → passes (positive reinforcement)", () => {
		const skill = makeSkill("read-tool", "Read files carefully before editing.");
		const logContent = JSON.stringify({
			type: "tool_result",
			toolName: "read",
			result: "Read src/main.ts successfully",
		});

		const report = validateSkill(skill, logContent);

		expect(report.passed).toBe(true);
		// "read" appears in both skill and log → relevance > 0.1
		// No errors in log → scoreDelta = 0.05
		expect(report.scoreDelta).toBe(0.05);
		expect(report.reason).toContain("successful session");
	});

	test("irrelevant skill → decay (scoreDelta < 0)", () => {
		// Skill with words that don't appear in log
		const skill = makeSkill("python-debugging", "Check mypy type hints first. Fix pyright errors before committing.");
		const logContent = JSON.stringify({
			type: "tool_result",
			toolName: "read",
			result: "Read src/main.ts successfully",
		});

		const report = validateSkill(skill, logContent);

		expect(report.passed).toBe(false);
		expect(report.scoreDelta).toBe(-0.02);
		expect(report.reason).toContain("not relevant");
	});

	test("relevant skill + failed log without fix keywords → slight negative", () => {
		// Skill shares words with log but doesn't mention fix/avoid/ensure
		const skill = makeSkill("git-merge", "Use git merge for integrating branches. Resolve conflicts carefully.");
		const logContent = JSON.stringify({
			type: "tool_result",
			toolName: "bash",
			isError: true,
			error: "git merge conflict failed",
		});

		const report = validateSkill(skill, logContent);

		// "git" and "merge" appear in both → relevance > 0.1
		// hasErrors = true, but no fix/avoid/ensure → scoreDelta = -0.05
		expect(report.passed).toBe(false);
		expect(report.scoreDelta).toBe(-0.05);
		expect(report.reason).toContain("session failed");
	});

	test("report includes all required fields", () => {
		const skill = makeSkill("test-skill", "Test content here");
		const logContent = "some log content for testing";

		const report = validateSkill(skill, logContent);

		expect(report).toHaveProperty("skillId");
		expect(report).toHaveProperty("scoreDelta");
		expect(report).toHaveProperty("reason");
		expect(report).toHaveProperty("passed");
		expect(report.skillId).toBe("evolution_extraction:test-skill");
	});

	test("scoreDelta is within expected range (-1.0 to +1.0)", () => {
		const scenarios = [
			{ skill: makeSkill("fix-tool", "Fix and avoid errors at all costs"), log: '{"isError": true, "error": "crash"}' },
			{ skill: makeSkill("read-tool", "Read files before editing"), log: '{"toolName": "read", "result": "ok"}' },
			{ skill: makeSkill("python-fix", "Fix python type checking issues"), log: '{"isError": true}' },
			{ skill: makeSkill("unrelated", "something completely random here"), log: '{"result": "success"}' },
		];

		for (const { skill, log } of scenarios) {
			const report = validateSkill(skill, log);
			expect(report.scoreDelta).toBeGreaterThanOrEqual(-1.0);
			expect(report.scoreDelta).toBeLessThanOrEqual(1.0);
		}
	});

	test("empty log content → decay", () => {
		const skill = makeSkill("test-skill", "Some skill content here");

		const report = validateSkill(skill, "");

		expect(report.passed).toBe(false);
		expect(report.scoreDelta).toBe(-0.02);
	});

	test("skill with description is used for relevance matching", () => {
		const skill = makeSkill("typescript-tool", "Handle TS files and fix type errors. Ensure proper linting.", "TypeScript compilation and linting tools");
		const logContent = "typescript compilation failed with linting errors";

		const report = validateSkill(skill, logContent);

		// "typescript", "compilation", "linting" appear in both → relevance > 0.1
		// "fix" and "ensure" in content → mentionsFix = true
		// hasErrors = true (log contains "failed")
		expect(report.passed).toBe(true);
		expect(report.scoreDelta).toBe(0.15);
	});
});
