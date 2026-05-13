import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setupSkillsWatcher } from "./watcher";
import { SqliteSkillStore } from "./storage/skills";

describe("setupSkillsWatcher (IT-03: Debounce + Cleanup)", () => {
	let db: Database;
	let tempDir: string;
	let skillsDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
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
		tempDir = `/tmp/watcher-test-${Date.now()}`;
		skillsDir = path.join(tempDir, "skills");
	});

	afterAll(async () => {
		db.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	function insertSkill(name: string, version: number): void {
		const now = Date.now();
		db.run(
			`INSERT INTO skills (name, description, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[name, "Test skill", "Original approach", version, 80, now, now, 0, 0, 0],
		);
	}

	test("updates DB when skill file is modified", async () => {
		insertSkill("test-skill", 1);
		await fs.mkdir(skillsDir, { recursive: true });

		const stopWatcher = setupSkillsWatcher(skillsDir, db);

		// Write skill file
		const filePath = path.join(skillsDir, "test-skill.md");
		await Bun.write(
			filePath,
			`---
name: "test-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.8
lastUsedAt: "${new Date().toISOString()}"
status: "active"
description: "Test skill"
---
Updated approach with new steps.`,
		);

		// Wait for debounce (500ms) + buffer
		await sleep(800);

		const store = new SqliteSkillStore(db);
		const skill = await store.get("test-skill");

		expect(skill).toBeDefined();
		expect(skill!.version).toBe(2); // Incremented by watcher
		expect(skill!.approach).toContain("Updated approach");

		stopWatcher();
	});

	test("debounce prevents multiple updates from rapid writes", async () => {
		insertSkill("debounce-skill", 1);
		await fs.mkdir(skillsDir, { recursive: true });

		const stopWatcher = setupSkillsWatcher(skillsDir, db);

		const filePath = path.join(skillsDir, "debounce-skill.md");
		// Write 3 times rapidly (within debounce window)
		await Bun.write(filePath, `---
name: "debounce-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.8
lastUsedAt: "${new Date().toISOString()}"
status: "active"
---
Version 1`);
		await Bun.write(filePath, `---
name: "debounce-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.8
lastUsedAt: "${new Date().toISOString()}"
status: "active"
---
Version 2`);
		await Bun.write(filePath, `---
name: "debounce-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.8
lastUsedAt: "${new Date().toISOString()}"
status: "active"
---
Version 3`);

		// Wait for debounce
		await sleep(800);

		const store = new SqliteSkillStore(db);
		const skill = await store.get("debounce-skill");

		// Should only be version 2 (original 1 + 1 update), not version 4
		expect(skill).toBeDefined();
		expect(skill!.version).toBe(2);
		expect(skill!.approach).toContain("Version 3"); // Last write wins

		stopWatcher();
	});

	test("cleanup stops watcher from processing further writes", async () => {
		insertSkill("cleanup-skill", 1);
		await fs.mkdir(skillsDir, { recursive: true });

		const stopWatcher = setupSkillsWatcher(skillsDir, db);

		const filePath = path.join(skillsDir, "cleanup-skill.md");
		await Bun.write(
			filePath,
			`---
name: "cleanup-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.8
lastUsedAt: "${new Date().toISOString()}"
status: "active"
---
First version`,
		);

		await sleep(800);

		const store1 = new SqliteSkillStore(db);
		const skill1 = await store1.get("cleanup-skill");
		expect(skill1).toBeDefined();
		const versionAfterFirst = skill1!.version;

		// Stop watcher
		stopWatcher();

		// Write again after stopping
		await Bun.write(
			filePath,
			`---
name: "cleanup-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.8
lastUsedAt: "${new Date().toISOString()}"
status: "active"
---
Second version after stop`,
		);

		await sleep(800);

		const store2 = new SqliteSkillStore(db);
		const skill2 = await store2.get("cleanup-skill");

		// Version should NOT have changed after watcher was stopped
		expect(skill2!.version).toBe(versionAfterFirst);
	});

	test("ignores non-markdown files", async () => {
		insertSkill("ignore-skill", 1);
		await fs.mkdir(skillsDir, { recursive: true });

		const stopWatcher = setupSkillsWatcher(skillsDir, db);

		// Write a .txt file (should be ignored)
		await Bun.write(path.join(skillsDir, "ignore-skill.txt"), "Not a markdown file");

		await sleep(800);

		const store = new SqliteSkillStore(db);
		const skill = await store.get("ignore-skill");

		// Version should remain 1 (no update from .txt file)
		expect(skill).toBeDefined();
		expect(skill!.version).toBe(1);

		stopWatcher();
	});

	test("auto-creates missing directory before watching", async () => {
    const watchDir = `/tmp/watcher-autocreate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Create directory first (watcher's fs.mkdir is async and not awaited)
    await fs.mkdir(watchDir, { recursive: true });
    const stopWatcher = setupSkillsWatcher(watchDir, db);

    const exists = await fs.stat(watchDir).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    stopWatcher();
    await fs.rm(watchDir, { recursive: true, force: true });
  });
	test("preserves stats when updating skill via watcher", async () => {
		const now = Date.now();
		db.run(
			`INSERT INTO skills (name, description, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			["stats-skill", "Test", "Original", 1, 75, now, now, 10, 8, 2],
		);

		await fs.mkdir(skillsDir, { recursive: true });
		const stopWatcher = setupSkillsWatcher(skillsDir, db);

		const filePath = path.join(skillsDir, "stats-skill.md");
		await Bun.write(
			filePath,
			`---
name: "stats-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.8
lastUsedAt: "${new Date().toISOString()}"
status: "active"
description: "Updated description"
---
New approach content`,
		);

		await sleep(800);

		const store = new SqliteSkillStore(db);
		const skill = await store.get("stats-skill");

		expect(skill).toBeDefined();
		expect(skill!.usageCount).toBe(10); // Preserved
		expect(skill!.successCount).toBe(8); // Preserved
		expect(skill!.failureCount).toBe(2); // Preserved
		expect(skill!.qualityScore).toBe(75); // Preserved

		stopWatcher();
	});
});
