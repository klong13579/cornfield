import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getUnifiedSkillsDir, migrateLegacyMemorySkills, writeConsolidationSkills } from "./skill-storage";

describe("skill-storage", () => {
	test("migrateLegacyMemorySkills moves subdirectory skills to flat md files", async () => {
		const root = await fs.mkdtemp("/tmp/skill-storage-");
		const memoryRoot = path.join(root, "memory");
		const unifiedDir = path.join(root, "unified");

		const legacySkillDir = path.join(memoryRoot, "skills", "my-playbook");
		await fs.mkdir(legacySkillDir, { recursive: true });
		await Bun.write(path.join(legacySkillDir, "SKILL.md"), "Do the thing.\n");

		const migrated = await migrateLegacyMemorySkills(memoryRoot, unifiedDir);
		expect(migrated).toBe(1);

		const text = await Bun.file(path.join(unifiedDir, "my-playbook.md")).text();
		expect(text).toContain("Do the thing.");
		expect(text).toContain('source: "memory"');

		const legacyExists = await fs
			.stat(path.join(memoryRoot, "skills"))
			.then(() => true)
			.catch(() => false);
		expect(legacyExists).toBeFalse();

		await fs.rm(root, { recursive: true, force: true });
	});

	test("getUnifiedSkillsDir uses legacy global layout when globalStore", () => {
		const dir = getUnifiedSkillsDir("/tmp/project", true);
		expect(dir).toEndWith("/.omp/self-evolution/skills");
	});

	test("getUnifiedSkillsDir uses project layout by default", () => {
		const dir = getUnifiedSkillsDir("/tmp/project", false);
		expect(dir).toEndWith("/.omp/skills");
	});

	test("writeConsolidationSkills writes flat markdown files", async () => {
		const unifiedDir = await fs.mkdtemp("/tmp/skill-storage-write-");
		await writeConsolidationSkills(unifiedDir, [{ name: "alpha", content: "Alpha playbook." }]);

		const file = await Bun.file(path.join(unifiedDir, "alpha.md")).text();
		expect(file).toContain("Alpha playbook.");
		expect(file).toContain('name: "alpha"');

		await fs.rm(unifiedDir, { recursive: true, force: true });
	});
});
