import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { getUnifiedSkillsDir } from "./skill-storage";
import { SqliteSkillStore } from "./storage/skills";
import { loadUnifiedSkillsForInjection } from "./unified-skills";

describe("loadUnifiedSkillsForInjection", () => {
	let tempAgentDir: string;
	let tempCwd: string;
	let previousAgentDir: string;

	function createSkillDb(): Database {
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

	afterEach(async () => {
		setAgentDir(previousAgentDir);
		if (tempAgentDir) await fs.rm(tempAgentDir, { recursive: true, force: true });
		if (tempCwd) await fs.rm(tempCwd, { recursive: true, force: true });
	});

	test("loads from single unified skills directory", async () => {
		previousAgentDir = getAgentDir();
		tempAgentDir = await fs.mkdtemp("/tmp/unified-skills-agent-");
		tempCwd = await fs.mkdtemp("/tmp/unified-skills-cwd-");
		setAgentDir(tempAgentDir);

		const unifiedDir = getUnifiedSkillsDir(tempCwd, false);
		await fs.mkdir(unifiedDir, { recursive: true });
		await Bun.write(
			path.join(unifiedDir, "file-skill.md"),
			`---
name: "file-skill"
version: "1"
source: "memory"
confidence_score: 0.6
last_used_at: "2024-01-01T00:00:00Z"
status: "active"
---
From unified dir.
`,
		);

		const db = createSkillDb();
		const store = new SqliteSkillStore(db);
		const now = Math.floor(Date.now() / 1000);
		await store.upsert({
			name: "db-skill",
			description: "",
			taskPattern: "",
			approach: "From database.",
			tools: [],
			pitfalls: [],
			createdAt: now,
			usageCount: 1,
			lastUsedAt: now,
			successCount: 1,
			failureCount: 0,
			version: 1,
			qualityScore: 80,
			deprecated: false,
		});

		const skills = await loadUnifiedSkillsForInjection(tempCwd, store, { globalStore: false });

		const names = skills.map(s => s.name).sort();
		expect(names).toEqual(["db-skill", "file-skill"]);

		db.close();
	});

	test("migrates legacy memory skills dir into unified directory", async () => {
		previousAgentDir = getAgentDir();
		tempAgentDir = await fs.mkdtemp("/tmp/unified-skills-agent-");
		tempCwd = await fs.mkdtemp("/tmp/unified-skills-cwd-");
		setAgentDir(tempAgentDir);

		const { resolveGlobalMemoryRoot } = await import("./paths");
		const memoryRoot = resolveGlobalMemoryRoot(tempAgentDir, tempCwd);
		if (!memoryRoot) {
			throw new Error("Failed to resolve global memory root");
		}
		const legacyDir = path.join(memoryRoot, "skills", "legacy-skill");
		await fs.mkdir(legacyDir, { recursive: true });
		await Bun.write(path.join(legacyDir, "SKILL.md"), "Legacy playbook content.\n");

		const db = createSkillDb();
		const store = new SqliteSkillStore(db);

		const skills = await loadUnifiedSkillsForInjection(tempCwd, store, { globalStore: false });
		expect(skills.some(s => s.name === "legacy-skill")).toBeTrue();

		const unifiedDir = getUnifiedSkillsDir(tempCwd, false);
		const migrated = await Bun.file(path.join(unifiedDir, "legacy-skill.md")).exists();
		expect(migrated).toBeTrue();

		db.close();
	});
});
