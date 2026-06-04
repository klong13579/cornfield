/**
 * Benefit admission: only proven improvements enter default prompt injection.
 */
import type { SkillEffectiveness } from "./types";

/** Minimum injection/help observations before skill help rate is trusted. */
export const SKILL_MIN_INJECTIONS = 5;
/** Minimum help rate (times_helped / times_injected) for skill injection. */
export const SKILL_MIN_HELP_RATE = 0.5;

export function skillHelpRate(eff: SkillEffectiveness | undefined): number | null {
	if (!eff || eff.timesInjected < SKILL_MIN_INJECTIONS) return null;
	return eff.timesHelped / eff.timesInjected;
}

export function isSkillEligibleForInjection(
	skill: { deprecated?: boolean; name: string },
	effectiveness: SkillEffectiveness | undefined,
): boolean {
	if (skill.deprecated) return false;
	const rate = skillHelpRate(effectiveness);
	if (rate === null) return false;
	return rate >= SKILL_MIN_HELP_RATE;
}

export function shouldDeprecateSkillFromInjectionStats(
	skill: { deprecated?: boolean },
	effectiveness: SkillEffectiveness | undefined,
): boolean {
	if (skill.deprecated) return false;
	if (!effectiveness || effectiveness.timesInjected < SKILL_MIN_INJECTIONS) return false;
	const rate = skillHelpRate(effectiveness);
	return rate !== null && rate < SKILL_MIN_HELP_RATE;
}
