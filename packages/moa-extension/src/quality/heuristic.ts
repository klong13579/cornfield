import type { MoaOutputSchema, MoaOutputSchemaSection, ParsedWorkerOutput } from "../types";
import type { MoaQualityRoleWeights, WorkerQualityBreakdownV2 } from "./types";

/** Known-bad patterns the worker emits when it's refusing to work. */
export const REFUSAL_PATTERNS = [
	/请确认/,
	/as an AI/i,
	/I cannot/i,
	/让我先/,
	/can you (?:please )?confirm/i,
	/需要(?:您|你)确认/,
	/需要(?:更多|进一步)信息/,
];

function countBulletItems(text: string): number {
	const lines = text.split("\n");
	let n = 0;
	for (const line of lines) {
		if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) n += 1;
	}
	return n;
}

/**
 * Primary deliverable section for `planSubstance`: first required markdown
 * section in schema order, else first required section of any type.
 * Falls back to `plan` when the schema has no required sections (legacy).
 */
export function resolvePrimarySubstanceSection(schema: MoaOutputSchema): MoaOutputSchemaSection | undefined {
	const required = schema.sections.filter(s => s.required);
	return required.find(s => s.type === "markdown") ?? required[0] ?? schema.sections.find(s => s.name === "plan");
}

/**
 * Question / residual-list section for `openQuestions` credit: prefer a
 * required list whose name contains "question", else any required list
 * excluding assumptions and the primary substance section (avoids double-
 * counting the same list as both planSubstance and openQuestions).
 * Falls back to the legacy `open_questions` name.
 */
export function resolveQuestionsListSection(
	schema: MoaOutputSchema,
	primary?: MoaOutputSchemaSection,
): MoaOutputSchemaSection | undefined {
	const primaryName = primary?.name;
	const requiredLists = schema.sections.filter(
		s => s.required && s.type === "list" && s.name !== primaryName && !/assumption/i.test(s.name),
	);
	const byName = requiredLists.find(s => /question/i.test(s.name));
	if (byName) return byName;
	if (requiredLists[0]) return requiredLists[0];
	return schema.sections.find(s => s.name === "open_questions" && s.name !== primaryName);
}

function resolveAssumptionsSection(schema: MoaOutputSchema): MoaOutputSchemaSection | undefined {
	return schema.sections.find(s => /assumption/i.test(s.name)) ?? schema.sections.find(s => s.name === "assumptions");
}

function computeHits(
	parsed: ParsedWorkerOutput,
	schema: MoaOutputSchema,
): {
	requiredHits: number;
	requiredTotal: number;
	hits: WorkerQualityBreakdownV2["hits"];
} {
	const requiredSections = schema.sections.filter(s => s.required);
	const requiredTotal = requiredSections.length;
	const requiredHits = requiredSections.filter(s => parsed.sections[s.name] !== undefined).length;

	const primary = resolvePrimarySubstanceSection(schema);
	const questionsSec = resolveQuestionsListSection(schema, primary);
	const assumptionsSec = resolveAssumptionsSection(schema);

	const primaryText = primary ? (parsed.sections[primary.name] ?? "") : "";
	const questionsText = questionsSec ? (parsed.sections[questionsSec.name] ?? "") : "";
	const assumptionsText = assumptionsSec ? (parsed.sections[assumptionsSec.name] ?? "") : "";
	const questionCount = questionsText ? countBulletItems(questionsText) : 0;

	const refusalMatches: string[] = [];
	for (const re of REFUSAL_PATTERNS) {
		const m = questionsText.match(re) ?? primaryText.match(re);
		if (m) refusalMatches.push(m[0]);
	}

	const requiredHit = requiredTotal === 0 ? 1 : requiredHits / requiredTotal;

	return {
		requiredHits,
		requiredTotal,
		hits: {
			required: requiredHit,
			planSubstance: primaryText.length > 200 ? 1 : 0,
			// Prefer few residual questions; empty / absent list also counts as ok
			// when the schema has no questions section at all.
			openQuestions: questionsSec ? (questionCount < 5 ? 1 : 0) : 1,
			assumptions: assumptionsText.trim().length > 0 ? 1 : 0,
			noRefusal: refusalMatches.length === 0 ? 1 : 0,
		},
	};
}

export function scoreWorkerHeuristicV2(
	parsed: ParsedWorkerOutput,
	schema: MoaOutputSchema,
	weights: MoaQualityRoleWeights,
): { score: number; contractHardFail: boolean; breakdown: WorkerQualityBreakdownV2 } {
	const { hits } = computeHits(parsed, schema);

	const contributions = {
		required: weights.required * hits.required,
		planSubstance: weights.planSubstance * hits.planSubstance,
		openQuestions: weights.openQuestions * hits.openQuestions,
		assumptions: weights.assumptions * hits.assumptions,
		noRefusal: weights.noRefusal * hits.noRefusal,
	};

	const raw =
		contributions.required +
		contributions.planSubstance +
		contributions.openQuestions +
		contributions.assumptions +
		contributions.noRefusal;

	let score = Math.round(raw);
	// softRecovered fills sections for display but must not clear the contract
	// hard-fail (empty synthesized open_questions would otherwise look complete).
	// `sources` is soft-enforced via research-mode penalty (cap 60 / −10), not
	// the hard-fail ceiling of 30 — otherwise research-required runs would drop
	// every worker that forgot a URL.
	const hardRequired = schema.sections.filter(s => s.required && s.name !== "sources");
	const hardRequiredHits = hardRequired.filter(s => parsed.sections[s.name] !== undefined).length;
	const contractHardFail =
		Boolean(parsed.softRecovered) || (hardRequired.length > 0 && hardRequiredHits < hardRequired.length);
	if (contractHardFail) {
		score = Math.min(score, 30);
	}

	return {
		score,
		contractHardFail,
		breakdown: {
			weights: { ...weights },
			hits,
			contributions,
		},
	};
}
