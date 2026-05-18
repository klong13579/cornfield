import { describe, expect, test } from "bun:test";
import { ConventionComplianceChecker } from "../src/convention-compliance";
import type { Convention, SessionTrace } from "../src/types";

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	const entries: SessionTrace["entries"] = overrides.entries ?? [];
	return {
		sessionId: "test-session",
		cwd: "/test",
		userPrompt: overrides.userPrompt ?? "fix bug",
		startTime: 1000,
		endTime: 2000,
		entries,
		toolCallCount: entries.filter(e => e.type === "tool_call").length,
		errorCount: entries.filter(e => e.isError).length,
		hadRecovery: false,
		completedSuccessfully: true,
		...overrides,
	};
}

function makeConvention(id: string, type: Convention["type"], content: string): Convention {
	return {
		id,
		type,
		content,
		sourceEpisodeId: "ep-1",
		confidence: 80,
		timesApplied: 0,
		timesViolated: 0,
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
	};
}

describe("ConventionComplianceChecker", () => {
	const checker = new ConventionComplianceChecker();

	test("CC-01: negative_rule forbidden tool NOT detected — convention forbids console.log, trace uses bash", () => {
		const trace = makeTrace({
			entries: [{ type: "tool_call", timestamp: 1001, toolName: "bash", args: { cmd: "ls" } }],
		});
		const conventions = [makeConvention("c1", "negative_rule", "不要用 console.log")];
		const feedback = checker.check(trace, conventions);

		expect(feedback.length).toBe(1);
		expect(feedback[0]!.conventionId).toBe("c1");
		expect(feedback[0]!.complied).toBe(true);
		expect(feedback[0]!.violationDetails).toBeUndefined();
	});

	test("CC-02: negative_rule forbidden tool DETECTED — convention forbids bash, trace uses bash", () => {
		const trace = makeTrace({
			entries: [{ type: "tool_call", timestamp: 1001, toolName: "bash", args: { cmd: "ls" } }],
		});
		const conventions = [makeConvention("c1", "negative_rule", "不要用 bash")];
		const feedback = checker.check(trace, conventions);

		expect(feedback.length).toBe(1);
		expect(feedback[0]!.conventionId).toBe("c1");
		expect(feedback[0]!.complied).toBe(false);
		expect(feedback[0]!.violationDetails).toContain("Used forbidden tool: bash");
	});

	test("CC-03: negative_rule forbidden file — convention forbids config.yml, trace edits it", () => {
		const trace = makeTrace({
			entries: [
				{
					type: "tool_call",
					timestamp: 1001,
					toolName: "edit",
					args: { path: "config.yml", old_text: "old", new_text: "new" },
				},
			],
		});
		const conventions = [makeConvention("c1", "negative_rule", "不要修改 config.yml")];
		const feedback = checker.check(trace, conventions);

		expect(feedback.length).toBe(1);
		expect(feedback[0]!.conventionId).toBe("c1");
		expect(feedback[0]!.complied).toBe(false);
		expect(feedback[0]!.violationDetails).toContain("Modified forbidden file: config.yml");
	});

	test("CC-04: preference preferred tool NOT used — convention prefers ast_grep, trace only uses search", () => {
		const trace = makeTrace({
			entries: [{ type: "tool_call", timestamp: 1001, toolName: "search", args: { pattern: "foo", path: "src/" } }],
		});
		const conventions = [makeConvention("c1", "preference", "prefer ast_grep")];
		const feedback = checker.check(trace, conventions);

		expect(feedback.length).toBe(1);
		expect(feedback[0]!.conventionId).toBe("c1");
		expect(feedback[0]!.complied).toBe(false);
		expect(feedback[0]!.violationDetails).toContain("Did not use preferred tool: ast_grep");
	});

	test("CC-05: positive_rule required file not modified — convention references test/index.ts but only src/foo.ts is edited", () => {
		const trace = makeTrace({
			userPrompt: "必须先修改 test/app.test.ts 文件才能继续",
			entries: [
				{ type: "tool_call", timestamp: 1001, toolName: "read", args: { path: "src/foo.ts" } },
				{
					type: "tool_call",
					timestamp: 1002,
					toolName: "edit",
					args: { path: "src/foo.ts", old_text: "x", new_text: "y" },
				},
			],
		});
		const conventions = [makeConvention("c1", "positive_rule", "必须修改 test/app.test.ts")];
		const feedback = checker.check(trace, conventions);

		expect(feedback.length).toBe(1);
		expect(feedback[0]!.conventionId).toBe("c1");
		expect(feedback[0]!.complied).toBe(false);
		expect(feedback[0]!.violationDetails).toContain("Did not modify required file");
	});

	test("multiple conventions evaluated together", () => {
		const trace = makeTrace({
			entries: [
				{
					type: "tool_call",
					timestamp: 1001,
					toolName: "edit",
					args: { path: "bad.txt", old_text: "", new_text: "" },
				},
				{ type: "tool_call", timestamp: 1002, toolName: "bash", args: { cmd: "echo hi" } },
			],
		});
		const conventions = [
			makeConvention("c-bash", "negative_rule", "不要用 bash"),
			makeConvention("c-file", "negative_rule", "不要修改 bad.txt"),
		];
		const feedback = checker.check(trace, conventions);

		expect(feedback.length).toBe(2);
		expect(feedback.find(f => f.conventionId === "c-bash")!.complied).toBe(false);
		expect(feedback.find(f => f.conventionId === "c-file")!.complied).toBe(false);
	});

	test("negative_rule with both forbidden tool and file — only tool violated", () => {
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: 1001, toolName: "bash", args: { cmd: "ls" } },
				{ type: "tool_call", timestamp: 1002, toolName: "read", args: { path: "safe.txt" } },
			],
		});
		const conventions = [makeConvention("c1", "negative_rule", "不要用 bash，也不要修改 safe.txt")];
		const feedback = checker.check(trace, conventions);

		expect(feedback.length).toBe(1);
		expect(feedback[0]!.complied).toBe(false);
		expect(feedback[0]!.violationDetails).toContain("Used forbidden tool: bash");
	});

	test("preference not triggered when no tools used at all", () => {
		const trace = makeTrace({
			entries: [],
		});
		const conventions = [makeConvention("c1", "preference", "prefer ast_grep")];
		const feedback = checker.check(trace, conventions);

		expect(feedback.length).toBe(1);
		expect(feedback[0]!.complied).toBe(true);
	});

	test("filesModified matching is case-insensitive", () => {
		const trace = makeTrace({
			entries: [
				{ type: "tool_call", timestamp: 1001, toolName: "write", args: { path: "Config.YML", content: "x" } },
			],
		});
		const conventions = [makeConvention("c1", "negative_rule", "不要修改 config.yml")];
		const feedback = checker.check(trace, conventions);

		expect(feedback[0]!.complied).toBe(false);
	});

	test("tool call detection covers write, edit, and ast_edit for file modifications", () => {
		const trace = makeTrace({
			entries: [{ type: "tool_call", timestamp: 1001, toolName: "ast_edit", args: { path: "target.js", ops: [] } }],
		});
		const conventions = [makeConvention("c1", "negative_rule", "不要修改 target.js")];
		const feedback = checker.check(trace, conventions);

		expect(feedback[0]!.complied).toBe(false);
		expect(feedback[0]!.violationDetails).toContain("Modified forbidden file: target.js");
	});
});
