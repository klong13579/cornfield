/**
 * One-time migration from legacy user-home evolution paths to project-local `.omp/`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { isUsableSqliteDatabase } from "./clear-project-evolution";
import {
	resolveEvolutionPathLayout,
	resolveLegacyGlobalEvolutionDir,
	resolveLegacyMemoryRootCandidates,
} from "./paths";

export interface MigrateEvolutionPathsResult {
	migratedMemory: boolean;
	migratedEvolutionDb: boolean;
	migratedSkills: boolean;
}

async function dirHasFiles(dir: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(dir);
		return entries.length > 0;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function copySqliteDbIfMissing(src: string, dest: string): Promise<boolean> {
	if (!(await fileExists(src))) return false;
	if (!isUsableSqliteDatabase(src)) {
		logger.debug("Evolution path migration: skip unusable source evolution.db", { src });
		return false;
	}
	if (await fileExists(dest)) return false;
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.copyFile(src, dest);
	const wal = `${src}-wal`;
	const shm = `${src}-shm`;
	if (await fileExists(wal)) await fs.copyFile(wal, `${dest}-wal`);
	if (await fileExists(shm)) await fs.copyFile(shm, `${dest}-shm`);
	if (isUsableSqliteDatabase(dest)) {
		return true;
	}
	await fs.rm(dest, { force: true });
	await fs.rm(`${dest}-wal`, { force: true }).catch(() => undefined);
	await fs.rm(`${dest}-shm`, { force: true }).catch(() => undefined);
	logger.debug("Evolution path migration: copied evolution.db bundle still unreadable", { src, dest });
	return false;
}

async function copyTreeIfTargetEmpty(src: string, dest: string): Promise<boolean> {
	if (!(await dirHasFiles(src))) return false;
	if (await dirHasFiles(dest)) return false;
	await fs.mkdir(dest, { recursive: true });
	await fs.cp(src, dest, { recursive: true });
	return true;
}

/**
 * Copy legacy global / encoded-memory artifacts into `<cwd>/.omp/` when project dirs are empty.
 * No-op when `globalStore` is true (caller still on legacy layout).
 */
export async function migrateLegacyEvolutionPathsIfNeeded(
	cwd: string,
	agentDir: string,
	globalStore?: boolean,
): Promise<MigrateEvolutionPathsResult> {
	const result: MigrateEvolutionPathsResult = {
		migratedMemory: false,
		migratedEvolutionDb: false,
		migratedSkills: false,
	};

	if (globalStore) {
		return result;
	}

	const layout = resolveEvolutionPathLayout(cwd, false, agentDir);
	const legacyGlobal = resolveLegacyGlobalEvolutionDir();

	for (const legacyMemory of resolveLegacyMemoryRootCandidates(agentDir, cwd)) {
		if (result.migratedMemory) break;
		try {
			result.migratedMemory = await copyTreeIfTargetEmpty(legacyMemory, layout.memoryDir);
		} catch (err) {
			logger.warn("Evolution path migration: memory copy failed", { error: String(err), cwd, legacyMemory });
		}
	}

	try {
		const legacyDb = path.join(legacyGlobal, "evolution.db");
		result.migratedEvolutionDb = await copySqliteDbIfMissing(legacyDb, layout.dbPath);
	} catch (err) {
		logger.warn("Evolution path migration: evolution.db copy failed", { error: String(err), cwd });
	}

	try {
		const legacySkills = path.join(legacyGlobal, "skills");
		result.migratedSkills = await copyTreeIfTargetEmpty(legacySkills, layout.skillsDir);
	} catch (err) {
		logger.warn("Evolution path migration: skills copy failed", { error: String(err), cwd });
	}

	if (result.migratedMemory || result.migratedEvolutionDb || result.migratedSkills) {
		logger.debug("Evolution legacy path migration applied", { cwd, ...result });
	}

	return result;
}
