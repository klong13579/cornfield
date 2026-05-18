/**
 * Evolution snapshots: point-in-time records of evolving state.
 *
 * Snapshots capture a serializable view of system state at a given time,
 * enabling replay, rollback, and trend analysis.
 */
import type { Database } from "bun:sqlite";

export interface Snapshot {
	id: string;
	kind: string;
	data: string;
	createdAt: number;
}

export class SnapshotStore {
	private tableCreated = false;

	constructor(private db: Database) {}

	private ensureTable(): void {
		if (this.tableCreated) return;
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS evolution_snapshots (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				data_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
		this.tableCreated = true;
	}

	async create(kind: string, data: unknown): Promise<Snapshot> {
		this.ensureTable();
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		const dataJson = JSON.stringify(data);
		const stmt = this.db.prepare(
			"INSERT INTO evolution_snapshots (id, kind, data_json, created_at) VALUES (?, ?, ?, ?)",
		);
		stmt.run(id, kind, dataJson, createdAt);
		stmt.finalize();
		return { id, kind, data: dataJson, createdAt };
	}

	async getLatest(kind: string): Promise<Snapshot | undefined> {
		this.ensureTable();
		const stmt = this.db.prepare("SELECT * FROM evolution_snapshots WHERE kind = ? ORDER BY created_at DESC LIMIT 1");
		const raw = stmt.get(kind) as { id: string; kind: string; data_json: string; created_at: number } | undefined;
		stmt.finalize();
		if (!raw) return undefined;
		return { id: raw.id, kind: raw.kind, data: raw.data_json, createdAt: raw.created_at };
	}

	async list(kind: string, limit: number): Promise<Snapshot[]> {
		this.ensureTable();
		const stmt = this.db.prepare("SELECT * FROM evolution_snapshots WHERE kind = ? ORDER BY created_at DESC LIMIT ?");
		const rows = stmt.all(kind, limit) as Array<{ id: string; kind: string; data_json: string; created_at: number }>;
		stmt.finalize();
		return rows.map(r => ({ id: r.id, kind: r.kind, data: r.data_json, createdAt: r.created_at }));
	}
}
