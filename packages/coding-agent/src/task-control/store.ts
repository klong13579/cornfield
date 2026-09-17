/**
 * The ledger: where an orchestration record and its history live.
 *
 * Contract: `docs/proma-comparison/orchestration-record-contract.md` §5.3 (the ledger is
 * the only recovery source: after an interruption the orchestrator re-reads it and
 * re-runs the same pure `reconcile`) and §1 invariant 3 (a shape that already exists on
 * disk keeps working); module boundary from
 * `docs/agent-task-control-plane-v1-implementation.md` §2 (`store.ts` = the repository).
 *
 * Division of labour, stated once so it is not re-litigated per caller:
 *   - **This file owns durability and shape.** It refuses a ledger it cannot describe
 *     exactly, and it never invents a default for a missing fact.
 *   - **`./main-worker` owns domain rules** — dependency legality, the plan, acceptance.
 *     `load` therefore does *not* run them: a store that judged cycles would be a second
 *     place where the record's semantics live.
 *
 * Failure policy (the same one the sibling stores state): a ledger that cannot be read as
 * this build's shape is a **hard error**, never an empty record. Degrading to "no units"
 * would tell an orchestrator its work vanished. Only ENOENT — the file genuinely not
 * existing yet — reads as `null`.
 *
 * Writes replace the file through a temp file plus `rename`, so a reader after a crash sees
 * either the previous ledger or the next one, never half of either. History is verified to
 * be a **prefix** of what is being written: a save that dropped or reordered events would
 * be the log rewriting itself, which is the one thing an append-only log may not do.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent } from "@cornfield/utils";
import { type OrchestrationEvent, type OrchestrationEventType, orchestrationEventId } from "./events";
import { isAcceptanceBinding, isUnitStatus } from "./state-machine";
import {
	type OrchestrationRecord,
	OrchestrationViolationError,
	UNIT_STATUSES,
	type UnitRecord,
	type UnitResult,
} from "./types";

/** Bump when the persisted shape changes: an older build must refuse a shape it would silently rewrite. */
export const ORCHESTRATION_LEDGER_VERSION = 1;

/** File name a record's ledger uses inside the store directory. */
export const ORCHESTRATION_LEDGER_SUFFIX = ".orchestration.json";

export interface OrchestrationLedger {
	readonly version: number;
	readonly record: OrchestrationRecord;
	/** Append-only; see `./events`. */
	readonly events: readonly OrchestrationEvent[];
}

export interface OrchestrationStore {
	/** `null` only when nothing has been written for this record yet. Every other failure throws. */
	load(recordId: string): Promise<OrchestrationLedger | null>;
	/** Writes the whole ledger, refusing history that is not an extension of what is on disk. */
	save(ledger: OrchestrationLedger): Promise<void>;
}

/**
 * Record ids are used as file names, so they are constrained to one path segment. A caller
 * that passes `"../../elsewhere"` gets a refusal, not a write outside the store directory.
 */
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function orchestrationLedgerPath(dir: string, recordId: string): string {
	if (!SAFE_RECORD_ID.test(recordId)) {
		throw new OrchestrationViolationError({
			rule: "record.ledger-rejected",
			subject: recordId,
			message: `"${recordId}" is not a usable record id: it must be one path segment of letters, digits, ".", "_" or "-"`,
		});
	}
	return path.join(dir, `${recordId}${ORCHESTRATION_LEDGER_SUFFIX}`);
}

export function createFileOrchestrationStore(dir: string): OrchestrationStore {
	return {
		async load(recordId: string): Promise<OrchestrationLedger | null> {
			return readLedger(orchestrationLedgerPath(dir, recordId), recordId);
		},
		async save(ledger: OrchestrationLedger): Promise<void> {
			const recordId = ledger.record.id;
			const file = orchestrationLedgerPath(dir, recordId);
			const normalized = normalizeLedger(file, ledger);
			const stored = await readLedger(file, recordId);
			if (stored) assertHistoryExtended(stored, normalized);
			await writeLedger(file, normalized);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

async function readLedger(file: string, recordId: string): Promise<OrchestrationLedger | null> {
	let parsed: unknown;
	try {
		parsed = await Bun.file(file).json();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw new OrchestrationViolationError({
			rule: "record.ledger-rejected",
			subject: file,
			message: `ledger at "${file}" is not readable JSON: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
	const ledger = normalizeLedger(file, parsed);
	// A ledger file holds the record it is named after: returning another record's facts under
	// the requested id would be a plausible lie about which orchestration was just restored.
	if (ledger.record.id !== recordId) {
		reject(file, `holds record "${ledger.record.id}" but was read as record "${recordId}".`);
	}
	return ledger;
}

async function writeLedger(file: string, ledger: OrchestrationLedger): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	// A fresh inode, then an atomic rename: a crash mid-write leaves the previous ledger intact.
	const staging = `${file}.${process.pid}.staging`;
	await Bun.write(staging, `${JSON.stringify(ledger, null, 2)}\n`);
	await fs.rename(staging, file);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────────────────────

function reject(file: string, detail: string): never {
	throw new OrchestrationViolationError({
		rule: "record.ledger-rejected",
		subject: file,
		message: `ledger at "${file}" ${detail}`,
	});
}

/**
 * The last gate before disk *and* the first after it: one validator, so a ledger this build
 * writes is exactly a ledger it can read.
 */
function normalizeLedger(file: string, value: unknown): OrchestrationLedger {
	const raw = value as Partial<OrchestrationLedger> | null;
	if (!raw || typeof raw !== "object") reject(file, "is not an object.");
	if (raw.version !== ORCHESTRATION_LEDGER_VERSION) {
		reject(
			file,
			`has version ${String(raw.version)}; this build reads version ${ORCHESTRATION_LEDGER_VERSION}. Editing the shape means bumping the version.`,
		);
	}
	const record = normalizeRecord(file, raw.record);
	if (!Array.isArray(raw.events)) reject(file, "has no events array.");
	const events = raw.events.map((event, index) => normalizeEvent(file, record, event, index));
	// Append order is a fact of the log, not a property of the file's line order: two events may
	// share a millisecond, so a non-increasing sequence means the history was rewritten.
	for (let i = 1; i < events.length; i++) {
		if (events[i].sequence <= events[i - 1].sequence) {
			reject(
				file,
				`has events out of append order: sequence ${events[i - 1].sequence} is followed by ${events[i].sequence}.`,
			);
		}
	}
	return { version: ORCHESTRATION_LEDGER_VERSION, record, events };
}

function normalizeRecord(file: string, value: unknown): OrchestrationRecord {
	const raw = value as Partial<OrchestrationRecord> | null;
	if (!raw || typeof raw !== "object") reject(file, "has no record object.");
	const recordId = raw.id;
	if (typeof recordId !== "string" || recordId.trim() === "") reject(file, "has a record without an id.");
	if (!Array.isArray(raw.units)) reject(file, `record "${recordId}" has no units array.`);
	if (!isFiniteNumber(raw.updatedAt)) reject(file, `record "${recordId}" has a non-numeric updatedAt.`);

	const units = raw.units.map((unit, index) => normalizeUnit(file, recordId, unit, index));
	const ids = new Set<string>();
	for (const unit of units) {
		if (ids.has(unit.id)) {
			// Two units under one id make every message, dependency and event ambiguous.
			reject(file, `record "${recordId}" declares unit id "${unit.id}" twice.`);
		}
		ids.add(unit.id);
	}

	const record: OrchestrationRecord = { id: recordId, units, updatedAt: raw.updatedAt };
	if (raw.maxConcurrency !== undefined) {
		if (!isFiniteNumber(raw.maxConcurrency) || raw.maxConcurrency < 1) {
			reject(
				file,
				`record "${raw.id}" has maxConcurrency ${String(raw.maxConcurrency)}; at least 1 slot must be schedulable.`,
			);
		}
		return { ...record, maxConcurrency: raw.maxConcurrency };
	}
	return record;
}

function normalizeUnit(file: string, recordId: string, value: unknown, index: number): UnitRecord {
	const raw = value as Partial<UnitRecord> | null;
	if (!raw || typeof raw !== "object") reject(file, `unit #${index} of record "${recordId}" is not an object.`);
	if (typeof raw.id !== "string" || raw.id.trim() === "")
		reject(file, `unit #${index} of record "${recordId}" has no id.`);
	if (!isUnitStatus(raw.status)) {
		reject(
			file,
			`unit "${raw.id}" has status "${String(raw.status)}"; expected one of ${UNIT_STATUSES.join(" | ")}.`,
		);
	}
	if (!Array.isArray(raw.deps) || raw.deps.some(dep => typeof dep !== "string" || dep.trim() === "")) {
		reject(file, `unit "${raw.id}" has a deps list that is not a list of ids.`);
	}
	if (!isFiniteNumber(raw.updatedAt)) reject(file, `unit "${raw.id}" has a non-numeric updatedAt.`);

	let note: string | undefined;
	if (raw.note !== undefined) {
		if (typeof raw.note !== "string") reject(file, `unit "${raw.id}" has a non-string note.`);
		note = raw.note;
	}
	let acceptance: UnitRecord["acceptance"];
	if (raw.acceptance !== undefined) {
		if (!isAcceptanceBinding(raw.acceptance)) {
			reject(file, `unit "${raw.id}" carries an acceptance binding that is empty or not an object.`);
		}
		acceptance = raw.acceptance;
	}
	return {
		id: raw.id,
		deps: raw.deps.slice(),
		status: raw.status,
		updatedAt: raw.updatedAt,
		...(note === undefined ? {} : { note }),
		...(acceptance === undefined ? {} : { acceptance }),
		...(raw.result === undefined ? {} : { result: normalizeResult(file, raw.id, raw.result) }),
	};
}

function normalizeResult(file: string, unitId: string, value: unknown): UnitResult {
	const raw = value as Partial<UnitResult> | null;
	if (!raw || typeof raw !== "object") reject(file, `unit "${unitId}" has a result that is not an object.`);
	if (typeof raw.ref !== "string" || raw.ref.trim() === "") {
		reject(file, `unit "${unitId}" has a result without a ref; a result that is ready always says what it is.`);
	}
	if (!isFiniteNumber(raw.readyAt)) reject(file, `unit "${unitId}" has a result without a numeric readyAt.`);
	const result: UnitResult = { ref: raw.ref, readyAt: raw.readyAt };
	if (raw.broughtBackAt !== undefined) {
		if (!isFiniteNumber(raw.broughtBackAt)) reject(file, `unit "${unitId}" has a non-numeric broughtBackAt.`);
		return { ...result, broughtBackAt: raw.broughtBackAt };
	}
	return result;
}

const EVENT_TYPES: readonly OrchestrationEventType[] = [
	"record.created",
	"unit.transitioned",
	"unit.accepted",
	"unit.reworked",
	"unit.result-ready",
	"unit.result-brought-back",
];

function normalizeEvent(file: string, record: OrchestrationRecord, value: unknown, index: number): OrchestrationEvent {
	const raw = value as Partial<OrchestrationEvent> | null;
	if (!raw || typeof raw !== "object") reject(file, `event #${index} is not an object.`);
	if (raw.recordId !== record.id) {
		reject(file, `event #${index} belongs to record "${String(raw.recordId)}", not "${record.id}".`);
	}
	if (!isFiniteNumber(raw.sequence) || !Number.isInteger(raw.sequence) || raw.sequence < 1) {
		reject(file, `event #${index} has a non-positive or non-integer sequence.`);
	}
	if (raw.id !== orchestrationEventId(record.id, raw.sequence)) {
		reject(file, `event #${index} id "${String(raw.id)}" does not match its sequence.`);
	}
	if (typeof raw.type !== "string" || !EVENT_TYPES.includes(raw.type as OrchestrationEventType)) {
		reject(file, `event #${index} has unknown type "${String(raw.type)}".`);
	}
	if (typeof raw.actor !== "string" || raw.actor.trim() === "") reject(file, `event #${index} has no actor.`);
	if (!isFiniteNumber(raw.at)) reject(file, `event #${index} has a non-numeric at.`);
	if (raw.unitId !== undefined) {
		if (typeof raw.unitId !== "string") reject(file, `event #${index} has a non-string unitId.`);
		if (!record.units.some(unit => unit.id === raw.unitId)) {
			// An event about a unit the record does not have is a fact about nothing.
			reject(file, `event #${index} names unit "${raw.unitId}", which is not in record "${record.id}".`);
		}
	}
	if (!raw.payload || typeof raw.payload !== "object") reject(file, `event #${index} has no payload object.`);
	return raw as OrchestrationEvent;
}

/** Append-only, enforced: what is on disk must be a prefix of what is being written. */
function assertHistoryExtended(stored: OrchestrationLedger, next: OrchestrationLedger): void {
	const subject = next.record.id;
	if (next.events.length < stored.events.length) {
		reject(
			subject,
			`history is not append-only: the ledger on disk has ${stored.events.length} events and the new one has ${next.events.length}.`,
		);
	}
	for (let i = 0; i < stored.events.length; i++) {
		// Compared by content, not by id: the id is derived from the sequence, so an id check would
		// happily accept a rewritten payload — and the payload is where an acceptance binding, a
		// finding or a result reference lives.
		if (!Bun.deepEquals(stored.events[i], next.events[i])) {
			reject(
				subject,
				`history is not append-only: event #${i + 1} (${stored.events[i].id}) is no longer the event that was recorded.`,
			);
		}
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
