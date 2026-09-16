/**
 * The Main Worker — the orchestrator role over one record.
 *
 * Contract: `docs/proma-comparison/orchestration-record-contract.md`
 *   §5.1 the plan and what the orchestrator does with it, §5.2 the slot rules,
 *   §5.3 crash safety (idempotent GO, send-then-record, re-running the same pure
 *   function after an interruption), §6 the acceptance binding,
 *   §7 the boundary this module must not cross.
 * Role definition: `docs/agent-task-control-plane-v1-implementation.md` §8 (manual dispatch
 * and the Worker protocol), §9 (the Main Worker owns child acceptance; verification supplies
 * evidence).
 *
 * Two boundaries this file holds, both from §1:
 *
 *   1. **No runtime.** Nothing here starts a process, queues work, or opens a channel. A
 *      function either computes the *plan* (what the orchestrator should send) or records
 *      what already happened into the ledger. Sending the verb is the adapter's job, through
 *      the existing message channel.
 *   2. **No second state machine.** The Main Worker has no status field: `mainWorkerStatus`
 *      *derives* one from the plan, so it cannot disagree with the units it supervises.
 *
 * Every mutation is a pure `(ledger) → ledger` step, so recovery is: `store.load()`, then
 * `reconcile(ledger.record)` again. Nothing is kept in memory between rounds, which is why
 * "the parent process restarted" needs no special case — it is just the next round.
 */

import { buildDependencyGraph, type DependencyGraphAgent, detectCycles } from "../task/dag";
import {
	type EventWriteContext,
	nextSequence,
	type OrchestrationEvent,
	type OrchestrationEventBody,
	orchestrationEvent,
} from "./events";
import { applyUnitTransition, isUnitStatus, type UnitWriteOptions } from "./state-machine";
import { ORCHESTRATION_LEDGER_VERSION, type OrchestrationLedger } from "./store";
import {
	type AcceptanceBinding,
	type InFlightUnit,
	type MainWorkerStatus,
	type OrchestrationAction,
	type OrchestrationRecord,
	type OrchestrationViolation,
	OrchestrationViolationError,
	type ReconcilePlan,
	SLOT_HOLDING_UNIT_STATUSES,
	type TerminalUnit,
	type UnitRecord,
	type UnitStatus,
	type UnrunnableUnit,
	type WaitingOnDeps,
} from "./types";

/**
 * Slots in force when neither the caller nor the record says otherwise (§5.2).
 *
 * Default 3 is resource protection, not a preference: N isolated workspaces building at
 * once contend for CPU and disk, and several concurrent runs against one provider hit its
 * rate limit.
 */
export const DEFAULT_MAX_CONCURRENCY = 3;

/** Slot-holding statuses as a set: membership is a lookup, and it needs no cast to ask. */
const SLOT_HOLDERS = new Set<UnitStatus>(SLOT_HOLDING_UNIT_STATUSES);

/** What a caller hands in to assemble a record. */
export interface UnitDraft {
	readonly id: string;
	/** Contractual dependencies only — see {@link UnitRecord.deps}. */
	readonly deps?: readonly string[];
	/** Defaults to `assembled`: a unit exists at the gate before anything has confirmed its readiness check. */
	readonly status?: UnitStatus;
}

export interface CreateLedgerInput {
	readonly recordId: string;
	readonly units: readonly UnitDraft[];
	readonly maxConcurrency?: number;
	/** Who is writing. Required: provenance is recorded, never inferred. */
	readonly actor: string;
	readonly now?: number;
}

/** Every mutation names its actor; `now` is injectable so staleness logic is testable without a clock. */
export interface WriteOptions {
	readonly actor: string;
	readonly now?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembling a ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the ledger for one record: the units as they stand at the gate, plus the creation
 * event. Illegal records are refused here rather than discovered at schedule time (§2: the
 * producer rejects a bad record; the scheduler must never wait forever on one).
 */
export function createLedger(input: CreateLedgerInput): OrchestrationLedger {
	const now = input.now ?? Date.now();
	const units: UnitRecord[] = input.units.map(draft => ({
		id: draft.id,
		deps: draft.deps === undefined ? [] : draft.deps.slice(),
		status: draft.status ?? "assembled",
		updatedAt: now,
	}));
	const record: OrchestrationRecord = {
		id: input.recordId,
		units,
		updatedAt: now,
		...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
	};

	const violations = validateRecord(record);
	if (violations.length > 0) throw new OrchestrationViolationError(violations[0]);

	const body: OrchestrationEventBody = {
		type: "record.created",
		payload: { unitIds: units.map(unit => unit.id), maxConcurrency: resolveMaxConcurrency(record, undefined) },
	};
	return {
		version: ORCHESTRATION_LEDGER_VERSION,
		record,
		events: [orchestrationEvent({ recordId: record.id, actor: input.actor, at: now, sequence: 1 }, body)],
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Record legality
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the kernel can say is wrong with a record.
 *
 * Dependency legality is judged **by the existing DAG primitives** (`../task/dag`), not by a
 * second traversal here: one graph implementation, one answer to "is this acyclic". The
 * graph is built with `chainByOrder: false` on purpose — array order decides who gets a free
 * slot (§5.1), it must never invent a dependency the record did not declare.
 */
export function validateRecord(record: OrchestrationRecord): OrchestrationViolation[] {
	const violations: OrchestrationViolation[] = [];
	const ids = new Set<string>();
	for (const unit of record.units) {
		if (ids.has(unit.id)) {
			violations.push({
				rule: "record.unit-id-duplicated",
				subject: unit.id,
				message: `unit id "${unit.id}" is declared twice in record "${record.id}"`,
			});
		}
		ids.add(unit.id);
		if (!isUnitStatus(unit.status)) {
			violations.push({
				rule: "unit.status-unknown",
				subject: unit.id,
				message: `unit "${unit.id}" has status "${String(unit.status)}"`,
			});
		}
	}

	for (const unit of record.units) {
		for (const dep of unit.deps) {
			if (dep === unit.id) {
				violations.push({
					rule: "record.dependency-self",
					subject: unit.id,
					message: `unit "${unit.id}" depends on itself`,
				});
				continue;
			}
			if (!ids.has(dep)) {
				violations.push({
					rule: "record.dependency-unknown",
					subject: unit.id,
					message: `unit "${unit.id}" depends on "${dep}", which is not in record "${record.id}"`,
				});
			}
		}
	}

	// A duplicate id collapses in the graph, so cycles are only meaningful once ids are unique.
	if (!violations.some(violation => violation.rule === "record.unit-id-duplicated")) {
		const cycle = detectCycles(dependencyGraph(record));
		if (cycle) {
			violations.push({
				rule: "record.dependency-cycle",
				subject: record.id,
				message:
					`record "${record.id}" has a dependency cycle; the ids reported are the ones that could not be ` +
					`ordered ([${cycle.join(", ")}]), which includes every unit waiting on the cycle — none of them ` +
					`can ever become runnable`,
			});
		}
	}

	return violations;
}

function dependencyGraph(record: OrchestrationRecord): Map<string, Set<string>> {
	const nodes = new Map<string, DependencyGraphAgent>();
	for (const unit of record.units) {
		// Self-edges are dropped here: a self-reference is its own rule (`record.dependency-self`) with a
		// better message, and leaving it in the graph would report the same defect twice as a "cycle".
		nodes.set(unit.id, { name: unit.id, waitsFor: unit.deps.filter(dep => dep !== unit.id), reportsTo: [] });
	}
	return buildDependencyGraph(nodes, { agentOrder: record.units.map(unit => unit.id), chainByOrder: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan (§5)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileOptions {
	/** Explicit argument wins over the record's own cap, which wins over the default (§5.2). */
	readonly maxConcurrency?: number;
}

/**
 * The only source of scheduling truth (§5): a pure function of the record.
 *
 * Running it twice without a write in between yields the same plan, and running it after a
 * crash yields the plan the crash interrupted — that is the whole recovery mechanism.
 *
 * Refuses to plan an illegal record: a plan derived from a cycle would be a schedule that
 * can never run, presented as if it could.
 */
export function reconcile(record: OrchestrationRecord, options: ReconcileOptions = {}): ReconcilePlan {
	const violations = validateRecord(record);
	if (violations.length > 0) throw new OrchestrationViolationError(violations[0]);

	const maxConcurrency = resolveMaxConcurrency(record, options.maxConcurrency);
	const statusOf = new Map<string, UnitStatus>(record.units.map(unit => [unit.id, unit.status]));
	const holders = record.units.filter(unit => SLOT_HOLDERS.has(unit.status)).length;
	let freeSlots = Math.max(0, maxConcurrency - holders);

	const needConfirm: string[] = [];
	const needGo: string[] = [];
	const waitingDeps: WaitingOnDeps[] = [];
	const waitingConcurrency: string[] = [];
	const unrunnable: UnrunnableUnit[] = [];
	const inFlight: InFlightUnit[] = [];
	const blocked: string[] = [];
	const terminal: TerminalUnit[] = [];

	// Array order is the queue: whoever is earlier gets the free slot (§5.1).
	for (const unit of record.units) {
		switch (unit.status) {
			case "assembled":
				needConfirm.push(unit.id);
				break;
			case "blocked":
				blocked.push(unit.id);
				break;
			case "running":
			case "reviewing":
				inFlight.push({ id: unit.id, status: unit.status });
				break;
			case "complete":
			case "failed":
				terminal.push({ id: unit.id, status: unit.status });
				break;
			case "started": {
				const failedDeps = unit.deps.filter(dep => statusOf.get(dep) === "failed");
				if (failedDeps.length > 0) {
					// No GO can unblock this: the contract it was built against is gone.
					unrunnable.push({ id: unit.id, failedDeps });
					break;
				}
				const blockedBy = unit.deps.filter(dep => statusOf.get(dep) !== "complete");
				if (blockedBy.length > 0) {
					waitingDeps.push({ id: unit.id, blockedBy });
					break;
				}
				if (freeSlots > 0) {
					// A GO this round means a unit about to hold a slot, so it is taken now.
					needGo.push(unit.id);
					freeSlots -= 1;
					break;
				}
				waitingConcurrency.push(unit.id);
				break;
			}
		}
	}

	return {
		maxConcurrency,
		freeSlots,
		needConfirm,
		needGo,
		waitingDeps,
		waitingConcurrency,
		unrunnable,
		inFlight,
		blocked,
		terminal,
	};
}

function resolveMaxConcurrency(record: OrchestrationRecord, explicit: number | undefined): number {
	const declared = explicit ?? record.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	if (!Number.isInteger(declared) || declared < 1) {
		throw new OrchestrationViolationError({
			rule: "record.ledger-rejected",
			subject: record.id,
			message: `maxConcurrency ${String(declared)} leaves no schedulable slot; expected an integer of at least 1`,
		});
	}
	return declared;
}

/** Every unit appears in exactly one bucket — the plan is a partition, which is what makes it complete. */
export function planUnitCount(plan: ReconcilePlan): number {
	return (
		plan.needConfirm.length +
		plan.needGo.length +
		plan.waitingDeps.length +
		plan.waitingConcurrency.length +
		plan.unrunnable.length +
		plan.inFlight.length +
		plan.blocked.length +
		plan.terminal.length
	);
}

/**
 * The verbs to emit this round, in the order §5.1 lists them.
 *
 * `go` is the one that must be **sent before it is recorded**: the caller sends, then calls
 * {@link recordGoSent}. Crashing between the two is safe — the next `reconcile` still says
 * `needGo` and the re-send is idempotent (§5.3). The reverse order would leave a `running`
 * unit nothing ever started.
 */
export function planActions(plan: ReconcilePlan): readonly OrchestrationAction[] {
	const actions: OrchestrationAction[] = [];
	for (const unitId of plan.needConfirm) actions.push({ kind: "confirm", unitId });
	for (const unitId of plan.needGo) actions.push({ kind: "go", unitId });
	for (const waiting of plan.waitingDeps) {
		actions.push({ kind: "wait", unitId: waiting.id, reason: "deps", blockedBy: waiting.blockedBy });
	}
	for (const unitId of plan.waitingConcurrency) actions.push({ kind: "wait", unitId, reason: "concurrency" });
	for (const unit of plan.unrunnable) {
		actions.push({ kind: "escalate", unitId: unit.id, failedDeps: unit.failedDeps });
	}
	for (const unit of plan.inFlight) {
		actions.push(
			unit.status === "reviewing"
				? { kind: "verify", unitId: unit.id }
				: { kind: "none", unitId: unit.id, disposition: "inFlight" },
		);
	}
	for (const unitId of plan.blocked) actions.push({ kind: "none", unitId, disposition: "blocked" });
	for (const unit of plan.terminal) actions.push({ kind: "none", unitId: unit.id, disposition: "terminal" });
	return actions;
}

/**
 * What the orchestrator is doing, read off the plan — a derivation, never a stored status.
 *
 * | condition                                   | status             |
 * |---------------------------------------------|--------------------|
 * | no units at all                             | `decomposing`      |
 * | anything unrunnable or blocked              | `waiting_user`     |
 * | verbs to send (confirm / GO)                | `dispatching`      |
 * | something in flight (or being verified)     | `supervising`      |
 * | every unit terminal, ≥1 accepted            | `package_accepted` |
 * | every unit terminal, none accepted          | `failed`           |
 * | otherwise (only waitingDeps/concurrency)    | `supervising`      |
 */
export function mainWorkerStatus(plan: ReconcilePlan): MainWorkerStatus {
	if (planUnitCount(plan) === 0) return "decomposing";
	if (plan.unrunnable.length > 0 || plan.blocked.length > 0) return "waiting_user";
	if (plan.needGo.length > 0 || plan.needConfirm.length > 0) return "dispatching";
	if (plan.inFlight.length > 0) return "supervising";
	if (plan.terminal.length === planUnitCount(plan)) {
		return plan.terminal.some(unit => unit.status === "complete") ? "package_accepted" : "failed";
	}
	return "supervising";
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording what the orchestrator did (or was told)
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordConfirmationOptions extends WriteOptions {
	readonly note?: string;
	readonly force?: boolean;
}

/**
 * The readiness check passed (`assembled → started`): the unit is at the gate, burning no
 * model quota (§5.2 — it must not hold a slot).
 */
export function recordConfirmation(
	ledger: OrchestrationLedger,
	unitIds: readonly string[],
	options: RecordConfirmationOptions,
): OrchestrationLedger {
	const at = options.now ?? Date.now();
	return writeUnits(ledger, { actor: options.actor, at }, unitIds, unitId => {
		const unit = requireUnit(ledger, unitId);
		const next = applyUnitTransition(unit, "started", { ...transitionOptions(options), now: at });
		return {
			unit: next,
			body: {
				type: "unit.transitioned",
				payload: {
					from: unit.status,
					to: next.status,
					forced: options.force === true,
					...(options.note === undefined ? {} : { note: options.note }),
				},
			},
		};
	});
}

export interface RecordGoOptions extends WriteOptions {
	readonly note?: string;
	readonly force?: boolean;
}

/**
 * GO was sent (`started → running`) — called **after** the message went out (§5.3).
 *
 * Refuses a unit whose dependencies are not all `complete`: the plan only ever issues GO
 * when they are, so a GO recorded against unsatisfied dependencies means the caller is not
 * following the plan, and writing `running` would hide that.
 */
export function recordGoSent(
	ledger: OrchestrationLedger,
	unitIds: readonly string[],
	options: RecordGoOptions,
): OrchestrationLedger {
	const at = options.now ?? Date.now();
	const statusOf = new Map<string, UnitStatus>(ledger.record.units.map(unit => [unit.id, unit.status]));
	return writeUnits(ledger, { actor: options.actor, at }, unitIds, unitId => {
		const unit = requireUnit(ledger, unitId);
		const blockedBy = unit.deps.filter(dep => statusOf.get(dep) !== "complete");
		if (blockedBy.length > 0) {
			throw new OrchestrationViolationError({
				rule: "unit.dependencies-unsatisfied",
				subject: unitId,
				message: `unit "${unitId}" cannot start: dependencies [${blockedBy.join(", ")}] are not complete`,
			});
		}
		const next = applyUnitTransition(unit, "running", { ...transitionOptions(options), now: at });
		return {
			unit: next,
			body: {
				type: "unit.transitioned",
				payload: {
					from: unit.status,
					to: next.status,
					forced: options.force === true,
					...(options.note === undefined ? {} : { note: options.note }),
				},
			},
		};
	});
}

export interface RecordStatusOptions extends WriteOptions, UnitWriteOptions {}

/**
 * Any other status the orchestrator was told about: a unit reporting a blocker, dying,
 * being cancelled, or coming back from `blocked`. The transition table in
 * `./state-machine` is what decides whether the write is legal — including that
 * `complete` cannot be reached without an acceptance binding, which this path does not
 * bypass either.
 */
export function recordStatus(
	ledger: OrchestrationLedger,
	unitId: string,
	to: UnitStatus,
	options: RecordStatusOptions,
): OrchestrationLedger {
	const at = options.now ?? Date.now();
	return writeUnits(ledger, { actor: options.actor, at }, [unitId], id => {
		const unit = requireUnit(ledger, id);
		const next = applyUnitTransition(unit, to, { ...transitionOptions(options), now: at });
		return {
			unit: next,
			body: {
				type: "unit.transitioned",
				payload: {
					from: unit.status,
					to: next.status,
					forced: options.force === true,
					...(options.note === undefined ? {} : { note: options.note }),
				},
			},
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance (§6) and rework
// ─────────────────────────────────────────────────────────────────────────────

export interface AcceptUnitOptions extends WriteOptions {
	/** What the delivery was verified on. Required: `complete` and its binding are written together. */
	readonly acceptance: AcceptanceBinding;
	/** Explicit re-acceptance onto a new binding — the only way an accepted unit's binding may move. */
	readonly reaccept?: boolean;
	readonly note?: string;
}

/**
 * The acceptance decision — the only way into `complete` (§3, §6).
 *
 * A unit reporting `COMPLETE` lands in `reviewing`; this function is what turns that into an
 * accepted delivery, and it writes the binding in the same commit, so "accepted but not
 * bound" is not a state the ledger can hold.
 */
export function acceptUnit(
	ledger: OrchestrationLedger,
	unitId: string,
	options: AcceptUnitOptions,
): OrchestrationLedger {
	const at = options.now ?? Date.now();
	return writeUnits(ledger, { actor: options.actor, at }, [unitId], id => {
		const unit = requireUnit(ledger, id);
		const next = applyUnitTransition(unit, "complete", {
			acceptance: options.acceptance,
			reaccept: options.reaccept === true,
			...(options.note === undefined ? {} : { note: options.note }),
			now: at,
		});
		return {
			unit: next,
			body: {
				type: "unit.accepted",
				payload: {
					from: unit.status,
					to: "complete",
					acceptance: options.acceptance,
					reaccept: options.reaccept === true,
				},
			},
		};
	});
}

export interface ReworkUnitOptions extends WriteOptions {
	/** Why it was rejected, in the reviewer's words. */
	readonly findings: readonly string[];
	/** What has to change before it comes back. */
	readonly requiredChanges: readonly string[];
}

/**
 * Reject a submitted delivery: `reviewing → running`, with the findings that sent it back.
 *
 * The unit goes back to work rather than to a state of its own: the record's package contract
 * is not amended by a rejection (§13 of the control-plane spec). `reviewing → started` is not
 * a legal move at all — re-arming the gate after work began means nothing.
 */
export function reworkUnit(
	ledger: OrchestrationLedger,
	unitId: string,
	options: ReworkUnitOptions,
): OrchestrationLedger {
	const at = options.now ?? Date.now();
	return writeUnits(ledger, { actor: options.actor, at }, [unitId], id => {
		const unit = requireUnit(ledger, id);
		if (unit.status !== "reviewing") {
			throw new OrchestrationViolationError({
				rule: "unit.transition-illegal",
				subject: id,
				message: `unit "${id}" is ${unit.status}; only a unit awaiting review can be sent back to work`,
			});
		}
		if (options.findings.length === 0 && options.requiredChanges.length === 0) {
			throw new OrchestrationViolationError({
				rule: "unit.rework-unsubstantiated",
				subject: id,
				message: `reworking unit "${id}" needs at least one finding or required change; a rejection that says nothing cannot be acted on`,
			});
		}
		const next = applyUnitTransition(unit, "running", {
			note: `rework: ${[...options.findings, ...options.requiredChanges].join(" | ")}`,
			now: at,
		});
		return {
			unit: next,
			body: {
				type: "unit.reworked",
				payload: {
					from: "reviewing",
					to: "running",
					findings: options.findings.slice(),
					requiredChanges: options.requiredChanges.slice(),
				},
			},
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// The two result facts
// ─────────────────────────────────────────────────────────────────────────────

export interface MarkResultReadyOptions extends WriteOptions {
	/** What the unit produced — an artifact or record reference. */
	readonly ref: string;
}

/**
 * The unit produced a result. Independent of {@link bringBackResult}: "ready" says the result
 * exists, "brought back" says somebody took it.
 *
 * Re-reporting the **same** ref is a no-op — no event, no `updatedAt` bump — because the fact
 * is already in the ledger and a fresh timestamp would make staleness detection lie. A
 * *different* ref is refused: a unit has one result, and re-pointing it would leave an earlier
 * acceptance describing content that is no longer the result.
 */
export function markResultReady(
	ledger: OrchestrationLedger,
	unitId: string,
	options: MarkResultReadyOptions,
): OrchestrationLedger {
	const at = options.now ?? Date.now();
	return writeUnits(ledger, { actor: options.actor, at }, [unitId], id => {
		const unit = requireUnit(ledger, id);
		if (unit.result) {
			if (unit.result.ref !== options.ref) {
				throw new OrchestrationViolationError({
					rule: "unit.result-conflict",
					subject: id,
					message: `unit "${id}" already has result "${unit.result.ref}"; it cannot be re-pointed at "${options.ref}"`,
				});
			}
			return null;
		}
		return {
			unit: { ...unit, updatedAt: at, result: { ref: options.ref, readyAt: at } },
			body: { type: "unit.result-ready", payload: { ref: options.ref } },
		};
	});
}

/** What {@link bringBackResult} reports: the ledger, and whether this call is the one that took the result. */
export interface BringBackOutcome {
	readonly ledger: OrchestrationLedger;
	/** False for a repeat: the result was already taken, and the ledger did not change. */
	readonly firstTime: boolean;
	readonly broughtBackAt: number;
}

/**
 * Take the unit's result back to the parent.
 *
 * Refuses when there is no result yet (`unit.result-not-ready`): a take without a ready
 * result would record a fact that never happened — the same refusal the session tree already
 * makes for a child session that has not produced anything.
 *
 * Bringing the same result back twice is allowed and reports `firstTime: false` with the
 * original timestamp, so a caller that injects results into its own context has a truthful
 * signal to gate on and cannot consume the same result twice.
 */
export function bringBackResult(ledger: OrchestrationLedger, unitId: string, options: WriteOptions): BringBackOutcome {
	const unit = requireUnit(ledger, unitId);
	const result = unit.result;
	if (!result) {
		throw new OrchestrationViolationError({
			rule: "unit.result-not-ready",
			subject: unitId,
			message: `unit "${unitId}" has no result yet; a result is ready before it is brought back`,
		});
	}
	if (result.broughtBackAt !== undefined) {
		return { ledger, firstTime: false, broughtBackAt: result.broughtBackAt };
	}
	const at = options.now ?? Date.now();
	const next = writeUnits(ledger, { actor: options.actor, at }, [unitId], () => ({
		unit: { ...unit, updatedAt: at, result: { ...result, broughtBackAt: at } },
		body: { type: "unit.result-brought-back", payload: { ref: result.ref, firstTime: true } },
	}));
	return { ledger: next, firstTime: true, broughtBackAt: at };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/** One unit write plus the event that records it. `null` means the builder found nothing to record. */
type UnitWrite = { readonly unit: UnitRecord; readonly body: OrchestrationEventBody } | null;

/**
 * Apply writes to units and append one event per write, returning a new ledger.
 *
 * A write whose status does not change still records — `updatedAt` moves and the event says
 * what was re-sent, which is what §4 asks for and what makes a lost GO visible in the log.
 * The builders that return `null` are the ones where the fact itself is already in the
 * ledger (re-reporting the same result reference): a second copy of an unchanged fact is not
 * a change, and a bumped `updatedAt` for one would erase the freshness signal the
 * orchestrator uses to spot a unit that has genuinely stopped moving.
 */
function writeUnits(
	ledger: OrchestrationLedger,
	write: { readonly actor: string; readonly at: number },
	unitIds: readonly string[],
	build: (unitId: string) => UnitWrite,
): OrchestrationLedger {
	const { actor, at } = write;
	const writes: { unit: UnitRecord; body: OrchestrationEventBody }[] = [];
	for (const unitId of unitIds) {
		const write = build(unitId);
		if (write) writes.push(write);
	}
	if (writes.length === 0) return ledger;

	let units = ledger.record.units;
	let sequence = nextSequence(ledger.events);
	const events: OrchestrationEvent[] = [];
	for (const write of writes) {
		units = units.map(unit => (unit.id === write.unit.id ? write.unit : unit));
		const context: EventWriteContext = {
			recordId: ledger.record.id,
			actor,
			at,
			sequence,
			unitId: write.unit.id,
		};
		events.push(orchestrationEvent(context, write.body));
		sequence += 1;
	}
	return {
		version: ledger.version,
		record: { ...ledger.record, units, updatedAt: at },
		events: [...ledger.events, ...events],
	};
}

function requireUnit(ledger: OrchestrationLedger, unitId: string): UnitRecord {
	const unit = ledger.record.units.find(candidate => candidate.id === unitId);
	if (!unit) {
		throw new OrchestrationViolationError({
			rule: "unit.unknown",
			subject: unitId,
			message: `unit "${unitId}" is not in record "${ledger.record.id}"`,
		});
	}
	return unit;
}

/** The write options that reach `./state-machine`; the clock is resolved once per call by the caller. */
function transitionOptions(options: UnitWriteOptions & { readonly force?: boolean }): UnitWriteOptions {
	return {
		...(options.note === undefined ? {} : { note: options.note }),
		...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
		...(options.reaccept === undefined ? {} : { reaccept: options.reaccept }),
		...(options.force === undefined ? {} : { force: options.force }),
	};
}
