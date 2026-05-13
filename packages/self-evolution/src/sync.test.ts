import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncSkillsToFiles } from "./sync";

describe("syncSkillsToFiles", () => {
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

	test("creates markdown files for active skills", async () => {
		const db = createDb();
		const tempDir = `/tmp/sync-test-active-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const outputDir = path.join(tempDir, "skills");

		try {
			const now = Date.now();
			const result = db.run(
				`INSERT INTO skills (name, description, task_pattern, approach, version, quality_score, deprecated, created_at, usage_count, last_used_at, success_count, failure_count, tools, pitfalls)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				["test-skill", "A test skill", "When testing", "Do this step by step.", 1, 80, 0, now, 0, now, 0, 0, "[]", "[]"],
			);
			expect(result.changes).toBe(1);

			// Ensure output directory exists
			await fs.mkdir(outputDir, { recursive: true });

			await syncSkillsToFiles(db, outputDir);

			const file = await Bun.file(path.join(outputDir, "test-skill.md")).text();
			expect(file).toContain('name: "test-skill"');
			expect(file).toContain("Do this step by step.");
			expect(file).toContain('source: "evolution"');
		} finally {
			db.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("does not create files for deprecated skills", async () => {
		const db = createDb();
		const tempDir = `/tmp/sync-test-deprecated-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const outputDir = path.join(tempDir, "skills");

		try {
			const now = Date.now();
			db.run(
				`INSERT INTO skills (name, approach, version, deprecated, created_at, last_used_at, tools, pitfalls)
				 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
				["deprecated-skill", "Old approach", 1, now, now, "[]", "[]"],
			);

			await fs.mkdir(outputDir, { recursive: true });
			await syncSkillsToFiles(db, outputDir);

			const exists = await Bun.file(path.join(outputDir, "deprecated-skill.md")).exists();
			expect(exists).toBeFalse();
		} finally {
			db.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("cleans up files with evolution marker for skills no longer in DB", async () => {
		const db = createDb();
		const tempDir = `/tmp/sync-test-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const outputDir = path.join(tempDir, "skills");

		try {
			// Create a "stale" file WITH the evolution marker
			await fs.mkdir(outputDir, { recursive: true });
			await Bun.write(
				path.join(outputDir, "stale-skill.md"),
				`---
name: "stale-skill"
version: "1.0"
source: "evolution"
confidence_score: 0.5
last_used_at: "2024-01-01T00:00:00Z"
status: "active"
---
Old content`,
			);

			// DB is empty — stale file should be removed
			await syncSkillsToFiles(db, outputDir);

			const exists = await Bun.file(path.join(outputDir, "stale-skill.md")).exists();
			expect(exists).toBeFalse();
		} finally {
			db.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("preserves files without evolution marker (user-created)", async () => {
		const db = createDb();
		const tempDir = `/tmp/sync-test-preserve-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const outputDir = path.join(tempDir, "skills");

		try {
			// Create a user file WITHOUT the evolution marker
			await fs.mkdir(outputDir, { recursive: true });
			await Bun.write(path.join(outputDir, "README.md"), "# Skills Directory");

			// DB is empty — user file should NOT be removed
			await syncSkillsToFiles(db, outputDir);

			const exists = await Bun.file(path.join(outputDir, "README.md")).exists();
			expect(exists).toBeTrue();
		} finally {
			db.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("handles empty DB gracefully", async () => {
		const db = createDb();
		const tempDir = `/tmp/sync-test-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const outputDir = path.join(tempDir, "skills");

		try {
			await fs.mkdir(outputDir, { recursive: true });
			await syncSkillsToFiles(db, outputDir);

			const exists = await fs.stat(outputDir).then(() => true).catch(() => false);
			expect(exists).toBeTrue();
			const entries = await fs.readdir(outputDir);
			expect(entries).toHaveLength(0);
		} finally {
			db.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
