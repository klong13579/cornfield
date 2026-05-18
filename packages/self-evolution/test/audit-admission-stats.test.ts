import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { queryAdmissionAuditStats } from "../src/audit-admission-stats";
import { initSchema } from "../src/storage/db";

describe("audit-admission-stats", () => {
	test("aggregates lifecycle, regression, and deprecate counts", () => {
		const db = new Database(":memory:");
		initSchema(db);

		db.run(
			`INSERT INTO learnings (
				id, cwd, kind, content, source, confidence, lifecycle, session_id,
				created_at, updated_at, times_injected, times_helped, times_ignored
			) VALUES ('l1', '/p', 'preference', 'a', 'session_llm', 4, 'active', 's1', 1, 1, 0, 0, 0),
			       ('l2', '/p', 'preference', 'b', 'session_llm', 4, 'archived', 's2', 1, 1, 0, 0, 0)`,
		);
		db.run(
			`INSERT INTO regression_trials (id, target_type, target_id, fixture_id, verdict, reason, created_at)
			VALUES ('t1', 'skill', 's1', 'f1', 'keep', 'ok', 1),
			       ('t2', 'skill', 's2', 'f1', 'discard', 'fail', 2)`,
		);
		db.run(
			`INSERT INTO skills (name, description, task_pattern, approach, tools, pitfalls, created_at, last_used_at, usage_count, success_count, failure_count, version, quality_score, deprecated)
			VALUES ('bad-skill', 'd', 't', 'a', '[]', '[]', 1, 1, 1, 0, 0, 1, 10, 1)`,
		);
		db.run(
			`INSERT INTO nudge_history (id, session_id, project, type, severity, message, suggestion, detected_at, dismissed_at, acknowledged)
			VALUES ('n1', 's', '/p', 'slow-loop', 'warn', 'm', 's', 1, 2, 0),
			       ('n2', 's', '/p', 'slow-loop', 'warn', 'm', 's', 1, NULL, 1)`,
		);

		const stats = queryAdmissionAuditStats(db);
		expect(stats.learningsByLifecycle.active).toBe(1);
		expect(stats.learningsByLifecycle.archived).toBe(1);
		expect(stats.conventionsByLifecycle).toEqual({});
		expect(stats.regressionKeep).toBe(1);
		expect(stats.regressionDiscard).toBe(1);
		expect(stats.trialsByTarget.skill.keep).toBe(1);
		expect(stats.trialsByTarget.skill.discard).toBe(1);
		expect(stats.recentTrials.length).toBe(2);
		expect(stats.regressionFixtureCount).toBe(0);
		expect(stats.sessionTraceCount).toBe(0);
		expect(stats.skillsDeprecated).toBe(1);
		expect(stats.nudgesDismissed).toBe(1);
		expect(stats.nudgesAcknowledged).toBe(1);
	});
});
