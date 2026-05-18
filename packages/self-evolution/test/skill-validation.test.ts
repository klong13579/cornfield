import { describe, expect, test } from "bun:test";
import { formatAgentSkillBody } from "../src/skill-format";
import { normalizeSkillDescription, validateSkillContent } from "../src/skill-validation";
import type { EvolvedSkill } from "../src/types";

function sampleSkill(overrides: Partial<EvolvedSkill> = {}): EvolvedSkill {
	return {
		name: "api-boundary-tests",
		description: "Apply boundary value analysis when designing tests for APIs and numeric ranges.",
		taskPattern: "When adding or reviewing API or numeric validation tests",
		approach:
			"If inputs have inclusive bounds, test min, max, and just outside each edge. When behavior differs by type, cover empty and null separately.",
		tools: [],
		pitfalls: ["Do not use this for pure UI layout checks without numeric contracts."],
		createdAt: 0,
		usageCount: 0,
		lastUsedAt: Date.now(),
		successCount: 0,
		failureCount: 0,
		version: 1,
		...overrides,
	};
}

describe("validateSkillContent", () => {
	test("accepts template-shaped skill", () => {
		const skill = sampleSkill();
		const result = validateSkillContent({
			name: skill.name,
			description: skill.description,
			taskPattern: skill.taskPattern,
			approach: skill.approach,
			pitfalls: skill.pitfalls,
		});
		expect(result.ok).toBeTrue();
		expect(result.failures).toHaveLength(0);
	});

	test("rejects session excerpt description", () => {
		const result = validateSkillContent({
			name: "x",
			description: "Extracted from session abc: fix the bug",
			taskPattern: "when debugging",
			approach: "If logs show timeouts, check the handler before the provider.",
			pitfalls: ["Not for sub-second calls"],
		});
		expect(result.ok).toBeFalse();
		expect(result.failures).toContain("description_is_session_excerpt");
	});

	test("rejects tool-sequence-only body", () => {
		const result = validateSkillContent({
			name: "x",
			description: "Use grep then read when exploring code.",
			taskPattern: "",
			approach: "grep → read → edit",
			pitfalls: [],
		});
		expect(result.ok).toBeFalse();
		expect(result.failures).toContain("body_empty_or_tool_sequence_only");
	});

	test("rejects evolution ops sections in body", () => {
		const result = validateSkillContent({
			name: "x",
			description: "Trace latency when tools feel slow.",
			taskPattern: "when slow",
			approach: "If delay scales with payload, profile the handler.\n\n## 评分详情\n",
			pitfalls: ["Not for model thinking time"],
		});
		expect(result.ok).toBeFalse();
		expect(result.failures).toContain("body_contains_evolution_ops_sections");
	});
});

describe("normalizeSkillDescription", () => {
	test("rewrites session excerpt using task pattern", () => {
		const desc = normalizeSkillDescription({
			name: "x",
			description: "Extracted from session foo",
			taskPattern: "Apply TDD when adding React components with tests",
			approach: "",
			pitfalls: [],
		});
		expect(desc).toMatch(/^Apply TDD/);
		expect(desc).not.toContain("Extracted from session");
	});
});

describe("formatAgentSkillBody", () => {
	test("wraps unstructured approach with When to use and Anti-patterns", () => {
		const body = formatAgentSkillBody(sampleSkill({ pitfalls: [] }));
		expect(body).toContain("## When to use");
		expect(body).toContain("## Procedure");
		expect(body).toContain("## Anti-patterns");
		expect(body).not.toContain("评分详情");
	});
});
