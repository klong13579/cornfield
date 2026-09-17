/**
 * Where the Session Tree ledger lives.
 *
 * The ledger belongs to the **parent session**: it is that session's record of
 * what it delegated, what came back, and what it had to reconcile after a
 * restart. So it is stored with the parent's session, through the mechanism the
 * repository already uses for session-scoped extension state — a `custom` entry
 * in the session JSONL (`SessionManager.appendCustomEntry`), the same mechanism
 * the session `todo` tool persists its edits with.
 *
 * Why not the child's own session header (WP1 lists the session header as the
 * session tree's eventual authority): the parent is the only writer of the child's
 * lifecycle. Writing the child's status into a file the *child* process owns would
 * be a second writer on that file with no ordering between them, and it would put
 * the parent's view of the child inside the child's own history. The child's header
 * keeps what it already had — `SessionHeader.parentSession` — and the parent's
 * ledger carries the rest.
 *
 * Writes are append-only snapshots, one per change: the ledger is a fold over the
 * log, so a crash between two writes loses nothing that was already recorded.
 * There is no compaction here on purpose — a delegation's lifecycle produces a
 * handful of entries, and the session log is already the compaction unit.
 *
 * Reading is strict: an entry this module cannot read is a hard error. Skipping it
 * would silently drop a delegation from the ledger, which is exactly the failure
 * reconcile exists to prevent.
 */

import { logger } from "@cornfield/utils";
import type { SessionEntry, SessionManager } from "./session-manager";
import type { ChildSessionRecord } from "./session-tree";

/** Custom-entry discriminator for ledger snapshots. One writer, one reader. */
export const SESSION_TREE_CUSTOM_TYPE = "session_tree_node";
/** Envelope version written with every snapshot; a future reader can tell which shape it has. */
export const SESSION_TREE_STORE_VERSION = 1;

const SESSION_STATUSES = new Set(["running", "waiting_user", "completed", "failed", "cancelled"]);

/** A ledger entry could not be read back. Never downgraded to "no ledger". */
export class SessionTreeStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionTreeStoreError";
	}
}

/**
 * The slice of `SessionManager` the ledger needs. Structural, so a test double is
 * the real shape. `ensureOnDisk` is part of it because the ledger cannot rely on
 * the session log existing: see {@link SessionLogTreeStore.save}.
 */
export type SessionTreeLog = Pick<SessionManager, "appendCustomEntry" | "ensureOnDisk" | "getEntries" | "flush">;

export interface SessionTreeStore {
	/** Every delegation this parent has recorded, oldest first. */
	load(): Promise<ChildSessionRecord[]>;
	/** Record the current state of one child. Upsert by session id. */
	save(record: ChildSessionRecord): Promise<void>;
}

interface StoredSnapshot {
	version: number;
	record: ChildSessionRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Validate a snapshot read back from disk.
 *
 * A violation names the field and the value: this runs on the recovery path,
 * where the operator needs to know which delegation is unreadable and why.
 */
function assertChildSessionRecord(value: unknown, where: string): ChildSessionRecord {
	if (!isRecord(value)) throw new SessionTreeStoreError(`${where}: ledger record is not an object`);
	const node = value.node;
	if (!isRecord(node)) throw new SessionTreeStoreError(`${where}: ledger record has no session node`);
	for (const field of ["sessionId", "agentId", "rootSessionId"] as const) {
		if (typeof node[field] !== "string" || (node[field] as string).trim() === "") {
			throw new SessionTreeStoreError(
				`${where}: node.${field} must be a non-empty string, got ${describe(node[field])}`,
			);
		}
	}
	if (typeof node.depth !== "number" || !Number.isInteger(node.depth) || node.depth < 0) {
		throw new SessionTreeStoreError(
			`${where}: node.depth must be a non-negative integer, got ${describe(node.depth)}`,
		);
	}
	if (node.kind !== "child") {
		throw new SessionTreeStoreError(`${where}: a ledger node is a child session, got kind ${describe(node.kind)}`);
	}
	if (typeof node.status !== "string" || !SESSION_STATUSES.has(node.status)) {
		throw new SessionTreeStoreError(`${where}: node.status is not a session status: ${describe(node.status)}`);
	}
	if (node.executionPolicy !== "isolated-process") {
		throw new SessionTreeStoreError(
			`${where}: node.executionPolicy must be "isolated-process", got ${describe(node.executionPolicy)}`,
		);
	}
	if (typeof value.runId !== "string" || value.runId.trim() === "") {
		throw new SessionTreeStoreError(`${where}: runId must be a non-empty string, got ${describe(value.runId)}`);
	}
	if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") {
		throw new SessionTreeStoreError(`${where}: createdAt/updatedAt must be numbers`);
	}
	return value as unknown as ChildSessionRecord;
}

function readSnapshot(entry: SessionEntry, where: string): ChildSessionRecord {
	if (entry.type !== "custom" || entry.customType !== SESSION_TREE_CUSTOM_TYPE) {
		throw new SessionTreeStoreError(`${where}: not a ${SESSION_TREE_CUSTOM_TYPE} entry`);
	}
	const data = entry.data;
	if (!isRecord(data)) throw new SessionTreeStoreError(`${where}: snapshot payload is not an object`);
	if (data.version !== SESSION_TREE_STORE_VERSION) {
		throw new SessionTreeStoreError(
			`${where}: snapshot version ${describe(data.version)} is not readable by version ${SESSION_TREE_STORE_VERSION}`,
		);
	}
	return assertChildSessionRecord(data.record, where);
}

/**
 * The ledger stored as custom entries in the parent's session log.
 *
 * `load()` folds the log to the last snapshot per session id — the newest write
 * for a child wins, so a node that moved through `running → waiting_user →
 * completed` reads back as `completed` regardless of how many times it changed.
 */
export class SessionLogTreeStore implements SessionTreeStore {
	readonly #log: SessionTreeLog;

	constructor(log: SessionTreeLog) {
		this.#log = log;
	}

	async load(): Promise<ChildSessionRecord[]> {
		const byId = new Map<string, ChildSessionRecord>();
		for (const entry of this.#log.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SESSION_TREE_CUSTOM_TYPE) continue;
			const record = readSnapshot(entry, `session tree entry ${entry.id}`);
			byId.set(record.node.sessionId, record);
		}
		return [...byId.values()];
	}

	async save(record: ChildSessionRecord): Promise<void> {
		const snapshot: StoredSnapshot = { version: SESSION_TREE_STORE_VERSION, record };
		this.#log.appendCustomEntry(SESSION_TREE_CUSTOM_TYPE, snapshot);
		// Durability is the whole point of the ledger: a restart has nothing but what
		// reached the disk. The session log is written lazily — a session with no
		// assistant message yet has no file at all — so "append" can be a no-op on
		// disk, and the ledger has to create the file it is recorded in. Without this
		// `save()` returns successfully while nothing survives the process.
		try {
			await this.#log.ensureOnDisk();
			await this.#log.flush();
		} catch (error) {
			logger.error("Session tree ledger write could not be flushed", {
				sessionId: record.node.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
}

/** In-memory ledger, for callers with no session log (tests, one-shot tooling). */
export class MemorySessionTreeStore implements SessionTreeStore {
	readonly #records = new Map<string, ChildSessionRecord>();

	constructor(seed: readonly ChildSessionRecord[] = []) {
		for (const record of seed) this.#records.set(record.node.sessionId, record);
	}

	async load(): Promise<ChildSessionRecord[]> {
		return [...this.#records.values()];
	}

	async save(record: ChildSessionRecord): Promise<void> {
		this.#records.set(record.node.sessionId, record);
	}
}
