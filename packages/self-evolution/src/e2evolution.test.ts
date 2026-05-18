import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SqliteSkillStore } from "./storage/skills";
import { syncSkillsToFiles } from "./sync";

describe("E2E Evolution (E2E-01: Full Closed Loop)", () => {
	let db: Database;
	let tempDir: string;
	let outputDir: string;

	beforeEach(async () => {
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
		tempDir = `/tmp/e2e-test-${Date.now()}`;
		outputDir = path.join(tempDir, "skills");
	});

	afterAll(async () => {
		db.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function insertSkill(name: string, deprecated: boolean, approach: string): void {
		const now = Date.now();
		const body = /\b(if|when|unless|当|若)\b/i.test(approach) ? approach : `If the task matches ${name}, ${approach}`;
		db.run(
			`INSERT INTO skills (name, description, task_pattern, approach, version, quality_score, deprecated, created_at, last_used_at, usage_count, success_count, failure_count, tools, pitfalls)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				name,
				`Apply ${name} workflow when the task pattern matches.`,
				`When doing ${name}`,
				body,
				1,
				80,
				deprecated ? 1 : 0,
				now,
				now,
				0,
				0,
				0,
				"[]",
				'["Do not apply outside the stated triggers."]',
			],
		);
	}

	test("full lifecycle: insert → sync → modify → re-sync → delete", async () => {
		// 1. Insert active skill
		insertSkill("lifecycle-skill", false, "Step 1: Analyze. Step 2: Implement.");

		// 2. Sync to files
		await syncSkillsToFiles(db, outputDir);

		// Verify file exists
		const file1 = await Bun.file(path.join(outputDir, "lifecycle-skill.md")).exists();
		expect(file1).toBe(true);

		// 3. Insert deprecated skill
		insertSkill("deprecated-skill", true, "Old approach");

		// 4. Re-sync — deprecated skill should NOT create a file
		await syncSkillsToFiles(db, outputDir);
		const depFile = await Bun.file(path.join(outputDir, "deprecated-skill.md")).exists();
		expect(depFile).toBe(false);

		// 5. Delete active skill from DB
		db.prepare("DELETE FROM skills WHERE name = ?").run("lifecycle-skill");

		// 6. Re-sync — file should be cleaned up
		await syncSkillsToFiles(db, outputDir);
		const cleanedFile = await Bun.file(path.join(outputDir, "lifecycle-skill.md")).exists();
		expect(cleanedFile).toBe(false);

		// 7. Verify directory is empty
		const entries = await fs.readdir(outputDir);
		expect(entries).toHaveLength(0);
	});

	test("sync preserves content integrity", async () => {
		const complexApproach = `## When to use

When parsing structured input that must pass schema validation before transform.

## Steps
1. Parse the input
2. Validate schema
3. Transform data
4. Output result

\`\`\`typescript
const result = await transform(input);
\`\`\`

> Note: Always validate before transforming.

## Anti-patterns
- Do not transform before schema validation succeeds.`;

		insertSkill("complex-skill", false, complexApproach);

		await syncSkillsToFiles(db, outputDir);

		const content = await Bun.file(path.join(outputDir, "complex-skill.md")).text();

		expect(content).toContain("complex-skill");
		expect(content).toContain("Parse the input");
		expect(content).toContain("transform(input)");
		expect(content).toContain("Always validate before transforming");
	});

	test("multiple skills are synced in one batch", async () => {
		insertSkill("skill-a", false, "Approach A");
		insertSkill("skill-b", false, "Approach B");
		insertSkill("skill-c", false, "Approach C");
		insertSkill("skill-d", true, "Deprecated D");

		await syncSkillsToFiles(db, outputDir);

		const entries = await fs.readdir(outputDir);
		const mdFiles = entries.filter(e => e.endsWith(".md"));

		expect(mdFiles).toHaveLength(3);
		expect(mdFiles).toContain("skill-a.md");
		expect(mdFiles).toContain("skill-b.md");
		expect(mdFiles).toContain("skill-c.md");
		expect(mdFiles).not.toContain("skill-d.md");
	});
});

describe("E2E-02: Self-Modification → DB Sync生效", () => {
	let db: Database;
	let tempDir: string;
	let skillsDir: string;

	beforeEach(async () => {
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
		tempDir = `/tmp/selfmod-test-${Date.now()}`;
		skillsDir = path.join(tempDir, "skills");
	});

	afterAll(async () => {
		db.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("agent edit → watcher → DB update生效", async () => {
		// Insert initial skill
		const now = Date.now();
		db.run(
			`INSERT INTO skills (name, description, task_pattern, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count, tools, pitfalls)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"self-mod-skill",
				"Apply self-mod workflow when the agent edits exported skill files.",
				"When editing skill markdown on disk",
				"If the agent edits the exported file, verify the watcher syncs version and preserves usage stats.",
				1,
				70,
				now,
				now,
				5,
				4,
				1,
				"[]",
				'["Not for manual DB edits without a file change."]',
			],
		);

		// Sync to create file
		await syncSkillsToFiles(db, skillsDir);

		// Start watcher
		const { setupSkillsWatcher } = await import("./watcher");
		const stopWatcher = setupSkillsWatcher(skillsDir, db);

		// Simulate agent editing the file (self-modification)
		const filePath = path.join(skillsDir, "self-mod-skill.md");
		await Bun.write(
			filePath,
			`---
name: "self-mod-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.7
lastUsedAt: "${new Date().toISOString()}"
status: "active"
description: "Updated description by agent"
---
# Self-Modified Approach

## New Steps
1. Check preconditions
2. Apply transformation
3. Verify output

This approach was improved by the agent itself.`,
		);

		// Wait for watcher debounce (500ms) + fs event delivery
		const store = new SqliteSkillStore(db);
		let skill = await store.get("self-mod-skill");
		for (let i = 0; i < 40 && (skill?.version ?? 0) < 2; i++) {
			await Bun.sleep(50);
			skill = await store.get("self-mod-skill");
		}

		// Verify DB was updated

		expect(skill).toBeDefined();
		expect(skill!.version).toBe(2); // Incremented
		expect(skill!.approach).toContain("Self-Modified Approach");
		expect(skill!.approach).toContain("Check preconditions");
		expect(skill!.usageCount).toBe(5); // Preserved
		expect(skill!.successCount).toBe(4); // Preserved
		expect(skill!.qualityScore).toBe(70); // Preserved

		stopWatcher();
	});

	test("multiple sequential edits each increment version", async () => {
		const now = Date.now();
		db.run(
			`INSERT INTO skills (name, description, task_pattern, approach, version, quality_score, created_at, last_used_at, usage_count, success_count, failure_count, tools, pitfalls)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"multi-edit-skill",
				"Apply sequential edit handling when the agent updates skill files repeatedly.",
				"When multiple file edits occur in one session",
				"If the watcher debounces edits, each save should increment version while preserving counters.",
				1,
				60,
				now,
				now,
				0,
				0,
				0,
				"[]",
				'["Not for single-shot edits."]',
			],
		);

		await syncSkillsToFiles(db, skillsDir);

		const { setupSkillsWatcher } = await import("./watcher");
		const stopWatcher = setupSkillsWatcher(skillsDir, db);

		const filePath = path.join(skillsDir, "multi-edit-skill.md");

		// Edit 1
		await Bun.write(
			filePath,
			`---
name: "multi-edit-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.6
lastUsedAt: "${new Date().toISOString()}"
status: "active"
---
Edit 1 content`,
		);
		await Bun.sleep(800);

		// Edit 2
		await Bun.write(
			filePath,
			`---
name: "multi-edit-skill"
version: "1.0"
source: "evolution"
confidenceScore: 0.6
lastUsedAt: "${new Date().toISOString()}"
status: "active"
---
Edit 2 content`,
		);
		await Bun.sleep(800);

		const store = new SqliteSkillStore(db);
		let skill = await store.get("multi-edit-skill");
		for (let i = 0; i < 40 && (skill?.version ?? 0) < 3; i++) {
			await Bun.sleep(50);
			skill = await store.get("multi-edit-skill");
		}

		expect(skill).toBeDefined();
		expect(skill!.version).toBe(3); // Original 1 + 2 edits
		expect(skill!.approach).toContain("Edit 2 content");

		stopWatcher();
	});
});
