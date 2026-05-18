import { describe, expect, test } from "bun:test";
import { buildRegressionFixtureFromTrace } from "../src/regression/fixture-from-trace";
import { evaluateConventionOnFixture, runRegressionGate } from "../src/regression/replay";
import type { Convention, RegressionFixture, SessionTrace, TraceEntry } from "../src/types";

function failedTrace(entries: TraceEntry[]): SessionTrace {
	return {
		sessionId: "sess-1",
		cwd: "/proj",
		userPrompt: "fix the missing file read",
		startTime: 1000,
		endTime: 2000,
		entries,
		toolCallCount: 2,
		errorCount: 1,
		hadRecovery: false,
		completedSuccessfully: false,
		errorDetails: ["read: ENOENT: no such file"],
	};
}

function convention(content: string): Convention {
	return {
		id: "c1",
		type: "negative_rule",
		content,
		sourceEpisodeId: "ep1",
		confidence: 80,
		timesApplied: 6,
		timesViolated: 1,
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
		lifecycleState: "candidate",
	};
}

describe("regression fixture from trace", () => {
	test("creates fixture only for failed sessions", () => {
		const trace = failedTrace([
			{ type: "tool_call", timestamp: 1, toolName: "read", args: { path: "missing.ts" } },
			{ type: "tool_result", timestamp: 2, toolName: "read", result: "ENOENT", isError: true },
		]);
		const fixture = buildRegressionFixtureFromTrace(trace, "ep-1", {
			dominantErrorTool: "read",
			dominantErrorPattern: "ENOENT",
		});
		expect(fixture).not.toBeNull();
		expect(fixture!.dominantErrorTool).toBe("read");
		expect(fixture!.errorCount).toBe(1);
	});

	test("skips successful sessions", () => {
		const trace = { ...failedTrace([]), errorCount: 0, completedSuccessfully: true };
		expect(buildRegressionFixtureFromTrace(trace, "ep-2")).toBeNull();
	});
});

describe("regression replay convention", () => {
	const entries: TraceEntry[] = [
		{ type: "tool_call", timestamp: 1, toolName: "read", args: { path: "x.ts" } },
		{ type: "tool_result", timestamp: 2, toolName: "read", result: "ENOENT: no such file", isError: true },
	];
	const fixture: RegressionFixture = {
		id: "fx-1",
		sessionId: "sess-1",
		episodeId: "ep-1",
		cwd: "/proj",
		userPrompt: "read config",
		errorCount: 1,
		completedSuccessfully: false,
		dominantErrorTool: "read",
		dominantErrorPattern: "ENOENT",
		entries,
		createdAt: Date.now(),
	};

	test("passes when convention addresses path/ENOENT errors", () => {
		const c = convention("Verify paths exist before calling read; use find when the path is unknown.");
		expect(evaluateConventionOnFixture(c, fixture).passed).toBe(true);
	});

	test("fails when convention is unrelated", () => {
		const c = convention("Always use tabs instead of spaces in TypeScript files.");
		expect(evaluateConventionOnFixture(c, fixture).passed).toBe(false);
	});
});

describe("regression gate keep/discard", () => {
	const fixture: RegressionFixture = {
		id: "fx-1",
		sessionId: "s",
		episodeId: "e",
		cwd: "/p",
		userPrompt: "x",
		errorCount: 1,
		completedSuccessfully: false,
		dominantErrorTool: "read",
		dominantErrorPattern: "ENOENT",
		entries: [{ type: "tool_result", timestamp: 1, toolName: "read", result: "ENOENT", isError: true }],
		createdAt: Date.now(),
	};

	test("keep when majority of fixtures pass", () => {
		const c = convention("Verify paths before read; use find for unknown paths.");
		const result = runRegressionGate(c, [fixture, fixture], { minPassRate: 0.5 });
		expect(result.verdict).toBe("keep");
	});

	test("discard when no fixtures", () => {
		const c = convention("Verify paths before read.");
		const result = runRegressionGate(c, [], { minPassRate: 0.6 });
		expect(result.verdict).toBe("discard");
	});
});
