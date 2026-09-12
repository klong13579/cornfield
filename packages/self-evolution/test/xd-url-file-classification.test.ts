import { describe, expect, test } from "bun:test";
import { FeedbackTracker } from "../src/feedback-tracker";
import { isInternalUrlPath } from "../src/internal-url-path";
import type { EffectivenessStore, SkillEffectivenessStore } from "../src/storage/types";
import { summarizeTrace } from "../src/trace";
import { TraceAnalyzer } from "../src/trace-analyzer";
import type { SessionTrace, TraceEntry } from "../src/types";

function makeTrace(entries: TraceEntry[]): SessionTrace {
	return {
		sessionId: "s1",
		cwd: "/test",
		userPrompt: "run a mounted device",
		startTime: 0,
		endTime: 1000,
		entries,
		toolCallCount: entries.filter(e => e.type === "tool_call").length,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
	};
}

/** Build a call/result pair for a write that executed an xd:// device. */
function xdWriteCall(name: string, isError = false): TraceEntry[] {
	return [
		{ type: "tool_call", timestamp: 0, toolName: "write", args: { path: `xd://${name}`, content: "{}" } },
		{ type: "tool_result", timestamp: 1, toolName: "write", result: {}, isError },
	];
}

class StubEffectivenessStore implements EffectivenessStore {
	async get() {
		return undefined;
	}
	async getMany() {
		return [];
	}
	async recordInjection() {}
	async recordOutcome() {}
}

class StubSkillEffectivenessStore implements SkillEffectivenessStore {
	async get() {
		return undefined;
	}
	async recordInjection() {}
	async recordOutcome() {}
}

describe("internal URL paths are not file modifications (xd:// transport)", () => {
	test("summarizeTrace excludes xd:// and other internal URLs from filesModified", () => {
		const trace = makeTrace([
			{ type: "tool_call", timestamp: 0, toolName: "write", args: { path: "src/Button.tsx" } },
			{ type: "tool_call", timestamp: 1, toolName: "write", args: { path: "xd://web_search", content: "{}" } },
			{ type: "tool_call", timestamp: 2, toolName: "write", args: { path: "agent://output", content: "{}" } },
		]);

		const { filesModified } = summarizeTrace(trace);
		expect(filesModified).toContain("src/Button.tsx");
		expect(filesModified).not.toContain("xd://web_search");
		expect(filesModified).not.toContain("agent://output");
	});

	test("TraceAnalyzer does not count xd:// device execution as a file modification", () => {
		// Five successful xd:// writes and one real file write that failed → the
		// only *successful file modification* is none, so slowLoop must be true
		// and efficiency must be computed over real-file writes only.
		const entries: TraceEntry[] = [
			...xdWriteCall("a"),
			...xdWriteCall("b"),
			...xdWriteCall("c"),
			...xdWriteCall("d"),
			...xdWriteCall("e"),
			{ type: "tool_call", timestamp: 0, toolName: "write", args: { path: "src/Real.tsx" } },
			{ type: "tool_result", timestamp: 1, toolName: "write", result: {}, isError: true },
		];
		const diagnosis = new TraceAnalyzer().analyze(makeTrace(entries));

		expect(diagnosis.slowLoop).toBe(true);
		expect(diagnosis.toolEfficiency).toBe(0);
	});

	test("TraceAnalyzer does not attribute xd:// writes as a user revert of a file", () => {
		const entries: TraceEntry[] = [...xdWriteCall("web_search"), ...xdWriteCall("web_search")];
		const diagnosis = new TraceAnalyzer().analyze(makeTrace(entries));

		expect(diagnosis.implicitSignals?.userRevertedEdit).toBe(false);
	});

	test("FeedbackTracker does not emit a revert delta for xd:// writes to the same device", () => {
		const tracker = new FeedbackTracker(new StubEffectivenessStore(), new StubSkillEffectivenessStore());
		const trace = makeTrace([
			{ type: "tool_call", timestamp: 0, toolName: "write", args: { path: "xd://web_search", content: "{}" } },
			{ type: "tool_call", timestamp: 1, toolName: "write", args: { path: "xd://web_search", content: "{}" } },
		]);

		const result = tracker.detectImplicitSignals(trace, ["ep-1"]);
		const revertDelta = result.outcomeDeltas.find(d => d.delta === -0.15);
		expect(revertDelta).toBeUndefined();
	});
});

describe("isInternalUrlPath", () => {
	test("matches internal URL schemes, rejects filesystem paths", () => {
		expect(isInternalUrlPath("xd://web_search")).toBe(true);
		expect(isInternalUrlPath("agent://output/0")).toBe(true);
		expect(isInternalUrlPath("skill://my-skill")).toBe(true);
		expect(isInternalUrlPath("mcp://server/tool")).toBe(true);
		expect(isInternalUrlPath("src/Button.tsx")).toBe(false);
		expect(isInternalUrlPath("/abs/path/file.ts")).toBe(false);
		expect(isInternalUrlPath("file.ts")).toBe(false);
	});

	test("trims surrounding whitespace before matching", () => {
		expect(isInternalUrlPath("  xd://web_search  ")).toBe(true);
		expect(isInternalUrlPath("  src/Button.tsx  ")).toBe(false);
	});
});
