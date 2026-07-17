/**
 * Parse a worker subprocess's raw text output against a `MoaOutputSchema`.
 *
 * The contract is structural, not semantic:
 *   - Sections are markdown `## <name>` headers. The first line of the
 *     header is taken as the section name; everything until the next
 *     `## <name>` header (or end of input) is the section body.
 *   - Section names are matched case-insensitively against schema.
 *   - A `required` section missing from output is reported in
 *     `missingRequired` so the quality scorer can penalize it.
 *   - Section bodies for `list` type are returned as raw bullet text;
 *     downstream code parses further if needed.
 *
 * The raw text is always preserved on the caller's MoaWorkerResult. The
 * parser is pure: it returns a new struct, never mutates input.
 */

import { REFUSAL_PATTERNS, scoreWorkerHeuristicV2 } from "./quality/heuristic";
import type { MoaQualitySettings } from "./quality/types";
import { resolveRoleWeights } from "./quality/weights";
import { applyResearchSourcesPenalty, type ResearchMode } from "./research-mode";
import type { MoaOutputSchema, MoaOutputSchemaSection, MoaWorkerResult, ParsedWorkerOutput } from "./types";

export type { ParsedWorkerOutput } from "./types";

/**
 * Regex for `## <name>` sections.
 *
 * PR2 fix: trailing whitespace before the section's trailing `\n` is matched
 * non-greedily (`\s*?`). The original greedy `\s*` would consume a blank
 * line between two consecutive sections, leaving the engine to start the
 * body at the next section's `##` prefix — which then forced the lazy
 * `[\s\S]*?` to capture the entire next section just to satisfy the
 * lookahead. With non-greedy whitespace, an empty `## foo\n\n## bar` body
 * correctly parses as `foo: ""`, `bar: <its body>`.
 */
const SECTION_RE = /##\s+([a-zA-Z][\w-]*)\s*?\n([\s\S]*?)(?=\n##\s+|$)/g;

/**
 * Extract every `## <name>` section from the raw text. Returns a Map of
 * lowercased name -> trimmed body. Order is preserved as encountered.
 */
function extractSections(raw: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!raw) return out;
	const re = new RegExp(SECTION_RE.source, "g");
	for (const match of raw.matchAll(re)) {
		const name = match[1]!.trim().toLowerCase();
		const body = match[2]!.trim();
		// First occurrence wins (workers occasionally re-emit the same header)
		if (!out.has(name)) out.set(name, body);
	}
	return out;
}

/**
 * Parse worker output against the schema. Pure: no side effects.
 *
 * - Required section missing ⇒ recorded in `missingRequired`.
 * - Non-required section missing ⇒ silently treated as empty (not in result).
 * - Extra sections in output ⇒ recorded in `extraSections` for awareness,
 *   but not in the result map.
 */
export function parseWorkerOutputBySchema(raw: string, schema: MoaOutputSchema): ParsedWorkerOutput {
	const found = extractSections(raw);
	const schemaNames = new Set(schema.sections.map(s => s.name.toLowerCase()));
	const sections: Record<string, string> = {};
	const missingRequired: string[] = [];
	const extraSections: string[] = [];
	for (const sec of schema.sections) {
		const text = found.get(sec.name.toLowerCase());
		if (text === undefined) {
			if (sec.required) missingRequired.push(sec.name);
		} else {
			sections[sec.name] = text;
		}
	}
	for (const name of found.keys()) {
		if (!schemaNames.has(name)) extraSections.push(name);
	}

	// Soft recovery (dual-channel): workers often emit freeform markdown
	// (`## Step 1`, Chinese headings, etc.) and omit the schema's exact
	// headers. When *every* required section is missing but there is substance,
	// try to partition the body into required slots (prose → primary markdown,
	// fenced code → code/diff-like markdown, verify bullets → list). If every
	// required section ends up non-empty, clear softRecovered (contract met via
	// recovery). Otherwise keep softRecovered + missingRequired so empty
	// synthesized open_questions cannot fake all_complete.
	const required = schema.sections.filter(s => s.required);
	const body = raw.trim();
	const matchedSchemaCount = schema.sections.filter(s => found.has(s.name.toLowerCase())).length;
	let softRecovered = false;
	if (
		body.length > 0 &&
		required.length > 0 &&
		matchedSchemaCount === 0 &&
		missingRequired.length === required.length
	) {
		const partitioned = partitionFreeformIntoSchema(body, required);
		for (const [name, text] of Object.entries(partitioned)) {
			sections[name] = text;
		}
		const allRequiredFilled = required.every(sec => (sections[sec.name] ?? "").trim().length > 0);
		if (allRequiredFilled) {
			missingRequired.length = 0;
			softRecovered = false;
		} else {
			softRecovered = true;
			// Do NOT clear missingRequired — contract remains unsatisfied.
		}
	}

	return { sections, missingRequired, extraSections, parseErrors: [], softRecovered: softRecovered || undefined };
}

const FENCE_RE = /```[\w+-]*\n([\s\S]*?)```/g;

/**
 * Heuristic split of freeform worker text into required schema sections.
 * Used only when zero schema headers matched.
 */
export function partitionFreeformIntoSchema(
	body: string,
	required: ReadonlyArray<MoaOutputSchemaSection>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const sec of required) out[sec.name] = "";

	const fences: string[] = [];
	const prose = body
		.replace(FENCE_RE, (_m, code: string) => {
			fences.push(code.trim());
			return "\n";
		})
		.trim();

	const primary = required.find(s => s.type === "markdown") ?? required[0]!;
	const codeSec =
		required.find(
			s => s.type === "markdown" && s.name !== primary.name && /code|diff|impl|patch|sketch/i.test(s.name),
		) ?? required.find(s => s.type === "markdown" && s.name !== primary.name);
	const listSecs = required.filter(s => s.type === "list");

	out[primary.name] = prose || (fences.length === 0 ? body : "");

	if (codeSec && fences.length > 0) {
		out[codeSec.name] = fences.map(f => "```\n" + f + "\n```").join("\n\n");
		if (!out[primary.name]?.trim() && prose) out[primary.name] = prose;
		if (!out[primary.name]?.trim()) {
			// Code-only freeform: keep a short pointer in the primary section.
			out[primary.name] = `See \`## ${codeSec.name}\` for the implementation.`;
		}
	} else if (fences.length > 0) {
		const fenceBlock = fences.map(f => "```\n" + f + "\n```").join("\n\n");
		out[primary.name] = [out[primary.name], fenceBlock].filter(Boolean).join("\n\n");
	}

	const verifyLines = extractVerifyBullets(body);
	for (const listSec of listSecs) {
		if (/question/i.test(listSec.name)) {
			// Leave empty — residual questions must not be invented; softRecover
			// stays set when this required list is empty.
			out[listSec.name] = "";
			continue;
		}
		if (verifyLines.length > 0 && /verif|step|check|test|curl/i.test(listSec.name)) {
			out[listSec.name] = verifyLines.map(l => (l.startsWith("-") ? l : `- ${l}`)).join("\n");
		} else if (/assumption/i.test(listSec.name)) {
			out[listSec.name] = "";
		} else if (verifyLines.length > 0) {
			out[listSec.name] = verifyLines.map(l => (l.startsWith("-") ? l : `- ${l}`)).join("\n");
		} else if ((out[primary.name] ?? "").trim().length > 0 || (codeSec && (out[codeSec.name] ?? "").trim())) {
			out[listSec.name] = "- covered in plan / code sections";
		}
	}

	return out;
}

function extractVerifyBullets(body: string): string[] {
	const lines = body.split("\n");
	const out: string[] = [];
	let inVerify = false;
	for (const line of lines) {
		if (/验证|verify|curl\b|运行|usage|如何启动|test(?:ing)?\b/i.test(line) && !line.trim().startsWith("```")) {
			inVerify = true;
		}
		if (inVerify) {
			const m = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
			if (m) out.push(m[1]!.trim());
			else if (/^\s*curl\b/i.test(line) || /^\s*bun\b/i.test(line)) out.push(line.trim());
			else if (line.trim().startsWith("```")) inVerify = false;
		}
	}
	if (out.length === 0) {
		for (const line of lines) {
			if (/^\s*curl\b/i.test(line)) out.push(line.trim());
		}
	}
	return out;
}

// ----------------------------------------------------------------------------
// Quality heuristic (v1)
//
// Score in [0, 100]. < qualityMinScore ⇒ worker dropped from synthesis input.
// Heuristic is rule-based, no LLM call. Designed to be inspectable and
// inspectable logs; PR2 may upgrade to LLM judge if distribution shows
// heuristic is too lenient or too strict.
// ----------------------------------------------------------------------------

export const DEFAULT_QUALITY_MIN_SCORE = 40;

export interface WorkerQualityBreakdown {
	score: number;
	requiredSectionHits: number;
	requiredSectionTotal: number;
	planLength: number;
	openQuestionCount: number;
	hasAssumptions: boolean;
	refusalMatches: string[];
}

export function scoreWorkerOutput(parsed: ParsedWorkerOutput, schema: MoaOutputSchema): WorkerQualityBreakdown {
	const requiredSections = schema.sections.filter(s => s.required);
	const requiredTotal = requiredSections.length;
	const requiredHits = requiredSections.filter(s => parsed.sections[s.name] !== undefined).length;

	const planText = parsed.sections.plan ?? "";
	const oqText = parsed.sections.open_questions ?? "";
	const oqCount = oqText ? countBulletItems(oqText) : 0;
	const hasAssumptions = !!parsed.sections.assumptions;

	const refusalMatches: string[] = [];
	for (const re of REFUSAL_PATTERNS) {
		const m = oqText.match(re) ?? planText.match(re);
		if (m) refusalMatches.push(m[0]);
	}

	let score = 0;
	if (requiredTotal > 0) score += Math.round((30 * requiredHits) / requiredTotal);
	if (planText.length > 200) score += 20;
	if (oqCount < 5) score += 20;
	if (hasAssumptions) score += 10;
	if (refusalMatches.length === 0) score += 20;
	// Hard drop: any missing required section (or soft-recovered freeform)
	// caps the score below the default minScore (40).
	if (parsed.softRecovered || requiredHits < requiredTotal) {
		score = Math.min(score, 30);
	}

	return {
		score,
		requiredSectionHits: requiredHits,
		requiredSectionTotal: requiredTotal,
		planLength: planText.length,
		openQuestionCount: oqCount,
		hasAssumptions,
		refusalMatches,
	};
}

/**
 * Count bullet items in a markdown section body. Tolerant: matches `-`, `*`,
 * `+`, or numbered list prefixes. Empty lines are not counted.
 */
function countBulletItems(text: string): number {
	const lines = text.split("\n");
	let n = 0;
	for (const line of lines) {
		if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) n += 1;
	}
	return n;
}

/**
 * Sync parse + heuristic v2 score + apply. Returns a copy with `parsed`,
 * `qualityScore`, `qualityDropped`, `parsedAt`. Uses per-role weights from
 * `result.name` / `result.role` via `resolveRoleWeights` +
 * `scoreWorkerHeuristicV2` — no LLM judge.
 *
 * For production pipeline scoring (including optional LLM judge in gray
 * zone), use async `applyWorkerQuality` from `./quality/apply` instead.
 */
export function applyWorkerParsing(
	result: MoaWorkerResult,
	schema: MoaOutputSchema,
	options: {
		minScore?: number;
		now?: () => Date;
		quality?: MoaQualitySettings;
		researchMode?: ResearchMode;
	} = {},
): MoaWorkerResult {
	const minScore = options.minScore ?? DEFAULT_QUALITY_MIN_SCORE;
	const researchMode = options.researchMode ?? "none";
	const parsed = parseWorkerOutputBySchema(result.output, schema);
	const weights = resolveRoleWeights(result.name, result.role, options.quality?.roleWeights);
	const heuristic = scoreWorkerHeuristicV2(parsed, schema, weights);
	const score = applyResearchSourcesPenalty(heuristic.score, parsed.sections.sources, researchMode);
	return {
		...result,
		parsed: parsed.sections,
		qualityScore: score,
		qualityDropped: score < minScore,
		parsedAt: (options.now ?? (() => new Date()))().toISOString(),
	};
}

/**
 * Returns true when the worker's parsed output has any non-empty
 * `## open_questions` section. Used by the multi-round convergence
 * check (condition 4: all workers score ≥ 80 AND zero open_questions).
 *
 * Soft-recovered freeform synthesizes an empty `open_questions` section;
 * that must NOT count as "no questions" / all_complete — treat as unresolved.
 */
export function hasOpenQuestions(result: MoaWorkerResult, schema: MoaOutputSchema): boolean {
	const parsed = parseWorkerOutputBySchema(result.output, schema);
	if (parsed.softRecovered) return true;
	const section = parsed.sections.open_questions;
	if (!section) return false;
	return section.trim().length > 0;
}

// Suppress lint: explicit no-op export of section type for type-only users.
export type { MoaOutputSchemaSection };
