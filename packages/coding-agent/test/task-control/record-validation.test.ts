/**
 * Record legality (`docs/proma-comparison/orchestration-record-contract.md` §2).
 *
 * "A cycle, a self-reference and a dangling id are illegal records: the producer rejects them
 * when the package is written, instead of leaving the scheduler to wait forever." These tests
 * check both halves — the rejection, and that the *answer* comes from the shared DAG
 * primitives rather than from a second traversal written here.
 */

import { describe, expect, test } from "bun:test";

import { buildDependencyGraph, detectCycles } from "../../src/task/dag";
import { createLedger, reconcile, validateRecord } from "../../src/task-control/main-worker";
import { AT, recordFixture, unitFixture, violationOf } from "./fixtures";

/** The same graph, built in the test with the primitives the kernel claims to reuse. */
function cyclesAsDagPrimitives(record: ReturnType<typeof recordFixture>): string[] | null {
	const nodes = new Map(
		record.units.map(unit => [unit.id, { name: unit.id, waitsFor: unit.deps, reportsTo: [] as string[] }]),
	);
	return detectCycles(
		buildDependencyGraph(nodes, { agentOrder: record.units.map(unit => unit.id), chainByOrder: false }),
	);
}

describe("legal records", () => {
	test("accepts a chain and a diamond", () => {
		const record = recordFixture([
			unitFixture("a", "started"),
			unitFixture("b", "started", ["a"]),
			unitFixture("c", "started", ["a"]),
			unitFixture("d", "started", ["b", "c"]),
		]);
		expect(validateRecord(record)).toEqual([]);
		expect(reconcile(record).waitingDeps.map(waiting => waiting.id)).toEqual(["b", "c", "d"]);
	});

	test("accepts a record with no dependencies at all", () => {
		expect(validateRecord(recordFixture([unitFixture("a", "assembled"), unitFixture("b", "assembled")]))).toEqual([]);
	});
});

describe("illegal records", () => {
	test("reports a duplicated unit id", () => {
		const violations = validateRecord(recordFixture([unitFixture("a", "assembled"), unitFixture("a", "started")]));
		expect(violations).toEqual([
			{
				rule: "record.unit-id-duplicated",
				subject: "a",
				message: 'unit id "a" is declared twice in record "record-1"',
			},
		]);
	});

	test("reports a dependency on itself", () => {
		expect(validateRecord(recordFixture([unitFixture("a", "started", ["a"])]))).toEqual([
			{ rule: "record.dependency-self", subject: "a", message: 'unit "a" depends on itself' },
		]);
	});

	test("reports a dependency on a unit that does not exist", () => {
		expect(validateRecord(recordFixture([unitFixture("a", "started", ["ghost"])]))).toEqual([
			{
				rule: "record.dependency-unknown",
				subject: "a",
				message: 'unit "a" depends on "ghost", which is not in record "record-1"',
			},
		]);
	});

	test("reports a cycle, from the same primitives the record is judged with", () => {
		const record = recordFixture([
			unitFixture("a", "started", ["c"]),
			unitFixture("b", "started", ["a"]),
			unitFixture("c", "started", ["b"]),
		]);
		const violation = validateRecord(record).find(entry => entry.rule === "record.dependency-cycle");
		expect(violation?.subject).toBe("record-1");
		for (const id of ["a", "b", "c"]) expect(violation?.message).toContain(id);
		expect(cyclesAsDagPrimitives(record)?.sort()).toEqual(["a", "b", "c"]);
	});

	test("reports the units waiting on a cycle too — they can never become runnable either", () => {
		const record = recordFixture([
			unitFixture("a", "started", ["b"]),
			unitFixture("b", "started", ["a"]),
			unitFixture("c", "started", ["a"]),
		]);
		const violation = validateRecord(record).find(entry => entry.rule === "record.dependency-cycle");
		for (const id of ["a", "b", "c"]) expect(violation?.message).toContain(id);
		expect(cyclesAsDagPrimitives(record)?.sort()).toEqual(["a", "b", "c"]);
	});

	test("does not invent a cycle out of a duplicated id", () => {
		const violations = validateRecord(recordFixture([unitFixture("a", "assembled"), unitFixture("a", "assembled")]));
		expect(violations.map(violation => violation.rule)).toEqual(["record.unit-id-duplicated"]);
	});

	test("reports every problem it finds, not just the first", () => {
		const rules = validateRecord(recordFixture([unitFixture("a", "started", ["a", "ghost"])])).map(
			violation => violation.rule,
		);
		expect(rules.sort()).toEqual(["record.dependency-self", "record.dependency-unknown"]);
	});

	test("reconcile refuses an illegal record instead of planning around it", () => {
		const cyclic = recordFixture([unitFixture("a", "started", ["b"]), unitFixture("b", "started", ["a"])]);
		expect(violationOf(() => reconcile(cyclic)).rule).toBe("record.dependency-cycle");
	});
});

describe("assembling a ledger", () => {
	test("refuses a draft set that is already an illegal record", () => {
		expect(
			violationOf(() =>
				createLedger({ recordId: "record-1", units: [{ id: "a", deps: ["a"] }], actor: "orchestrator" }),
			).rule,
		).toBe("record.dependency-self");
		expect(
			violationOf(() =>
				createLedger({ recordId: "record-1", units: [{ id: "a", deps: ["b"] }], actor: "orchestrator" }),
			).rule,
		).toBe("record.dependency-unknown");
	});

	test("starts every unit at the gate and records the creation event", () => {
		const ledger = createLedger({
			recordId: "record-1",
			units: [{ id: "a" }, { id: "b", deps: ["a"] }],
			maxConcurrency: 2,
			actor: "orchestrator",
			now: AT,
		});
		expect(ledger.version).toBe(1);
		expect(ledger.record.units).toEqual([
			{ id: "a", deps: [], status: "assembled", updatedAt: AT },
			{ id: "b", deps: ["a"], status: "assembled", updatedAt: AT },
		]);
		expect(ledger.record.maxConcurrency).toBe(2);
		expect(ledger.events).toEqual([
			{
				id: "record-1#1",
				sequence: 1,
				recordId: "record-1",
				actor: "orchestrator",
				at: AT,
				type: "record.created",
				payload: { unitIds: ["a", "b"], maxConcurrency: 2 },
			},
		]);
	});

	test("records the effective cap when none is declared, so the plan is reproducible", () => {
		const ledger = createLedger({ recordId: "record-1", units: [{ id: "a" }], actor: "orchestrator", now: AT });
		expect(ledger.record.maxConcurrency).toBeUndefined();
		expect(ledger.events[0]).toMatchObject({ type: "record.created", payload: { maxConcurrency: 3 } });
	});
});
