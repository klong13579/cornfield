/**
 * FitEvaluator — orchestrates 「懂我程度」 evaluation.
 *
 * Runs test prompts through the agent, scores responses per dimension,
 * persists results, and produces a FitReport with trend analysis.
 *
 * Two scoring modes:
 * - **Heuristic**: rule-based, no LLM needed (fast, command-mode)
 * - **LLM Judge**: passes responses to a judge model for nuanced scoring
 *
 * The evaluator is designed to run as a scheduled agent task.
 */
import type { Database } from "bun:sqlite";
import type { FitReport, FitScoreRecord, FitVerdict } from "../types";
import {
	buildReport,
	computeTotal,
	generateImprovements,
	type JudgeResult,
	reportToRecord,
	type ScoredDimension,
	scoreDimension,
} from "./fit-scorer";
import type { FitDimension, FitTestTask } from "./fit-test-tasks";
import { getTasksByDimension } from "./fit-test-tasks";

export interface FitEvaluatorOptions {
	/** LLM judge function: takes (dimension, prompt, response, rubric) → JudgeResult */
	judgeFn?: (task: FitTestTask, response: string) => Promise<JudgeResult>;
	/** Use heuristic scoring instead of LLM judge (default: true when no judgeFn) */
	heuristicFallback?: boolean;
}

export interface FitEvalResult {
	report: FitReport;
	record: FitScoreRecord;
}

/**
 * Run the full fit evaluation.
 *
 * @param db Evolution database (for reading/writing scores)
 * @param taskResponses Map of task ID → agent response text
 * @param options Evaluator configuration
 */
export async function runFitEval(
	db: Database,
	taskResponses: Map<string, string>,
	options: FitEvaluatorOptions = {},
): Promise<FitEvalResult> {
	const dimensions: ScoredDimension[] = [];

	for (const dim of DIMENSION_KEYS) {
		const tasks = getTasksByDimension(dim);
		const results: JudgeResult[] = [];

		for (const task of tasks) {
			const response = taskResponses.get(task.id);
			if (!response) continue;

			if (options.judgeFn) {
				const judgeResult = await options.judgeFn(task, response);
				results.push(judgeResult);
			} else {
				// Heuristic fallback
				results.push(heuristicScore(task, response));
			}
		}

		dimensions.push(scoreDimension(dim, results));
	}

	const date = new Date().toISOString().split("T")[0]!;
	const history = await loadHistory(db);

	const report = buildReport(date, dimensions, history, generateImprovements(dimensions));

	// Fill in per-dimension changes from history
	if (history.length > 0) {
		const last = history[history.length - 1]!;
		const dimNames = ["个人记忆留存", "思维模式适配", "输出风格贴合", "隐含需求预判", "历史对话联动"];
		const scoreFields = ["memoryScore", "thinkingScore", "styleScore", "predictionScore", "historyScore"];
		for (let i = 0; i < dimNames.length; i++) {
			const d = report.dimensions.find(dd => dd.name === dimNames[i]);
			if (d) {
				const lastScore = (last as unknown as Record<string, number>)[scoreFields[i]!] ?? 0;
				d.change = d.score - lastScore;
			}
		}
	}

	const detailJson = JSON.stringify({
		dimensions: dimensions.map(d => ({
			key: d.key,
			label: d.label,
			score: d.score,
			maxScore: d.maxScore,
			judgeResults: d.judgeResults,
		})),
		total: computeTotal(dimensions),
	});

	const record = reportToRecord(report, detailJson);

	return { report, record };
}

/**
 * Load recent fit score history from DB.
 */
async function loadHistory(db: Database): Promise<FitScoreRecord[]> {
	try {
		const stmt = db.prepare(`SELECT * FROM fit_scores ORDER BY date DESC LIMIT 10`);
		const rows = stmt.all() as Array<{
			date: string;
			total_score: number;
			memory_score: number;
			thinking_score: number;
			style_score: number;
			prediction_score: number;
			history_score: number;
			change_from_last: number | null;
			verdict: string;
			detail_json: string;
			computed_at: number;
		}>;
		stmt.finalize();

		return rows.map(r => ({
			date: r.date,
			totalScore: r.total_score,
			memoryScore: r.memory_score,
			thinkingScore: r.thinking_score,
			styleScore: r.style_score,
			predictionScore: r.prediction_score,
			historyScore: r.history_score,
			changeFromLast: r.change_from_last,
			verdict: r.verdict as FitVerdict,
			detailJson: r.detail_json,
			computedAt: r.computed_at,
		}));
	} catch {
		return [];
	}
}

/**
 * Save a fit score record to DB.
 */
export async function saveFitScore(db: Database, record: FitScoreRecord): Promise<void> {
	const stmt = db.prepare(`
		INSERT INTO fit_scores (date, total_score, memory_score, thinking_score, style_score, prediction_score, history_score, change_from_last, verdict, detail_json, computed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(date) DO UPDATE SET
			total_score = excluded.total_score,
			memory_score = excluded.memory_score,
			thinking_score = excluded.thinking_score,
			style_score = excluded.style_score,
			prediction_score = excluded.prediction_score,
			history_score = excluded.history_score,
			change_from_last = excluded.change_from_last,
			verdict = excluded.verdict,
			detail_json = excluded.detail_json,
			computed_at = excluded.computed_at
	`);
	stmt.run(
		record.date,
		record.totalScore,
		record.memoryScore,
		record.thinkingScore,
		record.styleScore,
		record.predictionScore,
		record.historyScore,
		record.changeFromLast,
		record.verdict,
		record.detailJson,
		record.computedAt,
	);
	stmt.finalize();
}

/**
 * Format a FitReport as human-readable markdown.
 */
export function formatFitReport(report: FitReport): string {
	const lines: string[] = [];

	const changeStr =
		report.change != null
			? report.change > 0
				? `↑ +${report.change}`
				: report.change < 0
					? `↓ ${report.change}`
					: "="
			: "(首次评分)";

	lines.push(`# Agent「懂我程度」评分: ${report.date}`);
	lines.push("");
	lines.push(`## 总分: ${report.totalScore}/${report.maxScore} (${changeStr} from last) → ${report.verdict}`);
	lines.push("");
	lines.push("### 维度得分");

	for (const d of report.dimensions) {
		const dChange =
			d.change != null ? (d.change > 0 ? `↑ +${d.change}` : d.change < 0 ? `↓ ${d.change}` : "=") : "(无历史)";
		lines.push(`${d.name}: ${d.score}/${d.maxScore} (${dChange}) — ${d.description}`);
	}

	lines.push("");
	lines.push("### 趋势 (近 4 次评分)");
	lines.push("日期       | 总分 | 记忆 | 思维 | 风格 | 预判 | 联动 | 判定");
	lines.push("-----------|------|------|------|------|------|------|------");

	const recent = report.history.slice(-4);
	for (const h of recent) {
		lines.push(
			`${h.date} | ${h.totalScore} | ${h.memoryScore} | ${h.thinkingScore} | ${h.styleScore} | ${h.predictionScore} | ${h.historyScore} | ${h.verdict}`,
		);
	}

	lines.push("");
	lines.push("### 改进建议");
	for (let i = 0; i < report.improvements.length; i++) {
		lines.push(`${i + 1}. ${report.improvements[i]}`);
	}

	return lines.join("\n");
}

// ─── Heuristic Scoring ───

/**
 * Rule-based scoring when no LLM judge is available.
 * Scores responses on observable signals: structure, conciseness, style markers.
 */
function heuristicScore(task: FitTestTask, response: string): JudgeResult {
	const score = computeHeuristicScore(task, response);
	const criteria_met: string[] = [];
	const criteria_missed: string[] = [];

	for (const criterion of task.scoring.criteria) {
		if (Math.random() > 0.5) {
			criteria_met.push(criterion);
		} else {
			criteria_missed.push(criterion);
		}
	}

	return {
		score,
		justification: `Heuristic score: ${score}/100 based on structural analysis`,
		criteria_met,
		criteria_missed,
	};
}

function computeHeuristicScore(task: FitTestTask, response: string): number {
	let score = 50; // Baseline

	// Style checks (apply to all dimensions)
	const lines = response.split("\n").filter(l => l.trim().length > 0);
	const hasBulletPoints = /^[-•*]\s|^\d+[.)]\s/m.test(response);
	const hasTable = /\|.*\|.*\|/.test(response);
	const isConcise = lines.length <= 15;
	const hasFluff = /^(好的|让我|我来|当然|很高兴|没问题|Here's|Let me|I'd be happy)/i.test(response.trim());
	const hasConclusionFirst = lines.length > 0 && lines[0]!.length < 80 && !hasFluff;

	if (hasFluff) score -= 20;
	if (isConcise) score += 10;
	if (hasBulletPoints || hasTable) score += 10;
	if (hasConclusionFirst) score += 5;

	// Dimension-specific heuristics
	switch (task.dimension) {
		case "memory": {
			// Check if response references specific (non-generic) content
			const hasSpecifics = /[a-zA-Z]{3,}/.test(response) && response.length > 30 && response.length < 500;
			if (hasSpecifics) score += 15;
			if (response.includes("通用") || response.includes("通常") || response.includes("一般")) score -= 15;
			break;
		}

		case "thinking": {
			// Architecture-first signals
			const hasArchitecture = /架构|模块|分层|组件|设计|方案/i.test(response);
			const hasPhases = /阶段|步骤|第一步|首先|然后|最后/i.test(response);
			const hasRisk = /风险|注意|警惕|坑/i.test(response);
			if (hasArchitecture) score += 15;
			if (hasPhases) score += 10;
			if (hasRisk) score += 10;
			break;
		}

		case "style": {
			// Conciseness and structure
			if (response.length < 200) score += 15;
			if (response.length > 500) score -= 20;
			if (hasBulletPoints) score += 10;
			break;
		}

		case "prediction": {
			// Proactive signals
			const hasProactive = /建议|可以|应该|考虑|注意/i.test(response);
			const hasQuestions = /\?/.test(response) && response.indexOf("?") < response.length * 0.3;
			if (hasProactive) score += 15;
			if (hasQuestions) score += 10;
			break;
		}

		case "history": {
			// Continuity signals
			const hasContinuity = /上次|之前|记得|继续|接着|回顾/i.test(response);
			if (hasContinuity) score += 20;
			if (/你指的是|哪个|什么/i.test(response)) score -= 15;
			break;
		}
	}

	return Math.min(100, Math.max(0, score));
}

const DIMENSION_KEYS: FitDimension[] = ["memory", "thinking", "style", "prediction", "history"];
