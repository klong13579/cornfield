/**
 * Benefit admission: only proven improvements enter default prompt injection.
 */
import type { Convention, ConventionLifecycleState, SkillEffectiveness, UserProfile } from "./types";

/** Minimum injection/help observations before skill help rate is trusted. */
export const SKILL_MIN_INJECTIONS = 5;
/** Minimum help rate (times_helped / times_injected) for skill injection. */
export const SKILL_MIN_HELP_RATE = 0.5;

/** Minimum compliance observations before convention compliance rate is trusted. */
export const CONVENTION_MIN_OBSERVED = 5;
/** Minimum applied / (applied + violated) for active convention. */
export const CONVENTION_MIN_COMPLIANCE = 0.6;

/** Profile avg errors per session at or above this triggers high-error cross-session nudge. */
export const PROFILE_HIGH_AVG_ERRORS_PER_SESSION = 1.0;

export function conventionObserved(c: Convention): number {
	return c.timesApplied + c.timesViolated;
}

export function conventionComplianceRate(c: Convention): number | null {
	const observed = conventionObserved(c);
	if (observed === 0) return null;
	return c.timesApplied / observed;
}

export type ConventionStatsTier = "cold" | "eligible" | "failing";

export function conventionStatsTier(c: Convention): ConventionStatsTier {
	const observed = conventionObserved(c);
	if (observed < CONVENTION_MIN_OBSERVED) return "cold";
	const compliance = conventionComplianceRate(c);
	if (compliance !== null && compliance >= CONVENTION_MIN_COMPLIANCE) return "eligible";
	return "failing";
}

/** Stats-only lifecycle; eligible conventions stay candidate until regression keep. */
export function classifyConventionLifecycle(c: Convention): ConventionLifecycleState {
	if (c.lifecycleState === "archived") return "archived";
	const tier = conventionStatsTier(c);
	if (tier === "failing") return "archived";
	if (tier === "eligible" && c.lifecycleState === "active") return "active";
	return "candidate";
}

export function applyRegressionVerdict(c: Convention, verdict: "keep" | "discard"): ConventionLifecycleState {
	const tier = conventionStatsTier(c);
	if (tier === "failing") return "archived";
	if (tier === "cold") return "candidate";
	if (verdict === "keep") return "active";
	return "candidate";
}

export function isConventionEligibleForInjection(c: Convention): boolean {
	if (c.lifecycleState === "archived") return false;
	if (c.lifecycleState !== "active") return false;
	if (c.confidence < 60) return false;
	const observed = conventionObserved(c);
	if (observed < CONVENTION_MIN_OBSERVED) return false;
	const compliance = conventionComplianceRate(c);
	return compliance !== null && compliance >= CONVENTION_MIN_COMPLIANCE;
}

export function newConventionLifecycleState(): ConventionLifecycleState {
	return "candidate";
}

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
