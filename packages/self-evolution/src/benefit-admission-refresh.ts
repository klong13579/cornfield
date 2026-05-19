/**
 * One-time / periodic refresh of lifecycle states from benefit metrics + regression replay.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { shouldDeprecateSkillFromInjectionStats } from "./benefit-admission";
import { REGRESSION_MAX_FIXTURES } from "./regression/replay";
import type { RegressionReplayBackend } from "./regression/replay-backend";
import { createRegressionReplayBackend } from "./regression/replay-backend";
import { selectFixturesForSkill } from "./regression/select-fixtures";
import { formatRegressionTrialReason, type ToolChainTrialTag } from "./regression/trial-reason";
import type {
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
	skillsDeprecated: number;
	skillsRegressionBlocked: number;
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
	const skillsDeprecated = await deprecateSkillsFromBenefitAdmission({
		skillStore: opts.skillStore,
		skillEffectivenessStore: opts.skillEffectivenessStore,
		populationStore: opts.populationStore,
	});

	return {
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

export interface RefreshAdmissionAfterSessionOptions {
	skillStore: SkillStore;
	skillEffectivenessStore: SkillEffectivenessStore;
	populationStore?: SkillPopulationStore;
	regressionReplayBackend: "heuristic" | "llm" | "subagent";
	sessionOrdinal: number;
	admissionReclassifyInterval?: number;
}

/** Per-session admission maintenance: deprecate skills that fail injection benefit thresholds. */
export async function refreshAdmissionAfterSessionEnd(
	opts: RefreshAdmissionAfterSessionOptions,
): Promise<{ skillsDeprecated: number }> {
	const skillsDeprecated = await deprecateSkillsFromBenefitAdmission({
		skillStore: opts.skillStore,
		skillEffectivenessStore: opts.skillEffectivenessStore,
		populationStore: opts.populationStore,
	});

	return { skillsDeprecated };
}
