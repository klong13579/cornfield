import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearProjectEvolutionData, isUsableSqliteDatabase } from "../src/clear-project-evolution";
import { resolveProjectEvolutionDir, resolveProjectMemoryDir, resolveProjectSkillsDir } from "../src/paths";
import { getEvolutionDb, initSchema } from "../src/storage/db";

describe("clearProjectEvolutionData", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("removes project memory, evolution, and skills directories", async () => {
		tempDir = path.join(os.tmpdir(), `evolution-clear-${Date.now()}`);
		const cwd = path.join(tempDir, "repo");
		await fs.mkdir(cwd, { recursive: true });

		await fs.mkdir(resolveProjectMemoryDir(cwd), { recursive: true });
		await fs.mkdir(resolveProjectEvolutionDir(cwd), { recursive: true });
		await fs.mkdir(resolveProjectSkillsDir(cwd), { recursive: true });
		await Bun.write(path.join(resolveProjectMemoryDir(cwd), "MEMORY.md"), "# x");

		const db = getEvolutionDb(cwd, false);
		initSchema(db);

		const result = await clearProjectEvolutionData({ cwd, globalStore: false });
		expect(result.removedDirs).toHaveLength(3);
		expect(await Bun.file(path.join(resolveProjectMemoryDir(cwd), "MEMORY.md")).exists()).toBe(false);
	});

	test("isUsableSqliteDatabase rejects non-database files", async () => {
		const bad = path.join(os.tmpdir(), `evo-bad-${Date.now()}.db`);
		await Bun.write(bad, "not-sqlite");
		expect(isUsableSqliteDatabase(bad)).toBe(false);
		await fs.rm(bad, { force: true });
	});
});
