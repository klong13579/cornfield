import type { MoaOutputSchema, MoaWorkerResult } from "../types";
import type { ResearchMode } from "../research-mode";
import { applyResearchSourcesPenalty } from "../research-mode";
import { DEFAULT_QUALITY_MIN_SCORE, parseWorkerOutputBySchema } from "../worker-parser";
import { scoreWorkerHeuristicV2 } from "./heuristic";
import { type JudgeFnArgs, type JudgeResult, shouldJudge } from "./judge";
import type { MoaQualityMeta, MoaQualitySettings } from "./types";
import { resolveRoleKey, resolveRoleWeights } from "./weights";

const DEFAULT_GRAY_MARGIN = 10;

function resolveJudgeEnabled(quality?: MoaQualitySettings): boolean {
	return quality?.judge.enabled ?? false;
}

function resolveGrayMargin(quality?: MoaQualitySettings): number {
	return quality?.judge.grayMargin ?? DEFAULT_GRAY_MARGIN;
}

export async function applyWorkerQuality(
	result: MoaWorkerResult,
	schema: MoaOutputSchema,
	options?: {
		minScore?: number;
		quality?: MoaQualitySettings;
		now?: () => Date;
		judgeFn?: (args: JudgeFnArgs) => Promise<JudgeResult>;
		task?: string;
		signal?: AbortSignal;
		researchMode?: ResearchMode;
	},
): Promise<MoaWorkerResult> {
	const minScore = options?.minScore ?? DEFAULT_QUALITY_MIN_SCORE;
	const quality = options?.quality;
	const judgeEnabled = resolveJudgeEnabled(quality);
	const grayMargin = resolveGrayMargin(quality);
	const researchMode = options?.researchMode ?? "none";

	const parsed = parseWorkerOutputBySchema(result.output, schema);
	const weights = resolveRoleWeights(result.name, result.role, quality?.roleWeights);
	const roleKey = resolveRoleKey(result.name, result.role);
	const heuristic = scoreWorkerHeuristicV2(parsed, schema, weights);
	const heuristicScore = applyResearchSourcesPenalty(
		heuristic.score,
		parsed.sections.sources,
		researchMode,
	);

	let finalScore = heuristicScore;
	let source: MoaQualityMeta["source"] = "heuristic";
	let judgeScore: number | undefined;
	let judged = false;
	let judgeError: string | undefined;

	const needsJudge = shouldJudge({
		enabled: judgeEnabled,
		contractHardFail: heuristic.contractHardFail,
		heuristicScore,
		minScore,
		grayMargin,
	});

	if (needsJudge && options?.judgeFn) {
		try {
			const judgeResult = await options.judgeFn({
				result,
				parsed,
				schema,
				heuristicScore,
				roleKey,
				task: options.task,
				signal: options.signal,
			});
			judgeScore = Math.min(100, Math.max(0, Math.round(judgeResult.score)));
			finalScore = applyResearchSourcesPenalty(judgeScore, parsed.sections.sources, researchMode);
			source = "judge";
			judged = true;
		} catch (err) {
			judgeError = err instanceof Error ? err.message : String(err);
		}
	} else if (needsJudge && !options?.judgeFn) {
		judgeError = "judge_fn_missing";
	}

	const qualityMeta: MoaQualityMeta = {
		version: 2,
		heuristicScore,
		source,
		roleKey,
		contractHardFail: heuristic.contractHardFail,
		judged,
		breakdown: heuristic.breakdown,
	};
	if (judgeScore !== undefined) {
		qualityMeta.judgeScore = judgeScore;
	}
	if (judgeError !== undefined) {
		qualityMeta.judgeError = judgeError;
	}

	return {
		...result,
		parsed: parsed.sections,
		qualityScore: finalScore,
		qualityDropped: finalScore < minScore,
		qualityMeta,
		parsedAt: (options?.now ?? (() => new Date()))().toISOString(),
	};
}
