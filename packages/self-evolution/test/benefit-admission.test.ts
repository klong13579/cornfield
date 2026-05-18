import { describe, expect, test } from "bun:test";
import {
	classifyConventionLifecycle,
	formatProfileAvgErrorsPerSession,
	isConventionEligibleForInjection,
	isHighAvgErrorsPerSession,
	isSkillEligibleForInjection,
	shouldDeprecateSkillFromInjectionStats,
	skillHelpRate,
} from "../src/benefit-admission";
import type { Convention, SkillEffectiveness, UserProfile } from "../src/types";

function convention(overrides: Partial<Convention> = {}): Convention {
	return {
		id: "c1",
		type: "preference",
		content: "test",
		sourceEpisodeId: "ep1",
		confidence: 80,
		timesApplied: 0,
		timesViolated: 0,
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
		lifecycleState: "candidate",
		...overrides,
	};
}

describe("benefit-admission conventions", () => {
	test("new convention stays candidate until observed", () => {
		expect(classifyConventionLifecycle(convention({ confidence: 100 }))).toBe("candidate");
		expect(isConventionEligibleForInjection(convention({ confidence: 100 }))).toBe(false);
	});

	test("eligible by stats stays candidate until regression keep", () => {
		const c = convention({
			lifecycleState: "candidate",
			timesApplied: 6,
			timesViolated: 4,
			confidence: 70,
		});
		expect(classifyConventionLifecycle(c)).toBe("candidate");
		const active = { ...c, lifecycleState: "active" as const };
		expect(isConventionEligibleForInjection(active)).toBe(true);
	});

	test("archived when observed but low compliance", () => {
		const c = convention({
			timesApplied: 2,
			timesViolated: 8,
			confidence: 100,
		});
		expect(classifyConventionLifecycle(c)).toBe("archived");
	});
});

describe("benefit-admission skills", () => {
	test("omp-like zero help fails injection eligibility", () => {
		const eff: SkillEffectiveness = {
			skillName: "omp",
			timesInjected: 28,
			timesHelped: 0,
			timesFailed: 10,
			lastInjectedAt: Date.now(),
		};
		expect(skillHelpRate(eff)).toBe(0);
		expect(isSkillEligibleForInjection({ name: "omp" }, eff)).toBe(false);
		expect(shouldDeprecateSkillFromInjectionStats({}, eff)).toBe(true);
	});

	test("boundary-condition-like high help passes", () => {
		const eff: SkillEffectiveness = {
			skillName: "boundary-condition-testing",
			timesInjected: 32,
			timesHelped: 28,
			timesFailed: 8,
			lastInjectedAt: Date.now(),
		};
		expect(isSkillEligibleForInjection({ name: "boundary-condition-testing" }, eff)).toBe(true);
	});
});

describe("profile error rate semantics", () => {
	test("formats as avg errors per session not percent", () => {
		expect(formatProfileAvgErrorsPerSession(0.93)).toContain("0.9");
		expect(formatProfileAvgErrorsPerSession(0.93)).toContain("avg tool errors/session");
	});

	test("high avg errors uses per-session threshold", () => {
		const profile: UserProfile = {
			toolFrequency: {},
			toolTransitions: {},
			intentDistribution: {},
			avgToolCallsPerSession: 10,
			avgFilesModifiedPerSession: 1,
			errorRate: 0.93,
			recoveryRate: 0.3,
			preferredLanguages: [],
			sessionCount: 10,
			updatedAt: Date.now(),
		};
		expect(isHighAvgErrorsPerSession(profile)).toBe(false);
		expect(isHighAvgErrorsPerSession({ ...profile, errorRate: 1.2 })).toBe(true);
	});
});
