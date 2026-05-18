/**
 * Skill content validation per packages/self-evolution/src/prompts/skill-template.md
 */

export interface SkillValidationInput {
	name: string;
	description: string;
	taskPattern: string;
	approach: string;
	pitfalls: string[];
}

export interface SkillValidationResult {
	ok: boolean;
	failures: string[];
	warnings: string[];
}

const EXTRACTED_SESSION_RE = /^Extracted from session\s+/i;
const TOOL_SEQUENCE_LINE_RE = /^\s*(?:[-*]\s*)?[a-z][a-z0-9_-]*(?:\s*→\s*[a-z][a-z0-9_-]*)+\s*\.?\s*$/i;
const FILE_PATH_RE =
	/(?:^|\s)(?:~\/[\w./-]+|\/(?:Users|tmp|var|home|packages|src|test)[\w./-]*|\.?\/?(?:src|packages|test|crates)\/[\w./-]+)/i;
const CONDITIONAL_RE = /\b(if|when|unless|取决于|若|当|除非)\b/i;
const ACTION_VERB_RE =
	/^(?:apply|use|trace|identify|analyze|analyse|design|verify|validate|prefer|avoid|ensure|include|extract|diagnose|debug|implement|run|check|document|automatically|自动|使用|采用)/i;

const SESSION_AUDIT_RE = /\b(?:Modified files|Tool sequence|session\s+[0-9a-f-]{8,}|tools used:)\b/i;

const MAX_BODY_LINES = 200;
const MAX_DESCRIPTION_LEN = 120;

export function validateSkillContent(input: SkillValidationInput): SkillValidationResult {
	const failures: string[] = [];
	const warnings: string[] = [];

	const description = input.description.trim();
	const body = buildBodyForValidation(input);
	const bodyLines = body.split("\n");

	if (EXTRACTED_SESSION_RE.test(description)) {
		failures.push("description_is_session_excerpt");
	}

	if (description.length > 0 && !ACTION_VERB_RE.test(description)) {
		failures.push("description_not_action_verb");
	}

	if (description.length > MAX_DESCRIPTION_LEN) {
		warnings.push("description_over_120_chars");
	}

	if (bodyLines.filter(l => l.trim().length > 0).length === 0) {
		failures.push("body_empty_or_tool_sequence_only");
	} else if (isToolSequenceOnlyBody(body)) {
		failures.push("body_empty_or_tool_sequence_only");
	}

	if (body.length > 0 && !CONDITIONAL_RE.test(body)) {
		failures.push("body_missing_conditional");
	}

	if (FILE_PATH_RE.test(body)) {
		failures.push("body_contains_file_paths");
	}

	if (body.length > 0 && !hasLimitationOrCounterExample(body, input.pitfalls)) {
		failures.push("body_missing_counterexample");
	}

	if (bodyLines.length > MAX_BODY_LINES) {
		failures.push("body_over_200_lines");
	}

	if (SESSION_AUDIT_RE.test(body) && !CONDITIONAL_RE.test(body)) {
		failures.push("body_is_session_audit_only");
	}

	if (body.includes("## 评分详情") || body.includes("## 种群生命周期") || body.includes("## 反馈与验证")) {
		failures.push("body_contains_evolution_ops_sections");
	}

	return { ok: failures.length === 0, failures, warnings };
}

/** Normalize description for export when extractor left a session excerpt. */
export function normalizeSkillDescription(input: SkillValidationInput): string {
	const trimmed = input.description.trim();
	if (!EXTRACTED_SESSION_RE.test(trimmed) && ACTION_VERB_RE.test(trimmed)) {
		return clampDescription(trimmed);
	}

	const fromPattern = input.taskPattern.trim();
	if (fromPattern.length > 0 && ACTION_VERB_RE.test(fromPattern)) {
		return clampDescription(fromPattern);
	}

	const fromApproach = firstSentence(input.approach);
	if (fromApproach.length > 0) {
		const prefixed = ACTION_VERB_RE.test(fromApproach) ? fromApproach : `Apply ${fromApproach}`;
		return clampDescription(prefixed);
	}

	return clampDescription(trimmed || `Use skill ${input.name} for recurring tasks in this project.`);
}

function buildBodyForValidation(input: SkillValidationInput): string {
	const parts: string[] = [];
	if (input.approach.trim()) parts.push(input.approach.trim());
	if (input.pitfalls.length > 0) {
		parts.push(input.pitfalls.map(p => `- ${p.trim()}`).join("\n"));
	}
	return parts.join("\n\n");
}

function isToolSequenceOnlyBody(body: string): boolean {
	const lines = body
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return true;
	if (lines.length > 3) return false;
	return lines.every(l => TOOL_SEQUENCE_LINE_RE.test(l) || /^Tool sequence:/i.test(l));
}

function hasLimitationOrCounterExample(body: string, pitfalls: string[]): boolean {
	if (pitfalls.length > 0) return true;
	return /\b(反例|不适用|anti-pattern|do not use|when not|limitation|except when|避免|不要)\b/i.test(body);
}

function firstSentence(text: string): string {
	const t = text.trim();
	const match = t.match(/^[^.!?\n]+[.!?]?/);
	return match ? match[0].trim() : t.slice(0, MAX_DESCRIPTION_LEN);
}

function clampDescription(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= MAX_DESCRIPTION_LEN) return oneLine;
	return `${oneLine.slice(0, MAX_DESCRIPTION_LEN - 3)}...`;
}
