/**
 * Grill-me Ask: one question at a time with recommended answers.
 * Stops when the question generator says done, maxQuestions hit, or user skips.
 */

import type { AskUserContext } from "./ask-user";
import { filterDecisionMissing } from "./decision-missing";
import type { TaskContextObject, TcoKnownInput, TcoMissingInput } from "./tco";

export interface GrillQuestion {
	done: boolean;
	key?: string;
	question?: string;
	options?: string[];
	recommended?: string[];
	rationale?: string;
}

export interface GrillTurn {
	key: string;
	question: string;
	answer: string;
	recommended: string[];
}

export interface GrillAskOptions {
	enabled?: boolean;
	maxQuestions?: number;
	/** Original user task text (for LLM prompt). */
	task?: string;
	/** Optional research digest so grill never asks definitions. */
	researchDigest?: string;
	/** Injected for tests / stages — calls LLM or returns fixture. */
	nextQuestion: (ctx: GrillQuestionContext) => Promise<GrillQuestion>;
	/** Optional: react to each completed turn (trace). */
	onTurn?: (turn: GrillTurn | { kind: "done" | "skipped"; questionIndex: number }) => void;
}

export interface GrillQuestionContext {
	task: string;
	tco: TaskContextObject;
	turns: GrillTurn[];
	seedMissing: TcoMissingInput[];
	researchDigest?: string;
	questionIndex: number;
}

export interface GrillAskResult {
	asked: number;
	answered: number;
	assumed: number;
	turns: GrillTurn[];
}

const DEFAULT_MAX = 5;

/**
 * Run grill-me Ask against TCO. Mutates tco (known_inputs / assumptions).
 * Falls back to assumptions when !hasUI or disabled.
 */
export async function runGrillAsk(
	tco: TaskContextObject,
	askCtx: AskUserContext,
	options: GrillAskOptions,
): Promise<GrillAskResult> {
	const enabled = options.enabled !== false;
	const maxQuestions = Math.max(1, options.maxQuestions ?? DEFAULT_MAX);
	const seedMissing = filterDecisionMissing(tco.missing_inputs);
	const turns: GrillTurn[] = [];
	let asked = 0;
	let answered = 0;
	let assumed = 0;

	if (!enabled || !askCtx.hasUI) {
		for (const item of seedMissing) {
			tco.assumptions.push({
				key: item.key,
				value: item.defaultValue ?? null,
				reason: "non_interactive_fallback",
			});
			assumed += 1;
		}
		return { asked: 0, answered: 0, assumed, turns };
	}

	for (let i = 0; i < maxQuestions; i++) {
		const next = await options.nextQuestion({
			task: options.task || tco.task_understanding || "",
			tco,
			turns,
			seedMissing,
			researchDigest: options.researchDigest,
			questionIndex: i,
		});

		if (next.done || !next.question?.trim()) {
			options.onTurn?.({ kind: "done", questionIndex: i });
			break;
		}

		const key = (next.key?.trim() || `grill_${i + 1}`).slice(0, 64);
		const question = next.question.trim();
		const optionsList = (next.options ?? []).map(o => o.trim()).filter(Boolean);
		const recommended = (next.recommended ?? []).map(r => r.trim()).filter(Boolean);

		asked += 1;
		const label =
			recommended.length > 0
				? `${question}\n推荐：${recommended.join(" / ")}${optionsList.length ? `\n可选：${optionsList.join(" | ")}` : ""}`
				: optionsList.length > 0
					? `${question}\n可选：${optionsList.join(" | ")}`
					: question;

		let raw: string | undefined;
		if (optionsList.length > 0 && typeof askCtx.ui.select === "function") {
			const choices = [...optionsList];
			if (!choices.includes("其他 / 自己输入")) choices.push("其他 / 自己输入");
			const picked = await askCtx.ui.select(label, choices);
			if (picked === "其他 / 自己输入") {
				raw = await askCtx.ui.input(`${question}（请输入）`);
			} else {
				raw = picked;
			}
		} else {
			raw = await askCtx.ui.input(label);
		}

		const answer = typeof raw === "string" ? raw.trim() : "";
		if (!answer) {
			tco.assumptions.push({
				key,
				value: recommended[0] ?? null,
				reason: "user_skipped",
			});
			assumed += 1;
			options.onTurn?.({ kind: "skipped", questionIndex: i });
			break;
		}

		const known: TcoKnownInput = {
			key,
			value: answer.includes(",") ? answer.split(",").map(s => s.trim()).filter(Boolean) : answer,
			source: "user",
			confidence: 1,
		};
		tco.known_inputs.push(known);
		const turn: GrillTurn = { key, question, answer, recommended };
		turns.push(turn);
		answered += 1;
		options.onTurn?.(turn);
	}

	// Keep missing_inputs (same as form Ask) for audit / merge introspection;
	// answers live in known_inputs / assumptions.
	return { asked, answered, assumed, turns };
}

/** Parse model JSON for the next grill question. */
export function parseGrillQuestion(raw: string): GrillQuestion {
	const trimmed = raw.trim();
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fence?.[1]?.trim() ?? trimmed;
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		if (parsed.done === true) {
			return { done: true, rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined };
		}
		return {
			done: false,
			key: typeof parsed.key === "string" ? parsed.key : undefined,
			question: typeof parsed.question === "string" ? parsed.question : undefined,
			options: Array.isArray(parsed.options) ? parsed.options.map(String) : undefined,
			recommended: Array.isArray(parsed.recommended) ? parsed.recommended.map(String) : undefined,
			rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
		};
	} catch {
		return { done: true, rationale: "parse_failed" };
	}
}
