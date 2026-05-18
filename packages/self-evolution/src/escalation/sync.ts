import type { SqliteEvolutionEscalationStore } from "../storage/evolution-escalations";
import type { SqliteLearningStore } from "../storage/learnings";
import type { SqliteRegressionFixtureStore } from "../storage/regression-fixtures";
import type { SqliteRegressionTrialStore } from "../storage/regression-trials";
import { detectEscalationCandidates, ESCALATION_MIN_OCCURRENCES } from "./detector";
import { regressionPatternKey } from "./pattern-key";

export async function syncEvolutionEscalations(opts: {
	escalationStore: SqliteEvolutionEscalationStore;
	fixtureStore: SqliteRegressionFixtureStore;
	learningStore: SqliteLearningStore;
	trialStore: SqliteRegressionTrialStore;
	fixtureLookback?: number;
	trialLookback?: number;
}): Promise<number> {
	const { escalationStore, fixtureStore, learningStore, trialStore, fixtureLookback = 40, trialLookback = 100 } = opts;

	const fixtures = await fixtureStore.listRecent(fixtureLookback);
	const allFixtures = await fixtureStore.listAll();
	const learnings = await learningStore.listAll();
	const trials = await trialStore.listRecent(trialLookback);

	const fixtureCounts = new Map<string, number>();
	for (const fixture of allFixtures) {
		const key = regressionPatternKey(fixture);
		fixtureCounts.set(key, (fixtureCounts.get(key) ?? 0) + 1);
	}

	const open = await escalationStore.listOpen();
	for (const esc of open) {
		const count = fixtureCounts.get(esc.patternKey) ?? 0;
		if (count < ESCALATION_MIN_OCCURRENCES) {
			await escalationStore.resolve(esc.id);
		}
	}

	const candidates = detectEscalationCandidates({ fixtures, learnings, trials });
	for (const candidate of candidates) {
		await escalationStore.upsertOpen(candidate);
	}
	return candidates.length;
}
