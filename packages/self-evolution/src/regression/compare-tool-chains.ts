import type { RegressionFixture, TraceEntry } from "../types";
import type { FixtureReplayResult } from "./replay";
import type { ToolChainTrialTag } from "./trial-reason";

export interface ToolChainCompareResult {
	score: number;
	replayToolCallCount: number;
	fixtureFirstErrorTool?: string;
	replayFirstErrorTool?: string;
	avoidedDominantError: boolean;
	reason: string;
}

function toolCallSequence(entries: TraceEntry[]): string[] {
	const names: string[] = [];
	for (const entry of entries) {
		if (entry.type === "tool_call" && entry.toolName) {
			names.push(entry.toolName.toLowerCase());
		}
	}
	return names;
}

function firstErrorToolName(entries: TraceEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type === "tool_result" && entry.isError && entry.toolName) {
			return entry.toolName.toLowerCase();
		}
	}
	return undefined;
}

function prefixSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	const max = Math.max(a.length, b.length);
	let matches = 0;
	const limit = Math.min(a.length, b.length);
	for (let i = 0; i < limit; i++) {
		if (a[i] === b[i]) matches++;
		else break;
	}
	return matches / max;
}

/**
 * Compare fixture failure tool chain to a replay subprocess tool chain.
 */
export function compareFixtureToReplayChain(
	fixture: RegressionFixture,
	replayEntries: TraceEntry[],
): ToolChainCompareResult {
	const fixtureCalls = toolCallSequence(fixture.entries);
	const replayCalls = toolCallSequence(replayEntries);
	const score = prefixSimilarity(fixtureCalls, replayCalls);
	const replayToolCallCount = replayCalls.length;

	const fixtureFirstErrorTool = firstErrorToolName(fixture.entries) ?? fixture.dominantErrorTool?.toLowerCase();
	const replayFirstErrorTool = firstErrorToolName(replayEntries);

	let avoidedDominantError = false;
	if (fixtureFirstErrorTool) {
		if (!replayFirstErrorTool) {
			avoidedDominantError = replayToolCallCount > 0;
		} else {
			avoidedDominantError = replayFirstErrorTool !== fixtureFirstErrorTool;
		}
	}

	let reason: string;
	if (replayToolCallCount === 0) {
		reason = "Replay produced no tool calls; tool-chain comparison skipped.";
	} else if (avoidedDominantError) {
		reason = `Replay first error tool ${replayFirstErrorTool ?? "(none)"} vs fixture ${fixtureFirstErrorTool}; dominant error avoided.`;
	} else {
		reason = `Replay first error tool ${replayFirstErrorTool ?? "(none)"} matches fixture path (similarity ${(score * 100).toFixed(0)}%).`;
	}

	return {
		score,
		replayToolCallCount,
		fixtureFirstErrorTool,
		replayFirstErrorTool,
		avoidedDominantError,
		reason,
	};
}

export interface ToolChainVerdictAdjustment {
	result: FixtureReplayResult;
	toolChainTag?: ToolChainTrialTag;
}

export function applyToolChainCompareToVerdict(
	verdict: FixtureReplayResult,
	compare: ToolChainCompareResult | undefined,
): ToolChainVerdictAdjustment {
	if (!compare || compare.replayToolCallCount === 0) {
		return { result: verdict, toolChainTag: "skip" };
	}

	if (verdict.passed && !compare.avoidedDominantError && compare.score >= 0.85) {
		return {
			result: {
				passed: false,
				reason: `Replay repeated failing tool chain (${compare.reason})`,
			},
			toolChainTag: "overturn",
		};
	}

	if (verdict.passed && compare.avoidedDominantError) {
		return {
			result: {
				passed: true,
				reason: `${verdict.reason} ${compare.reason}`,
			},
			toolChainTag: "confirm",
		};
	}

	if (!verdict.passed && compare.avoidedDominantError && compare.replayToolCallCount >= 1) {
		return {
			result: {
				passed: true,
				reason: `Tool-chain evidence overrides discard: ${compare.reason}`,
			},
			toolChainTag: "only",
		};
	}

	if (!verdict.passed && !compare.avoidedDominantError && compare.score >= 0.85) {
		return { result: verdict, toolChainTag: "repeat" };
	}

	return { result: verdict };
}
