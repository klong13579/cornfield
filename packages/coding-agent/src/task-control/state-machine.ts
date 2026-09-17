/**
 * The one state machine.
 *
 * Contract: `docs/proma-comparison/orchestration-record-contract.md` §3 (vocabulary, and
 * the message-layer ≠ orchestration-layer distinction) and §4 (transitions).
 *
 * §1 invariant 2 is the reason this file is the only place a unit's status may change: a
 * second copy of the table — in prose, in an adapter, in a strategy — is how the reference
 * implementation's vocabulary and its code drifted apart. Strategies *reference* these
 * rules; they do not restate them.
 *
 * Three properties the callers rely on, all tested in `test/task-control/state-machine.test.ts`:
 *   1. Re-setting the same status is idempotent, not an error — recovery re-records freely.
 *   2. Illegal transitions are refused, including `assembled → complete` and
 *      `started → complete` (a GO that was never recorded must not be inferred away) and
 *      any move back to `assembled`.
 *   3. `force` skips the transition check **only**. Vocabulary, unit existence and the
 *      acceptance invariant still hold (§4 and §6).
 */

import {
	type AcceptanceBinding,
	type OrchestrationViolation,
	OrchestrationViolationError,
	UNIT_STATUSES,
	type UnitRecord,
	type UnitStatus,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary guards (used at the JSON boundary too, where types do not hold)
// ─────────────────────────────────────────────────────────────────────────────

export function isUnitStatus(value: unknown): value is UnitStatus {
	return typeof value === "string" && (UNIT_STATUSES as readonly string[]).includes(value);
}

export function isTerminalUnitStatus(status: UnitStatus): status is "complete" | "failed" {
	return status === "complete" || status === "failed";
}

/**
 * The acceptance slot holds a non-empty JSON object. The kernel does not interpret any
 * field (§6) — but an *empty* binding records that nothing was verified, which is exactly
 * the "accepted without a binding" record §6 forbids.
 */
export function isAcceptanceBinding(value: unknown): value is AcceptanceBinding {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions (§4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legal moves, including the idempotent self-loop.
 *
 * Read the rows as the prose in §4, not as a convenience table:
 *   - `assembled → blocked/failed`: the readiness check itself can be the first report
 *     (missing key, unreadable package, dead process); without those edges the ledger
 *     would have nowhere to record it.
 *   - `started → reviewing`: tolerance for a lost `running` record (the unit reported
 *     done while the orchestrator never wrote the GO down).
 *   - `reviewing → running`: sending it back to work. `→ started` is refused — re-arming
 *     the gate means nothing once work began.
 *   - `complete` / `failed`: terminal rows.
 */
export const UNIT_TRANSITIONS: Record<UnitStatus, readonly UnitStatus[]> = {
	assembled: ["assembled", "started", "blocked", "failed"],
	started: ["started", "running", "blocked", "reviewing", "failed"],
	running: ["running", "blocked", "reviewing", "complete", "failed"],
	blocked: ["blocked", "started", "running", "reviewing", "complete", "failed"],
	reviewing: ["reviewing", "running", "complete", "failed"],
	complete: ["complete"],
	failed: ["failed"],
};

/**
 * Is `from → to` legal? Returns the violation instead of a boolean so the caller can
 * refuse with the same words the ledger rule uses.
 *
 * `from === to` is always legal (idempotent re-record).
 */
export function checkUnitTransition(unitId: string, from: UnitStatus, to: UnitStatus): OrchestrationViolation | null {
	for (const [label, status] of [
		["from", from],
		["to", to],
	] as const) {
		if (!isUnitStatus(status)) {
			return {
				rule: "unit.status-unknown",
				subject: unitId,
				message: `"${String(status)}" is not a unit status (${label}); expected one of ${UNIT_STATUSES.join(" | ")}`,
			};
		}
	}
	if (UNIT_TRANSITIONS[from].includes(to)) return null;
	return {
		rule: "unit.transition-illegal",
		subject: unitId,
		message: `illegal unit transition ${from} → ${to}`,
	};
}

/** Options for one unit write. `now` is injectable so recovery/staleness logic is testable without a clock. */
export interface UnitWriteOptions {
	/** Overwrites the note; absent keeps whatever the unit already carries (§2: 不设置时保留原值). */
	readonly note?: string;
	/** Required for `→ complete` unless the unit is already bound (see §6). */
	readonly acceptance?: AcceptanceBinding;
	/** Re-binding an accepted unit to a different acceptance is refused unless this is set (§6). */
	readonly reaccept?: boolean;
	/** Skip the transition table **only** — for recording a known-sent GO after an interruption. */
	readonly force?: boolean;
	/** Injectable clock; defaults to `Date.now()`. */
	readonly now?: number;
}

/**
 * Apply one write to one unit, returning a **new** record (the ledger is immutable data;
 * the caller commits the whole ledger or none of it).
 *
 * Throws {@link OrchestrationViolationError} rather than returning a flag: a caller that
 * ignored a boolean would silently write a status the domain refuses.
 */
export function applyUnitTransition(unit: UnitRecord, to: UnitStatus, options: UnitWriteOptions = {}): UnitRecord {
	const transition = checkUnitTransition(unit.id, unit.status, to);
	// The vocabulary check is not a transition rule: `force` must not admit an unknown status (§4).
	if (transition && (transition.rule === "unit.status-unknown" || !options.force)) {
		throw new OrchestrationViolationError(transition);
	}

	const now = options.now ?? Date.now();
	let acceptance = unit.acceptance;

	if (to === "complete") {
		if (options.acceptance !== undefined) {
			if (!isAcceptanceBinding(options.acceptance)) {
				throw new OrchestrationViolationError({
					rule: "unit.acceptance-missing",
					subject: unit.id,
					message: `acceptance for unit "${unit.id}" is empty; the terminal complete must say what it was verified on (§6)`,
				});
			}
			const rebound = acceptance !== undefined && bindingKey(acceptance) !== bindingKey(options.acceptance);
			if (rebound && options.reaccept !== true) {
				throw new OrchestrationViolationError({
					rule: "unit.acceptance-rebind",
					subject: unit.id,
					message:
						`unit "${unit.id}" is already accepted on a different binding; re-accepting must be ` +
						`explicit (reaccept: true) so an acceptance is never silently moved onto unverified content (§6)`,
				});
			}
			acceptance = options.acceptance;
		}
		// §6 invariant: there is no "accepted but unbound" record — this holds even for a forced write.
		if (acceptance === undefined || !isAcceptanceBinding(acceptance)) {
			throw new OrchestrationViolationError({
				rule: "unit.acceptance-missing",
				subject: unit.id,
				message: `unit "${unit.id}" cannot become complete without an acceptance binding (§6)`,
			});
		}
	}

	const next: UnitRecord = {
		...unit,
		status: to,
		updatedAt: now,
		...(acceptance === undefined ? {} : { acceptance }),
		...(options.note === undefined ? {} : { note: options.note }),
	};
	return next;
}

/**
 * A stable key for an acceptance binding: key order must not turn "the same binding
 * written twice" into a re-bind that requires `reaccept`.
 */
function bindingKey(binding: AcceptanceBinding): string {
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(binding).sort()) sorted[key] = binding[key];
	return JSON.stringify(sorted);
}
