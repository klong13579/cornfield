/**
 * Benefit admission: only proven improvements enter default prompt injection.
 */
import type { SkillEffectiveness, UserProfile } from "./types";

/** Minimum injection/help observations before skill help rate is trusted. */
export const SKILL_MIN_INJECTIONS = 5;
/** Minimum help rate (times_helped / times_injected) for skill injection. */
export const SKILL_MIN_HELP_RATE = 0.5;

/** Profile avg errors per session at or above this triggers high-error cross-session nudge. */
export const PROFILE_HIGH_AVG_ERRORS_PER_SESSION = 1.0;

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

/** UserProfile.errorRate stores mean tool errors per session (not a 0–1 failure rate). */
export function formatProfileAvgErrorsPerSession(errorRate: number): string {
	return `${errorRate.toFixed(1)} avg tool errors/session`;
}

export function isHighAvgErrorsPerSession(profile: UserProfile | undefined): boolean {
	if (!profile || profile.sessionCount < 5) return false;
	return profile.errorRate >= PROFILE_HIGH_AVG_ERRORS_PER_SESSION;
}
