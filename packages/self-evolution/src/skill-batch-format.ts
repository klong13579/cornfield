/**
 * Batch-normalize evolved skills to prompts/skill-template.md before export.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { HeuristicSkillEvaluator } from "./evaluator";
import { formatAgentSkillBody } from "./skill-format";
import { isValidSkillName } from "./skill-score";
import { normalizeSkillDescription, type SkillValidationInput, validateSkillContent } from "./skill-validation";
import { SqliteSkillStore } from "./storage/skills";
import { syncSkillsToFiles } from "./sync";
import type { EvolvedSkill } from "./types";

const EVOLUTION_SECTION_RE = /\n## (?:评分详情|种群生命周期|反馈与验证)[\s\S]*$/;
const EXTRACTED_SESSION_RE = /^Extracted from session\s+/i;
const TOOL_SEQUENCE_RE = /^Tool sequence:/i;
const TOOL_SEQUENCE_LINE_RE = /^\s*(?:[-*]\s*)?[a-z][a-z0-9_-]*(?:\s*→\s*[a-z][a-z0-9_-]*)+\s*\.?\s*$/i;

export interface BatchFormatSkillResult {
	name: string;
	changed: boolean;
	valid: boolean;
	failures: string[];
}

export interface BatchFormatResult {
	formatted: number;
	unchanged: number;
	stillInvalid: number;
	synced: number;
	skippedSync: number;
	skills: BatchFormatSkillResult[];
}

/** Strip score / population / ops sections from markdown body. */
export function stripEvolutionOpsSections(body: string): string {
	return body.replace(EVOLUTION_SECTION_RE, "").trim();
}

function isSessionExcerpt(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (EXTRACTED_SESSION_RE.test(t)) return true;
	if (t.length < 8 && !ACTION_LIKE.test(t)) return true;
	return false;
}

const ACTION_LIKE = /^(?:apply|use|trace|identify|analyze|design|verify|when|if|diagnose)/i;

function isToolSequenceOnly(approach: string): boolean {
	const t = approach.trim();
	if (!t) return true;
	if (TOOL_SEQUENCE_RE.test(t)) return true;
	const lines = t
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
	if (lines.length <= 2 && lines.every(l => TOOL_SEQUENCE_LINE_RE.test(l))) return true;
	return false;
}

function redactFilePaths(text: string): string {
	return text
		.replace(/Modified files:\s*[^\n]+/gi, "Modified files: (see session changelog)")
		.replace(/(?:~\/|\/Users\/)[\w./-]+/g, "project paths")
		.replace(/\b(?:packages|src|crates)\/[\w./-]+/g, "project modules")
		.replace(/\/(?:var|tmp|home)\/[\w./-]*/g, "system paths")
		.replace(/\(e\.g\.,\s*[^)]+\)/gi, "(e.g., standard OS log locations)");
}

function titleFromName(name: string): string {
	return name
		.split("-")
		.map(w => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

function inferWhenToUse(skill: EvolvedSkill): string {
	if (skill.taskPattern.trim() && !isSessionExcerpt(skill.taskPattern)) {
		const tp = skill.taskPattern.trim();
		if (!/^when\b/i.test(tp)) return `Use when ${tp.charAt(0).toLowerCase()}${tp.slice(1)}`;
		return tp;
	}

	const hints: Record<string, string> = {
		omp: "Use when designing tests or changing coding-agent behavior in this repository.",
		dws: "Use when the user asks to access DingTalk product capabilities via the dws CLI.",
		"skill-dws": "Use when operating DingTalk tables, docs, calendar, or related APIs through dws only.",
		log: "Use when diagnosing production or local issues from system or application logs.",
		reading: "Use when investigating slow read tool latency or redundant read/search loops.",
		"session-read": "Use when CLI read operations in recent sessions are unusually slow.",
		"omp-root-cause": "Use when tool calls hang or take much longer than expected before results render.",
		s3: "Use when analyzing S3 spreadsheet business metrics the user references by name.",
		"4-1-4": "Use when performing vacuum robot business analysis for April or YTD periods.",
		"deploy-playbook": "Use when planning or executing application deployments for this project.",
		"omp-evolution": "Use when extracting or explaining omp self-evolution user persona artifacts.",
		"omp-userpersona": "Use when implementing or updating autonomous UserPersona capture in omp.",
		"omp-skill-md": "Use when auditing generated skill markdown under a skills directory.",
		"task-mp8vukjv": "Use when fixing episodic storage or evolution pipeline regressions with traceable edits.",
	};

	return hints[skill.name] ?? `Use when the task clearly matches the "${skill.name}" workflow.`;
}

function inferOutcome(skill: EvolvedSkill): string {
	const hints: Record<string, string> = {
		omp: "Tests and code changes that routinely cover boundary and edge cases without user reminders.",
		log: "A short diagnosis naming log sources checked, the error pattern, and the next verification step.",
		"boundary-condition-testing":
			"A test plan naming each boundary, expected behavior, and the bug class it prevents.",
		dws: "Correct DingTalk operation results using only verified IDs and fields from dws JSON output.",
		"skill-dws": "DingTalk actions completed via dws with JSON-confirmed parameters and no fabricated IDs.",
		"deploy-playbook": "A deployment executed with rollback path documented.",
		"omp-root-cause": "A written root-cause hypothesis for slow tool latency with the next measurement.",
		reading: "Identified bottleneck layer (handler, provider, or I/O) for slow reads.",
		"session-read": "Explanation of why session reads were slow and what to change.",
	};
	return hints[skill.name] ?? `Deliverable for skill "${skill.name}" is complete and matches the triggers above.`;
}

function promoteEmbeddedBody(skill: EvolvedSkill): EvolvedSkill {
	const tp = skill.taskPattern.trim();
	const ap = skill.approach.trim();
	if (tp.length > 80 && (/^#\s/m.test(tp) || /^##\s/m.test(tp)) && (isToolSequenceOnly(ap) || ap.length < tp.length)) {
		return { ...skill, approach: tp, taskPattern: inferWhenToUse({ ...skill, taskPattern: "" }) };
	}
	return skill;
}

function procedureFromPitfalls(skill: EvolvedSkill): string {
	if (skill.pitfalls.length === 0) {
		return `When symptoms match this skill, state the plan in one paragraph, then execute the smallest verification step before broad searches.`;
	}
	const lines = skill.pitfalls.map(p => `- ${p.trim()}`).filter(Boolean);
	return [
		"When executing this workflow:",
		"",
		...lines,
		"",
		"If a pitfall matches the current symptom, change strategy before repeating the same tool chain.",
	].join("\n");
}

/** Rebuild approach stored in DB as full template-shaped markdown. */
export function rebuildSkillApproach(skill: EvolvedSkill): string {
	let approach = stripEvolutionOpsSections(redactFilePaths(skill.approach.trim()));

	if (isToolSequenceOnly(approach)) {
		approach = procedureFromPitfalls(skill);
	}

	const hasOutcome = /\b##\s*Outcome\b/i.test(approach);
	const hasWhen = /\b##\s*When to use\b/i.test(approach);
	const hasProcedure = /\b##\s*Procedure\b/i.test(approach);
	const hasTitle = /^#\s+/m.test(approach);

	const parts: string[] = [];

	if (!hasTitle) {
		parts.push(`# ${titleFromName(skill.name)}`, "");
	}
	if (!hasOutcome) {
		parts.push("## Outcome", "", inferOutcome(skill), "");
	}
	if (!hasWhen) {
		parts.push("## When to use", "", inferWhenToUse(skill), "");
	}

	if (hasProcedure || (hasTitle && hasOutcome && hasWhen)) {
		if (!hasProcedure && !/^##\s*Procedure/m.test(approach)) {
			const bodyWithoutHeader = approach.replace(/^#\s+[^\n]+\n+/, "").trim();
			parts.push("## Procedure", "", bodyWithoutHeader, "");
		} else {
			parts.push(approach);
		}
	} else if (hasTitle || /^##\s/m.test(approach)) {
		parts.push(approach);
	} else {
		parts.push("## Procedure", "", approach, "");
	}

	const merged = parts.join("\n").trim();
	const withPitfalls: EvolvedSkill = { ...skill, approach: merged };
	return formatAgentSkillBody(withPitfalls);
}

export function normalizeSkillForTemplate(skill: EvolvedSkill): EvolvedSkill {
	let s = promoteEmbeddedBody(skill);
	if (s.pitfalls.length === 0) {
		s = {
			...s,
			pitfalls: ["Do not apply outside the triggers listed under When to use."],
		};
	}
	s = {
		...s,
		approach: rebuildSkillApproach(s),
		taskPattern: isSessionExcerpt(s.taskPattern) ? inferWhenToUse(s) : s.taskPattern.trim(),
	};

	const input: SkillValidationInput = {
		name: s.name,
		description: s.description,
		taskPattern: s.taskPattern,
		approach: s.approach,
		pitfalls: s.pitfalls,
	};
	s.description = normalizeSkillDescription(input);

	return s;
}

export async function batchFormatSkills(
	db: Database,
	outputDir: string,
	options?: { dryRun?: boolean },
): Promise<BatchFormatResult> {
	const store = new SqliteSkillStore(db);
	const evaluator = new HeuristicSkillEvaluator();
	const skills = await store.list({ deprecated: false });

	const results: BatchFormatSkillResult[] = [];
	let formatted = 0;
	let unchanged = 0;
	let stillInvalid = 0;

	for (const original of skills) {
		if (!isValidSkillName(original.name)) continue;

		const normalized = normalizeSkillForTemplate(original);
		const validation = validateSkillContent({
			name: normalized.name,
			description: normalized.description,
			taskPattern: normalized.taskPattern,
			approach: normalized.approach,
			pitfalls: normalized.pitfalls,
		});

		const changed =
			normalized.description !== original.description ||
			normalized.taskPattern !== original.taskPattern ||
			normalized.approach !== original.approach;

		if (changed) {
			if (!options?.dryRun) {
				const breakdown = evaluator.reevaluate(normalized);
				await store.upsert({
					...normalized,
					version: original.version + 1,
					qualityScore: breakdown.total,
				});
			}
			formatted++;
		} else {
			unchanged++;
		}

		if (!validation.ok) stillInvalid++;

		results.push({
			name: original.name,
			changed,
			valid: validation.ok,
			failures: validation.failures,
		});
	}

	let synced = 0;
	let skippedSync = 0;
	if (!options?.dryRun) {
		const syncResult = await syncSkillsToFiles(db, outputDir);
		synced = syncResult.written;
		skippedSync = syncResult.skippedQuality;
		logger.debug("Batch format sync complete", {
			written: syncResult.written,
			skippedQuality: syncResult.skippedQuality,
		});
	}

	return { formatted, unchanged, stillInvalid, synced, skippedSync, skills: results };
}
