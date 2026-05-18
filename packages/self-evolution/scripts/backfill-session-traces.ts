#!/usr/bin/env bun
/**
 * Backfill session_traces + regression_fixtures from episodes and ~/.omp/agent/sessions JSONL.
 *
 * Usage:
 *   bun packages/self-evolution/scripts/backfill-session-traces.ts [limit] [--cwd <project>]
 */
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { refreshBenefitAdmissionState } from "../src/benefit-admission-refresh";
import { backfillSessionTracesFromEpisodes } from "../src/regression/backfill-traces";
import { closeEvolutionDb, getEvolutionDb } from "../src/storage/db";
import { SqliteEpisodeStore } from "../src/storage/episodes";
import { SqliteRegressionFixtureStore } from "../src/storage/regression-fixtures";
import { SqliteSessionTraceStore } from "../src/storage/session-traces";
import { SqliteSkillEffectivenessStore } from "../src/storage/skill-effectiveness";
import { SqliteSkillPopulationStore } from "../src/storage/skill-population";
import { SqliteSkillStore } from "../src/storage/skills";

const limitArg = process.argv.find(a => /^\d+$/.test(a));
const limit = limitArg ? Number.parseInt(limitArg, 10) : 500;
const cwdIdx = process.argv.indexOf("--cwd");
const cwd = cwdIdx >= 0 ? (process.argv[cwdIdx + 1] ?? process.cwd()) : process.cwd();
const globalStore = !process.argv.includes("--per-project");

const db = getEvolutionDb(cwd, globalStore);
const episodeStore = new SqliteEpisodeStore(db);
const traceStore = new SqliteSessionTraceStore(db);
const fixtureStore = new SqliteRegressionFixtureStore(db);
const result = await backfillSessionTracesFromEpisodes({
	episodeStore,
	traceStore,
	fixtureStore,
	sessionsRoot: getSessionsDir(),
	limit,
});

const admission = await refreshBenefitAdmissionState({
	skillStore: new SqliteSkillStore(db),
	skillEffectivenessStore: new SqliteSkillEffectivenessStore(db),
	populationStore: new SqliteSkillPopulationStore(db),
});

console.log(JSON.stringify({ backfill: result, admission }, null, 2));
closeEvolutionDb(cwd, globalStore);
