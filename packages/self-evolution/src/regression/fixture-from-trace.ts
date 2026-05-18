/**
 * Build regression fixtures from failed session traces.
 */

import { inferDominantErrorsFromTrace } from "../trace-analyzer";
import type { RegressionFixture, SessionTrace } from "../types";
import { sliceTraceEntriesForFixture } from "./fixture-entries";

export function buildRegressionFixtureFromTrace(
	trace: SessionTrace,
	episodeId: string,
	diagnosis?: { dominantErrorTool?: string; dominantErrorPattern?: string },
): RegressionFixture | null {
	if (trace.errorCount === 0 && trace.completedSuccessfully) {
		return null;
	}

	const id = `fx_${Bun.hash(`${trace.sessionId}:${trace.startTime}`).toString(36)}`;
	const inferred =
		diagnosis?.dominantErrorTool || diagnosis?.dominantErrorPattern
			? {
					dominantErrorTool: diagnosis.dominantErrorTool,
					dominantErrorPattern: diagnosis.dominantErrorPattern,
				}
			: inferDominantErrorsFromTrace(trace);

	return {
		id,
		sessionId: trace.sessionId,
		episodeId,
		cwd: trace.cwd,
		userPrompt: trace.userPrompt,
		errorCount: trace.errorCount,
		completedSuccessfully: trace.completedSuccessfully,
		dominantErrorTool: inferred.dominantErrorTool,
		dominantErrorPattern: inferred.dominantErrorPattern,
		entries: sliceTraceEntriesForFixture(trace),
		createdAt: Date.now(),
	};
}
