/**
 * Backfill dominant_error_* on regression_fixtures from episode diagnoses and session traces.
 */
import type { Database } from "bun:sqlite";
import type { SqliteEpisodeDiagnosisStore } from "../storage/diagnoses";
import type { SqliteRegressionFixtureStore } from "../storage/regression-fixtures";
import type { SqliteSessionTraceStore } from "../storage/session-traces";
import { inferDominantErrorsFromTrace } from "../trace-analyzer";

export interface RepairRegressionFixtureLabelsResult {
	scanned: number;
	updated: number;
	unchanged: number;
	missingTrace: number;
}

export async function repairRegressionFixtureLabels(opts: {
	db: Database;
	fixtureStore: SqliteRegressionFixtureStore;
	traceStore: SqliteSessionTraceStore;
	diagnosisStore: SqliteEpisodeDiagnosisStore;
}): Promise<RepairRegressionFixtureLabelsResult> {
	const { fixtureStore, traceStore, diagnosisStore } = opts;
	const fixtures = await fixtureStore.listAll();
	const result: RepairRegressionFixtureLabelsResult = {
		scanned: fixtures.length,
		updated: 0,
		unchanged: 0,
		missingTrace: 0,
	};

	for (const fixture of fixtures) {
		const diagnosis = await diagnosisStore.get(fixture.episodeId);
		const trace = await traceStore.getBySessionId(fixture.sessionId);
		if (!trace) {
			result.missingTrace++;
			continue;
		}

		const inferred = inferDominantErrorsFromTrace(trace);
		const nextTool = diagnosis?.dominantErrorTool ?? inferred.dominantErrorTool;
		const nextPattern = diagnosis?.dominantErrorPattern ?? inferred.dominantErrorPattern;

		if (fixture.dominantErrorTool === nextTool && fixture.dominantErrorPattern === nextPattern) {
			result.unchanged++;
			continue;
		}

		if (!nextTool && !nextPattern) {
			result.unchanged++;
			continue;
		}

		await fixtureStore.updateDominantError(fixture.id, nextTool, nextPattern);
		result.updated++;
	}

	return result;
}
