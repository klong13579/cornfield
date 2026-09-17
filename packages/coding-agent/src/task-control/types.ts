/**
 * Orchestration Record — the strategy-free kernel vocabulary.
 *
 * Contract: `docs/proma-comparison/orchestration-record-contract.md`
 *   §1 scope + the three hard invariants, §2 unit fields, §3 status vocabulary,
 *   §4 transition table, §5.1 reconcile plan, §6 acceptance binding.
 * Module boundary (the file names this kernel is allowed to have):
 *   `docs/agent-task-control-plane-v1-implementation.md` §2.
 *
 * What this module is: the vocabulary — a unit, a record, the two facts a unit's
 * result has, the plan the orchestrator computes, and the violations the kernel can
 * report. Nothing else.
 *
 * What it deliberately is NOT:
 *   - No scheduler, no queue, no process, no second message channel (§1 invariant 1).
 *     A record is *data*; the orchestrator computes a plan and the existing message
 *     channel carries the verbs.
 *   - No second status machine (§1 invariant 2). `UnitStatus` is the only lifecycle a
 *     unit has; the Main Worker's own progress is *derived* from the plan
 *     (`./main-worker`), never a persisted second state.
 *   - No strategy vocabulary (§7): `worktree`, `branch`, `git`, model tiers and gate
 *     commands are payloads of one strategy. The kernel never names them — see
 *     `test/task-control/kernel-boundary.test.ts`.
 *   - No second home for a fact: a strategy keeps its own fields in its own file and
 *     projects units into this record. The kernel does not grow an open
 *     `Record<string, unknown>` bag for them, because then it could no longer say what
 *     an Orchestration Record is.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Status vocabulary (§3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seven unit states, in lifecycle order. This array is the **only** definition of
 * the vocabulary; `UnitStatus` is derived from it so the two cannot drift.
 */
export const UNIT_STATUSES = ["assembled", "started", "running", "blocked", "reviewing", "complete", "failed"] as const;

export type UnitStatus = (typeof UNIT_STATUSES)[number];

/**
 * States a unit never leaves. `complete` means *accepted* (§3: a unit reporting
 * `COMPLETE` lands in `reviewing`, never here) and only the acceptance decision writes
 * it (§6).
 */
export const TERMINAL_UNIT_STATUSES = ["complete", "failed"] as const;

export type TerminalUnitStatus = (typeof TERMINAL_UNIT_STATUSES)[number];

/** States that occupy a concurrency slot (§5.2). `assembled`/`started` must not: they wait at the gate. */
export const SLOT_HOLDING_UNIT_STATUSES = ["running", "reviewing", "blocked"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Unit (§2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The acceptance binding — *where* a unit's delivery was verified.
 *
 * The kernel owns the **slot**, not its shape (§6): it requires that the acceptance
 * action writes a binding in the same commit as the terminal `complete`, and never
 * interprets a field. A strategy (code delivery, for example) declares its own labeled
 * interface `{ verifiedCommit, pinnedBranch, verifiedAt }`, which is structurally
 * assignable to this type — so the strategy keeps its field names and the kernel keeps
 * its independence from them.
 */
export type AcceptanceBinding = Readonly<Record<string, unknown>>;

/**
 * The two facts a unit's result has, kept apart on purpose.
 *
 * `resultRef`/`readyAt` means *the unit produced a result*; `broughtBackAt` means *a
 * parent has taken it back*. They are independent: a result can be ready and never taken,
 * and a take without a ready result is a lie — the same distinction the session tree
 * already makes (`agent-domain` `SessionNode.resultRef` / `resultBroughtBackAt`,
 * rule `session.result-not-ready`).
 *
 * Collapsing them into one timestamp or one boolean would make "the result exists but
 * nobody has consumed it" unrepresentable, and a parent that injects results into its own
 * context could not tell a first bring-back from a repeat.
 */
export interface UnitResult {
	/** Reference to the result (artifact/record the unit pointed at). */
	readonly ref: string;
	/** When the result became ready. */
	readonly readyAt: number;
	/** When a parent brought it back — absent until that happens. */
	readonly broughtBackAt?: number;
}

/** One piece of orchestrated work — the unit of §2. */
export interface UnitRecord {
	/** Unique inside the record; the message dialect, `deps` and the verbs all address by it. */
	readonly id: string;
	/**
	 * Units this one depends on. Only **contractual** dependencies belong here (an interface
	 * was fixed and both sides build against it); a sequential dependency — B needs A's
	 * *output* — is not a dependency, it is one execution sequence and must be merged.
	 */
	readonly deps: readonly string[];
	readonly status: UnitStatus;
	/** Epoch ms of the last write; the freshness signal recovery reads (§2). */
	readonly updatedAt: number;
	/** Human-readable note (block reason, cancel reason, acceptance conclusion). Absent keeps the day-1 value out of the way. */
	readonly note?: string;
	/** Acceptance slot (§6); written together with the terminal `complete`, never before. */
	readonly acceptance?: AcceptanceBinding;
	/** The two result facts, kept apart — see {@link UnitResult}. */
	readonly result?: UnitResult;
}

/**
 * A record is a set of units plus a record-level concurrency cap (§1) — the ledger a
 * single orchestration is run from.
 *
 * Strategy fields (`baseBranch`, `parent`, model tiers, isolation…) live next to this
 * record in the strategy's own shape; the kernel neither reads nor stores them.
 */
export interface OrchestrationRecord {
	readonly id: string;
	/** Units in **queue order**: `deps` gates by contract, array order settles who gets a free slot (§5.1). */
	readonly units: readonly UnitRecord[];
	/** Resolved as explicit argument > this > {@link DEFAULT_MAX_CONCURRENCY} (§5.2). */
	readonly maxConcurrency?: number;
	readonly updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile plan (§5.1)
// ─────────────────────────────────────────────────────────────────────────────

/** Which disposition a unit is in this round. */
export type UnitDisposition =
	| "needConfirm"
	| "needGo"
	| "waitingDeps"
	| "waitingConcurrency"
	| "unrunnable"
	| "inFlight"
	| "blocked"
	| "terminal";

/** A unit waiting on dependencies. `blockedBy` lists the dependencies that are not `complete` — unknown ids included, they are not `complete` either. */
export interface WaitingOnDeps {
	readonly id: string;
	readonly blockedBy: readonly string[];
}

/** A unit that can never start because a dependency failed. Not schedulable — the user decides (re-split or drop). */
export interface UnrunnableUnit {
	readonly id: string;
	readonly failedDeps: readonly string[];
}

/**
 * A unit waiting for a terminal state. It holds a slot whichever of the two it is, so the
 * plan could have collapsed them — but `reviewing` means *run the gate* and `running`
 * means *wait*: an orchestrator that could not tell them apart would never verify anything.
 */
export interface InFlightUnit {
	readonly id: string;
	readonly status: "running" | "reviewing";
}

/** A unit that is done. `complete` is *accepted away from the unit's hands*; `failed` is gone (§3). */
export interface TerminalUnit {
	readonly id: string;
	readonly status: TerminalUnitStatus;
}

/**
 * The plan, and the only source of scheduling truth (§5). `reconcile` is a pure function
 * of the record, so re-running it after a process interruption recomputes the same plan
 * from the ledger instead of from memory.
 */
export interface ReconcilePlan {
	/** Effective cap in force this round. */
	readonly maxConcurrency: number;
	/** Slots left after the units that actually hold one. */
	readonly freeSlots: number;
	/** `assembled`: the readiness check has not been confirmed yet. */
	readonly needConfirm: readonly string[];
	/** `started` with every dependency `complete` and a free slot: send GO (idempotent), then record `running`. */
	readonly needGo: readonly string[];
	readonly waitingDeps: readonly WaitingOnDeps[];
	/** Dependencies satisfied but no slot free; queued by record order. */
	readonly waitingConcurrency: readonly string[];
	readonly unrunnable: readonly UnrunnableUnit[];
	/** `running` / `reviewing` — hold a slot, wait for a terminal state (or, for `reviewing`, run the gate). */
	readonly inFlight: readonly InFlightUnit[];
	/** `blocked` — holds a slot, waits for a decision. */
	readonly blocked: readonly string[];
	/** `complete` / `failed`, with the status kept (§3: Task, Run and acceptance statuses are never collapsed). */
	readonly terminal: readonly TerminalUnit[];
}

/** The verb the orchestrator must emit for one unit this round — derived from the plan, never stored. */
export type OrchestrationAction =
	/** Send the non-blocking readiness confirmation request. */
	| { readonly kind: "confirm"; readonly unitId: string }
	/** Send GO (idempotent, re-sendable), then record `running`. */
	| { readonly kind: "go"; readonly unitId: string }
	/** The unit reported done: run the gate before anything is accepted. */
	| { readonly kind: "verify"; readonly unitId: string }
	| {
			readonly kind: "wait";
			readonly unitId: string;
			readonly reason: "deps" | "concurrency";
			readonly blockedBy?: readonly string[];
	  }
	/** Not schedulable: hand it to the user (re-split or drop). */
	| { readonly kind: "escalate"; readonly unitId: string; readonly failedDeps: readonly string[] }
	| { readonly kind: "none"; readonly unitId: string; readonly disposition: UnitDisposition };

// ─────────────────────────────────────────────────────────────────────────────
// Main Worker — derived, never a second state machine (§7, agent-task-control-plane §8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the orchestrator is doing, read off the plan.
 *
 * This is a **derivation**, not a stored status: the Main Worker has no lifecycle record
 * of its own, exactly as `agent-domain` refuses to persist a Worker. A persisted second
 * status would be a second state machine that can disagree with the units it supervises
 * (§1 invariant 2).
 */
export type MainWorkerStatus =
	/** No units yet: the package has not been decomposed. */
	| "decomposing"
	/** Something needs a human decision: unrunnable units, or blocked units. */
	| "waiting_user"
	/** There are verbs to send (confirmation requests and/or GO). */
	| "dispatching"
	/** Nothing to send; units are in flight or waiting on dependencies/slots. */
	| "supervising"
	/** Every unit is terminal and at least one was accepted. */
	| "package_accepted"
	/** Every unit is terminal and none was accepted. */
	| "failed";

// ─────────────────────────────────────────────────────────────────────────────
// Violations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rules the kernel can report. Dotted, subject-first, matching `agent-domain`'s
 * `DomainViolation` shape so the two read the same way.
 */
export type OrchestrationViolationRule =
	| "unit.unknown"
	| "unit.status-unknown"
	| "unit.transition-illegal"
	| "unit.acceptance-missing"
	| "unit.acceptance-rebind"
	| "unit.dependencies-unsatisfied"
	| "unit.rework-unsubstantiated"
	| "unit.result-not-ready"
	| "unit.result-conflict"
	| "record.unit-id-duplicated"
	| "record.dependency-self"
	| "record.dependency-unknown"
	| "record.dependency-cycle"
	| "record.ledger-rejected";

/** One broken rule. `subject` names the offending object (unit id, or the record id). */
export interface OrchestrationViolation {
	readonly rule: OrchestrationViolationRule;
	readonly subject: string;
	readonly message: string;
}

/**
 * Thrown by every kernel write that refuses to happen. `callers` distinguish by
 * `violation.rule`, and each rule is a distinct fact — a caller that cannot tell "illegal
 * transition" from "result not ready" would report the wrong thing to the user.
 */
export class OrchestrationViolationError extends Error {
	readonly violation: OrchestrationViolation;

	constructor(violation: OrchestrationViolation) {
		super(violation.message);
		this.name = "OrchestrationViolationError";
		this.violation = violation;
	}
}
