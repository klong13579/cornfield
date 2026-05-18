#!/usr/bin/env bun
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
/**
 * LLM regression replay on evolved skills (global DB).
 *
 * Usage:
 *   OMP_REGRESSION_REPLAY=llm bun packages/self-evolution/scripts/run-llm-regression-sample.ts
 */
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { createRegressionReplayBackend } from "../src/regression/replay-backend";
import { clearRegressionReplayRuntime, setRegressionReplayRuntime } from "../src/regression/replay-runtime";
import { selectFixturesForSkill } from "../src/regression/select-fixtures";
import { closeEvolutionDb, getEvolutionDb, initSchema } from "../src/storage/db";
import { SqliteRegressionFixtureStore } from "../src/storage/regression-fixtures";
import { SqliteRegressionTrialStore } from "../src/storage/regression-trials";
import { SqliteSkillStore } from "../src/storage/skills";

const cwd = process.cwd();
const globalStore = true;
const replayKind = (process.env.OMP_REGRESSION_REPLAY as "heuristic" | "llm" | "subagent" | undefined) ?? "llm";
const sampleCount = Number.parseInt(process.env.OMP_LLM_REGRESSION_SAMPLES ?? "2", 10);

const db = getEvolutionDb(cwd, globalStore);
initSchema(db);

const skillStore = new SqliteSkillStore(db);
const fixtureStore = new SqliteRegressionFixtureStore(db);
const trialStore = new SqliteRegressionTrialStore(db);

const settings = await Settings.init({ cwd });
const authStorage = await discoverAuthStorage(getAgentDir());
const registry = new ModelRegistry(authStorage);
const available = registry.getAvailable();
const role = resolveRoleSelection(["smol", "default"], settings, available, registry);
const model = role?.model;
if (!model) {
	console.error("No model available for LLM regression replay. Configure credentials in ~/.omp/agent/");
	closeEvolutionDb(cwd, globalStore);
	process.exit(1);
}

const apiKey = await registry.getApiKey(model);
if (!apiKey) {
	console.error(`No API key for ${model.provider}/${model.id}`);
	closeEvolutionDb(cwd, globalStore);
	process.exit(1);
}

setRegressionReplayRuntime({
	model,
	auth: { getApiKey: async () => apiKey },
});

const backend = createRegressionReplayBackend(replayKind);
const candidates = (await skillStore.list({ deprecated: false }))
	.sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0))
	.slice(0, sampleCount);

console.log(`replay=${replayKind} model=${model.provider}/${model.id} samples=${candidates.length}`);

for (const skill of candidates) {
	const fixtures = await selectFixturesForSkill(fixtureStore, skill, 5);
	const gate = await backend.runSkillGate(skill, fixtures);
	const trialId = `trial_${Bun.hash(`${skill.name}:llm-sample:${Date.now()}`).toString(36)}`;
	if (fixtures[0]) {
		await trialStore.insert({
			id: trialId,
			targetType: "skill",
			targetId: skill.name,
			fixtureId: fixtures[0].id,
			verdict: gate.verdict,
			reason: `[replay:${replayKind}] ${gate.reason}`,
			createdAt: Date.now(),
		});
	}
	console.log(
		JSON.stringify(
			{
				skillName: skill.name,
				content: skill.approach.slice(0, 120),
				fixtureCount: fixtures.length,
				verdict: gate.verdict,
				passCount: gate.passCount,
				failCount: gate.failCount,
				reason: gate.reason,
			},
			null,
			2,
		),
	);
}

clearRegressionReplayRuntime();
closeEvolutionDb(cwd, globalStore);
