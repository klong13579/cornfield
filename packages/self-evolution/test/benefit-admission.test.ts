import { describe, expect, test } from "bun:test";
import {
	isSkillEligibleForInjection,
	shouldDeprecateSkillFromInjectionStats,
	skillHelpRate,
} from "../src/benefit-admission";
import type { SkillEffectiveness } from "../src/types";

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
