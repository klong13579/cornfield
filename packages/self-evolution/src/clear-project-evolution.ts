/**
 * Remove project-local (or global user-level) evolution artifacts: memory, evolution DB, skills.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { DEFAULT_EVOLUTION_GLOBAL_STORE, resolveEvolutionPathLayout } from "./paths";
import { closeEvolutionDb } from "./storage/db";

export interface ClearProjectEvolutionResult {
	removedDirs: string[];
	layout: ReturnType<typeof resolveEvolutionPathLayout>;
}

export async function clearProjectEvolutionData(opts: {
	cwd: string;
	globalStore?: boolean;
	agentDir?: string;
}): Promise<ClearProjectEvolutionResult> {
	const agentDir = opts.agentDir ?? getAgentDir();
	const globalStore = opts.globalStore ?? DEFAULT_EVOLUTION_GLOBAL_STORE;
	const layout = resolveEvolutionPathLayout(opts.cwd, globalStore, agentDir);

	closeEvolutionDb(opts.cwd, globalStore);

	const removedDirs: string[] = [];
	for (const dir of [layout.memoryDir, layout.evolutionDir, layout.skillsDir]) {
		await fs.rm(dir, { recursive: true, force: true });
		removedDirs.push(dir);
	}

	// Drop cached connection if something reopens the same path in-process
	closeEvolutionDb(opts.cwd, globalStore);

	return { removedDirs, layout };
}

/** True when SQLite can read sqlite_master (filters corrupt 18-byte placeholder files). */
export function isUsableSqliteDatabase(dbPath: string): boolean {
	try {
		const db = new Database(dbPath, { readonly: true });
		db.query("SELECT name FROM sqlite_master LIMIT 1").get();
		db.close();
		return true;
	} catch {
		return false;
	}
}
