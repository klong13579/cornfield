/**
 * Append-only event contracts.
 *
 * Contract: `docs/proma-comparison/orchestration-record-contract.md` §2 (the unit is what
 * events are addressed by), §4 (every status write is a validated transition), §5.3
 * (recovery reads the ledger, so the record of *what happened* must be complete enough to
 * recompute the plan).
 *
 * Two rules make the log worth keeping:
 *   1. **Append-only.** History rows are never rewritten; a correction is a new event. A
 *      mutable log cannot answer "what did the ledger believe at 14:02", which is the only
 *      question recovery ever asks.
 *   2. **One event per write, carrying the whole fact.** `unit.accepted` carries the
 *      binding it was accepted on; `unit.reworked` carries the findings that sent it back.
 *      Splitting a single decision across several events would leave windows in which the
 *      log describes a state the record never held.
 *
 * `sequence` is the append order inside one record's ledger and is assigned by the writer
 * (`nextSequence`), not by a clock: two events can share a millisecond, and "which came
 * first" must survive that.
 */

import type { AcceptanceBinding, UnitStatus } from "./types";

/** Fields every event carries. */
export interface OrchestrationEventEnvelope {
	/** Deterministic within a ledger: `${recordId}#${sequence}`. Re-deriving a ledger yields the same ids, so two ledgers can be diffed. */
	readonly id: string;
	/** Strictly increasing from 1 within the record's ledger. */
	readonly sequence: number;
	readonly recordId: string;
	/** Absent only for record-level events such as the creation event. */
	readonly unitId?: string;
	/** Who wrote it — `orchestrator`, `unit:<id>`, a human. Provenance is never inferred. */
	readonly actor: string;
	/** Epoch ms. */
	readonly at: number;
}

/** The event bodies, each carrying everything its fact is made of. */
export type OrchestrationEventBody =
	| {
			readonly type: "record.created";
			readonly payload: { readonly unitIds: readonly string[]; readonly maxConcurrency: number };
	  }
	| {
			readonly type: "unit.transitioned";
			readonly payload: {
				readonly from: UnitStatus;
				readonly to: UnitStatus;
				/** True when the transition table was skipped to record a known-sent GO (§4). */
				readonly forced: boolean;
				readonly note?: string;
			};
	  }
	| {
			readonly type: "unit.accepted";
			readonly payload: {
				readonly from: UnitStatus;
				readonly to: "complete";
				readonly acceptance: AcceptanceBinding;
				/** True when an already-accepted unit was explicitly re-accepted onto a new binding (§6). */
				readonly reaccept: boolean;
			};
	  }
	| {
			readonly type: "unit.reworked";
			readonly payload: {
				readonly from: "reviewing";
				readonly to: "running";
				readonly findings: readonly string[];
				readonly requiredChanges: readonly string[];
			};
	  }
	| {
			readonly type: "unit.result-ready";
			readonly payload: { readonly ref: string };
	  }
	| {
			readonly type: "unit.result-brought-back";
			readonly payload: { readonly ref: string; readonly firstTime: boolean };
	  };

export type OrchestrationEventType = OrchestrationEventBody["type"];

export type OrchestrationEvent = OrchestrationEventEnvelope & OrchestrationEventBody;

/** Envelope fields the writer supplies; `id` is derived from `recordId` + `sequence`. */
export interface EventWriteContext {
	readonly recordId: string;
	readonly actor: string;
	readonly at: number;
	readonly sequence: number;
	readonly unitId?: string;
}

/**
 * Build one event. The body is a discriminated union, so a caller cannot attach a
 * `unit.accepted` payload to a `record.created` event.
 */
export function orchestrationEvent(context: EventWriteContext, body: OrchestrationEventBody): OrchestrationEvent {
	return {
		id: orchestrationEventId(context.recordId, context.sequence),
		sequence: context.sequence,
		recordId: context.recordId,
		actor: context.actor,
		at: context.at,
		...(context.unitId === undefined ? {} : { unitId: context.unitId }),
		...body,
	};
}

export function orchestrationEventId(recordId: string, sequence: number): string {
	return `${recordId}#${sequence}`;
}

/** The next sequence to write: one past the highest already in the ledger. */
export function nextSequence(events: readonly OrchestrationEvent[]): number {
	let highest = 0;
	for (const event of events) {
		if (event.sequence > highest) highest = event.sequence;
	}
	return highest + 1;
}
