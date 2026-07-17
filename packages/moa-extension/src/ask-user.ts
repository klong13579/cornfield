/**
 * Ask user for missing TCO inputs.
 *
 * Two paths:
 *   1. TUI mode (hasUI): use `ctx.ui.input()` / `ctx.ui.select()` to ask
 *      one focused question per missing input, sequentially. Each ask has
 *      a per-input timeout (default 30s). On timeout or empty answer, the
 *      input is recorded as an `assumptions` entry with `reason` =
 *      `user_skipped` (or `user_skipped_required` if `required=true`).
 *   2. Non-TUI mode (gateway / cron / batch): skip the ask entirely,
 *      record every missing input as an `assumptions` entry with
 *      `reason` = `non_interactive_fallback`.
 *
 * The function mutates the TCO in place: it appends to `assumptions` and
 * (for answered questions) to `known_inputs` with `source = "user"`. The
 * caller passes the same TCO object downstream to the worker / synthesis
 * stage.
 */

import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { TaskContextObject, TcoAssumption, TcoMissingInput } from "./tco";

export interface AskUserContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
}

export interface AskUserOptions {
	timeoutMs?: number;
	/** When false, skip the TUI ask entirely and assume everything. */
	enabled?: boolean;
	/** Called before each question so the orchestrator can update the status bar. */
	onProgress?: (info: { index: number; total: number }) => void;
}

export interface AskUserResult {
	tco: TaskContextObject;
	asked: number;
	answered: number;
	assumed: number;
	timedOut: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function askMissingInputs(
	tco: TaskContextObject,
	ctx: AskUserContext,
	options: AskUserOptions = {},
): Promise<AskUserResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const enabled = options.enabled ?? true;
	const missing = tco.missing_inputs;

	if (!enabled || !ctx.hasUI || missing.length === 0) {
		// Non-interactive fallback: assume everything.
		// Reason is always `non_interactive_fallback` — the system deliberately
		// did not ask (no UI in cron/gateway, or askEnabled=false). The
		// `required` flag only matters when a TUI ask was attempted.
		for (const m of missing) {
			tco.assumptions.push(buildAssumption(m, "non_interactive_fallback"));
		}
		return { tco, asked: 0, answered: 0, assumed: missing.length, timedOut: 0 };
	}

	let asked = 0;
	let answered = 0;
	let assumed = 0;
	let timedOut = 0;
	const total = missing.length;

	for (let i = 0; i < missing.length; i++) {
		const m = missing[i]!;
		options.onProgress?.({ index: i + 1, total });
		asked += 1;
		const result = await withTimeout(askOne(m, ctx), timeoutMs, m);
		if (result.kind === "answered") {
			answered += 1;
			tco.known_inputs.push({ key: m.key, value: result.value, source: "user" });
		} else if (result.kind === "timeout") {
			timedOut += 1;
			assumed += 1;
			tco.assumptions.push(buildAssumption(m, m.required ? "user_skipped_required" : "user_skipped", "timed out"));
		} else {
			assumed += 1;
			tco.assumptions.push(buildAssumption(m, m.required ? "user_skipped_required" : "user_skipped"));
		}
	}
	return { tco, asked, answered, assumed, timedOut };
}

interface Answered {
	kind: "answered";
	value: string | number | boolean | string[];
}
interface Skipped {
	kind: "skipped";
}
interface TimedOut {
	kind: "timeout";
}
type AskOneResult = Answered | Skipped | TimedOut;

async function askOne(m: TcoMissingInput, ctx: AskUserContext): Promise<AskOneResult> {
	// Brief preamble: question + why it matters (capped to fit terminal).
	const header = m.why_critical ? `${m.question}\n(${m.why_critical})` : m.question;
	if (m.type === "confirm") {
		const ans = await ctx.ui.input(`${header}\n[y/n]`, "y/n");
		if (ans === undefined) return { kind: "skipped" };
		const lower = ans.trim().toLowerCase();
		if (lower === "y" || lower === "yes") return { kind: "answered", value: true };
		if (lower === "n" || lower === "no") return { kind: "answered", value: false };
		return { kind: "skipped" };
	}
	if (m.type === "select") {
		const options = m.options ?? [];
		if (options.length === 0) return { kind: "skipped" };
		const ans = await ctx.ui.select(header, options);
		if (ans === undefined) return { kind: "skipped" };
		return { kind: "answered", value: ans };
	}
	if (m.type === "number") {
		const ans = await ctx.ui.input(header, "number");
		if (ans === undefined || ans.trim() === "") return { kind: "skipped" };
		const num = Number(ans);
		if (!Number.isFinite(num)) return { kind: "skipped" };
		return { kind: "answered", value: num };
	}
	if (m.type === "list") {
		const ans = await ctx.ui.input(`${header}\n(comma-separated)`, "item1, item2");
		if (ans === undefined || ans.trim() === "") return { kind: "skipped" };
		const items = ans
			.split(",")
			.map(s => s.trim())
			.filter(Boolean);
		return { kind: "answered", value: items };
	}
	// text
	const ans = await ctx.ui.input(header, "your answer");
	if (ans === undefined || ans.trim() === "") return { kind: "skipped" };
	return { kind: "answered", value: ans.trim() };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, _m: unknown): Promise<T | TimedOut> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<TimedOut>(resolve => {
		handle = setTimeout(() => resolve({ kind: "timeout" }), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (handle) clearTimeout(handle);
	}
}

function buildAssumption(m: TcoMissingInput, reason: TcoAssumption["reason"], note?: string): TcoAssumption {
	// If the Discovery LLM suggested a defaultValue, use it. Otherwise fall
	// back to a type-appropriate empty value so downstream workers see
	// something rather than undefined.
	let value: unknown;
	if (m.defaultValue !== undefined) {
		value = m.defaultValue;
	} else {
		switch (m.type) {
			case "number":
				value = undefined;
				break;
			case "list":
				value = [];
				break;
			case "confirm":
				value = false;
				break;
			default:
				value = undefined;
		}
	}
	return { key: m.key, value, reason, note: note ?? `auto-assumed: ${m.question}` };
}

// ----------------------------------------------------------------------------
// askQuestionsList — per-round ask (PR2 multi-round)
//
// Distinct from `askMissingInputs` (pre-ask, bounded TCO.missing_inputs):
//   - Items come from worker output's open_questions, not from the TCO.
//   - Per design §7.3, each question starts with a three-way select:
//     `answer` / `skip` / `stop all`. Typing STOP in a freeform input is
//     still accepted as a fallback.
//   - Caller passes a stable `key` (typically `<round>.<worker>.<idx>`) so
//     answered / skipped results are traceable back to the source.
//   - Non-TUI mode short-circuits to "all skipped, non_interactive_fallback".
// ----------------------------------------------------------------------------

export const ASK_ACTION_ANSWER = "answer";
export const ASK_ACTION_SKIP = "skip";
export const ASK_ACTION_STOP = "stop all";

export const ASK_ACTION_OPTIONS = [ASK_ACTION_ANSWER, ASK_ACTION_SKIP, ASK_ACTION_STOP] as const;

export interface AskQuestionsListItem {
	/** Stable id used to track answer / skip back to the source. */
	key: string;
	question: string;
	type: "freeform" | "choice";
	/** Optional preamble (why this question matters) shown under the prompt. */
	context?: string;
	/** Pre-filled placeholder / suggested default. */
	suggested_default?: string;
	/** For type=choice: the options to present. */
	options?: string[];
	/** Worker names that surfaced this question. Used to attribute
	 *  convergence: "divergent + critical both asked" → high signal. */
	sourceWorkers: string[];
}

export interface AskQuestionsListAnswered {
	key: string;
	question: string;
	answer: string;
	sourceWorkers: string[];
}

export interface AskQuestionsListSkipped {
	key: string;
	question: string;
	reason: string;
	sourceWorkers: string[];
}

export interface AskQuestionsListResult {
	answered: AskQuestionsListAnswered[];
	skipped: AskQuestionsListSkipped[];
	stopped: boolean;
	timedOut: number;
}

export type AskQuestionsListOptions = AskUserOptions;

const STOP_SENTINEL = "STOP";

function isStopAction(value: string | undefined): boolean {
	if (!value) return false;
	const trimmed = value.trim().toLowerCase();
	return trimmed === ASK_ACTION_STOP || trimmed.toUpperCase() === STOP_SENTINEL;
}

function isSkipAction(value: string | undefined): boolean {
	if (value === undefined) return true;
	return value.trim().toLowerCase() === ASK_ACTION_SKIP;
}

function isAnswerAction(value: string | undefined): boolean {
	if (!value) return false;
	return value.trim().toLowerCase() === ASK_ACTION_ANSWER;
}

export async function askQuestionsList(
	items: AskQuestionsListItem[],
	ctx: AskUserContext,
	options: AskQuestionsListOptions = {},
): Promise<AskQuestionsListResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const enabled = options.enabled ?? true;

	if (!enabled || !ctx.hasUI || items.length === 0) {
		return {
			answered: [],
			skipped: items.map(m => ({
				key: m.key,
				question: m.question,
				reason: "non_interactive_fallback",
				sourceWorkers: m.sourceWorkers,
			})),
			stopped: false,
			timedOut: 0,
		};
	}

	const answered: AskQuestionsListAnswered[] = [];
	const skipped: AskQuestionsListSkipped[] = [];
	let stopped = false;
	let timedOut = 0;
	const total = items.length;

	for (let i = 0; i < items.length; i++) {
		const m = items[i]!;
		options.onProgress?.({ index: i + 1, total });

		const header = m.context ? `${m.question}\n(${m.context})` : m.question;
		const result = await withTimeout(askQuestionsListOne(m, header, ctx), timeoutMs, m);
		if (result.kind === "stopped") {
			stopped = true;
			skipped.push({
				key: m.key,
				question: m.question,
				reason: "user_stopped",
				sourceWorkers: m.sourceWorkers,
			});
			break;
		}
		if (result.kind === "answered") {
			answered.push({
				key: m.key,
				question: m.question,
				answer: result.value,
				sourceWorkers: m.sourceWorkers,
			});
		} else if (result.kind === "timeout") {
			timedOut += 1;
			skipped.push({
				key: m.key,
				question: m.question,
				reason: "timed_out",
				sourceWorkers: m.sourceWorkers,
			});
		} else {
			skipped.push({
				key: m.key,
				question: m.question,
				reason: "user_skipped",
				sourceWorkers: m.sourceWorkers,
			});
		}
	}

	return { answered, skipped, stopped, timedOut };
}

type AskQuestionsListOneResult =
	| { kind: "answered"; value: string }
	| { kind: "skipped" }
	| { kind: "stopped" }
	| { kind: "timeout" };

async function askQuestionsListOne(
	m: AskQuestionsListItem,
	header: string,
	ctx: AskUserContext,
): Promise<AskQuestionsListOneResult> {
	// Step 1: three-way action select (design §7.3 answer / skip / stop all).
	const action = await ctx.ui.select(header, [...ASK_ACTION_OPTIONS]);
	if (isStopAction(action)) return { kind: "stopped" };
	if (isSkipAction(action)) return { kind: "skipped" };
	if (!isAnswerAction(action)) return { kind: "skipped" };

	// Step 2: collect the actual answer.
	if (m.type === "choice") {
		const options = m.options ?? [];
		if (options.length === 0) return { kind: "skipped" };
		const ans = await ctx.ui.select(`${header}\n(pick one)`, options);
		if (ans === undefined) return { kind: "skipped" };
		if (isStopAction(ans)) return { kind: "stopped" };
		return { kind: "answered", value: ans };
	}

	const placeholder = m.suggested_default ?? "your answer";
	const ans = await ctx.ui.input(`${header}\n(type answer; empty = skip; ${STOP_SENTINEL} = stop all)`, placeholder);
	if (ans === undefined) return { kind: "skipped" };
	const trimmed = ans.trim();
	if (trimmed === "") return { kind: "skipped" };
	if (isStopAction(trimmed)) return { kind: "stopped" };
	return { kind: "answered", value: trimmed };
}
