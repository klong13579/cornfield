/**
 * Coverage tests for V2.1 architecture gaps identified in the test plan.
 *
 * Covers:
 * - ConventionStore: provenance-aware merge + monthly decay
 * - TraceAnalyzer: implicit signal extraction + trace enhancement
 * - FeedbackTracker: implicit signal detection
 * - InjectionFormatter: 7-layer injection + dynamic token budget
 * - SkillManager: variant synthesis
 */

import { describe, expect, test } from "bun:test";
import type { ImplicitConvention } from "@oh-my-pi/cognitive-coordination";
import { applyDecay, mergeConventions } from "../src/convention-store";
import { FeedbackTracker } from "../src/feedback-tracker";
import { InjectionFormatter } from "../src/injection-formatter";
import { TraceAnalyzer } from "../src/trace-analyzer";
import type { Convention, SessionTrace, TraceEntry } from "../src/types";

// ============================================================================
// Helpers
// ============================================================================

function makeConvention(overrides: Partial<Convention> = {}): Convention {
	return {
		id: overrides.id ?? "conv-1",
		type: overrides.type ?? "preference",
		content: overrides.content ?? "Use bun test",
		sourceEpisodeId: overrides.sourceEpisodeId ?? "ep-1",
		confidence: overrides.confidence ?? 80,
		timesApplied: overrides.timesApplied ?? 0,
		timesViolated: overrides.timesViolated ?? 0,
		createdAt: overrides.createdAt ?? Date.now(),
		lastSeenAt: overrides.lastSeenAt ?? Date.now(),
		provenance: overrides.provenance,
	};
}

function makeImplicitConvention(
	rule: string,
	confidence: number,
	provenance?: ImplicitConvention["provenance"],
	updatedAt?: number,
): ImplicitConvention {
	return { rule, confidence, provenance, updatedAt };
}

function makeTraceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
	return {
		type: overrides.type ?? "tool_call",
		timestamp: overrides.timestamp ?? Date.now(),
		toolName: overrides.toolName,
		args: overrides.args,
		result: overrides.result,
		isError: overrides.isError,
		content: overrides.content,
	};
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
	return {
		sessionId: overrides.sessionId ?? "s-1",
		cwd: overrides.cwd ?? "/test",
		userPrompt: overrides.userPrompt ?? "fix bug",
		startTime: overrides.startTime ?? Date.now() - 60000,
		endTime: overrides.endTime ?? Date.now(),
		entries: overrides.entries ?? [],
		toolCallCount: overrides.toolCallCount ?? 0,
		errorCount: overrides.errorCount ?? 0,
		hadRecovery: overrides.hadRecovery ?? false,
		completedSuccessfully: overrides.completedSuccessfully ?? true,
	};
}

// ============================================================================
// ConventionStore: provenance-aware merge + decay
// ============================================================================

describe("ConventionStore — provenance-aware merge", () => {
	test("higher provenance supersedes lower on merge", () => {
		const existing: ImplicitConvention[] = [makeImplicitConvention("use bun test", 60, "inferred")];
		const newOnes: ImplicitConvention[] = [makeImplicitConvention("use bun test", 50, "user_stated")];

		const merged = mergeConventions(existing, newOnes);
		expect(merged).toHaveLength(1);
		expect(merged[0].provenance).toBe("user_stated");
		// Confidence takes max of both when superseding
		expect(merged[0].confidence).toBe(60);
	});

	test("same provenance, higher confidence wins", () => {
		const existing: ImplicitConvention[] = [makeImplicitConvention("use bun test", 60, "implied")];
		const newOnes: ImplicitConvention[] = [makeImplicitConvention("use bun test", 90, "implied")];

		const merged = mergeConventions(existing, newOnes);
		expect(merged).toHaveLength(1);
		expect(merged[0].confidence).toBe(90);
	});

	test("same provenance, lower confidence does not replace", () => {
		const existing: ImplicitConvention[] = [makeImplicitConvention("use bun test", 90, "implied")];
		const newOnes: ImplicitConvention[] = [makeImplicitConvention("use bun test", 60, "implied")];

		const merged = mergeConventions(existing, newOnes);
		expect(merged).toHaveLength(1);
		expect(merged[0].confidence).toBe(90);
	});

	test("new conventions without conflict are added", () => {
		const existing: ImplicitConvention[] = [makeImplicitConvention("use bun test", 80, "implied")];
		const newOnes: ImplicitConvention[] = [makeImplicitConvention("prefer ast_grep", 70, "user_stated")];

		const merged = mergeConventions(existing, newOnes);
		expect(merged).toHaveLength(2);
	});

	test("updatedAt is set on merge", () => {
		const existing: ImplicitConvention[] = [makeImplicitConvention("use bun test", 80, "implied", 1000)];
		const newOnes: ImplicitConvention[] = [makeImplicitConvention("use bun test", 90, "user_stated")];

		const merged = mergeConventions(existing, newOnes);
		expect(merged[0].updatedAt).toBeDefined();
		expect(merged[0].updatedAt!).toBeGreaterThan(1000);
	});
});

describe("ConventionStore — monthly confidence decay", () => {
	test("applyDecay reduces confidence after time passes", () => {
		const convention = makeImplicitConvention(
			"use bun test",
			100,
			"user_stated",
			Date.now() - 31 * 24 * 60 * 60 * 1000,
		); // 31 days ago
		const decayed = applyDecay(convention, Date.now());
		// After 31 days with half-life of 30, should be ~100 * 0.5^(31/30) ≈ 48
		expect(decayed.confidence).toBeLessThan(60);
		expect(decayed.confidence).toBeGreaterThan(30);
	});

	test("applyDecay does not decay within first day", () => {
		const convention = makeImplicitConvention("use bun test", 100, "user_stated", Date.now() - 12 * 60 * 60 * 1000); // 12 hours ago
		const decayed = applyDecay(convention, Date.now());
		expect(decayed.confidence).toBe(100);
	});

	test("applyDecay has floor of 1", () => {
		const convention = makeImplicitConvention(
			"use bun test",
			10,
			"user_stated",
			Date.now() - 365 * 24 * 60 * 60 * 1000,
		); // 1 year ago
		const decayed = applyDecay(convention, Date.now());
		expect(decayed.confidence).toBeGreaterThanOrEqual(1);
	});

	test("applyDecay does nothing when no updatedAt", () => {
		const convention = makeImplicitConvention("use bun test", 100);
		const decayed = applyDecay(convention, Date.now());
		expect(decayed).toBe(convention);
	});
});

// ============================================================================
// TraceAnalyzer: implicit signals + trace enhancement
// ============================================================================

describe("TraceAnalyzer — implicit signal extraction", () => {
	const analyzer = new TraceAnalyzer();

	test("detects user manual revert when same file edited twice", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "tool_call", toolName: "edit", args: { path: "src/foo.ts" } }),
				makeTraceEntry({ type: "tool_result", result: "ok", isError: false }),
				makeTraceEntry({ type: "tool_call", toolName: "edit", args: { path: "src/foo.ts" } }),
				makeTraceEntry({ type: "tool_result", result: "ok", isError: false }),
			],
			toolCallCount: 2,
		});

		const diagnosis = analyzer.analyze(trace);
		expect(diagnosis.implicitSignals).toBeDefined();
		expect(diagnosis.implicitSignals!.userRevertedEdit).toBe(true);
	});

	test("detects duplicate requests", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "user_input", content: "fix the bug" }),
				makeTraceEntry({ type: "user_input", content: "fix the bug" }),
			],
		});

		const diagnosis = analyzer.analyze(trace);
		expect(diagnosis.implicitSignals).toBeDefined();
		expect(diagnosis.implicitSignals!.duplicateRequestCount).toBe(2);
		expect(diagnosis.implicitSignals!.duplicateRequestText).toBe("fix the bug");
	});

	test("detects same tool consecutive failures", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "tool_call", toolName: "read" }),
				makeTraceEntry({ type: "tool_result", result: "ENOENT", isError: true }),
				makeTraceEntry({ type: "tool_call", toolName: "read" }),
				makeTraceEntry({ type: "tool_result", result: "ENOENT", isError: true }),
				makeTraceEntry({ type: "tool_call", toolName: "read" }),
				makeTraceEntry({ type: "tool_result", result: "ENOENT", isError: true }),
			],
			toolCallCount: 3,
			errorCount: 3,
		});

		const diagnosis = analyzer.analyze(trace);
		expect(diagnosis.implicitSignals).toBeDefined();
		expect(diagnosis.implicitSignals!.consecutiveFailureTools.length).toBeGreaterThanOrEqual(1);
		expect(diagnosis.implicitSignals!.consecutiveFailureTools[0].tool).toBe("read");
		expect(diagnosis.implicitSignals!.consecutiveFailureTools[0].count).toBeGreaterThanOrEqual(3);
	});

	test("detects user acceptance without correction", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "tool_call", toolName: "edit", args: { path: "src/foo.ts" } }),
				makeTraceEntry({ type: "tool_result", result: "ok", isError: false }),
			],
			toolCallCount: 1,
		});

		const diagnosis = analyzer.analyze(trace);
		expect(diagnosis.implicitSignals).toBeDefined();
		expect(diagnosis.implicitSignals!.userAcceptedWithoutCorrection).toBe(true);
	});
});

describe("TraceAnalyzer — trace enhancement", () => {
	const analyzer = new TraceAnalyzer();

	test("captures last 3 assistant messages", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "assistant_message", content: "msg 1" }),
				makeTraceEntry({ type: "assistant_message", content: "msg 2" }),
				makeTraceEntry({ type: "assistant_message", content: "msg 3" }),
				makeTraceEntry({ type: "assistant_message", content: "msg 4" }),
			],
		});

		const diagnosis = analyzer.analyze(trace);
		expect(diagnosis.traceEnhancement).toBeDefined();
		expect(diagnosis.traceEnhancement!.lastAssistantMessages).toHaveLength(3);
		expect(diagnosis.traceEnhancement!.lastAssistantMessages[0]).toBe("msg 2");
		expect(diagnosis.traceEnhancement!.lastAssistantMessages[2]).toBe("msg 4");
	});

	test("records model errors", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "model_error", content: "rate limit exceeded" }),
				makeTraceEntry({ type: "model_error", content: "invalid api key" }),
			],
		});

		const diagnosis = analyzer.analyze(trace);
		expect(diagnosis.traceEnhancement).toBeDefined();
		expect(diagnosis.traceEnhancement!.modelErrors).toHaveLength(2);
		expect(diagnosis.traceEnhancement!.modelErrors[0].content).toBe("rate limit exceeded");
	});

	test("truncates tool results", () => {
		const longResult = "x".repeat(3000);
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "tool_call", toolName: "read", args: { path: "/test" } }),
				makeTraceEntry({ type: "tool_result", result: longResult }),
			],
			toolCallCount: 1,
		});

		const diagnosis = analyzer.analyze(trace);
		expect(diagnosis.traceEnhancement).toBeDefined();
		expect(diagnosis.traceEnhancement!.truncatedToolResults).toHaveLength(1);
		expect(diagnosis.traceEnhancement!.truncatedToolResults[0].resultSnippet.length).toBeLessThanOrEqual(2048);
		expect(diagnosis.traceEnhancement!.truncatedToolResults[0].toolName).toBe("read");
	});
});

// ============================================================================
// FeedbackTracker: implicit signal detection
// ============================================================================

describe("FeedbackTracker — implicit signal detection", () => {
	// Create a minimal mock store for FeedbackTracker
	const mockStore = {
		recordInjection: async (_id: string) => {},
		recordOutcome: async (_id: string, _ok: boolean) => {},
		get: async (_id: string) => undefined,
	};
	const tracker = new FeedbackTracker(mockStore as any, mockStore as any);

	test("detects user acceptance without follow-up corrections → +0.05", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "tool_call", toolName: "edit", args: { path: "src/foo.ts" } }),
				makeTraceEntry({ type: "tool_result", result: "ok", isError: false }),
			],
			toolCallCount: 1,
		});

		const result = tracker.detectImplicitSignals(trace, ["ep-1"]);
		expect(result.outcomeDeltas).toHaveLength(1);
		expect(result.outcomeDeltas[0].delta).toBe(0.05);
		expect(result.outcomeDeltas[0].episodeId).toBe("ep-1");
	});

	test("detects user manual revert → -0.15", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "tool_call", toolName: "edit", args: { path: "src/foo.ts" } }),
				makeTraceEntry({ type: "tool_result", result: "ok", isError: false }),
				makeTraceEntry({ type: "tool_call", toolName: "edit", args: { path: "src/foo.ts" } }),
				makeTraceEntry({ type: "tool_result", result: "ok", isError: false }),
			],
			toolCallCount: 2,
		});

		const result = tracker.detectImplicitSignals(trace, ["ep-1"]);
		// Both acceptance AND revert detected — revert delta takes effect
		const revertDeltas = result.outcomeDeltas.filter(d => d.delta === -0.15);
		expect(revertDeltas.length).toBeGreaterThanOrEqual(1);
	});

	test("detects duplicate requests → triggerMutation=true", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "user_input", content: "fix the bug please" }),
				makeTraceEntry({ type: "user_input", content: "fix the bug please" }),
			],
		});

		const result = tracker.detectImplicitSignals(trace, []);
		expect(result.triggerMutation).toBe(true);
		expect(result.mutationReason).toBeDefined();
		expect(result.mutationReason!).toContain("Duplicate request");
	});

	test("no injected episodes → no outcome deltas", () => {
		const trace = makeTrace({
			entries: [
				makeTraceEntry({ type: "tool_call", toolName: "edit", args: { path: "src/foo.ts" } }),
				makeTraceEntry({ type: "tool_result", result: "ok", isError: false }),
			],
			toolCallCount: 1,
		});

		const result = tracker.detectImplicitSignals(trace, []);
		expect(result.outcomeDeltas).toHaveLength(0);
	});
});

// ============================================================================
// InjectionFormatter: 7-layer injection + dynamic token budget
// ============================================================================

describe("InjectionFormatter — 7-layer injection", () => {
	const formatter = new InjectionFormatter();

	test("7-layer mode produces AGENTS.md as first layer", () => {
		const result = formatter.formatInjection([], [], [], undefined, undefined, {
			useSevenLayer: true,
			maxTokens: 2000,
		});
		expect(result).toContain("## AGENTS.md");
	});

	test("7-layer mode includes all expected layers", () => {
		const conventions: Convention[] = [makeConvention({ content: "Use bun test", confidence: 80 })];
		const skills = [{ name: "test-skill", taskPattern: "run tests", approach: "use bun test", qualityScore: 75 }];

		const result = formatter.formatInjection([], conventions, skills, undefined, undefined, {
			useSevenLayer: true,
			maxTokens: 2000,
		});

		expect(result).toContain("## AGENTS.md");
		expect(result).toContain("## Memory Summary");
		expect(result).toContain("## Conventions");
		expect(result).toContain("## Relevant Skills");
		expect(result).toContain("## Past Episodes");
	});

	test("dynamic token budget for refactoring task type", () => {
		const result = formatter.formatInjection([], [], [], undefined, undefined, {
			useSevenLayer: true,
			maxTokens: 1000,
			taskType: "refactoring",
		});
		// Should not crash and should produce output
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain("## AGENTS.md");
	});

	test("dynamic token budget for exploration task type", () => {
		const result = formatter.formatInjection([], [], [], undefined, undefined, {
			useSevenLayer: true,
			maxTokens: 1000,
			taskType: "exploration",
		});
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain("## AGENTS.md");
	});

	test("skills sorted by qualityScore descending", () => {
		const skills = [
			{ name: "low", taskPattern: "low", approach: "low", qualityScore: 30 },
			{ name: "high", taskPattern: "high", approach: "high", qualityScore: 90 },
			{ name: "mid", taskPattern: "mid", approach: "mid", qualityScore: 60 },
		];

		const result = formatter.formatInjection([], [], skills, undefined, undefined, {
			useSevenLayer: true,
			maxTokens: 500,
		});

		const highIdx = result.indexOf("high");
		const midIdx = result.indexOf("mid");
		const lowIdx = result.indexOf("low");

		expect(highIdx).toBeLessThan(midIdx);
		expect(midIdx).toBeLessThan(lowIdx);
	});

	test("legacy mode still works correctly", () => {
		const conventions: Convention[] = [makeConvention({ content: "Short rule", confidence: 90 })];
		const result = formatter.formatInjection([], conventions, []);
		expect(result).toContain("## Project Conventions");
		expect(result).toContain("Short rule");
		expect(result.length).toBeLessThan(2000);
		expect(result).not.toContain("AGENTS.md");
	});

	test("7-layer mode truncates at token limit", () => {
		const conventions: Convention[] = [];
		for (let i = 0; i < 100; i++) {
			conventions.push(
				makeConvention({
					content: `Very long convention text number ${i} that will definitely exceed any reasonable token limit`,
					confidence: 80,
				}),
			);
		}

		const result = formatter.formatInjection([], conventions, [], undefined, undefined, {
			useSevenLayer: true,
			maxTokens: 500, // 2000 chars
		});

		expect(result.length).toBeLessThanOrEqual(2100);
		expect(result).toContain("... (truncated");
	});
});

// ============================================================================
// SkillManager: variant synthesis
// ============================================================================

describe("SkillManager — variant synthesis", () => {
	test("synthesizeVariant is exported and callable", async () => {
		// We verify the method exists and has correct signature.
		// Full integration test requires DB setup — covered by e2e-skill-evolution.test.ts.
		const { SkillManager } = await import("../src/manager");
		expect(SkillManager.prototype.synthesizeVariant).toBeDefined();
		expect(typeof SkillManager.prototype.synthesizeVariant).toBe("function");
	});
});
