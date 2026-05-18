import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { initSchema } from "../src/storage/db";

describe("v2 schema", () => {
	let db: Database;
	let dbPath: string;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `evolution-test-${Date.now()}.db`);
		db = new Database(dbPath);
		initSchema(db);
	});

	afterAll(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {}
	});

	test("episode_intents table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_intents'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("episode_intents");
	});

	test("workflow_patterns table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_patterns'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("workflow_patterns");
	});

	test("user_profiles table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_profiles'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("user_profiles");
	});

	test("episode_effectiveness table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_effectiveness'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("episode_effectiveness");
	});

	test("skills table has intent column", () => {
		const stmt = db.prepare("PRAGMA table_info(skills)");
		const rows = stmt.all() as Array<{ name: string }>;
		stmt.finalize();
		const intentCol = rows.find(r => r.name === "intent");
		expect(intentCol).toBeDefined();
	});
	test("episode_detailed_outcomes table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_detailed_outcomes'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("episode_detailed_outcomes");
	});

	test("session_model_stats table exists", () => {
		const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_model_stats'");
		const row = stmt.get() as { name: string } | undefined;
		stmt.finalize();
		expect(row?.name).toBe("session_model_stats");
	});

	test("session_model_stats has expected columns", () => {
		const stmt = db.prepare("PRAGMA table_info(session_model_stats)");
		const rows = stmt.all() as Array<{ name: string; notnull: number }>;
		stmt.finalize();
		const colNames = rows.map(r => r.name);
		expect(colNames).toContain("session_id");
		expect(colNames).toContain("model_name");
		expect(colNames).toContain("prompt_tokens");
		expect(colNames).toContain("completion_tokens");
		expect(colNames).toContain("duration_ms");
		expect(colNames).toContain("success_count");
		expect(colNames).toContain("error_count");
		expect(colNames).toContain("timestamp");
		expect(colNames).toContain("task_type");
	});

	test("regression_fixtures has no entries_json column after dedup migration", () => {
		const stmt = db.prepare("PRAGMA table_info(regression_fixtures)");
		const rows = stmt.all() as Array<{ name: string }>;
		stmt.finalize();
		const names = rows.map(r => r.name);
		expect(names).toContain("session_id");
		expect(names).not.toContain("entries_json");
	});

	test("skill_population has no content column after dedup migration", () => {
		const stmt = db.prepare("PRAGMA table_info(skill_population)");
		const rows = stmt.all() as Array<{ name: string }>;
		stmt.finalize();
		const names = rows.map(r => r.name);
		expect(names).toContain("name");
		expect(names).not.toContain("content");
	});
});
