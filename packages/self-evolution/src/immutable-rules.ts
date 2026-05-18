/**
 * Immutable rules: content protection layer for self-evolution.
 *
 * Rules define protected text snippets (skill names, patterns, etc.)
 * that must not be modified or deleted by automated processes.
 */
import type { Database } from "bun:sqlite";

export interface ImmutableRule {
	id: string;
	content: string;
	reason: string;
	createdAt: number;
}

export class ImmutableRuleStore {
	private tableCreated = false;

	constructor(private db: Database) {}

	private ensureTable(): void {
		if (this.tableCreated) return;
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS immutable_rules (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				reason TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
		this.tableCreated = true;
	}

	async add(rule: Omit<ImmutableRule, "id" | "createdAt">): Promise<ImmutableRule> {
		this.ensureTable();
		const id = crypto.randomUUID();
		const createdAt = Date.now();
		const stmt = this.db.prepare("INSERT INTO immutable_rules (id, content, reason, created_at) VALUES (?, ?, ?, ?)");
		stmt.run(id, rule.content, rule.reason, createdAt);
		stmt.finalize();
		return { id, content: rule.content, reason: rule.reason, createdAt };
	}

	async list(): Promise<ImmutableRule[]> {
		this.ensureTable();
		const stmt = this.db.prepare("SELECT * FROM immutable_rules ORDER BY created_at DESC");
		const rows = stmt.all() as ImmutableRule[];
		stmt.finalize();
		return rows;
	}

	async isProtected(content: string): Promise<boolean> {
		this.ensureTable();
		// Check if any rule content appears as a substring within the given text
		const stmt = this.db.prepare("SELECT 1 FROM immutable_rules WHERE ? LIKE '%' || content || '%' LIMIT 1");
		const row = stmt.get(content);
		stmt.finalize();
		return row !== undefined && row !== null;
	}
}
