/**
 * Format evolved skills as markdown per skill-template.md (agent body only in正文).
 */
import type { SkillFrontmatter } from "@oh-my-pi/cognitive-coordination";
import { normalizeEvolutionScore } from "./skill-score";
import { normalizeSkillDescription, type SkillValidationInput } from "./skill-validation";
import type { EvolvedSkill } from "./types";

export interface SkillMarkdownFrontmatter extends SkillFrontmatter {
	quality_score: number;
	usage_count: number;
	success_count: number;
	failure_count: number;
	user_rating: number;
	population_state?: string;
	evolution_score?: number;
	population_success_rate?: number;
	times_injected?: number;
	times_helped?: number;
	times_failed?: number;
}

export interface FormatSkillMarkdownOptions {
	source: SkillFrontmatter["source"];
	/** Heuristic re-evaluation total (0–100); overrides DB quality_score when set. */
	qualityScore?: number;
	population?: {
		state: string;
		evolutionScore: number;
		successRate: number;
	};
	effectiveness?: {
		timesInjected: number;
		timesHelped: number;
		timesFailed: number;
	};
}

export function formatSkillMarkdown(skill: EvolvedSkill, options: FormatSkillMarkdownOptions): string {
	const validationInput: SkillValidationInput = {
		name: skill.name,
		description: skill.description,
		taskPattern: skill.taskPattern,
		approach: skill.approach,
		pitfalls: skill.pitfalls,
	};

	const frontmatter = buildFrontmatter(skill, options, validationInput);
	const body = formatAgentSkillBody(skill);
	const yaml = formatYamlFrontmatter(frontmatter);
	return `${yaml}\n\n${body}\n`;
}

function buildFrontmatter(
	skill: EvolvedSkill,
	options: FormatSkillMarkdownOptions,
	validationInput: SkillValidationInput,
): SkillMarkdownFrontmatter {
	let confidenceScore: number;
	if (skill.qualityScore !== undefined) {
		confidenceScore = skill.qualityScore / 100;
	} else if (skill.usageCount > 0) {
		confidenceScore = skill.successCount / skill.usageCount;
	} else {
		confidenceScore = 0;
	}

	const status: SkillFrontmatter["status"] = skill.deprecated ? "deprecated" : "active";
	const lastUsedAt = skill.lastUsedAt ? new Date(skill.lastUsedAt).toISOString() : new Date().toISOString();

	const base: SkillMarkdownFrontmatter = {
		name: skill.name,
		version: String(skill.version),
		source: options.source,
		confidence_score: Math.round(confidenceScore * 100) / 100,
		last_used_at: lastUsedAt,
		status,
		description: normalizeSkillDescription(validationInput),
		quality_score: options.qualityScore ?? skill.qualityScore ?? 0,
		usage_count: skill.usageCount,
		success_count: skill.successCount,
		failure_count: skill.failureCount,
		user_rating: skill.userRating ?? 0,
	};

	if (options.population) {
		base.population_state = options.population.state;
		base.evolution_score = Math.round(normalizeEvolutionScore(options.population.evolutionScore) * 1000) / 1000;
		base.population_success_rate = Math.round(options.population.successRate * 1000) / 1000;
	}

	if (options.effectiveness) {
		base.times_injected = options.effectiveness.timesInjected;
		base.times_helped = options.effectiveness.timesHelped;
		base.times_failed = options.effectiveness.timesFailed;
	}

	return base;
}

function formatYamlFrontmatter(frontmatter: SkillMarkdownFrontmatter): string {
	const lines = [
		"---",
		`name: "${escapeYamlString(frontmatter.name)}"`,
		`version: "${frontmatter.version}"`,
		`source: "${frontmatter.source}"`,
		`status: "${frontmatter.status}"`,
		`confidence_score: ${frontmatter.confidence_score}`,
		`quality_score: ${frontmatter.quality_score}`,
		`usage_count: ${frontmatter.usage_count}`,
		`success_count: ${frontmatter.success_count}`,
		`failure_count: ${frontmatter.failure_count}`,
		`user_rating: ${frontmatter.user_rating}`,
		`last_used_at: "${frontmatter.last_used_at}"`,
		`description: "${escapeYamlString(frontmatter.description ?? "")}"`,
	];

	if (frontmatter.population_state) {
		lines.push(`population_state: "${frontmatter.population_state}"`);
		lines.push(`evolution_score: ${frontmatter.evolution_score}`);
		lines.push(`population_success_rate: ${frontmatter.population_success_rate}`);
	}
	if (frontmatter.times_injected !== undefined) {
		lines.push(`times_injected: ${frontmatter.times_injected}`);
		lines.push(`times_helped: ${frontmatter.times_helped}`);
		lines.push(`times_failed: ${frontmatter.times_failed}`);
	}

	lines.push("---");
	return lines.join("\n");
}

/** Agent-facing markdown body (no scores, population tables, or ops instructions). */
export function formatAgentSkillBody(skill: EvolvedSkill): string {
	const title = skill.name
		.split("-")
		.map(w => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");

	const sections: string[] = [`# ${title}`, ""];

	const approach = skill.approach.trim();
	const hasStructuredApproach = /^#\s+/m.test(approach) || /^##\s+/m.test(approach);

	if (hasStructuredApproach) {
		sections.push(approach);
	} else {
		if (skill.taskPattern.trim()) {
			sections.push("## When to use", "", skill.taskPattern.trim(), "");
		}
		if (approach) {
			sections.push("## Procedure", "", approach, "");
		}
	}

	const pitfalls = skill.pitfalls.map(p => p.trim()).filter(Boolean);
	if (pitfalls.length > 0) {
		const hasPitfallSection = /\b##\s*Pitfalls\b/i.test(approach);
		if (!hasPitfallSection) {
			sections.push("## Pitfalls", "", ...pitfalls.map(p => `- ${p}`), "");
		}
	}

	if (
		!/\b##\s*Anti-patterns\b/i.test(sections.join("\n")) &&
		!/\b(不适用|when not|do not)\b/i.test(sections.join("\n"))
	) {
		sections.push(
			"## Anti-patterns",
			"",
			"- Do not apply this skill outside the triggers listed under When to use.",
			"",
		);
	}

	return sections.join("\n").trimEnd();
}

/** Ensure memory-consolidated markdown passes agent-body shape checks. */
export function ensureAgentBodyShape(content: string): string {
	const trimmed = content.trim();
	if (!trimmed) return trimmed;
	if (/^#\s+/m.test(trimmed) || /^##\s+/m.test(trimmed)) {
		if (!/\b(不适用|when not|Anti-patterns)\b/i.test(trimmed)) {
			return `${trimmed}\n\n## Anti-patterns\n\n- Do not apply outside the triggers described above.\n`;
		}
		return trimmed;
	}
	return [
		"# Skill",
		"",
		"## When to use",
		"",
		"Apply when this consolidated memory matches the current task context.",
		"",
		"## Procedure",
		"",
		trimmed,
		"",
		"## Anti-patterns",
		"",
		"- Do not apply when the task does not match the triggers above.",
		"",
	].join("\n");
}

function escapeYamlString(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
