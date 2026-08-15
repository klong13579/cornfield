/**
 * Cron task result delivery via DingTalk AI Card.
 *
 * Replaces the legacy plain-text path (`buildDeliverySummary` +
 * `DingTalkChannel.sendMessage` sampleText) with a structured card that
 * carries:
 *   - status badge + task name + duration in the card header,
 *   - the agent's full final reply as the markdown body (no 2000-char
 *     truncation — the card renderer scrolls),
 *   - a "查看执行日志" action button linking to today's execution log,
 *   - the output text in `copyContent` so the schema's built-in copy
 *     button copies the actual result, not the card chrome.
 *
 * Lifecycle: the cron hot path delivers a *finished* result. Unlike the
 * IM chat path (which streams text deltas into a card created at prompt
 * start), cron doesn't have an inbound message to anchor a "running"
 * card. The card is therefore created and finished in one shot at the
 * end of the run — the user sees a single card with the terminal state.
 * A future iteration can add a "派发中" skeleton at run start if
 * long-running tasks need live progress.
 *
 * Failure semantics: every public function returns `{ ok, error? }` and
 * never throws. The caller (`CronLifecycle.#deliverCronResult`) falls
 * back to the plain-text path on `{ ok: false }` — the user always
 * gets a result, just in a coarser format if the card API is down.
 */

import { logger } from "@oh-my-pi/pi-utils";
import * as os from "node:os";
import * as path from "node:path";
import { type AICardInstance, type AICardTarget, BlockType, buildAnswerBlock, createAICardForTarget, finishAICard, type CardBlock } from "../channels/dingtalk-card";
import type { DingTalkConfig } from "../types";

// ═══════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════

export type CronCardStatus = "success" | "failure" | "timed_out";

export interface CronCardPayload {
	taskName: string;
	taskId: string;
	/** Human-readable slug for log file lookup. Today this is the task name. */
	slug: string;
	status: CronCardStatus;
	exitCode: number | undefined;
	durationMs: number;
	/** Full agent output (no truncation). Card renderer scrolls. */
	output: string;
	/** Optional failure reason for the footer when status !== "success". */
	error?: string;
}

export interface DeliverCronCardParams {
	dingtalkConfig: DingTalkConfig;
	target: AICardTarget;
	card: CronCardPayload;
}

export interface DeliverCronCardResult {
	ok: boolean;
	error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Card body builders
// ═══════════════════════════════════════════════════════════════════════

const STATUS_EMOJI: Record<CronCardStatus, string> = {
	success: "✅",
	failure: "❌",
	timed_out: "⏰",
};

/**
 * Build the markdown body. Mirrors the legacy `buildDeliverySummary`
 * shape (`<status> <task> (exit N, T s)\n\n<output>`) so the card's
 * visual identity matches what the IM chat path renders. The output
 * is included verbatim (no 2000-char cap) because the card renderer
 * handles long content gracefully.
 */
function buildBodyText(payload: CronCardPayload): string {
	const prefix = STATUS_EMOJI[payload.status];
	const dur = `${(payload.durationMs / 1000).toFixed(1)}s`;
	const code = payload.exitCode === undefined ? "?" : String(payload.exitCode);
	const header = `${prefix} ${payload.taskName} (exit ${code}, ${dur})`;
	const outputSection = payload.output.trim() || "_(无输出)_";
	return `${header}\n\n${outputSection}`;
}

/**
 * Build the footer status line shown at the bottom of the card. Kept
 * short — the card body already carries the full status block, so the
 * footer just anchors the timing for scanning.
 */
function buildStatusLine(payload: CronCardPayload): string {
	const dur = `${(payload.durationMs / 1000).toFixed(1)}s`;
	const errorSuffix =
		payload.status === "success" || !payload.error ? "" : ` · ${payload.error.slice(0, 80)}`;
	return `exit ${payload.exitCode ?? "?"} · ${dur}${errorSuffix}`;
}

/**
 * Build the action button block. The OpenClaw 675cde2f schema renders
 * `blockList[N].type === 4 && blockList[N].btns` as a ButtonGroup; we
 * reuse the STOP block type (4) for action buttons since the schema
 * doesn't have a distinct "actions" block type.
 *
 * Buttons:
 *   - 查看执行日志 — opens today's JSONL log via `file://` URL. Works
 *     in the desktop DingTalk client; the link is dead on mobile, but
 *     the rest of the card still renders. A proper HTTP log endpoint
 *     is a follow-up.
 */
function buildActionBlock(payload: CronCardPayload, bodyText: string): CardBlock {
	const logUrl = buildLogFileUrl(payload.slug);
	return {
		type: BlockType.STOP,
		text: "",
		markdown: "",
		btns: [
			{ text: "查看执行日志", actionType: "url", url: logUrl },
			// The schema's built-in copy button uses `copyContent`; we
			// also surface a copy action here for clients that only
			// render the ButtonGroup. The text is the agent's output
			// (not the prefixed status line) so what users get matches
			// what they see.
			{ text: "复制输出", actionType: "call_back", params: { copyText: bodyText } },
		],
	};
}

function buildLogFileUrl(slug: string): string {
	const date = new Date();
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	const logPath = path.join(
		os.homedir(),
		".omp",
		"gateway-data",
		"scheduler",
		"logs",
		"by-task",
		slug,
		`${yyyy}-${mm}-${dd}.jsonl`,
	);
	return `file://${logPath}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Public entry point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Deliver a cron result as a DingTalk AI Card.
 *
 * Steps:
 *   1. `createAICardForTarget` — create the card instance and deliver
 *      to the target user/group. Returns `null` on any failure; we
 *      propagate as `{ ok: false }` so the caller falls back to text.
 *   2. Build the answer block (body markdown) and action block
 *      (ButtonGroup) from the payload.
 *   3. `finishAICard` — flush the final content + chrome + buttons to
 *      the card. Throws on permanent failure (network error, 4xx
 *      business error, retries exhausted). We catch and return as
 *      `{ ok: false }`.
 *
 * The function is intentionally never-throws. Every failure path
 * returns `{ ok: false, error }` so the gateway can decide whether to
 * retry, fall back, or surface to the user.
 */
export async function deliverCronResultAsCard(params: DeliverCronCardParams): Promise<DeliverCronCardResult> {
	const { dingtalkConfig, target, card: payload } = params;
	const bodyText = buildBodyText(payload);
	const statusLine = buildStatusLine(payload);

	// The card SDK's documented contract is "return null on failure, do
	// not throw". We still wrap in try/catch as a defensive net: a
	// future change (e.g. an auth library that throws on missing
	// credentials) must not cascade into the cron run.
	let card: AICardInstance | null = null;
	try {
		card = await createAICardForTarget(dingtalkConfig, target, { statusLine });
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.error("[CronCard] createAICardForTarget threw; caller should fall back to text", {
			taskId: payload.taskId,
			taskName: payload.taskName,
			error,
		});
		return { ok: false, error };
	}
	if (!card) {
		const err = "createAICardForTarget returned null (network, auth, or rate limit)";
		logger.warn("[CronCard] card creation failed; caller should fall back to text", {
			taskId: payload.taskId,
			taskName: payload.taskName,
		});
		return { ok: false, error: err };
	}

	const blockList: CardBlock[] = [buildAnswerBlock(bodyText), buildActionBlock(payload, bodyText)];

	try {
		await finishAICard(
			card,
			{
				content: bodyText,
				blockList,
				quoteContent: "",
				statusLine,
				copyContent: bodyText,
				hasAction: true,
				version: 1,
			},
			dingtalkConfig,
		);
		logger.info("[CronCard] card delivered", {
			taskId: payload.taskId,
			taskName: payload.taskName,
			cardInstanceId: card.cardInstanceId,
			status: payload.status,
		});
		return { ok: true };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.error("[CronCard] finishAICard threw; caller should fall back to text", {
			taskId: payload.taskId,
			taskName: payload.taskName,
			error,
		});
		return { ok: false, error };
	}
}
