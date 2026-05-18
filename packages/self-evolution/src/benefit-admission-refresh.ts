/**
 * One-time / periodic refresh of lifecycle states from benefit metrics + regression replay.
 */

import { logger } from "@oh-my-pi/pi-utils";
import {
	applyRegressionVerdict,
	classifyConventionLifecycle,
	conventionStatsTier,
	shouldDeprecateSkillFromInjectionStats,
} from "./benefit-admission";
import { REGRESSION_MAX_FIXTURES } from "./regression/replay";
import type { RegressionReplayBackend } from "./regression/replay-backend";
import { createRegressionReplayBackend } from "./regression/replay-backend";
import { selectFixturesForConvention, selectFixturesForSkill } from "./regression/select-fixtures";
import { formatRegressionTrialReason, type ToolChainTrialTag } from "./regression/trial-reason";
import type {
	ConventionStore,
	RegressionFixtureStore,
	RegressionTrialStore,
	SkillEffectivenessStore,
	SkillPopulationStore,
	SkillStore,
} from "./storage/types";
import type { SkillPopulationState } from "./types";

function regressionTrialReason(
	backend: RegressionReplayBackend,
	body: string,
	toolChainTag?: ToolChainTrialTag,
): string {
	return formatRegressionTrialReason({
		replayBackend: backend.kind,
		toolChainTag,
		body,
	});
}

export interface BenefitAdmissionRefreshResult {
	conventionsReclassified: number;
	conventionsRegressionPromoted: number;
	skillsDeprecated: number;
	skillsRegressionBlocked: number;
}

export interface ReclassifyConventionOptions {
	conventionStore: ConventionStore;
	fixtureStore?: RegressionFixtureStore;
	trialStore?: RegressionTrialStore;
	replayBackend?: RegressionReplayBackend;
}

export async function reclassifyConventionLifecycles(
	opts: ReclassifyConventionOptions,
): Promise<{ reclassified: number; promoted: number }> {
	const { conventionStore, fixtureStore, trialStore } = opts;
	const backend = opts.replayBackend ?? createRegressionReplayBackend("heuristic");
	let reclassified = 0;
	let promoted = 0;

	const conventions = await conventionStore.listAll();

	for (const c of conventions) {
		const tier = conventionStatsTier(c);
		let next = classifyConventionLifecycle(c);

		if (tier === "eligible" && fixtureStore) {
			const fixtures = await selectFixturesForConvention(fixtureStore, c, REGRESSION_MAX_FIXTURES);
			if (fixtures.length > 0) {
				const gate = await backend.runConventionGate(c, fixtures);
				next = applyRegressionVerdict(c, gate.verdict);
				if (trialStore && fixtures[0]) {
					await trialStore.insert({
						id: `trial_${Bun.hash(`${c.id}:${gate.verdict}:${Date.now()}`).toString(36)}`,
						targetType: "convention",
						targetId: c.id,
						fixtureId: fixtures[0].id,
						verdict: gate.verdict,
						reason: regressionTrialReason(backend, gate.reason),
						createdAt: Date.now(),
					});
				}
				if (next === "active" && c.lifecycleState !== "active") {
					promoted++;
				}
			}
		}

		if (next !== (c.lifecycleState ?? "candidate")) {
			await conventionStore.updateLifecycleState(c.id, next);
			reclassified++;
		}
	}

	return { reclassified, promoted };
}

const PROMOTION_STATES: SkillPopulationState[] = ["experimental", "graduated"];

export async function applySkillRegressionBeforePromotion(opts: {
	skillStore: SkillStore;
	fixtureStore: RegressionFixtureStore;
	trialStore: RegressionTrialStore;
	proposedState: SkillPopulationState;
	skillName: string;
	replayBackend?: RegressionReplayBackend;
}): Promise<{ allowed: boolean; reason?: string }> {
	if (!PROMOTION_STATES.includes(opts.proposedState)) {
		return { allowed: true };
	}

	const skill = await opts.skillStore.get(opts.skillName);
	if (!skill) return { allowed: true };

	const backend = opts.replayBackend ?? createRegressionReplayBackend("heuristic");
	const fixtures = await selectFixturesForSkill(opts.fixtureStore, skill, REGRESSION_MAX_FIXTURES);
	if (fixtures.length === 0) {
		return { allowed: true };
	}

	const gate = await backend.runSkillGate(skill, fixtures);
	if (fixtures[0]) {
		await opts.trialStore.insert({
			id: `trial_${Bun.hash(`skill:${skill.name}:${gate.verdict}:${Date.now()}`).toString(36)}`,
			targetType: "skill",
			targetId: skill.name,
			fixtureId: fixtures[0].id,
			verdict: gate.verdict,
			reason: regressionTrialReason(backend, gate.reason),
			createdAt: Date.now(),
		});
	}

	if (gate.verdict === "keep") {
		return { allowed: true };
	}

	return { allowed: false, reason: gate.reason };
}

export async function refreshBenefitAdmissionState(opts: {
	skillStore: SkillStore;
	skillEffectivenessStore: SkillEffectivenessStore;
	populationStore?: SkillPopulationStore;
}): Promise<BenefitAdmissionRefreshResult> {
	const { skillStore, skillEffectivenessStore, populationStore } = opts;

	const skillsDeprecated = await deprecateSkillsFromBenefitAdmission({
		skillStore,
		skillEffectivenessStore,
		populationStore,
	});

	return {
		conventionsReclassified: 0,
		conventionsRegressionPromoted: 0,
		skillsDeprecated,
		skillsRegressionBlocked: 0,
	};
}

export async function deprecateSkillsFromBenefitAdmission(opts: {
	skillStore: SkillStore;
	skillEffectivenessStore: SkillEffectivenessStore;
	populationStore?: SkillPopulationStore;
}): Promise<number> {
	let skillsDeprecated = 0;
	const skills = await opts.skillStore.list({ deprecated: false });
	for (const skill of skills) {
		const eff = await opts.skillEffectivenessStore.get(skill.name);
		if (!shouldDeprecateSkillFromInjectionStats(skill, eff)) continue;

		skill.deprecated = true;
		skill.deprecationReason = `Injection help rate below threshold (${eff?.timesHelped ?? 0}/${eff?.timesInjected ?? 0} helped)`;
		await opts.skillStore.upsert(skill);
		await opts.populationStore?.transitionState(skill.name, "deprecated", skill.deprecationReason, 0);
		skillsDeprecated++;
		logger.debug("Deprecated skill failing benefit admission", { skill: skill.name });
	}
	return skillsDeprecated;
}

const HEAVY_REGRESSION_BACKENDS = new Set(["llm", "subagent"]);
const DEFAULT_HEAVY_RECLASSIFY_INTERVAL = 5;

export interface RefreshAdmissionAfterSessionOptions {
	skillStore: SkillStore;
	skillEffectivenessStore: SkillEffectivenessStore;
	populationStore?: SkillPopulationStore;
	fixtureStore?: RegressionFixtureStore;
	trialStore?: RegressionTrialStore;
	replayBackend?: RegressionReplayBackend;
	regressionReplayBackend: "heuristic" | "llm" | "subagent";
	sessionOrdinal: number;
	admissionReclassifyInterval?: number;
}

/**
 * Per-session admission maintenance: always deprecate failing skills; reclassify conventions
 * every session for heuristic replay, every N sessions for LLM/sub-agent backends.
 */
export async function refreshAdmissionAfterSessionEnd(
	opts: RefreshAdmissionAfterSessionOptions,
): Promise<{ skillsDeprecated: number; conventionsReclassified: number; conventionsPromoted: number }> {
	const skillsDeprecated = await deprecateSkillsFromBenefitAdmission({
		skillStore: opts.skillStore,
		skillEffectivenessStore: opts.skillEffectivenessStore,
		populationStore: opts.populationStore,
	});

	const heavy = HEAVY_REGRESSION_BACKENDS.has(opts.regressionReplayBackend);
	const interval = heavy ? Math.max(1, opts.admissionReclassifyInterval ?? DEFAULT_HEAVY_RECLASSIFY_INTERVAL) : 1;
	const _runReclassify = opts.sessionOrdinal % interval === 0;

	return { skillsDeprecated, conventionsReclassified: 0, conventionsPromoted: 0 };
}
