import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initSchema } from "../src/storage/db";
import { SqliteRegressionFixtureStore } from "../src/storage/regression-fixtures";
import type { TraceEntry } from "../src/types";

function tableColumns(db: Database, table: string): string[] {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.map(r => r.name);
}

describe("storage dedup migrations", () => {
	let dbPath: string;
	let db: Database;

	afterEach(() => {
		db?.close();
		if (dbPath) {
			fs.rm(path.dirname(dbPath), { recursive: true, force: true }).catch(() => {});
		}
	});

	test("drops entries_json and backfills session_traces from legacy fixture rows", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dedup-mig-"));
		dbPath = path.join(dir, "evolution.db");
		db = new Database(dbPath);

		db.exec(`
			CREATE TABLE session_traces (
				session_id TEXT PRIMARY KEY,
				episode_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				trace_json TEXT NOT NULL,
				error_count INTEGER NOT NULL DEFAULT 0,
				completed_successfully INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE regression_fixtures (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				episode_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				user_prompt TEXT NOT NULL,
				error_count INTEGER NOT NULL DEFAULT 0,
				completed_successfully INTEGER NOT NULL DEFAULT 0,
				dominant_error_tool TEXT,
				dominant_error_pattern TEXT,
				entries_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);

		const legacyEntry: TraceEntry = {
			type: "tool_result",
			toolName: "bash",
			isError: true,
			result: "legacy-only",
			timestamp: 1,
		};
		db.prepare(
			`INSERT INTO regression_fixtures (
				id, session_id, episode_id, cwd, user_prompt, error_count,
				completed_successfully, entries_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("fx-legacy", "sess-mig", "ep-mig", dir, "fix", 1, 0, JSON.stringify([legacyEntry]), Date.now());

		initSchema(db);

		expect(tableColumns(db, "regression_fixtures")).not.toContain("entries_json");
		expect(tableColumns(db, "skill_population")).not.toContain("content");

		const fixtureStore = new SqliteRegressionFixtureStore(db);
		const loaded = await fixtureStore.listRecent(1);
		expect(loaded[0]?.entries).toHaveLength(1);
		expect(loaded[0]?.entries[0]?.toolName).toBe("bash");
	});

	test("fresh initSchema has deduped columns only", () => {
		db = new Database(":memory:");
		initSchema(db);
		expect(tableColumns(db, "regression_fixtures")).not.toContain("entries_json");
		expect(tableColumns(db, "skill_population")).not.toContain("content");
	});
});
