/**
 * Fixtures shared by the `task-control` kernel tests.
 *
 * A test file that asserts on rule names needs the rule the write refused with, and a test
 * that builds records needs records — both are written once here rather than re-derived per
 * file, so a change to the record shape has one place to land in the tests.
 *
 * Not a test file: `bun test <dir>` only picks up `*.test.ts`.
 */

import {
	type OrchestrationRecord,
	type OrchestrationViolation,
	OrchestrationViolationError,
	type UnitRecord,
	type UnitStatus,
} from "../../src/task-control/types";

/** A fixed clock. Nothing in the kernel reads a clock it cannot be handed. */
export const AT = 1_700_000_000_000;

export function unitFixture(
	id: string,
	status: UnitStatus,
	deps: readonly string[] = [],
	overrides: Partial<UnitRecord> = {},
): UnitRecord {
	return { id, deps: deps.slice(), status, updatedAt: AT, ...overrides };
}

export function recordFixture(units: readonly UnitRecord[], maxConcurrency?: number): OrchestrationRecord {
	return {
		id: "record-1",
		units,
		updatedAt: AT,
		...(maxConcurrency === undefined ? {} : { maxConcurrency }),
	};
}

/**
 * Run a write that must refuse and hand back the violation it refused with.
 *
 * Asserting on the rule (not just "it threw") is the point: a caller distinguishes "illegal
 * transition" from "result not ready", so the test has to as well.
 */
export function violationOf(run: () => unknown): OrchestrationViolation {
	try {
		run();
	} catch (err) {
		return asViolation(err);
	}
	throw new Error("expected an OrchestrationViolationError, but nothing was thrown");
}

/** The same, for the store's async boundary — a refusal that only shows up after an await must be asserted too. */
export async function violationOfAsync(run: () => Promise<unknown>): Promise<OrchestrationViolation> {
	try {
		await run();
	} catch (err) {
		return asViolation(err);
	}
	throw new Error("expected an OrchestrationViolationError, but nothing was thrown");
}

function asViolation(err: unknown): OrchestrationViolation {
	if (err instanceof OrchestrationViolationError) return err.violation;
	throw err;
}
