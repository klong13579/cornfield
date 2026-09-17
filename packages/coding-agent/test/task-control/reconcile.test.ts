/**
 * The plan (`docs/proma-comparison/orchestration-record-contract.md` §5).
 *
 * The plan is the only scheduling truth, so these tests are about the *rules*: who is
 * waiting on whom, who holds a slot, who merely has one reserved, and which verb the
 * orchestrator owes each unit this round.
 */

import { describe, expect, test } from "bun:test";

import { DEFAULT_MAX_CONCURRENCY, planActions, planUnitCount, reconcile } from "../../src/task-control/main-worker";
import type { ReconcilePlan } from "../../src/task-control/types";
import { recordFixture, unitFixture, violationOf } from "./fixtures";

/** Every unit id the plan mentions, whichever bucket it landed in. */
function plannedIds(plan: ReconcilePlan): string[] {
	return [
		...plan.needConfirm,
		...plan.needGo,
		...plan.waitingDeps.map(waiting => waiting.id),
		...plan.waitingConcurrency,
		...plan.unrunnable.map(unit => unit.id),
		...plan.inFlight.map(unit => unit.id),
		...plan.blocked,
		...plan.terminal.map(unit => unit.id),
	];
}

describe("slots (§5.2)", () => {
	test("defaults to 3, and a unit waiting at the gate does not hold one", () => {
		const record = recordFixture([
			unitFixture("a", "assembled"),
			unitFixture("b", "assembled"),
			unitFixture("c", "assembled"),
			unitFixture("d", "assembled"),
		]);
		const plan = reconcile(record);
		expect(plan.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(plan.freeSlots).toBe(3);
		expect(plan.needConfirm).toEqual(["a", "b", "c", "d"]);
	});

	test("the record's cap wins over the default, and the explicit argument wins over the record", () => {
		expect(reconcile(recordFixture([], 5)).maxConcurrency).toBe(5);
		expect(reconcile(recordFixture([], 5), { maxConcurrency: 2 }).maxConcurrency).toBe(2);
		expect(reconcile(recordFixture([unitFixture("a", "running")])).freeSlots).toBe(2);
	});

	test("refuses a cap that leaves nothing schedulable", () => {
		expect(violationOf(() => reconcile(recordFixture([], 0))).rule).toBe("record.ledger-rejected");
		expect(violationOf(() => reconcile(recordFixture([]), { maxConcurrency: 0 })).rule).toBe(
			"record.ledger-rejected",
		);
		expect(violationOf(() => reconcile(recordFixture([]), { maxConcurrency: 1.5 })).rule).toBe(
			"record.ledger-rejected",
		);
	});

	test("running, reviewing and blocked hold slots; assembled and started do not", () => {
		const record = recordFixture([
			unitFixture("a", "running"),
			unitFixture("b", "reviewing"),
			unitFixture("c", "blocked"),
			unitFixture("d", "started"),
			unitFixture("e", "assembled"),
		]);
		const plan = reconcile(record);
		expect(plan.freeSlots).toBe(0);
		expect(plan.inFlight).toEqual([
			{ id: "a", status: "running" },
			{ id: "b", status: "reviewing" },
		]);
		expect(plan.blocked).toEqual(["c"]);
		expect(plan.waitingConcurrency).toEqual(["d"]);
		expect(plan.needConfirm).toEqual(["e"]);
	});

	test("a GO this round takes the slot the unit is about to hold, in record order", () => {
		const plan = reconcile(
			recordFixture([
				unitFixture("a", "started"),
				unitFixture("b", "started"),
				unitFixture("c", "started"),
				unitFixture("d", "started"),
				unitFixture("e", "started"),
			]),
		);
		expect(plan.needGo).toEqual(["a", "b", "c"]);
		expect(plan.waitingConcurrency).toEqual(["d", "e"]);
		expect(plan.freeSlots).toBe(0);
	});

	test("two in-flight units leave exactly one slot for the next GO", () => {
		const plan = reconcile(
			recordFixture([
				unitFixture("a", "running"),
				unitFixture("b", "running"),
				unitFixture("c", "started"),
				unitFixture("d", "started"),
			]),
		);
		expect(plan.needGo).toEqual(["c"]);
		expect(plan.waitingConcurrency).toEqual(["d"]);
		expect(plan.freeSlots).toBe(0);
	});
});

describe("dependencies (§5.1)", () => {
	test("a unit whose dependencies are complete gets GO", () => {
		const plan = reconcile(
			recordFixture([
				unitFixture("a", "started"),
				unitFixture("b", "started", ["a"]),
				unitFixture("d", "complete"),
				unitFixture("e", "started", ["d"]),
			]),
		);
		expect(plan.needGo).toEqual(["a", "e"]);
		expect(plan.waitingDeps).toEqual([{ id: "b", blockedBy: ["a"] }]);
		expect(plan.terminal).toEqual([{ id: "d", status: "complete" }]);
		expect(plan.freeSlots).toBe(1);
	});

	test("an unsatisfied dependency keeps the unit waiting, and names what it waits on", () => {
		const plan = reconcile(recordFixture([unitFixture("a", "blocked"), unitFixture("b", "started", ["a"])]));
		expect(plan.waitingDeps).toEqual([{ id: "b", blockedBy: ["a"] }]);
		expect(plan.needGo).toEqual([]);
	});

	test("a failed dependency makes the unit unrunnable, not merely waiting", () => {
		const plan = reconcile(
			recordFixture([unitFixture("a", "failed"), unitFixture("b", "started", ["a"]), unitFixture("c", "started")]),
		);
		expect(plan.unrunnable).toEqual([{ id: "b", failedDeps: ["a"] }]);
		expect(plan.waitingDeps).toEqual([]);
		expect(plan.needGo).toEqual(["c"]);
		expect(plan.terminal).toEqual([{ id: "a", status: "failed" }]);
	});

	test("a unit with several dependencies waits until all of them are complete", () => {
		const plan = reconcile(
			recordFixture([
				unitFixture("a", "complete"),
				unitFixture("b", "reviewing"),
				unitFixture("c", "started", ["a", "b"]),
			]),
		);
		expect(plan.waitingDeps).toEqual([{ id: "c", blockedBy: ["b"] }]);
	});

	test("every unit lands in exactly one bucket — the plan is a partition", () => {
		const record = recordFixture([
			unitFixture("a", "running"),
			unitFixture("b", "reviewing"),
			unitFixture("c", "blocked"),
			unitFixture("d", "started"),
			unitFixture("e", "assembled"),
			unitFixture("f", "failed"),
			unitFixture("g", "started", ["f"]),
		]);
		const plan = reconcile(record);
		expect(planUnitCount(plan)).toBe(record.units.length);
		expect(plannedIds(plan).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
	});

	test("the same record yields the same plan — recovery re-derives it, it is not remembered (§5.3)", () => {
		const record = recordFixture([
			unitFixture("a", "running"),
			unitFixture("b", "started"),
			unitFixture("c", "assembled"),
		]);
		expect(reconcile(record)).toEqual(reconcile(record));
	});
});

describe("verbs", () => {
	const record = recordFixture([
		unitFixture("a", "running"),
		unitFixture("b", "reviewing"),
		unitFixture("c", "blocked"),
		unitFixture("d", "started"),
		unitFixture("e", "assembled"),
		unitFixture("f", "failed"),
		unitFixture("g", "started", ["f"]),
	]);

	test("maps each disposition to the verb §5.1 requires", () => {
		expect(planActions(reconcile(record))).toEqual([
			{ kind: "confirm", unitId: "e" },
			{ kind: "wait", unitId: "d", reason: "concurrency" },
			{ kind: "escalate", unitId: "g", failedDeps: ["f"] },
			{ kind: "none", unitId: "a", disposition: "inFlight" },
			{ kind: "verify", unitId: "b" },
			{ kind: "none", unitId: "c", disposition: "blocked" },
			{ kind: "none", unitId: "f", disposition: "terminal" },
		]);
	});

	test("owes exactly one verb per unit, and never drops one", () => {
		const actions = planActions(reconcile(record));
		expect(actions.map(action => action.unitId).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
	});

	test("asks for GO only where GO is what the plan says", () => {
		const started = recordFixture([unitFixture("a", "started"), unitFixture("b", "started", ["a"])]);
		expect(planActions(reconcile(started))).toEqual([
			{ kind: "go", unitId: "a" },
			{ kind: "wait", unitId: "b", reason: "deps", blockedBy: ["a"] },
		]);
	});
});

describe("illegal records", () => {
	test("refuses to plan a record it cannot order, instead of planning a dead wait", () => {
		const cyclic = recordFixture([unitFixture("a", "started", ["b"]), unitFixture("b", "started", ["a"])]);
		expect(violationOf(() => reconcile(cyclic)).rule).toBe("record.dependency-cycle");
	});

	test("refuses a record whose dependencies point at nothing", () => {
		const dangling = recordFixture([unitFixture("a", "started", ["ghost"])]);
		expect(violationOf(() => reconcile(dangling)).rule).toBe("record.dependency-unknown");
	});
});
