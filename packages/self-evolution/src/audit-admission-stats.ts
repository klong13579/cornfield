/**
 * Admission / rejection counters for evolution audit reports.
 */
import type { Database } from "bun:sqlite";
import type { RegressionReplayBackendKind } from "./regression/replay-backend";

export interface RegressionTrialAuditRow {
	id: string;
	targetType: string;
	targetId: string;
	verdict: string;
	reason: string;
	createdAt: number;
}

export interface RegressionTrialsByTarget {
	convention: { keep: number; discard: number };
	skill: { keep: number; discard: number };
}

export interface AdmissionAuditStats {
	/** V3 primary lifecycle counts (`learnings` table). */
	learningsByLifecycle: Record<string, number>;
	/** Legacy; empty when `conventions` table was dropped. */
	conventionsByLifecycle: Record<string, number>;
	regressionKeep: number;
	regressionDiscard: number;
	regressionPending: number;
	regressionFixtureCount: number;
	sessionTraceCount: number;
	trialsByTarget: RegressionTrialsByTarget;
	trialsByReplayBackend: Record<RegressionReplayBackendKind, number>;
	regressionToolchainOverturns: number;
	regressionToolchainConfirm: number;
	regressionToolchainOnly: number;
	recentTrials: RegressionTrialAuditRow[];
	skillsDeprecated: number;
	nudgesDismissed: number;
	nudgesAcknowledged: number;
}

const EMPTY_BY_TARGET = (): RegressionTrialsByTarget => ({
	convention: { keep: 0, discard: 0 },
	skill: { keep: 0, discard: 0 },
});

const EMPTY_BY_BACKEND = (): Record<RegressionReplayBackendKind, number> => ({
	heuristic: 0,
	llm: 0,
	subagent: 0,
});

function countTrialsLike(db: Database, pattern: string): number {
	const row = db.prepare("SELECT COUNT(*) as c FROM regression_trials WHERE reason LIKE ?").get(`%${pattern}%`) as {
		c: number;
	};
	return row.c;
}

function tableExists(db: Database, name: string): boolean {
	return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export function queryAdmissionAuditStats(db: Database): AdmissionAuditStats {
	const learningsByLifecycle: Record<string, number> = {};
	if (tableExists(db, "learnings")) {
		const learningRows = db
			.prepare("SELECT lifecycle, COUNT(*) as c FROM learnings GROUP BY lifecycle")
			.all() as Array<{ lifecycle: string; c: number }>;
		for (const row of learningRows) {
			learningsByLifecycle[row.lifecycle] = row.c;
		}
	}

	const conventionsByLifecycle: Record<string, number> = {};
	if (tableExists(db, "conventions")) {
		const conventionRows = db
			.prepare("SELECT lifecycle_state, COUNT(*) as c FROM conventions GROUP BY lifecycle_state")
			.all() as Array<{ lifecycle_state: string; c: number }>;
		for (const row of conventionRows) {
			conventionsByLifecycle[row.lifecycle_state] = row.c;
		}
	}

	const trialRows = db
		.prepare("SELECT verdict, COUNT(*) as c FROM regression_trials GROUP BY verdict")
		.all() as Array<{ verdict: string; c: number }>;
	let regressionKeep = 0;
	let regressionDiscard = 0;
	let regressionPending = 0;
	for (const row of trialRows) {
		if (row.verdict === "keep") regressionKeep = row.c;
		else if (row.verdict === "discard") regressionDiscard = row.c;
		else if (row.verdict === "pending") regressionPending = row.c;
	}

	const trialsByTarget = EMPTY_BY_TARGET();
	const targetRows = db
		.prepare(
			`SELECT target_type, verdict, COUNT(*) as c FROM regression_trials
			WHERE verdict IN ('keep', 'discard')
			GROUP BY target_type, verdict`,
		)
		.all() as Array<{ target_type: string; verdict: string; c: number }>;
	for (const row of targetRows) {
		const bucket = row.target_type === "skill" ? trialsByTarget.skill : trialsByTarget.convention;
		if (row.verdict === "keep") bucket.keep = row.c;
		else if (row.verdict === "discard") bucket.discard = row.c;
	}

	const trialsByReplayBackend = EMPTY_BY_BACKEND();
	for (const kind of ["heuristic", "llm", "subagent"] as RegressionReplayBackendKind[]) {
		trialsByReplayBackend[kind] = countTrialsLike(db, `[replay:${kind}]`);
	}

	const recentTrialRows = db
		.prepare(
			`SELECT id, target_type, target_id, verdict, reason, created_at
			FROM regression_trials ORDER BY created_at DESC LIMIT 8`,
		)
		.all() as Array<{
		id: string;
		target_type: string;
		target_id: string;
		verdict: string;
		reason: string;
		created_at: number;
	}>;
	const recentTrials: RegressionTrialAuditRow[] = recentTrialRows.map(row => ({
		id: row.id,
		targetType: row.target_type,
		targetId: row.target_id,
		verdict: row.verdict,
		reason: row.reason,
		createdAt: row.created_at,
	}));

	const fixtureRow = db.prepare("SELECT COUNT(*) as c FROM regression_fixtures").get() as { c: number };
	const traceRow = db.prepare("SELECT COUNT(*) as c FROM session_traces").get() as { c: number };

	const skillRow = db.prepare("SELECT COUNT(*) as c FROM skills WHERE deprecated = 1").get() as {
		c: number;
	};
	const nudgeDismissedRow = db
		.prepare("SELECT COUNT(*) as c FROM nudge_history WHERE dismissed_at IS NOT NULL")
		.get() as { c: number };
	const nudgeAckRow = db.prepare("SELECT COUNT(*) as c FROM nudge_history WHERE acknowledged = 1").get() as {
		c: number;
	};

	return {
		learningsByLifecycle,
		conventionsByLifecycle,
		regressionKeep,
		regressionDiscard,
		regressionPending,
		regressionFixtureCount: fixtureRow.c,
		sessionTraceCount: traceRow.c,
		trialsByTarget,
		trialsByReplayBackend,
		regressionToolchainOverturns: countTrialsLike(db, "[toolchain:overturn]"),
		regressionToolchainConfirm: countTrialsLike(db, "[toolchain:confirm]"),
		regressionToolchainOnly: countTrialsLike(db, "[toolchain:only]"),
		recentTrials,
		skillsDeprecated: skillRow.c,
		nudgesDismissed: nudgeDismissedRow.c,
		nudgesAcknowledged: nudgeAckRow.c,
	};
}
