import { describe, expect, test } from "bun:test";
import { isValidSkillName, normalizeEvolutionScore } from "./skill-score";

describe("normalizeEvolutionScore", () => {
	test("passes through 0–1 scores", () => {
		expect(normalizeEvolutionScore(0.72)).toBe(0.72);
	});

	test("converts legacy 0–100 scores", () => {
		expect(normalizeEvolutionScore(90)).toBe(0.9);
		expect(normalizeEvolutionScore(85)).toBe(0.85);
	});

	test("clamps invalid values", () => {
		expect(normalizeEvolutionScore(Number.NaN)).toBe(0);
		expect(normalizeEvolutionScore(150)).toBe(1);
	});
});

describe("isValidSkillName", () => {
	test("rejects empty names", () => {
		expect(isValidSkillName("")).toBeFalse();
		expect(isValidSkillName("   ")).toBeFalse();
		expect(isValidSkillName("---")).toBeFalse();
	});

	test("accepts normal names", () => {
		expect(isValidSkillName("boundary-condition-testing")).toBeTrue();
	});
});
