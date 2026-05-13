/**
 * FitScorer — heuristic dimension scoring for 「懂我程度」.
 *
 * Computes per-dimension scores from raw LLM judge outputs,
 * applies dimension weights, and produces the final FitReport.
 */
import type { FitReport, FitScoreRecord, FitVerdict } from "../types";

const DIMENSION_NAMES = ["memory", "thinking", "style", "prediction", "history"] as const;
type DimKey = (typeof DIMENSION_NAMES)[number];

const DIMENSION_LABELS: Record<DimKey, string> = {
	memory: "个人记忆留存",
	thinking: "思维模式适配",
	style: "输出风格贴合",
	prediction: "隐含需求预判",
	history: "历史对话联动",
};

const DIMENSION_MAX: Record<DimKey, number> = {
	memory: 25,
	thinking: 25,
	style: 20,
	prediction: 15,
	history: 15,
};

export interface JudgeResult {
	score: number;
	justification: string;
	criteria_met: string[];
	criteria_missed: string[];
}

export interface ScoredDimension {
	key: DimKey;
	label: string;
	score: number;
	maxScore: number;
	judgeResults: JudgeResult[];
	description: string;
}

/**
 * Score a single dimension from its judge results.
 * Normalizes judge scores (0–100 scale) to the dimension's max score.
 */
export function scoreDimension(key: DimKey, results: JudgeResult[]): ScoredDimension {
	const max = DIMENSION_MAX[key];
	if (results.length === 0) {
		return {
			key,
			label: DIMENSION_LABELS[key],
			score: 0,
			maxScore: max,
			judgeResults: [],
			description: "无测试数据",
		};
	}

	// Average raw judge scores (each 0–100 range from the LLM judge), then scale to dimension max
	const avg = results.reduce((sum, r) => sum + r.score, 0) / results.length;
	// Map from 0-100 judge scale to 0-max dimension scale
	const scaled = Math.round((avg / 100) * max);
	const clamped = Math.min(max, Math.max(0, scaled));

	const description = buildDescription(key, clamped, max);

	return {
		key,
		label: DIMENSION_LABELS[key],
		score: clamped,
		maxScore: max,
		judgeResults: results,
		description,
	};
}

/**
 * Compute total score from scored dimensions.
 */
export function computeTotal(dimensions: ScoredDimension[]): number {
	return dimensions.reduce((sum, d) => sum + d.score, 0);
}

/**
 * Determine verdict from score change vs. baseline.
 */
export function determineVerdict(change: number): FitVerdict {
	if (change >= 8) return "明显更懂我";
	if (change >= 3) return "轻微更懂我";
	if (change >= -2) return "持平";
	if (change >= -7) return "变生疏";
	return "明显不懂我";
}

/**
 * Build the full FitReport from scored dimensions and history.
 */
export function buildReport(
	date: string,
	dimensions: ScoredDimension[],
	history: FitScoreRecord[],
	improvements: string[],
): FitReport {
	const total = computeTotal(dimensions);
	const last = history.length > 0 ? history[history.length - 1] : null;
	const change = last != null ? Math.round(total - last.totalScore) : null;
	const verdict = change != null ? determineVerdict(change) : "持平";

	return {
		date,
		totalScore: total,
		maxScore: 100,
		change,
		verdict,
		dimensions: dimensions.map(d => ({
			name: d.label,
			score: d.score,
			maxScore: d.maxScore,
			change: null, // filled in by caller if history available
			description: d.description,
		})),
		history,
		improvements,
	};
}

/**
 * Convert a FitReport to a FitScoreRecord for persistence.
 */
export function reportToRecord(report: FitReport, _detailJson: string): FitScoreRecord {
	const dimMap = new Map(report.dimensions.map(d => [d.name, d]));

	return {
		date: report.date,
		totalScore: report.totalScore,
		memoryScore: dimMap.get(DIMENSION_LABELS.memory)?.score ?? 0,
		thinkingScore: dimMap.get(DIMENSION_LABELS.thinking)?.score ?? 0,
		styleScore: dimMap.get(DIMENSION_LABELS.style)?.score ?? 0,
		predictionScore: dimMap.get(DIMENSION_LABELS.prediction)?.score ?? 0,
		historyScore: dimMap.get(DIMENSION_LABELS.history)?.score ?? 0,
		changeFromLast: report.change,
		verdict: report.verdict,
		detailJson: _detailJson,
		computedAt: Date.now(),
	};
}

function buildDescription(key: DimKey, score: number, max: number): string {
	const ratio = score / max;
	const descriptions: Record<DimKey, [string, string, string, string, string]> = {
		memory: [
			"完全没记忆，每次都要重新自我介绍",
			"只记得零星信息，大部分需要重新说明",
			"只记得基础人设，关键细分关注点模糊",
			"记住大部分核心信息，少量细节遗忘",
			"完整记住职业、技术栈、业务方向，无需重复介绍",
		],
		thinking: [
			"逻辑跑偏，完全不符合做事的思考方式",
			"逻辑散乱，不爱结构化，思维节奏脱节",
			"常规回答，偶尔贴合，多数按通用 AI 思路",
			"大体匹配，需要轻微提醒才按习惯输出",
			"自动匹配思维，主动给架构和落地路径",
		],
		style: [
			"文风杂乱、口语泛滥、重点不明",
			"冗长啰嗦、堆砌文字，不符合阅读习惯",
			"中规中矩，偏通用文风，不贴合也不违和",
			"风格接近，偶尔啰嗦",
			"默认输出极简、结论前置、条理清晰",
		],
		prediction: [
			"完全看不懂言外之意，答非所问",
			"理解片面，经常曲解隐含意图",
			"只能听懂字面需求，不会主动预判",
			"能预判大部分隐含需求，少量需要补充",
			"精准补全真实需求，主动给超出预期的方案",
		],
		history: [
			"完全无连续记忆，每句都像从头开始",
			"经常遗忘当前会话前文，需要反复提醒",
			"只能关联当前会话，跨会话无记忆",
			"能关联近一周对话，更早的记忆弱化",
			"自动关联半个月以上的历史话题，无需重复铺垫",
		],
	};

	const levels = descriptions[key];
	const idx = ratio >= 0.84 ? 4 : ratio >= 0.64 ? 3 : ratio >= 0.44 ? 2 : ratio >= 0.2 ? 1 : 0;
	return levels[idx];
}

/**
 * Generate improvement suggestions based on dimension scores.
 */
export function generateImprovements(dimensions: ScoredDimension[]): string[] {
	const improvements: string[] = [];
	const threshold = 0.64; // Below 64% of max triggers a suggestion

	for (const d of dimensions) {
		const ratio = d.score / d.maxScore;
		if (ratio < threshold) {
			const suggestion = IMPROVEMENT_SUGGESTIONS[d.key];
			if (suggestion) improvements.push(suggestion);
		}
	}

	if (improvements.length === 0) {
		improvements.push("各维度表现良好，继续保持当前适配策略");
	}

	return improvements;
}

const IMPROVEMENT_SUGGESTIONS: Record<DimKey, string> = {
	memory: "增强 persona 文件中的个人信息完整性，确保职业、技术栈、业务方向、做事风格等核心信息持久化",
	thinking: "在系统提示中增加思维模式引导：架构先行、分层拆解、利弊对比、落地路径",
	style: "强化输出风格约束：结论前置、分点短句、禁用废话开头、限制输出长度",
	prediction: "增加隐含需求识别能力训练，对模糊需求主动追问关键上下文",
	history: "增强跨会话记忆注入，增加 persona 文件中的历史话题索引",
};
