/**
 * The orchestrator's writes: the gate protocol, acceptance, rework, the two result facts, and
 * the derived Main Worker status.
 *
 * `docs/proma-comparison/orchestration-record-contract.md` §5.3 (idempotent GO, send-then-record,
 * recovery), §6 (acceptance binding);
 * `docs/agent-task-control-plane-v1-implementation.md` §9 (the Main Worker owns acceptance,
 * verification supplies evidence).
 *
 * The acceptance binding used here is the *strategy's* shape — the code-delivery one §6 names
 * (`{ verifiedCommit, pinnedBranch, verifiedAt }`). The kernel never reads those fields; the
 * tests spell them out because that is what the strategy layer passes in.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	acceptUnit,
	bringBackResult,
	createLedger,
	mainWorkerStatus,
	markResultReady,
	planActions,
	reconcile,
	recordConfirmation,
	recordGoSent,
	recordStatus,
	reworkUnit,
} from "../../src/task-control/main-worker";
import { createFileOrchestrationStore } from "../../src/task-control/store";
import { AT, violationOf } from "./fixtures";

/** The code-delivery strategy's binding (§6). The kernel treats it as an opaque slot. */
const VERIFIED = { verifiedCommit: "9f2c1ab", pinnedBranch: "squad/t11", verifiedAt: AT };

/** Two units, `b` waiting on `a`, both at the gate. */
function atGate() {
	return createLedger({
		recordId: "pkg",
		units: [{ id: "a" }, { id: "b", deps: ["a"] }],
		actor: "orchestrator",
		now: AT,
	});
}

/** The same two units, confirmed, with `a` running. */
function withRunningUnit() {
	const confirmed = recordConfirmation(atGate(), ["a", "b"], { actor: "orchestrator", now: AT + 1 });
	return recordGoSent(confirmed, ["a"], { actor: "orchestrator", now: AT + 2 });
}

describe("the GO gate (§5.3)", () => {
	test("opens in two steps: the readiness check is confirmed, then GO is sent", () => {
		const gated = atGate();
		expect(reconcile(gated.record).needConfirm).toEqual(["a", "b"]);

		const confirmed = recordConfirmation(gated, ["a", "b"], { actor: "orchestrator", now: AT + 1 });
		expect(reconcile(confirmed.record).needGo).toEqual(["a"]);
		expect(reconcile(confirmed.record).waitingDeps).toEqual([{ id: "b", blockedBy: ["a"] }]);

		const started = recordGoSent(confirmed, ["a"], { actor: "orchestrator", now: AT + 2 });
		expect(reconcile(started.record).inFlight).toEqual([{ id: "a", status: "running" }]);
	});

	test("a crash between sending GO and recording it leaves no dead window", () => {
		const confirmed = recordConfirmation(atGate(), ["a"], { actor: "orchestrator", now: AT + 1 });
		// GO went out; the ledger never moved. The next round derives the same verb again — the unit is
		// still `started`, so re-sending is the plan's own instruction rather than a guess.
		expect(reconcile(confirmed.record).needGo).toEqual(["a"]);
		expect(planActions(reconcile(confirmed.record))).toContainEqual({ kind: "go", unitId: "a" });
	});

	test("a repeated GO is recorded and restarts nothing", () => {
		const started = withRunningUnit();
		const repeated = recordGoSent(started, ["a"], { actor: "orchestrator", now: AT + 3 });
		expect(repeated.record.units[0].status).toBe("running");
		expect(repeated.record.units[0].updatedAt).toBe(AT + 3);
		expect(repeated.events.at(-1)).toMatchObject({
			type: "unit.transitioned",
			unitId: "a",
			payload: { from: "running", to: "running", forced: false },
		});
		expect(reconcile(repeated.record).inFlight).toEqual([{ id: "a", status: "running" }]);
	});

	test("a repeated confirmation does not open the gate", () => {
		const confirmed = recordConfirmation(atGate(), ["a", "b"], { actor: "orchestrator", now: AT + 1 });
		const repeated = recordConfirmation(confirmed, ["a"], { actor: "orchestrator", now: AT + 4 });
		expect(repeated.record.units[0].status).toBe("started");
		expect(reconcile(repeated.record).needGo).toEqual(["a"]);
	});

	test("refuses to record GO for a unit whose dependencies are not complete", () => {
		const confirmed = recordConfirmation(atGate(), ["a", "b"], { actor: "orchestrator", now: AT + 1 });
		expect(violationOf(() => recordGoSent(confirmed, ["b"], { actor: "orchestrator" })).rule).toBe(
			"unit.dependencies-unsatisfied",
		);
	});

	test("force records a GO the ledger never saw, and marks the event as forced", () => {
		const gated = atGate();
		expect(violationOf(() => recordGoSent(gated, ["a"], { actor: "orchestrator" })).rule).toBe(
			"unit.transition-illegal",
		);

		const forced = recordGoSent(gated, ["a"], { actor: "orchestrator", force: true, now: AT + 5 });
		expect(forced.record.units[0].status).toBe("running");
		expect(forced.events.at(-1)).toMatchObject({ payload: { from: "assembled", to: "running", forced: true } });
	});
});

describe("acceptance (§6)", () => {
	const inReview = () => recordStatus(withRunningUnit(), "a", "reviewing", { actor: "unit:a", now: AT + 3 });

	test("complete is an acceptance decision, and the binding lands with it", () => {
		const reviewing = inReview();
		expect(violationOf(() => recordStatus(reviewing, "a", "complete", { actor: "orchestrator" })).rule).toBe(
			"unit.acceptance-missing",
		);

		const accepted = acceptUnit(reviewing, "a", { acceptance: VERIFIED, actor: "orchestrator", now: AT + 4 });
		expect(accepted.record.units[0]).toMatchObject({ status: "complete", acceptance: VERIFIED });
		expect(accepted.events.at(-1)).toMatchObject({
			type: "unit.accepted",
			unitId: "a",
			payload: { from: "reviewing", to: "complete", acceptance: VERIFIED, reaccept: false },
		});
	});

	test("the reviewed unit unblocks its dependent, which is what the plan then says", () => {
		const accepted = acceptUnit(inReview(), "a", { acceptance: VERIFIED, actor: "orchestrator", now: AT + 4 });
		expect(reconcile(accepted.record).needGo).toEqual(["b"]);
		expect(mainWorkerStatus(reconcile(accepted.record))).toBe("dispatching");
	});

	test("re-accepting onto a new binding is explicit, never silent", () => {
		const accepted = acceptUnit(inReview(), "a", { acceptance: VERIFIED, actor: "orchestrator", now: AT + 4 });
		expect(
			violationOf(() =>
				acceptUnit(accepted, "a", { acceptance: { verifiedCommit: "deadbeef" }, actor: "orchestrator" }),
			).rule,
		).toBe("unit.acceptance-rebind");

		const moved = acceptUnit(accepted, "a", {
			acceptance: { verifiedCommit: "deadbeef" },
			reaccept: true,
			actor: "orchestrator",
			now: AT + 9,
		});
		expect(moved.record.units[0].acceptance).toEqual({ verifiedCommit: "deadbeef" });
		expect(moved.events.at(-1)).toMatchObject({ type: "unit.accepted", payload: { reaccept: true } });
	});

	test("refuses to accept a unit that failed — failure is terminal, not a review outcome", () => {
		const failed = recordStatus(withRunningUnit(), "a", "failed", { actor: "orchestrator", note: "provider gone" });
		expect(violationOf(() => acceptUnit(failed, "a", { acceptance: VERIFIED, actor: "orchestrator" })).rule).toBe(
			"unit.transition-illegal",
		);
	});

	test("refuses a write for a unit the record does not have", () => {
		expect(
			violationOf(() => acceptUnit(atGate(), "ghost", { acceptance: VERIFIED, actor: "orchestrator" })).rule,
		).toBe("unit.unknown");
		expect(violationOf(() => recordStatus(atGate(), "ghost", "running", { actor: "orchestrator" })).rule).toBe(
			"unit.unknown",
		);
	});
});

describe("rework", () => {
	const inReview = () => recordStatus(withRunningUnit(), "a", "reviewing", { actor: "unit:a", now: AT + 3 });

	test("sends the unit back to work with the findings that did it", () => {
		const reworked = reworkUnit(inReview(), "a", {
			findings: ["gate failed: bun test run", "changed files exceed the ticket scope"],
			requiredChanges: ["fix the store test", "drop the unrelated edit"],
			actor: "orchestrator",
			now: AT + 4,
		});
		expect(reworked.record.units[0].status).toBe("running");
		expect(reworked.record.units[0].note).toBe(
			"rework: gate failed: bun test run | changed files exceed the ticket scope | fix the store test | drop the unrelated edit",
		);
		expect(reworked.events.at(-1)).toMatchObject({
			type: "unit.reworked",
			unitId: "a",
			payload: {
				from: "reviewing",
				to: "running",
				findings: ["gate failed: bun test run", "changed files exceed the ticket scope"],
				requiredChanges: ["fix the store test", "drop the unrelated edit"],
			},
		});
	});

	test("refuses a rejection that says nothing", () => {
		expect(
			violationOf(() => reworkUnit(inReview(), "a", { findings: [], requiredChanges: [], actor: "orchestrator" }))
				.rule,
		).toBe("unit.rework-unsubstantiated");
	});

	test("refuses to send back a unit that is not awaiting review", () => {
		expect(
			violationOf(() => reworkUnit(withRunningUnit(), "a", { findings: ["nope"], requiredChanges: [], actor: "o" }))
				.rule,
		).toBe("unit.transition-illegal");
	});
});

describe("the two result facts", () => {
	test("ready and brought back are independent", () => {
		const running = withRunningUnit();
		const ready = markResultReady(running, "a", { ref: "artifact://result-1", actor: "unit:a", now: AT + 5 });
		expect(ready.record.units[0].result).toEqual({ ref: "artifact://result-1", readyAt: AT + 5 });
		expect(ready.record.units[0].result?.broughtBackAt).toBeUndefined();

		const brought = bringBackResult(ready, "a", { actor: "orchestrator", now: AT + 6 });
		expect(brought.firstTime).toBe(true);
		expect(brought.broughtBackAt).toBe(AT + 6);
		expect(brought.ledger.record.units[0].result).toEqual({
			ref: "artifact://result-1",
			readyAt: AT + 5,
			broughtBackAt: AT + 6,
		});
	});

	test("refuses to bring back a result that is not ready", () => {
		expect(violationOf(() => bringBackResult(withRunningUnit(), "a", { actor: "orchestrator" })).rule).toBe(
			"unit.result-not-ready",
		);
	});

	test("a repeated bring-back is not a second result", () => {
		const ready = markResultReady(withRunningUnit(), "a", {
			ref: "artifact://result-1",
			actor: "unit:a",
			now: AT + 5,
		});
		const first = bringBackResult(ready, "a", { actor: "orchestrator", now: AT + 6 });
		const again = bringBackResult(first.ledger, "a", { actor: "orchestrator", now: AT + 7 });
		expect(again.firstTime).toBe(false);
		expect(again.broughtBackAt).toBe(AT + 6);
		expect(again.ledger).toBe(first.ledger);
	});

	test("a unit has one result: re-pointing it is refused", () => {
		const ready = markResultReady(withRunningUnit(), "a", { ref: "artifact://result-1", actor: "unit:a" });
		expect(violationOf(() => markResultReady(ready, "a", { ref: "artifact://result-2", actor: "unit:a" })).rule).toBe(
			"unit.result-conflict",
		);
	});

	test("re-reporting the same result changes nothing at all", () => {
		const ready = markResultReady(withRunningUnit(), "a", {
			ref: "artifact://result-1",
			actor: "unit:a",
			now: AT + 5,
		});
		expect(markResultReady(ready, "a", { ref: "artifact://result-1", actor: "unit:a", now: AT + 9 })).toBe(ready);
	});
});

describe("the derived Main Worker status", () => {
	test("follows the plan through a whole package, with no second status to keep in sync", () => {
		const empty = createLedger({ recordId: "pkg", units: [], actor: "orchestrator" });
		expect(mainWorkerStatus(reconcile(empty.record))).toBe("decomposing");

		const gated = atGate();
		expect(mainWorkerStatus(reconcile(gated.record))).toBe("dispatching");

		const confirmed = recordConfirmation(gated, ["a", "b"], { actor: "orchestrator", now: AT + 1 });
		expect(mainWorkerStatus(reconcile(confirmed.record))).toBe("dispatching");

		const started = recordGoSent(confirmed, ["a"], { actor: "orchestrator", now: AT + 2 });
		expect(mainWorkerStatus(reconcile(started.record))).toBe("supervising");

		const blocked = recordStatus(started, "a", "blocked", { actor: "unit:a", note: "which model?" });
		expect(mainWorkerStatus(reconcile(blocked.record))).toBe("waiting_user");

		const resumed = recordStatus(blocked, "a", "running", { actor: "orchestrator", now: AT + 3 });
		const acceptedA = acceptUnit(resumed, "a", { acceptance: VERIFIED, actor: "orchestrator", now: AT + 4 });
		expect(mainWorkerStatus(reconcile(acceptedA.record))).toBe("dispatching");

		const bRan = recordGoSent(acceptedA, ["b"], { actor: "orchestrator", now: AT + 5 });
		const bInReview = recordStatus(bRan, "b", "reviewing", { actor: "unit:b", now: AT + 6 });
		expect(mainWorkerStatus(reconcile(bInReview.record))).toBe("supervising");

		const acceptedB = acceptUnit(bInReview, "b", { acceptance: VERIFIED, actor: "orchestrator", now: AT + 7 });
		expect(mainWorkerStatus(reconcile(acceptedB.record))).toBe("package_accepted");
	});

	test("calls a package with a failed dependency waiting for the user, not stuck", () => {
		const started = withRunningUnit();
		const failed = recordStatus(started, "a", "failed", { actor: "orchestrator", note: "provider gone" });
		expect(reconcile(failed.record).unrunnable).toEqual([{ id: "b", failedDeps: ["a"] }]);
		expect(mainWorkerStatus(reconcile(failed.record))).toBe("waiting_user");
	});

	test("reports failure only when every unit is terminal and none was accepted", () => {
		const oneUnit = createLedger({ recordId: "pkg", units: [{ id: "a" }], actor: "orchestrator", now: AT });
		const failed = recordStatus(oneUnit, "a", "failed", { actor: "orchestrator" });
		expect(mainWorkerStatus(reconcile(failed.record))).toBe("failed");
	});
});

describe("the ledger is the only thing that survives a restart", () => {
	test("a restart re-reads the ledger and continues from the same plan", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cornfield-task-control-"));
		try {
			const store = createFileOrchestrationStore(dir);
			const running = withRunningUnit();
			await store.save(running);

			// The orchestrator process dies here. Nothing but the ledger survives.
			const reloaded = await store.load("pkg");
			if (reloaded === null) throw new Error("the ledger did not survive the restart");
			expect(reloaded).toEqual(running);
			expect(reconcile(reloaded.record)).toEqual(reconcile(running.record));

			const accepted = acceptUnit(recordStatus(reloaded, "a", "reviewing", { actor: "unit:a", now: AT + 3 }), "a", {
				acceptance: VERIFIED,
				actor: "orchestrator",
				now: AT + 4,
			});
			await store.save(accepted);
			expect(await store.load("pkg")).toEqual(accepted);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("a mutation never touches the ledger it was handed", () => {
		const before = atGate();
		const snapshot = JSON.parse(JSON.stringify(before));
		recordConfirmation(before, ["a", "b"], { actor: "orchestrator", now: AT + 1 });
		violationOf(() => acceptUnit(before, "a", { acceptance: VERIFIED, actor: "orchestrator", now: AT + 2 }));
		markResultReady(before, "a", { ref: "artifact://result-1", actor: "unit:a", now: AT + 3 });
		expect(before).toEqual(snapshot);
	});

	test("a unit's updatedAt is the timestamp of the last event about it — one instant per write", () => {
		const accepted = acceptUnit(
			recordStatus(withRunningUnit(), "a", "reviewing", { actor: "unit:a", now: AT + 3 }),
			"a",
			{ acceptance: VERIFIED, actor: "orchestrator", now: AT + 4 },
		);
		for (const unit of accepted.record.units) {
			const last = accepted.events.filter(event => event.unitId === unit.id).at(-1);
			if (!last) throw new Error(`unit "${unit.id}" has no event, so nothing explains its status`);
			expect(unit.updatedAt).toBe(last.at);
		}
	});

	test("every write appends one event per unit, in sequence", () => {
		const confirmed = recordConfirmation(atGate(), ["a", "b"], { actor: "orchestrator", now: AT + 1 });
		expect(confirmed.events.map(event => event.sequence)).toEqual([1, 2, 3]);
		expect(confirmed.events.map(event => event.id)).toEqual(["pkg#1", "pkg#2", "pkg#3"]);
		expect(confirmed.events.map(event => event.unitId)).toEqual([undefined, "a", "b"]);
		expect(confirmed.events.map(event => event.actor)).toEqual(["orchestrator", "orchestrator", "orchestrator"]);
		expect(confirmed.events.at(-1)).toMatchObject({
			type: "unit.transitioned",
			payload: { from: "assembled", to: "started", forced: false },
		});
	});
});
