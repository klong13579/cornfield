/**
 * The Child Session lifecycle report — the message a delegated child sends its
 * parent over intercom (ticket 07: "Child Session 独立进程通过 intercom 回传
 * started/progress/waiting/completed/failed 状态").
 *
 * Why a dialect at all: the parent has to turn "the child said something" into a
 * `SessionNode.status` transition, and it must never guess. Prose cannot be
 * parsed without heuristics, and a heuristic that silently reads a failure as a
 * success is exactly the plausible lie the parent cannot afford. So the report is
 * one machine-readable envelope line plus an optional human body:
 *
 *   [child-session] {"runId":"…","lifecycle":"completed","result":"/abs/path"}
 *
 *   <prose the parent's model reads>
 *
 * Parsing is strict and total: anything that is not an envelope this module
 * understands parses to `null`, and the caller decides what to do about it. In
 * particular unknown keys are rejected rather than ignored — a future dialect
 * must be read as "I do not understand this report", never as "this report is
 * missing the fields I happen to know about".
 *
 * What this module is NOT: it does not decide anything. It does not know about
 * processes, supervisors, stores, or what the parent does with a report. It is
 * the wire format and the vocabulary, shared by the child that emits and the
 * parent that consumes.
 */

import type { SessionStatus } from "../agent-domain/types";

/** Marker that makes an envelope line recognisable without parsing it. */
export const CHILD_SESSION_REPORT_TAG = "[child-session]";

/**
 * The lifecycle a child reports about the work its parent delegated to it.
 *
 * This is the child's own vocabulary, deliberately smaller than
 * `SessionStatus`: the child never reports `cancelled` (only its parent can
 * cancel it) and never reports a status it cannot observe about itself.
 */
export type ChildSessionLifecycle =
	/** The child is up and registered; it has not started working yet. */
	| "started"
	/** A work round passed without ending the task (still running). */
	| "progress"
	/** The child is blocked on its parent (an ask or a permission decision). */
	| "waiting"
	/** The delegated task is done, and the result it points at exists. */
	| "completed"
	/** The delegated task did not succeed. */
	| "failed";

const LIFECYCLES: readonly ChildSessionLifecycle[] = ["started", "progress", "waiting", "completed", "failed"];

/** What a `waiting` child is blocked on. */
export type ChildSessionBlocking = "ask" | "permission";

const BLOCKINGS: readonly ChildSessionBlocking[] = ["ask", "permission"];

/**
 * The machine-readable half of a report.
 *
 * `runId` is the launch id the parent put in the child's environment
 * (`CHILD_SESSION_ENV.runId`) — it identifies the *delegation*, not the process
 * incarnation, so a relaunched child keeps reporting as the same child and the
 * parent keeps one node for it across a crash restart.
 */
export interface ChildSessionReport {
	runId: string;
	lifecycle: ChildSessionLifecycle;
	/** Only on `waiting`. */
	blocking?: ChildSessionBlocking;
	/**
	 * Only on `completed`: where the result lives. Opaque to this module — the
	 * parent resolves it with whatever resolver it was configured with.
	 */
	result?: string;
}

export interface ChildSessionReportEnvelope {
	report: ChildSessionReport;
	/**
	 * Everything after the envelope line, trimmed; `undefined` when the message
	 * carried no body. Human-facing only — never parsed.
	 */
	body?: string;
}

/** The lifecycle → parent-side session status map. Total over the vocabulary. */
export function childSessionLifecycleToStatus(lifecycle: ChildSessionLifecycle): SessionStatus {
	switch (lifecycle) {
		case "started":
		case "progress":
			return "running";
		case "waiting":
			return "waiting_user";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
	}
}

/** True when the text claims to be a report, whether or not it parses. */
export function hasChildSessionReportTag(text: string): boolean {
	const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
	return firstLine.startsWith(CHILD_SESSION_REPORT_TAG);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REPORT_KEYS = new Set(["runId", "lifecycle", "blocking", "result"]);

/**
 * Parse the strict shape.
 *
 * Rejections (all `null`) are deliberate:
 *   - the first line does not carry the tag,
 *   - the first line carries the tag but nothing that is a JSON object after it,
 *   - a key outside {@link REPORT_KEYS} (a dialect this parser does not know),
 *   - `runId` missing/empty/non-string,
 *   - `lifecycle` outside the vocabulary,
 *   - `blocking` on a lifecycle other than `waiting`, or outside the vocabulary,
 *   - `result` on a lifecycle other than `completed`.
 */
export function parseChildSessionReport(text: string): ChildSessionReportEnvelope | null {
	const newline = text.indexOf("\n");
	const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();
	if (!firstLine.startsWith(CHILD_SESSION_REPORT_TAG)) return null;

	const payloadText = firstLine.slice(CHILD_SESSION_REPORT_TAG.length).trim();
	if (payloadText === "") return null;

	let payload: unknown;
	try {
		payload = JSON.parse(payloadText);
	} catch {
		return null;
	}
	if (!isRecord(payload)) return null;
	for (const key of Object.keys(payload)) {
		if (!REPORT_KEYS.has(key)) return null;
	}

	const runId = payload.runId;
	if (typeof runId !== "string" || runId.trim() === "") return null;

	const lifecycle = payload.lifecycle;
	if (typeof lifecycle !== "string" || !LIFECYCLES.includes(lifecycle as ChildSessionLifecycle)) return null;

	const report: ChildSessionReport = { runId, lifecycle: lifecycle as ChildSessionLifecycle };

	if (payload.blocking !== undefined) {
		if (typeof payload.blocking !== "string" || !BLOCKINGS.includes(payload.blocking as ChildSessionBlocking))
			return null;
		if (report.lifecycle !== "waiting") return null;
		report.blocking = payload.blocking as ChildSessionBlocking;
	}
	if (payload.result !== undefined) {
		if (typeof payload.result !== "string" || payload.result.trim() === "") return null;
		if (report.lifecycle !== "completed") return null;
		report.result = payload.result;
	}

	const body = newline === -1 ? "" : text.slice(newline + 1).trim();
	return body === "" ? { report } : { report, body };
}

/**
 * Render a report as the message text a child sends.
 *
 * `body` is passed through untouched: it is what the parent's model reads, and
 * the envelope is what the parent's code reads. Keeping them in one message is
 * the point — two messages for one fact would be two things to keep in sync.
 */
export function formatChildSessionReport(report: ChildSessionReport, body?: string): string {
	const payload: Record<string, string> = { runId: report.runId, lifecycle: report.lifecycle };
	if (report.blocking) payload.blocking = report.blocking;
	if (report.result) payload.result = report.result;
	const envelope = `${CHILD_SESSION_REPORT_TAG} ${JSON.stringify(payload)}`;
	const trimmedBody = body?.trim();
	return trimmedBody ? `${envelope}\n\n${trimmedBody}` : envelope;
}
