/**
 * The ledger's pure rules: report application, escalation bookkeeping, and the
 * reconcile plan.
 *
 * No processes, no broker, no disk — these functions are where the parent decides
 * what a child's statement means, and every case here is one the manager relies
 * on when it is talking to something that can die mid-sentence.
 */

import { describe, expect, test } from "bun:test";
import { validateSessionTree } from "../../src/agent-domain/relations";
import type { SessionNode } from "../../src/agent-domain/types";
import { formatChildSessionReport, parseChildSessionReport } from "../../src/session/child-session-report";
import {
	applyChildSessionReport,
	applyReconcilePlan,
	type ChildSessionRecord,
	planReconcile,
} from "../../src/session/session-tree";

const RUN_ID = "run-1";
const NOW = 1_000;

function baseRecord(overrides: Partial<ChildSessionRecord> = {}, node: Partial<SessionNode> = {}): ChildSessionRecord {
	return {
		node: {
			sessionId: "child-1",
			agentId: "coding",
			parentSessionId: "parent-1",
			rootSessionId: "parent-1",
			depth: 1,
			kind: "child",
			status: "running",
			executionPolicy: "isolated-process",
			...node,
		},
		runId: RUN_ID,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function envelopeFor(report: Parameters<typeof formatChildSessionReport>[0], body?: string) {
	const parsed = parseChildSessionReport(formatChildSessionReport(report, body));
	if (!parsed) throw new Error("the fixture report did not parse");
	return parsed;
}

describe("applyChildSessionReport", () => {
	test("started and progress both mean the child is running", () => {
		for (const lifecycle of ["started", "progress"] as const) {
			const result = applyChildSessionReport(baseRecord(), {
				envelope: envelopeFor({ runId: RUN_ID, lifecycle }),
				senderPid: 111,
				now: NOW + 1,
			});
			expect(result.applied).toBe(true);
			if (!result.applied) return;
			expect(result.record.node.status).toBe("running");
			expect(result.record.lastPid).toBe(111);
			expect(result.record.updatedAt).toBe(NOW + 1);
		}
	});

	test("waiting records what the child is blocked on, in the child's own words", () => {
		const result = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting", blocking: "permission" }, "may I run rm -rf?"),
			now: NOW + 5,
		});
		expect(result.applied).toBe(true);
		if (!result.applied) return;
		expect(result.record.node.status).toBe("waiting_user");
		expect(result.record.escalation).toEqual({
			blocking: "permission",
			question: "may I run rm -rf?",
			at: NOW + 5,
		});
	});

	test("a waiting report with no words is still recorded as waiting", () => {
		// Accepting is the safe direction: a child that says it is blocked and is
		// dropped would wait forever with nothing in the ledger to say why.
		const result = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting" }),
			now: NOW + 5,
		});
		expect(result.applied).toBe(true);
		if (!result.applied) return;
		expect(result.record.node.status).toBe("waiting_user");
		expect(result.record.escalation?.question).toBe("");
	});

	test("any later report clears the escalation — the child moved, so it is not blocked", () => {
		const waiting = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting" }),
			now: NOW + 1,
		});
		if (!waiting.applied) throw new Error("expected the waiting report to apply");
		const moved = applyChildSessionReport(waiting.record, {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "progress" }),
			now: NOW + 2,
		});
		if (!moved.applied) throw new Error("expected the progress report to apply");
		expect(moved.record.escalation).toBeUndefined();
		expect(moved.record.node.status).toBe("running");
	});

	test("completed records the result the child points at, and the round's own words", () => {
		const result = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "completed", result: "/tmp/child-session.jsonl" }, "done"),
			now: NOW + 9,
		});
		if (!result.applied) throw new Error("expected the completed report to apply");
		expect(result.record.node.status).toBe("completed");
		expect(result.record.node.resultRef).toBe("/tmp/child-session.jsonl");
		expect(result.record.node.resultBroughtBackAt).toBeUndefined();
	});

	test("a completed report that names no result keeps the result the node already had", () => {
		const prior = baseRecord({}, { status: "running", resultRef: "artifact://kept" });
		const result = applyChildSessionReport(prior, {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "completed" }),
			now: NOW + 9,
		});
		if (!result.applied) throw new Error("expected the completed report to apply");
		expect(result.record.node.resultRef).toBe("artifact://kept");
	});

	test("failed keeps the reason the child gave", () => {
		const result = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "failed" }, "the model rejected the request"),
			now: NOW + 3,
		});
		if (!result.applied) throw new Error("expected the failed report to apply");
		expect(result.record.node.status).toBe("failed");
		expect(result.record.statusDetail).toBe("the model rejected the request");
	});

	test("refuses to reopen a terminal node, whatever the child now says", () => {
		for (const terminal of ["completed", "failed", "cancelled"] as const) {
			for (const lifecycle of ["started", "progress", "waiting", "completed", "failed"] as const) {
				const result = applyChildSessionReport(baseRecord({}, { status: terminal }), {
					envelope: envelopeFor({ runId: RUN_ID, lifecycle }),
					now: NOW + 10,
				});
				expect(result.applied).toBe(false);
				if (result.applied) return;
				expect(result.reason).toBe("terminal");
			}
		}
	});

	test("refuses to reopen a terminal node, whatever the child now says", () => {
		const learned = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "started" }),
			senderPid: 111,
			now: NOW + 1,
		});
		if (!learned.applied) throw new Error("expected the started report to apply");
		expect(learned.record.lastPid).toBe(111);

		// A relaunch is a new process on the same delegation, so the pid moves with it.
		// Whether that pid is *allowed* to speak for the child is the manager's call:
		// it is the only layer holding current evidence about the running process.
		const relaunched = applyChildSessionReport(learned.record, {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "progress" }),
			senderPid: 222,
			now: NOW + 2,
		});
		if (!relaunched.applied) throw new Error("expected the progress report to apply");
		expect(relaunched.record.lastPid).toBe(222);
	});

	test("a repeated report changes nothing and does not move the node's timestamp", () => {
		const first = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting" }, "decide this"),
			senderPid: 111,
			now: NOW + 1,
		});
		if (!first.applied) throw new Error("expected the first report to apply");
		const again = applyChildSessionReport(first.record, {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting" }, "decide this"),
			senderPid: 111,
			now: NOW + 50,
		});
		expect(again.applied).toBe(true);
		if (!again.applied) return;
		expect(again.changed).toBe(false);
		expect(again.record.updatedAt).toBe(NOW + 1);
		// The wait did not restart; `at` still says when it began.
		expect(again.record.escalation?.at).toBe(NOW + 1);
	});

	test("a re-ask with different words updates the question and keeps the original wait clock", () => {
		const first = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting" }, "first question"),
			now: NOW + 1,
		});
		if (!first.applied) throw new Error("expected the first report to apply");
		const again = applyChildSessionReport(first.record, {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting" }, "second question"),
			now: NOW + 2,
		});
		if (!again.applied) throw new Error("expected the second report to apply");
		expect(again.changed).toBe(true);
		expect(again.record.escalation).toEqual({ blocking: "ask", question: "second question", at: NOW + 1 });
	});

	test("a new wait after the child moved starts a new clock", () => {
		const waiting = applyChildSessionReport(baseRecord(), {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting" }),
			now: NOW + 1,
		});
		if (!waiting.applied) throw new Error("expected the waiting report to apply");
		const moved = applyChildSessionReport(waiting.record, {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "progress" }),
			now: NOW + 2,
		});
		if (!moved.applied) throw new Error("expected the progress report to apply");
		const blockedAgain = applyChildSessionReport(moved.record, {
			envelope: envelopeFor({ runId: RUN_ID, lifecycle: "waiting" }),
			now: NOW + 3,
		});
		if (!blockedAgain.applied) throw new Error("expected the second waiting report to apply");
		expect(blockedAgain.record.escalation?.at).toBe(NOW + 3);
	});
});

describe("planReconcile", () => {
	test("leaves terminal nodes alone", () => {
		const plan = planReconcile([baseRecord({}, { status: "completed" })], new Set());
		expect(plan.decisions).toEqual([
			{
				sessionId: "child-1",
				disposition: "terminal",
				status: "completed",
				reason: "already completed; a terminal session is never reopened",
			},
		]);
	});

	test("adopts a non-terminal child whose process is still registered under the parent", () => {
		const plan = planReconcile([baseRecord({ lastPid: 4242 })], new Set([4242]));
		expect(plan.decisions).toEqual([
			{
				sessionId: "child-1",
				disposition: "adopted",
				status: "running",
				reason: "child process 4242 is still registered under this parent",
				pid: 4242,
			},
		]);
	});

	test("orphans a non-terminal child whose process is gone", () => {
		const plan = planReconcile([baseRecord({ lastPid: 4242 })], new Set());
		expect(plan.decisions[0]).toMatchObject({
			disposition: "orphaned",
			status: "failed",
			reason:
				"child process 4242 is no longer registered under this parent and the session never reported a terminal status",
		});
	});

	test("orphans a child no process was ever recorded for", () => {
		const plan = planReconcile([baseRecord()], new Set([4242]));
		expect(plan.decisions[0]).toMatchObject({ disposition: "orphaned", status: "failed" });
		expect(plan.decisions[0]?.reason).toContain("no process was ever recorded");
	});
});

describe("applyReconcilePlan", () => {
	test("writes only the orphans, and says why in the ledger", () => {
		const records = [
			baseRecord({ lastPid: 11 }),
			baseRecord({ lastPid: 22 }, { sessionId: "child-2" }),
			baseRecord({ lastPid: 33 }, { sessionId: "child-3", status: "completed" }),
		];

		const plan = planReconcile(records, new Set([11]));
		const applied = applyReconcilePlan(records, plan, NOW + 100);

		expect(applied.applied.map(decision => decision.sessionId)).toEqual(["child-2"]);
		const byId = new Map(applied.records.map(record => [record.node.sessionId, record]));
		expect(byId.get("child-1")?.node.status).toBe("running");
		expect(byId.get("child-1")?.updatedAt).toBe(NOW);
		expect(byId.get("child-2")?.node.status).toBe("failed");
		expect(byId.get("child-2")?.statusDetail).toContain("no longer registered");
		expect(byId.get("child-2")?.updatedAt).toBe(NOW + 100);
		expect(byId.get("child-3")?.node.status).toBe("completed");
	});

	test("produces a ledger the WP1 session-tree relations accept", () => {
		const parent: SessionNode = {
			sessionId: "parent-1",
			agentId: "coding",
			rootSessionId: "parent-1",
			depth: 0,
			kind: "root",
			status: "running",
			executionPolicy: "isolated-process",
		};
		const record = baseRecord(
			{ lastPid: 7 },
			{ status: "completed", resultRef: "/tmp/result.jsonl", resultBroughtBackAt: NOW + 2 },
		);
		const violations = validateSessionTree({
			agents: [{ agentId: "coding", agentDir: "/tmp/agents/coding", displayName: "coding", enabled: true }],
			projects: [],
			sessions: [parent, record.node],
		});
		expect(violations).toEqual([]);
	});
});
