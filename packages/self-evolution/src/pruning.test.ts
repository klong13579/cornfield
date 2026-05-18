import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { SandboxReport } from "@oh-my-pi/cognitive-coordination";
import { applySandboxReports } from "./pruning";

describe("applySandboxReports (SR-01: Auto-Rollback)", () => {
	function createDb(): Database {
		const db = new Database(":memory:");
		db.run(`
			CREATE TABLE skills (
				name TEXT PRIMARY KEY,
				description TEXT DEFAULT '',
				task_pattern TEXT DEFAULT '',
				approach TEXT DEFAULT '',
				tools TEXT DEFAULT '[]',
				pitfalls TEXT DEFAULT '[]',
				created_at INTEGER DEFAULT 0,
				usage_count INTEGER DEFAULT 0,
				last_used_at INTEGER DEFAULT 0,
				success_count INTEGER DEFAULT 0,
				failure_count INTEGER DEFAULT 0,
				version INTEGER DEFAULT 1,
				quality_score REAL,
				optimized_prompt TEXT,
				deprecated INTEGER DEFAULT 0,
				deprecation_reason TEXT,
				autonomy_notes TEXT,
				last_optimized_at INTEGER,
				user_rating INTEGER
			)
		`);
		return db;
	}

	test("skill is marked deprecated after consecutive negative reports", async () => {
		const db = createDb();
		try {
			const now = Date.now();
			db.run(
				`INSERT INTO skills (name, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["unstable-skill", "Original approach", 1, 70, now, now, 2, 1, 1],
			);

			const reports: SandboxReport[] = [
				{
					skillId: "evolution_extraction:unstable-skill",
					scoreDelta: -0.3,
					reason: "Failed validation",
					passed: false,
				},
				{
					skillId: "evolution_extraction:unstable-skill",
					scoreDelta: -0.3,
					reason: "Failed validation",
					passed: false,
				},
				{
					skillId: "evolution_extraction:unstable-skill",
					scoreDelta: -0.3,
					reason: "Failed validation",
					passed: false,
				},
			];

			await applySandboxReports(db, reports, { deprecationThreshold: 0.2, minUsageCount: 5 });

			const row = db
				.prepare("SELECT quality_score, deprecated FROM skills WHERE name = ?")
				.get("unstable-skill") as {
				quality_score: number;
				deprecated: number;
			};

			// 70 - 90 = -20, clamped to 0, and deprecated because score < 20 and usageCount < 5
			expect(row.quality_score).toBe(0);
			expect(row.deprecated).toBe(1);
		} finally {
			db.close();
		}
	});

	test("frequently-used skills are protected from pruning", async () => {
		const db = createDb();
		try {
			const now = Date.now();
			db.run(
				`INSERT INTO skills (name, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["popular-skill", "Well-tested approach", 1, 30, now, now, 10, 8, 2],
			);

			const reports: SandboxReport[] = [
				{ skillId: "evolution_extraction:popular-skill", scoreDelta: -0.4, reason: "Failed", passed: false },
				{ skillId: "evolution_extraction:popular-skill", scoreDelta: -0.4, reason: "Failed", passed: false },
			];

			await applySandboxReports(db, reports, { deprecationThreshold: 0.2, minUsageCount: 5 });

			const row = db.prepare("SELECT quality_score, deprecated FROM skills WHERE name = ?").get("popular-skill") as {
				quality_score: number;
				deprecated: number;
			};

			// Score drops but NOT deprecated because usageCount(10) >= minUsageCount(5)
			expect(row.quality_score).toBeLessThan(30);
			expect(row.deprecated).toBe(0);
		} finally {
			db.close();
		}
	});

	test("positive reports increase skill quality", async () => {
		const db = createDb();
		try {
			const now = Date.now();
			db.run(
				`INSERT INTO skills (name, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["improving-skill", "Good approach", 1, 50, now, now, 3, 2, 1],
			);

			const reports: SandboxReport[] = [
				{
					skillId: "evolution_extraction:improving-skill",
					scoreDelta: 0.15,
					reason: "Passed validation",
					passed: true,
				},
				{
					skillId: "evolution_extraction:improving-skill",
					scoreDelta: 0.15,
					reason: "Passed validation",
					passed: true,
				},
			];

			await applySandboxReports(db, reports);

			const row = db.prepare("SELECT quality_score FROM skills WHERE name = ?").get("improving-skill") as {
				quality_score: number;
			};

			// 50 + 15 + 15 = 80
			expect(row.quality_score).toBe(80);
		} finally {
			db.close();
		}
	});

	test("score is clamped to 0-100 range", async () => {
		const db = createDb();
		try {
			const now = Date.now();
			db.run(
				`INSERT INTO skills (name, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["boundary-skill", "Edge case", 1, 5, now, now, 0, 0, 0],
			);

			const reports: SandboxReport[] = [
				{ skillId: "evolution_extraction:boundary-skill", scoreDelta: -0.5, reason: "Failed badly", passed: false },
			];

			await applySandboxReports(db, reports);

			const row = db.prepare("SELECT quality_score FROM skills WHERE name = ?").get("boundary-skill") as {
				quality_score: number;
			};

			// 5 - 50 = -45, clamped to 0
			expect(row.quality_score).toBe(0);
		} finally {
			db.close();
		}
	});

	test("unknown skill ID is silently skipped", async () => {
		const db = createDb();
		try {
			const reports: SandboxReport[] = [
				{ skillId: "evolution_extraction:nonexistent", scoreDelta: -0.5, reason: "N/A", passed: false },
			];

			// Should not throw
			await expect(applySandboxReports(db, reports)).resolves.toBeUndefined();
		} finally {
			db.close();
		}
	});

	test("autonomy_notes is updated with reason", async () => {
		const db = createDb();
		try {
			const now = Date.now();
			db.run(
				`INSERT INTO skills (name, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["note-skill", "Test", 1, 50, now, now, 0, 0, 0],
			);

			const reports: SandboxReport[] = [
				{
					skillId: "evolution_extraction:note-skill",
					scoreDelta: 0.1,
					reason: "Passed sandbox test",
					passed: true,
				},
			];

			await applySandboxReports(db, reports);

			const row = db.prepare("SELECT autonomy_notes FROM skills WHERE name = ?").get("note-skill") as {
				autonomy_notes: string | null;
			};

			expect(row.autonomy_notes).toContain("Passed sandbox test");
		} finally {
			db.close();
		}
	});
});
