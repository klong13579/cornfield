import { describe, expect, test } from "bun:test";
import { assembleContext } from "./assembler";
import type { ProceduralRule, UnifiedSkill } from "./types";

describe("assembleContext", () => {
	const makeSkill = (name: string, confidence: number, content: string): UnifiedSkill => ({
		id: `evolution_extraction:${name}`,
		source: "evolution_extraction",
		name,
		content,
		confidenceScore: confidence,
		lastUsedAt: Date.now(),
		version: "1.0",
		status: "active",
	});

	const makeRule = (rule: string, confidence: number): ProceduralRule => ({
		rule,
		confidence,
	});

	test("returns null for empty input", () => {
		const result = assembleContext([], [], { maxTokens: 2000 });
		expect(result).toBe("");
	});

	test("includes conventions at top priority", () => {
		const skills: UnifiedSkill[] = [];
		const conventions: ProceduralRule[] = [makeRule("Don't use async/await", 0.9)];

		const result = assembleContext(skills, conventions, { maxTokens: 2000 });

		expect(result).toContain("## Active Rules");
		expect(result).toContain("Don't use async/await");
		expect(result).toContain("Confidence: 0.90");
	});

	test("includes skills sorted by confidence (highest first)", () => {
		const skills: UnifiedSkill[] = [
			makeSkill("low-skill", 0.3, "Low priority content"),
			makeSkill("high-skill", 0.9, "High priority content"),
			makeSkill("mid-skill", 0.6, "Mid priority content"),
		];

		const result = assembleContext(skills, [], { maxTokens: 2000 });

		const highIdx = result.indexOf("high-skill");
		const midIdx = result.indexOf("mid-skill");
		const lowIdx = result.indexOf("low-skill");

		expect(highIdx).toBeLessThan(midIdx);
		expect(midIdx).toBeLessThan(lowIdx);
	});

	test("filters out deprecated skills", () => {
		const active = makeSkill("active-skill", 0.8, "Active content");
		const deprecated: UnifiedSkill = {
			...makeSkill("deprecated-skill", 0.9, "Deprecated content"),
			status: "deprecated",
		};

		const result = assembleContext([active, deprecated], [], { maxTokens: 2000 });

		expect(result).toContain("active-skill");
		expect(result).not.toContain("deprecated-skill");
	});

	test("truncates output when exceeding token budget", () => {
		// Create skills that will exceed the budget
		const longContent = "x".repeat(500);
		const skills: UnifiedSkill[] = Array.from({ length: 10 }, (_, i) =>
			makeSkill(`skill-${i}`, 0.9 - i * 0.05, longContent),
		);

		const result = assembleContext(skills, [], { maxTokens: 200 });

		expect(result.length).toBeLessThanOrEqual(200 * 4 + 50); // maxChars + truncation suffix
		expect(result).toContain("[truncated");
	});

	test("conventions are never truncated (highest priority)", () => {
		const convention = makeRule("CRITICAL: Never deploy on Friday", 0.95);
		const skills: UnifiedSkill[] = [makeSkill("big-skill", 0.5, "a".repeat(1000))];

		const result = assembleContext(skills, [convention], { maxTokens: 100 });

		// Convention must appear even when truncated
		expect(result).toContain("CRITICAL: Never deploy on Friday");
	});

	test("conventions appear before skills", () => {
		const skills = [makeSkill("test-skill", 0.8, "Skill content")];
		const conventions = [makeRule("Always test first", 0.9)];

		const result = assembleContext(skills, conventions, { maxTokens: 2000 });

		const convIdx = result.indexOf("## Active Rules");
		const skillIdx = result.indexOf("## Relevant Skills");

		expect(convIdx).toBeLessThan(skillIdx);
	});

	test("default token budget is 2000", () => {
		const skills = [makeSkill("default-test", 0.5, "Default budget test")];
		const result = assembleContext(skills, []);

		expect(result).toContain("default-test");
	});
});
