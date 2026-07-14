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

import type { MoaOutputSchema, MoaOutputSchemaSection, MoaWorkerResult } from "./types";

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

export interface ParsedWorkerOutput {
	/** Section name (lowercased) -> raw section text (trimmed). */
	sections: Record<string, string>;
	/** Required section names that were not present in the output. */
	missingRequired: string[];
	/** Section names present in output that are not in the schema. Informational. */
	extraSections: string[];
	/** Any structural parse errors (e.g. malformed section header). */
	parseErrors: string[];
}

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
	return { sections, missingRequired, extraSections, parseErrors: [] };
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

/** Heuristic: known-bad patterns the worker emits when it's refusing to work. */
const REFUSAL_PATTERNS = [
	/请确认/,
	/as an AI/i,
	/I cannot/i,
	/让我先/,
	/can you (?:please )?confirm/i,
	/需要(?:您|你)确认/,
	/需要(?:更多|进一步)信息/,
];

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
	// Hard drop: any missing required section caps the score below the
	// default minScore (40), so a worker that didn't follow the schema
	// contract is always dropped regardless of other strengths.
	if (requiredHits < requiredTotal) {
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
 * Convenience: parse + score + apply. Mutates a copy of the worker result
 * with `parsed`, `qualityScore`, `qualityDropped`, `parsedAt`. Returns the
 * mutated copy; the input is not modified.
 *
 * PR1 callers: tests, smoke e2e. PR2 callers: executor after runWorker.
 */
export function applyWorkerParsing(
	result: MoaWorkerResult,
	schema: MoaOutputSchema,
	options: { minScore?: number; now?: () => Date } = {},
): MoaWorkerResult {
	const minScore = options.minScore ?? DEFAULT_QUALITY_MIN_SCORE;
	const parsed = parseWorkerOutputBySchema(result.output, schema);
	const breakdown = scoreWorkerOutput(parsed, schema);
	return {
		...result,
		parsed: parsed.sections,
		qualityScore: breakdown.score,
		qualityDropped: breakdown.score < minScore,
		parsedAt: (options.now ?? (() => new Date()))().toISOString(),
	};
}

/**
 * Returns true when the worker's parsed output has any non-empty
 * `## open_questions` section. Used by the multi-round convergence
 * check (condition 4: all workers score ≥ 80 AND zero open_questions).
 */
export function hasOpenQuestions(result: MoaWorkerResult, schema: MoaOutputSchema): boolean {
	const parsed = parseWorkerOutputBySchema(result.output, schema);
	const section = parsed.sections.open_questions;
	if (!section) return false;
	return section.trim().length > 0;
}

// Suppress lint: explicit no-op export of section type for type-only users.
export type { MoaOutputSchemaSection };
