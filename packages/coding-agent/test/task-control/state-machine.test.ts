/**
 * The transition table and its guards (`docs/proma-comparison/orchestration-record-contract.md` §3, §4).
 *
 * The matrix is written out again here on purpose: it is the *spec*, and a test that imported
 * the implementation's own table would agree with a typo. Every other assertion in this file
 * is about behaviour a caller depends on — idempotency, force, the acceptance invariant.
 */

import { describe, expect, test } from "bun:test";

import {
	applyUnitTransition,
	checkUnitTransition,
	isAcceptanceBinding,
	isTerminalUnitStatus,
	isUnitStatus,
	UNIT_TRANSITIONS,
} from "../../src/task-control/state-machine";
import { TERMINAL_UNIT_STATUSES, UNIT_STATUSES, type UnitStatus } from "../../src/task-control/types";
import { AT, unitFixture, violationOf } from "./fixtures";

/** §4's table, with the idempotent self-loop removed (that is asserted separately). */
const LEGAL_CHANGES: Record<UnitStatus, readonly UnitStatus[]> = {
	assembled: ["started", "blocked", "failed"],
	started: ["running", "blocked", "reviewing", "failed"],
	running: ["blocked", "reviewing", "complete", "failed"],
	blocked: ["started", "running", "reviewing", "complete", "failed"],
	reviewing: ["running", "complete", "failed"],
	complete: [],
	failed: [],
};

describe("the transition matrix", () => {
	test("matches the contract's matrix, row for row (§4)", () => {
		for (const from of UNIT_STATUSES) {
			expect(UNIT_TRANSITIONS[from].filter(to => to !== from).sort()).toEqual([...LEGAL_CHANGES[from]].sort());
		}
	});

	test("is idempotent for all seven states", () => {
		for (const from of UNIT_STATUSES) {
			expect(UNIT_TRANSITIONS[from]).toContain(from);
			expect(checkUnitTransition("u1", from, from)).toBeNull();
		}
	});

	test("agrees with itself for every ordered pair", () => {
		for (const from of UNIT_STATUSES) {
			for (const to of UNIT_STATUSES) {
				const legal = UNIT_TRANSITIONS[from].includes(to);
				expect(checkUnitTransition("u1", from, to) === null).toBe(legal);
			}
		}
	});

	test("declares the same status at most once per row", () => {
		for (const from of UNIT_STATUSES) {
			expect(new Set(UNIT_TRANSITIONS[from]).size).toBe(UNIT_TRANSITIONS[from].length);
		}
	});

	test("treats complete and failed as the terminal set, and nothing else", () => {
		const terminal = new Set<string>(TERMINAL_UNIT_STATUSES);
		for (const status of UNIT_STATUSES) {
			const onlySelf = UNIT_TRANSITIONS[status].length === 1 && UNIT_TRANSITIONS[status][0] === status;
			expect(onlySelf).toBe(terminal.has(status));
			expect(isTerminalUnitStatus(status)).toBe(onlySelf);
		}
	});
});

describe("refusals", () => {
	test("never lets a gate-hopping status skip the GO ledger", () => {
		expect(checkUnitTransition("u1", "assembled", "complete")).toEqual({
			rule: "unit.transition-illegal",
			subject: "u1",
			message: "illegal unit transition assembled → complete",
		});
		expect(checkUnitTransition("u1", "started", "complete")?.rule).toBe("unit.transition-illegal");
	});

	test("never moves a unit back to assembled", () => {
		const backwards: UnitStatus[] = ["started", "running", "blocked", "reviewing", "complete", "failed"];
		for (const from of backwards) {
			expect(checkUnitTransition("u1", from, "assembled")?.rule).toBe("unit.transition-illegal");
		}
	});

	test("keeps terminal units terminal", () => {
		for (const terminal of TERMINAL_UNIT_STATUSES) {
			for (const to of UNIT_STATUSES) {
				if (to === terminal) continue;
				expect(checkUnitTransition("u1", terminal, to)?.rule).toBe("unit.transition-illegal");
			}
		}
	});

	test("reports an unknown status by vocabulary, not as a transition", () => {
		expect(checkUnitTransition("u1", "running", "finished" as UnitStatus)).toEqual({
			rule: "unit.status-unknown",
			subject: "u1",
			message:
				'"finished" is not a unit status (to); expected one of assembled | started | running | blocked | reviewing | complete | failed',
		});
		expect(checkUnitTransition("u1", "unknown" as UnitStatus, "running")?.rule).toBe("unit.status-unknown");
	});
});

describe("applying a write", () => {
	test("returns a new record and leaves the input untouched", () => {
		const before = unitFixture("u1", "running");
		const after = applyUnitTransition(before, "reviewing", { now: AT + 5 });
		expect(after.status).toBe("reviewing");
		expect(after.updatedAt).toBe(AT + 5);
		expect(before.status).toBe("running");
		expect(before.updatedAt).toBe(AT);
		expect(after).not.toBe(before);
	});

	test("keeps the note when none is supplied, and overwrites it when one is (§2)", () => {
		const withNote = unitFixture("u1", "running", [], { note: "blocked on the provider" });
		expect(applyUnitTransition(withNote, "reviewing", { now: AT + 1 }).note).toBe("blocked on the provider");
		expect(applyUnitTransition(withNote, "reviewing", { now: AT + 1, note: "done" }).note).toBe("done");
	});

	test("refuses an illegal transition, and records a same-status write as legal", () => {
		expect(violationOf(() => applyUnitTransition(unitFixture("u1", "assembled"), "running"))).toEqual({
			rule: "unit.transition-illegal",
			subject: "u1",
			message: "illegal unit transition assembled → running",
		});
		const repeated = applyUnitTransition(unitFixture("u1", "running"), "running", { now: AT + 9 });
		expect(repeated.status).toBe("running");
		expect(repeated.updatedAt).toBe(AT + 9);
	});
});

describe("force", () => {
	test("records a GO the ledger never saw, skipping the transition check only (§4)", () => {
		const forced = applyUnitTransition(unitFixture("u1", "assembled"), "running", { force: true, now: AT + 2 });
		expect(forced.status).toBe("running");
	});

	test("still refuses a status outside the vocabulary", () => {
		expect(
			violationOf(() => applyUnitTransition(unitFixture("u1", "assembled"), "done" as UnitStatus, { force: true }))
				.rule,
		).toBe("unit.status-unknown");
	});

	test("still refuses complete without a binding — that invariant is not a transition rule (§6)", () => {
		expect(
			violationOf(() => applyUnitTransition(unitFixture("u1", "reviewing"), "complete", { force: true })),
		).toEqual({
			rule: "unit.acceptance-missing",
			subject: "u1",
			message: 'unit "u1" cannot become complete without an acceptance binding (§6)',
		});
	});
});

describe("the acceptance binding (§6)", () => {
	const verifiedOn = { verifiedCommit: "9f2c1ab", pinnedBranch: "squad/t11", verifiedAt: AT };

	test("complete and its binding are written together", () => {
		const accepted = applyUnitTransition(unitFixture("u1", "reviewing"), "complete", {
			acceptance: verifiedOn,
			now: AT + 3,
		});
		expect(accepted.status).toBe("complete");
		expect(accepted.acceptance).toEqual(verifiedOn);
	});

	test("refuses an empty binding: it would verify nothing", () => {
		expect(
			violationOf(() => applyUnitTransition(unitFixture("u1", "reviewing"), "complete", { acceptance: {} })).rule,
		).toBe("unit.acceptance-missing");
	});

	test("refuses to move an acceptance onto a different binding without an explicit re-accept", () => {
		const accepted = unitFixture("u1", "complete", [], { acceptance: verifiedOn });
		expect(
			violationOf(() => applyUnitTransition(accepted, "complete", { acceptance: { verifiedCommit: "deadbeef" } }))
				.rule,
		).toBe("unit.acceptance-rebind");
	});

	test("allows a re-accept when it is explicit", () => {
		const accepted = unitFixture("u1", "complete", [], { acceptance: verifiedOn });
		const moved = applyUnitTransition(accepted, "complete", {
			acceptance: { verifiedCommit: "deadbeef" },
			reaccept: true,
		});
		expect(moved.acceptance).toEqual({ verifiedCommit: "deadbeef" });
	});

	test("treats the same binding written twice as the same binding, whatever the key order", () => {
		const accepted = unitFixture("u1", "complete", [], { acceptance: verifiedOn });
		const rewritten = applyUnitTransition(accepted, "complete", {
			acceptance: { verifiedAt: AT, pinnedBranch: "squad/t11", verifiedCommit: "9f2c1ab" },
		});
		expect(rewritten.status).toBe("complete");
	});

	test("refuses to accept a failed unit: failed is terminal, not a review outcome (§3)", () => {
		expect(
			violationOf(() => applyUnitTransition(unitFixture("u1", "failed"), "complete", { acceptance: verifiedOn }))
				.rule,
		).toBe("unit.transition-illegal");
	});
});

describe("guards used at the JSON boundary", () => {
	test("isUnitStatus accepts exactly the vocabulary", () => {
		for (const status of UNIT_STATUSES) expect(isUnitStatus(status)).toBe(true);
		for (const value of ["", "Complete", "done", 1, null, undefined, {}]) expect(isUnitStatus(value)).toBe(false);
	});

	test("isAcceptanceBinding requires a non-empty object, not an array", () => {
		expect(isAcceptanceBinding({ verifiedCommit: "9f2c1ab" })).toBe(true);
		for (const value of [{}, [], "9f2c1ab", null, undefined, 7]) expect(isAcceptanceBinding(value)).toBe(false);
	});
});
