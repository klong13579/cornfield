/**
 * The Session Tree ledger: what a parent session knows about the children it
 * delegated, and the pure rules that move a child from one status to the next.
 *
 * The node shape is `SessionNode` from the WP1 domain contract (`../agent-domain`)
 * — this module does not define a second session tree. What it adds is the
 * parent-owned part of the projection:
 *
 *   - `runId` — which delegation this is (the value in the child's environment),
 *   - `lastPid` — the OS process last seen serving it, which is the only handle
 *     that survives a parent restart and still proves the child is alive,
 *   - `escalation` — what the child is blocked on, so the parent can surface it,
 *   - `statusDetail` — why the node is in its current status when that is not
 *     obvious from the status alone.
 *
 * Two rules this module exists to enforce, because both are ways a parent ends up
 * reporting something untrue:
 *
 *   1. **Terminal is terminal.** `completed` / `failed` / `cancelled` are never
 *      reopened (WP1 §6: "Terminal states are never reopened — a follow-up is a
 *      new node"). A late report from a stopped child, or a `progress` that
 *      crosses a `cancelled` already written by the parent, is refused rather
 *      than applied.
 *   2. **A report is only applied to the child it came from.** The ledger is
 *      keyed by `runId`; a report naming a run this parent never launched is
 *      refused, never matched to a nearby node. Whether the *sender* is the
 *      process that serves that child is judged by the manager, which is the
 *      only party holding current evidence about that process (see
 *      `./session-tree-manager`).
 *
 * Reconciliation is a *plan* (data) plus an application step, both pure, so the
 * restart path can be reasoned about — and tested — without a process.
 */

import type { SessionId, SessionNode, SessionStatus } from "../agent-domain/types";
import {
	type ChildSessionBlocking,
	type ChildSessionReportEnvelope,
	childSessionLifecycleToStatus,
} from "./child-session-report";

/** Terminal statuses. A node in one of these is finished for good (WP1 §6). */
export type TerminalSessionStatus = Extract<SessionStatus, "completed" | "failed" | "cancelled">;

export function isTerminalSessionStatus(status: SessionStatus): status is TerminalSessionStatus {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * What a child is blocked on, as the parent records it.
 *
 * Promoted from the report because it outlives the message: the child may ask
 * once and stay blocked for as long as the parent takes to answer.
 */
export interface ChildSessionEscalation {
	blocking: ChildSessionBlocking;
	/** The child's own words. May be empty — a `waiting` report is actionable evidence on its own. */
	question: string;
	at: number;
}

/**
 * One delegated child session as its parent knows it.
 *
 * The parent is the only writer: it owns the child process handle, it receives
 * the child's reports, and it is the only party that can observe a crash. The
 * child's own session header keeps the parent edge it already had
 * (`SessionHeader.parentSession`); nothing here writes into the child's files.
 */ export interface ChildSessionRecord {
	node: SessionNode;
	/** The delegation's launch id, injected into the child's environment. */
	runId: string;
	/** OS process last seen serving this child. Absent until a launch reported one. */
	lastPid?: number;
	/** Set while the child is `waiting_user`; cleared by any other report. */
	escalation?: ChildSessionEscalation;
	/** Why the node holds its current status, when the status alone does not say. */
	statusDetail?: string;
	createdAt: number;
	updatedAt: number;
}

/** Why a report was not applied. Every value is a reason the parent must be able to state. */
export type ReportRejection =
	/** No ledger entry carries this `runId` — this parent never launched that run. */
	| "unknown-run"
	/** The node is already terminal; terminal is never reopened. */
	| "terminal"
	/** The report came from a process other than the one the parent knows serves this child. */
	| "sender-mismatch";

export type ReportApplication =
	| { applied: true; record: ChildSessionRecord; changed: boolean }
	| { applied: false; reason: ReportRejection };

export interface ApplyReportInput {
	envelope: ChildSessionReportEnvelope;
	/**
	 * Pid the report arrived from, recorded as the child's process. The manager
	 * decides whether the sender *is* that process before calling this; at this
	 * layer a pid is information, not evidence.
	 */
	senderPid?: number;
	now: number;
}

/**
 * Apply one report to one ledger entry.
 *
 * Returns the updated record and whether anything actually changed — persisting
 * an unchanged record is a write with no information in it, and the session log
 * is append-only, so "changed" is what the caller persists on.
 */
export function applyChildSessionReport(record: ChildSessionRecord, input: ApplyReportInput): ReportApplication {
	const { envelope, senderPid, now } = input;
	const { report } = envelope;

	if (isTerminalSessionStatus(record.node.status)) return { applied: false, reason: "terminal" };

	const status = childSessionLifecycleToStatus(report.lifecycle);
	const detail = envelope.body?.trim();
	const next: ChildSessionRecord = { ...record, node: { ...record.node }, updatedAt: now };

	if (senderPid !== undefined) next.lastPid = senderPid;

	// Any report other than `waiting` means the child is not blocked any more —
	// it moved, so the escalation it was waiting on is over.
	delete next.escalation;
	if (report.lifecycle === "waiting") {
		next.escalation = {
			blocking: report.blocking ?? "ask",
			question: detail ?? "",
			// A repeat of the same wait does not restart its clock: `at` is when the
			// child *became* blocked, which is the number someone acts on.
			at: record.escalation?.at ?? now,
		};
	}

	// A `completed` report that names no result keeps whatever result the node
	// already had: absence in a later message is not evidence that the result
	// disappeared.
	if (report.lifecycle === "completed" && report.result !== undefined) {
		next.node.resultRef = report.result;
	}

	next.node.status = status;
	if (report.lifecycle === "failed") {
		if (detail) next.statusDetail = detail;
	} else if (report.lifecycle === "completed") {
		delete next.statusDetail;
	}

	// An unchanged report leaves the caller's record exactly as it was — including
	// its timestamp. Returning the rewritten copy here would advance `updatedAt`
	// for a message that said nothing new.
	if (recordsAgree(record, next)) return { applied: true, record, changed: false };
	return { applied: true, record: next, changed: true };
}

/**
 * Compare everything a report can move.
 *
 * Not `JSON.stringify` on the records: key order would make two equal records
 * compare unequal, which would turn every redundant report into a disk write.
 */
function recordsAgree(a: ChildSessionRecord, b: ChildSessionRecord): boolean {
	const sameNode =
		a.node.status === b.node.status &&
		a.node.resultRef === b.node.resultRef &&
		a.node.resultBroughtBackAt === b.node.resultBroughtBackAt;
	const sameEscalation =
		a.escalation?.at === b.escalation?.at &&
		a.escalation?.blocking === b.escalation?.blocking &&
		a.escalation?.question === b.escalation?.question;
	return (
		sameNode && sameEscalation && a.lastPid === b.lastPid && a.statusDetail === b.statusDetail && a.runId === b.runId
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation — the parent restarted and has no memory, only a ledger and
// whatever the broker can still see.
// ─────────────────────────────────────────────────────────────────────────────

export type ReconcileDisposition =
	/** Already finished; a restart changes nothing about it. */
	| "terminal"
	/** Non-terminal and still observable — the child outlived the parent. */
	| "adopted"
	/** Non-terminal and gone. Nothing will ever report for it again. */
	| "orphaned";

export interface ReconcileDecision {
	sessionId: SessionId;
	disposition: ReconcileDisposition;
	/** Status the node holds after this decision. */
	status: SessionStatus;
	/** The evidence, in one line, for whoever reads the ledger next. */
	reason: string;
	/** Live pid, on `adopted`. */
	pid?: number;
}

export interface ReconcilePlan {
	readonly decisions: readonly ReconcileDecision[];
}

/**
 * What the parent can still see about its own children.
 *
 * Two independent sources, because they answer different questions and neither
 * subsumes the other:
 */
export interface ReconcileLiveness {
	/**
	 * Pids the broker still shows registered as children of this parent — the only
	 * evidence that outlives the parent process. Matched against the pid recorded
	 * per child; never against a name, which can be reused.
	 */
	livePids: ReadonlySet<number>;
	/**
	 * Sessions this process owns *right now*: supervising them, or launching them.
	 *
	 * A child that has not been spawned yet (queued for a slot) or is mid-handshake
	 * has no pid to match, and a launching child declared an orphan would kill a
	 * delegation that is still in flight. After a restart this set is empty, which
	 * is exactly when the broker has to answer instead.
	 */
	ownedSessionIds: ReadonlySet<SessionId>;
}

/**
 * Decide the fate of every ledger entry after a restart.
 *
 * An orphan is reported `failed`, not `completed` and not left `running`. Both
 * alternatives lie: the first claims a result nobody produced, the second leaves
 * a child that will never be heard from again looking like live work.
 */
export function planReconcile(records: readonly ChildSessionRecord[], liveness: ReconcileLiveness): ReconcilePlan {
	const decisions: ReconcileDecision[] = [];
	for (const record of records) {
		const sessionId = record.node.sessionId;
		if (isTerminalSessionStatus(record.node.status)) {
			decisions.push({
				sessionId,
				disposition: "terminal",
				status: record.node.status,
				reason: `already ${record.node.status}; a terminal session is never reopened`,
			});
			continue;
		}
		if (liveness.ownedSessionIds.has(sessionId)) {
			decisions.push({
				sessionId,
				disposition: "adopted",
				status: record.node.status,
				reason: "this process is still supervising or launching this child",
			});
			continue;
		}
		const pid = record.lastPid;
		if (pid !== undefined && liveness.livePids.has(pid)) {
			decisions.push({
				sessionId,
				disposition: "adopted",
				status: record.node.status,
				reason: `child process ${pid} is still registered under this parent`,
				pid,
			});
			continue;
		}
		decisions.push({
			sessionId,
			disposition: "orphaned",
			status: "failed",
			reason:
				pid === undefined
					? "no process was ever recorded for this child and it never reported a terminal status"
					: `child process ${pid} is no longer registered under this parent and the session never reported a terminal status`,
		});
	}
	return { decisions };
}

export interface ReconcileApplication {
	records: ChildSessionRecord[];
	/** The decisions that required a write. */
	applied: ReconcileDecision[];
}

/** Fold a plan back into the ledger. Orphans become `failed`; nothing else moves. */
export function applyReconcilePlan(
	records: readonly ChildSessionRecord[],
	plan: ReconcilePlan,
	now: number,
): ReconcileApplication {
	const byId = new Map(records.map(record => [record.node.sessionId, record]));
	const applied: ReconcileDecision[] = [];
	for (const decision of plan.decisions) {
		if (decision.disposition !== "orphaned") continue;
		const record = byId.get(decision.sessionId);
		if (!record) continue;
		byId.set(decision.sessionId, {
			...record,
			node: { ...record.node, status: "failed" },
			statusDetail: decision.reason,
			updatedAt: now,
		});
		applied.push(decision);
	}
	return { records: [...byId.values()], applied };
}
