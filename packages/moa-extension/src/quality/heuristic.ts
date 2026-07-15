import type { MoaOutputSchema, ParsedWorkerOutput } from "../types";
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

	const planText = parsed.sections.plan ?? "";
	const oqText = parsed.sections.open_questions ?? "";
	const oqCount = oqText ? countBulletItems(oqText) : 0;
	const assumptionsText = parsed.sections.assumptions ?? "";

	const refusalMatches: string[] = [];
	for (const re of REFUSAL_PATTERNS) {
		const m = oqText.match(re) ?? planText.match(re);
		if (m) refusalMatches.push(m[0]);
	}

	const requiredHit = requiredTotal === 0 ? 1 : requiredHits / requiredTotal;

	return {
		requiredHits,
		requiredTotal,
		hits: {
			required: requiredHit,
			planSubstance: planText.length > 200 ? 1 : 0,
			openQuestions: oqCount < 5 ? 1 : 0,
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
	const { requiredHits, requiredTotal, hits } = computeHits(parsed, schema);

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
	const contractHardFail = requiredTotal > 0 && requiredHits < requiredTotal;
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
