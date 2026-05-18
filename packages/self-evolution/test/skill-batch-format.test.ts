import { describe, expect, test } from "bun:test";
import { normalizeSkillForTemplate, stripEvolutionOpsSections } from "../src/skill-batch-format";
import { validateSkillContent } from "../src/skill-validation";
import type { EvolvedSkill } from "../src/types";

function baseSkill(overrides: Partial<EvolvedSkill> = {}): EvolvedSkill {
	return {
		name: "dws",
		description: "Extracted from session abc: 使用 dws 访问",
		taskPattern: "使用 dws 访问",
		approach: "Tool sequence: search → bash.",
		tools: [],
		pitfalls: ["Do not use curl when dws is required."],
		createdAt: 0,
		usageCount: 0,
		lastUsedAt: Date.now(),
		successCount: 0,
		failureCount: 0,
		version: 1,
		...overrides,
	};
}

describe("skill-batch-format", () => {
	test("stripEvolutionOpsSections removes score tables", () => {
		const body = "## Procedure\n\nDo work.\n\n## 评分详情\n\n| x | 1 |";
		expect(stripEvolutionOpsSections(body)).toBe("## Procedure\n\nDo work.");
	});

	test("normalizeSkillForTemplate fixes tool-sequence skill", () => {
		const normalized = normalizeSkillForTemplate(baseSkill());
		const validation = validateSkillContent({
			name: normalized.name,
			description: normalized.description,
			taskPattern: normalized.taskPattern,
			approach: normalized.approach,
			pitfalls: normalized.pitfalls,
		});
		expect(normalized.description).not.toContain("Extracted from session");
		expect(normalized.approach).toContain("## When to use");
		expect(validation.ok).toBeTrue();
	});

	test("promotes markdown embedded in task_pattern", () => {
		const normalized = normalizeSkillForTemplate(
			baseSkill({
				name: "skill-dws",
				taskPattern: "# DingTalk\n\n## Rules\n\nWhen using dws, always pass --format json.",
				approach: "Tool sequence: read → bash.",
			}),
		);
		expect(normalized.approach).toContain("# DingTalk");
		expect(normalized.approach).toContain("## When to use");
	});
});
