import { describe, expect, it } from "bun:test";
import { checkLearningRelevance } from "../src/learning-relevance";
import type { Learning, SessionTrace } from "../src/types";

function makeLearning(kind: Learning["kind"], content: string): Learning {
	return {
		id: `lrn_${Bun.hash(content).toString(36)}`,
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

function makeTrace(userPrompt: string, entries: SessionTrace["entries"], opts?: { errorCount?: number }): SessionTrace {
	const toolCallCount = entries.filter(e => e.type === "tool_call").length;
	const errorCount = opts?.errorCount ?? 0;
	return {
		sessionId: "s1",
		cwd: "/test",
		userPrompt,
		startTime: 0,
		endTime: 1000,
		entries,
		toolCallCount,
		errorCount,
		hadRecovery: false,
		completedSuccessfully: toolCallCount > 0 && errorCount === 0,
	};
}

/** Simulate the agent_end feedback loop */
function simulateFeedback(
	learnings: Learning[],
	trace: SessionTrace,
): { helped: string[]; ignored: string[]; skipped: string[] } {
	const helped: string[] = [];
	const ignored: string[] = [];
	const skipped: string[] = [];

	const isTrivialSession = trace.toolCallCount === 0 && trace.errorCount === 0;
	if (isTrivialSession) {
		return { helped: [], ignored: [], skipped: learnings.map(l => l.id) };
	}

	const sessionHelped = trace.completedSuccessfully && trace.errorCount === 0;
	for (const learning of learnings) {
		const { score, shouldRecord } = checkLearningRelevance(learning, trace);
		if (!shouldRecord) {
			skipped.push(learning.id);
			continue;
		}
		if (sessionHelped) {
			helped.push(learning.id);
		} else {
			ignored.push(learning.id);
		}
	}

	return { helped, ignored, skipped };
}

describe("learning feedback integration — positive correlation", () => {
	it("preference: dws rule + dws tool call = helped", () => {
		const l = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const trace = makeTrace("Read this DingTalk doc", [
			{ type: "tool_call", timestamp: 100, toolName: "dws", args: { action: "doc" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toContain(l.id);
		expect(ignored).toHaveLength(0);
		expect(skipped).toHaveLength(0);
	});

	it("procedure: alidocs steps + dws calls = helped", () => {
		const l = makeLearning(
			"procedure",
			"遇到 alidocs 链接时，先用 dws doc info 获取文档类型。如果是 AI 多维表，使用 dws aitable 命令。",
		);
		const trace = makeTrace("Check this alidocs link", [
			{ type: "tool_call", timestamp: 100, toolName: "dws", args: { action: "doc", sub: "info" } },
			{ type: "tool_call", timestamp: 200, toolName: "dws", args: { action: "aitable" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toContain(l.id);
		expect(ignored).toHaveLength(0);
		expect(skipped).toHaveLength(0);
	});

	it("fact: person name in prompt = helped", () => {
		const l = makeLearning("fact", "用户是彭梦龙，云鲸扫地机事业部总经理");
		const trace = makeTrace("彭梦龙请查看这个报告", [
			{ type: "tool_call", timestamp: 100, toolName: "read", args: { path: "/report.md" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toContain(l.id);
		expect(ignored).toHaveLength(0);
		expect(skipped).toHaveLength(0);
	});

	it("skill_hint: jq suggestion + jq usage = helped", () => {
		const l = makeLearning("skill_hint", "处理 JSON 数据时优先使用 jq 工具");
		const trace = makeTrace("Parse this JSON", [
			{ type: "tool_call", timestamp: 100, toolName: "jq", args: { query: ".foo" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toContain(l.id);
		expect(ignored).toHaveLength(0);
		expect(skipped).toHaveLength(0);
	});

	it("multiple relevant learnings: all get helped", () => {
		const l1 = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const l2 = makeLearning("procedure", "遇到 alidocs 链接时，先用 dws doc info 获取文档类型");
		const trace = makeTrace("Check this alidocs link", [
			{ type: "tool_call", timestamp: 100, toolName: "dws", args: { action: "doc", sub: "info" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l1, l2], trace);
		expect(helped).toHaveLength(2);
		expect(ignored).toHaveLength(0);
		expect(skipped).toHaveLength(0);
	});
});

describe("learning feedback integration — negative correlation", () => {
	it("preference: dws rule + only read tool = skipped", () => {
		const l = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const trace = makeTrace("Read this file", [
			{ type: "tool_call", timestamp: 100, toolName: "read", args: { path: "/foo" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toHaveLength(0);
		expect(ignored).toHaveLength(0);
		expect(skipped).toContain(l.id);
	});

	it("procedure: alidocs steps + only read tool = skipped", () => {
		const l = makeLearning(
			"procedure",
			"遇到 alidocs 链接时，先用 dws doc info 获取文档类型。如果是 AI 多维表，使用 dws aitable 命令。",
		);
		const trace = makeTrace("Read a local file", [
			{ type: "tool_call", timestamp: 100, toolName: "read", args: { path: "/foo" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toHaveLength(0);
		expect(ignored).toHaveLength(0);
		expect(skipped).toContain(l.id);
	});

	it("fact: person name + unrelated prompt = skipped", () => {
		const l = makeLearning("fact", "用户是彭梦龙，云鲸扫地机事业部总经理");
		const trace = makeTrace("Fix this TypeScript error", [
			{ type: "tool_call", timestamp: 100, toolName: "read", args: { path: "/src/foo.ts" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toHaveLength(0);
		expect(ignored).toHaveLength(0);
		expect(skipped).toContain(l.id);
	});

	it("trivial session (no tool calls): all skipped regardless of relevance", () => {
		const l1 = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const l2 = makeLearning("fact", "用户是彭梦龙");
		const trace = makeTrace("hi", []);
		const { helped, ignored, skipped } = simulateFeedback([l1, l2], trace);
		expect(helped).toHaveLength(0);
		expect(ignored).toHaveLength(0);
		expect(skipped).toHaveLength(2);
	});

	it("session with errors: relevant learning gets ignored (not helped)", () => {
		const l = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const trace = makeTrace(
			"Read this DingTalk doc",
			[{ type: "tool_call", timestamp: 100, toolName: "dws", args: { action: "doc" } }],
			{ errorCount: 1 },
		);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toHaveLength(0);
		expect(ignored).toContain(l.id);
		expect(skipped).toHaveLength(0);
	});
});

describe("learning feedback integration — mixed sessions", () => {
	it("relevant + irrelevant learnings in same session: only relevant gets feedback", () => {
		const relevant = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const irrelevant = makeLearning("fact", "用户是彭梦龙，云鲸扫地机事业部总经理");
		const trace = makeTrace("Read this DingTalk doc", [
			{ type: "tool_call", timestamp: 100, toolName: "dws", args: { action: "doc" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([relevant, irrelevant], trace);
		expect(helped).toContain(relevant.id);
		expect(helped).not.toContain(irrelevant.id);
		expect(skipped).toContain(irrelevant.id);
		expect(ignored).toHaveLength(0);
	});

	it("multiple irrelevant learnings: all skipped", () => {
		const l1 = makeLearning("preference", "所有 DingTalk 链接必须使用 dws CLI 工具处理");
		const l2 = makeLearning("procedure", "遇到 alidocs 链接时，先用 dws doc info 获取文档类型");
		const l3 = makeLearning("fact", "用户是彭梦龙，云鲸扫地机事业部总经理");
		const trace = makeTrace("Fix TypeScript compilation errors", [
			{ type: "tool_call", timestamp: 100, toolName: "read", args: { path: "/src/error.ts" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l1, l2, l3], trace);
		expect(helped).toHaveLength(0);
		expect(ignored).toHaveLength(0);
		expect(skipped).toHaveLength(3);
	});

	it("complex session with partial procedure match: procedure skipped if steps don't match enough", () => {
		const l = makeLearning(
			"procedure",
			"遇到 alidocs 链接时，先用 dws doc info 获取文档类型。如果是 AI 多维表，使用 aitable 命令。然后 validate 数据格式。再 export 结果。最后 convert 成 csv。",
		);
		// Only 1 of 5 steps match (dws doc info called, but no aitable/validate/export/convert)
		const trace = makeTrace("Check this alidocs link", [
			{ type: "tool_call", timestamp: 100, toolName: "dws", args: { action: "doc", sub: "info" } },
		]);
		const { helped, ignored, skipped } = simulateFeedback([l], trace);
		expect(helped).toHaveLength(0);
		expect(ignored).toHaveLength(0);
		expect(skipped).toContain(l.id);
	});
});
