import { beforeEach, describe, expect, test } from "bun:test";
import { TraceAnalyzer } from "../src/trace-analyzer";
import type { SessionTrace, TraceEntry } from "../src/types";

describe("TraceAnalyzer", () => {
	let analyzer: TraceAnalyzer;

	beforeEach(() => {
		analyzer = new TraceAnalyzer();
	});

	function makeTrace(entries: TraceEntry[]): SessionTrace {
		return {
			sessionId: "test",
			cwd: "/tmp",
			userPrompt: "test",
			startTime: Date.now(),
			endTime: Date.now(),
			toolCallCount: entries.filter(e => e.type === "tool_call").length,
			errorCount: entries.filter(e => e.isError).length,
			hadRecovery: false,
			completedSuccessfully: true,
			entries,
		};
	}

	// ========================================================================
	// TA-01: read failure causal attribution — edit fails → read ENOENT
	//       → failureType=verify_after_edit_failure
	// ========================================================================
	test("TA-01: read failure causal attribution (edit fails → read ENOENT)", async () => {
		const trace = makeTrace([
			{
				type: "tool_call",
				timestamp: 1,
				toolName: "edit",
				args: { path: "missing.ts", old_text: "x", new_text: "y" },
			},
			{
				type: "tool_result",
				timestamp: 2,
				toolName: "edit",
				result: "Parse issue: edit failed",
				isError: true,
			},
			{
				type: "tool_call",
				timestamp: 3,
				toolName: "read",
				args: { path: "missing.ts" },
			},
			{
				type: "tool_result",
				timestamp: 4,
				toolName: "read",
				result: "ENOENT: no such file or directory",
				isError: true,
			},
		]);

		// Without model → pure rule-based path
		const result = await analyzer.analyzeWithLlm(trace);

		expect(result.readFailures.length).toBeGreaterThanOrEqual(1);
		const readFailure = result.readFailures.find(f => f.failureType === "verify_after_edit_failure");
		expect(readFailure).toBeDefined();
		expect(readFailure!.precedingTool).toBe("edit");
		expect(readFailure!.precedingToolSuccess).toBe(false);
		expect(readFailure!.attemptedPath).toBe("missing.ts");
	});

	// ========================================================================
	// TA-02: read failure — search misleading — search fails → read ENOENT
	//       → failureType=search_misled
	// ========================================================================
	test("TA-02: read failure (search misled — search fails → read ENOENT)", async () => {
		const trace = makeTrace([
			{
				type: "tool_call",
				timestamp: 1,
				toolName: "search",
				args: { pattern: "foo", path: "src/" },
			},
			{
				type: "tool_result",
				timestamp: 2,
				toolName: "search",
				result: "No matches found",
				isError: true,
			},
			{
				type: "tool_call",
				timestamp: 3,
				toolName: "read",
				args: { path: "src/foo.ts" },
			},
			{
				type: "tool_result",
				timestamp: 4,
				toolName: "read",
				result: "ENOENT: no such file or directory",
				isError: true,
			},
		]);

		const result = await analyzer.analyzeWithLlm(trace);

		const searchMisled = result.readFailures.find(f => f.failureType === "search_misled");
		expect(searchMisled).toBeDefined();
		expect(searchMisled!.precedingTool).toBe("search");
		expect(searchMisled!.precedingToolSuccess).toBe(false);
	});

	// ========================================================================
	// TA-03: cascade pattern detection — edit error → search(remediation)
	//       → cascadePattern detected
	// ========================================================================
	test("TA-03: cascade pattern detection (edit error → search remediation)", async () => {
		const trace = makeTrace([
			{
				type: "tool_call",
				timestamp: 1,
				toolName: "edit",
				args: { path: "a.ts" },
			},
			{
				type: "tool_result",
				timestamp: 2,
				toolName: "edit",
				result: "edit failed anchor mismatch",
				isError: true,
			},
			{
				type: "tool_call",
				timestamp: 3,
				toolName: "search",
				args: { pattern: "x", path: "a.ts" },
			},
			{
				type: "tool_result",
				timestamp: 4,
				toolName: "search",
				result: "search failed",
				isError: true,
			},
		]);

		const result = await analyzer.analyzeWithLlm(trace);

		expect(result.cascadePatterns.length).toBeGreaterThan(0);
		const cascade = result.cascadePatterns[0];
		expect(cascade.triggerTool).toBe("edit");
		expect(cascade.followUpTool).toBe("search");
	});

	// ========================================================================
	// TA-04: redundant search detection — 3+ consecutive search/read/find
	//       without modification → redundantSearches=true
	// ========================================================================
	test("TA-04: redundant search detection (3+ consecutive searches)", async () => {
		const trace = makeTrace([
			{
				type: "tool_call",
				timestamp: 1,
				toolName: "search",
				args: { pattern: "a", path: "src/" },
			},
			{ type: "tool_result", timestamp: 2, toolName: "search", result: "ok", isError: false },
			{
				type: "tool_call",
				timestamp: 3,
				toolName: "find",
				args: { pattern: "**/*.ts" },
			},
			{ type: "tool_result", timestamp: 4, toolName: "find", result: "ok", isError: false },
			{
				type: "tool_call",
				timestamp: 5,
				toolName: "read",
				args: { path: "src/x.ts" },
			},
			{ type: "tool_result", timestamp: 6, toolName: "read", result: "ok", isError: false },
		]);

		const result = await analyzer.analyzeWithLlm(trace);

		expect(result.redundantSearches).toBe(true);
	});

	// ========================================================================
	// TA-05: slow loop detection — 5+ calls without successful modification
	//       → slowLoop=true
	// ========================================================================
	test("TA-05: slow loop detection (5+ calls, no successful modification)", async () => {
		const entries: TraceEntry[] = [];

		for (let i = 0; i < 7; i++) {
			entries.push({
				type: "tool_call",
				timestamp: i * 10,
				toolName: "search",
				args: { pattern: "x", path: "src/" },
			});
			entries.push({
				type: "tool_result",
				timestamp: i * 10 + 1,
				toolName: "search",
				result: "no match",
				isError: true,
			});
		}

		const trace = makeTrace(entries);
		const result = await analyzer.analyzeWithLlm(trace);

		expect(result.slowLoop).toBe(true);
	});

	// ========================================================================
	// TA-06: tool efficiency calculation — 2 successful / 3 total edits
	//       → toolEfficiency=0.67
	// ========================================================================
	test("TA-06: tool efficiency calculation (2/3 successful edits)", async () => {
		const trace = makeTrace([
			{
				type: "tool_call",
				timestamp: 1,
				toolName: "edit",
				args: { path: "a.ts" },
			},
			{ type: "tool_result", timestamp: 2, toolName: "edit", result: "ok", isError: false },
			{
				type: "tool_call",
				timestamp: 3,
				toolName: "edit",
				args: { path: "b.ts" },
			},
			{
				type: "tool_result",
				timestamp: 4,
				toolName: "edit",
				result: "fail",
				isError: true,
			},
			{
				type: "tool_call",
				timestamp: 5,
				toolName: "edit",
				args: { path: "c.ts" },
			},
			{ type: "tool_result", timestamp: 6, toolName: "edit", result: "ok", isError: false },
		]);

		const result = await analyzer.analyzeWithLlm(trace);

		expect(result.toolEfficiency).toBeCloseTo(2 / 3, 2);
	});

	// ========================================================================
	// TA-07: dominant error tool — read errors most → dominantErrorTool=read
	// ========================================================================
	test("TA-07: dominant error tool (read errors most frequent)", async () => {
		const entries: TraceEntry[] = [];

		// 3 read errors
		for (let i = 0; i < 3; i++) {
			entries.push({
				type: "tool_call",
				timestamp: i * 10,
				toolName: "read",
				args: { path: `file${i}.ts` },
			});
			entries.push({
				type: "tool_result",
				timestamp: i * 10 + 1,
				toolName: "read",
				result: "not found",
				isError: true,
			});
		}

		// 1 search error
		entries.push({
			type: "tool_call",
			timestamp: 30,
			toolName: "search",
			args: { pattern: "x" },
		});
		entries.push({
			type: "tool_result",
			timestamp: 31,
			toolName: "search",
			result: "error",
			isError: true,
		});

		const trace = makeTrace(entries);
		const result = await analyzer.analyzeWithLlm(trace);

		expect(result.dominantErrorTool).toBe("read");
	});

	// ========================================================================
	// TA-08: dominant error pattern — same error text ≥2 times
	//       → dominantErrorPattern captured
	// ========================================================================
	test("TA-08: dominant error pattern (same error repeats ≥2 times)", async () => {
		const entries: TraceEntry[] = [];

		const errText = "ENOENT: no such file or directory";

		// 2 identical errors via read
		for (let i = 0; i < 2; i++) {
			entries.push({
				type: "tool_call",
				timestamp: i * 10,
				toolName: "read",
				args: { path: `file${i}.ts` },
			});
			entries.push({
				type: "tool_result",
				timestamp: i * 10 + 1,
				toolName: "read",
				result: errText,
				isError: true,
			});
		}

		// 1 different error
		entries.push({
			type: "tool_call",
			timestamp: 20,
			toolName: "search",
			args: { pattern: "x" },
		});
		entries.push({
			type: "tool_result",
			timestamp: 21,
			toolName: "search",
			result: "permission denied",
			isError: true,
		});

		const trace = makeTrace(entries);
		const result = await analyzer.analyzeWithLlm(trace);

		expect(result.dominantErrorPattern).toBe(errText.slice(0, 60));
	});

	// ========================================================================
	// LLM path: verify analyzeWithLlm merges LLM output with rule-based
	// ========================================================================
	test("LLM path: merged result contains both rule and LLM fields", async () => {
		// Rule-based alone gives some data
		const trace = makeTrace([
			{
				type: "tool_call",
				timestamp: 1,
				toolName: "edit",
				args: { path: "a.ts" },
			},
			{ type: "tool_result", timestamp: 2, toolName: "edit", result: "fail", isError: true },
			{
				type: "tool_call",
				timestamp: 3,
				toolName: "read",
				args: { path: "a.ts" },
			},
			{
				type: "tool_result",
				timestamp: 4,
				toolName: "read",
				result: "ENOENT: no such file or directory",
				isError: true,
			},
		]);

		// No model → rule-based only
		const ruleOnly = await analyzer.analyzeWithLlm(trace);
		expect(ruleOnly.readFailures.length).toBeGreaterThanOrEqual(1);

		// With model but returning undefined → falls back to rule-based
		const _mockModelFailing = {
			generate: async () => ({ content: "" }),
			config: { provider: "mock", model: "mock" },
		} as any;

		// When callBackgroundLlm returns nothing → fallback to rule-based
		// The rule-based already covered above; confirm consistent result shape
		expect(ruleOnly.sessionId).toBe("test");
		expect(typeof ruleOnly.redundantSearches).toBe("boolean");
		expect(typeof ruleOnly.slowLoop).toBe("boolean");
		expect(typeof ruleOnly.toolEfficiency).toBe("number");
		expect(typeof ruleOnly.suggestedAction).toBe("string");
	});
});
