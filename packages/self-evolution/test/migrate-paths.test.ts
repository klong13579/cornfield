import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeMemoryDb, openMemoryDb } from "../src/memory/db-access";
import { migrateLegacyEvolutionPathsIfNeeded } from "../src/migrate-paths";
import { resolveLegacyGlobalEvolutionDir, resolveProjectEvolutionDbPath, resolveProjectMemoryDir } from "../src/paths";
import { initSchema } from "../src/storage/db";

describe("migrateLegacyEvolutionPathsIfNeeded", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("copies legacy global evolution.db into project .omp when target is empty", async () => {
		tempDir = path.join(os.tmpdir(), `evolution-migrate-${Date.now()}`);
		const home = path.join(tempDir, "home");
		const agentDir = path.join(home, ".omp", "agent");
		const cwd = path.join(tempDir, "repo");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });

		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const legacyGlobal = resolveLegacyGlobalEvolutionDir();
			await fs.mkdir(legacyGlobal, { recursive: true });
			const legacyDbPath = path.join(legacyGlobal, "evolution.db");
			const legacyDb = openMemoryDb(legacyDbPath);
			initSchema(legacyDb);
			closeMemoryDb(legacyDb);

			const result = await migrateLegacyEvolutionPathsIfNeeded(cwd, agentDir, false);
			expect(result.migratedEvolutionDb).toBe(true);
			expect(await Bun.file(resolveProjectEvolutionDbPath(cwd)).exists()).toBe(true);
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});

	it("skips corrupt legacy evolution.db", async () => {
		tempDir = path.join(os.tmpdir(), `evolution-migrate-bad-${Date.now()}`);
		const home = path.join(tempDir, "home");
		const agentDir = path.join(home, ".omp", "agent");
		const cwd = path.join(tempDir, "repo");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });

		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const legacyGlobal = resolveLegacyGlobalEvolutionDir();
			await fs.mkdir(legacyGlobal, { recursive: true });
			await Bun.write(path.join(legacyGlobal, "evolution.db"), "not-a-database");

			const result = await migrateLegacyEvolutionPathsIfNeeded(cwd, agentDir, false);
			expect(result.migratedEvolutionDb).toBe(false);
			expect(await Bun.file(resolveProjectEvolutionDbPath(cwd)).exists()).toBe(false);
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});

	it("copies legacy encoded memory tree into project memory dir", async () => {
		tempDir = path.join(os.tmpdir(), `evolution-migrate-mem-${Date.now()}`);
		const agentDir = path.join(tempDir, "agent");
		const cwd = path.join(tempDir, "repo");
		await fs.mkdir(cwd, { recursive: true });

		const { resolveLegacyMemoryRoot } = await import("../src/paths");
		const legacyMem = resolveLegacyMemoryRoot(agentDir, cwd);
		await fs.mkdir(legacyMem, { recursive: true });
		await Bun.write(path.join(legacyMem, "MEMORY.md"), "# Legacy\n");

		const result = await migrateLegacyEvolutionPathsIfNeeded(cwd, agentDir, false);
		expect(result.migratedMemory).toBe(true);
		const text = await Bun.file(path.join(resolveProjectMemoryDir(cwd), "MEMORY.md")).text();
		expect(text).toContain("Legacy");
	});
});
