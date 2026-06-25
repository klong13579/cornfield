import { describe, expect, it } from "bun:test";
import { checkLearningRelevance, _testing } from "../src/learning-relevance";
import type { Learning, SessionTrace } from "../src/types";

function makeLearning(kind: Learning["kind"], content: string): Learning {
	return {
		id: "lrn_test",
		cwd: "/test",
		kind,
		content,
		source: "agent_written",
		confidence: 5,
		lifecycle: "active",
		scope: "project",
		sessionId: "",
		createdAt: 0,
		updatedAt: 0,
		timesInjected: 0,
		timesHelped: 0,
		timesIgnored: 0,
	};
}

function makeTrace(userPrompt: string, entries: SessionTrace["entries"]): SessionTrace {
	return {
		sessionId: "s1",
		cwd: "/test",
		userPrompt,
		startTime: 0,
		endTime: 1000,
		entries,
		toolCallCount: entries.filter(e => e.type === "tool_call").length,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
	};
}

describe("checkLearningRelevance", () => {
	it("preference: relevant when tool mentioned is used", () => {
		const l = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const trace = makeTrace("Read this DingTalk doc", [
			{ type: "tool_call", timestamp: 100, toolName: "dws", args: { action: "doc" } },
		]);
		const { score, shouldRecord } = checkLearningRelevance(l, trace);
		expect(shouldRecord).toBe(true);
		expect(score).toBeGreaterThan(0.25);
	});

	it("preference: irrelevant when unrelated tool is used", () => {
		const l = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const trace = makeTrace("Read this file", [
			{ type: "tool_call", timestamp: 100, toolName: "read", args: { path: "/foo" } },
		]);
		const { shouldRecord } = checkLearningRelevance(l, trace);
		expect(shouldRecord).toBe(false);
	});

	it("procedure: relevant when steps match", () => {
		const l = makeLearning(
			"procedure",
			"遇到 alidocs 链接时，先用 dws doc info 获取文档类型。如果是 AI 多维表，使用 dws aitable 命令。",
		);
		const trace = makeTrace("Check this alidocs link", [
			{ type: "tool_call", timestamp: 100, toolName: "dws", args: { action: "doc", sub: "info" } },
			{ type: "tool_call", timestamp: 200, toolName: "dws", args: { action: "aitable" } },
		]);
		const { score, shouldRecord } = checkLearningRelevance(l, trace);
		expect(shouldRecord).toBe(true);
		expect(score).toBeGreaterThan(0.25);
	});

	it("fact: relevant when entity appears in prompt", () => {
		const l = makeLearning("fact", "用户是彭梦龙，云鲸扫地机事业部总经理");
		const trace = makeTrace("彭梦龙请查看这个报告", []);
		const { score, shouldRecord } = checkLearningRelevance(l, trace);
		expect(shouldRecord).toBe(true);
		expect(score).toBeGreaterThan(0.25);
	});

	it("fact: irrelevant when no overlap", () => {
		const l = makeLearning("fact", "用户是彭梦龙，云鲸扫地机事业部总经理");
		const trace = makeTrace("Fix this TypeScript error", [
			{ type: "tool_call", timestamp: 100, toolName: "read", args: { path: "/src/foo.ts" } },
		]);
		const { shouldRecord } = checkLearningRelevance(l, trace);
		expect(shouldRecord).toBe(false);
	});

	it("skill_hint: relevant when suggested tool is used", () => {
		const l = makeLearning("skill_hint", "处理 JSON 数据时优先使用 jq 工具");
		const trace = makeTrace("Parse this JSON", [
			{ type: "tool_call", timestamp: 100, toolName: "jq", args: { query: ".foo" } },
		]);
		const { shouldRecord } = checkLearningRelevance(l, trace);
		expect(shouldRecord).toBe(true);
	});

	it("procedure: irrelevant when no tools match", () => {
		const l = makeLearning("procedure", "遇到 alidocs 链接时，先用 dws doc info 获取文档类型");
		const trace = makeTrace("Read a local file", [
			{ type: "tool_call", timestamp: 100, toolName: "read", args: { path: "/foo" } },
		]);
		const { shouldRecord } = checkLearningRelevance(l, trace);
		expect(shouldRecord).toBe(false);
	});
});

describe("extractChineseEntities", () => {
	it("extracts 2-4 char phrases from Chinese text", () => {
		const entities = _testing.extractChineseEntities("用户是彭梦龙");
		expect(entities).toContain("彭梦");
		expect(entities).toContain("梦龙");
		expect(entities).toContain("彭梦龙");
	});
});

describe("extractTerms", () => {
	it("extracts tool names from mixed text", () => {
		const terms = _testing.extractTerms("使用 dws 工具处理 doc 文件");
		expect(terms).toContain("dws");
		expect(terms).toContain("doc");
	});
});
