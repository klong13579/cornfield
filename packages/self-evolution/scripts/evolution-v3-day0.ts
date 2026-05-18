#!/usr/bin/env bun
/**
 * V3 Day-0: backup MEMORY.md + learnings seed → clear project .omp → restore → seed → memory_summary.
 *
 * Usage:
 *   bun packages/self-evolution/scripts/evolution-v3-day0.ts [--cwd <repo>] [--global-store]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { clearProjectEvolutionData } from "../src/clear-project-evolution";
import { applyLearningsSeed, defaultLearningsSeedPath, readLearningsSeedFile } from "../src/learnings-seed";
import { ensureMemorySummaryFromMemory } from "../src/memory/summary";
import { getMemoryRoot, resolveEvolutionProjectionDir } from "../src/paths";
import { projectLearnings } from "../src/projection/learnings";
import { closeEvolutionDb, getEvolutionDb, initSchema } from "../src/storage/db";
import { SqliteLearningStore } from "../src/storage/learnings";

const cwdIdx = process.argv.indexOf("--cwd");
const repoCwd = cwdIdx >= 0 ? path.resolve(process.argv[cwdIdx + 1] ?? process.cwd()) : process.cwd();
const globalStore = process.argv.includes("--global-store");

const agentDir = getAgentDir();
const memoryRoot = getMemoryRoot(agentDir, repoCwd, { globalStore });
const evolutionDir = resolveEvolutionProjectionDir(repoCwd, globalStore);
const memoryMdPath = path.join(memoryRoot, "MEMORY.md");
const seedInRepo = path.join(evolutionDir, "learnings-seed.json");
const seedExample = path.join(import.meta.dir, "../learnings-seed.example.json");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupRoot = path.join(repoCwd, ".omp", `v3-day0-backup-${stamp}`);

await fs.mkdir(backupRoot, { recursive: true });

let backedUpMemory = false;
try {
	await fs.copyFile(memoryMdPath, path.join(backupRoot, "MEMORY.md"));
	backedUpMemory = true;
} catch (err) {
	if (!isEnoent(err)) throw err;
}

let seedSource = seedInRepo;
try {
	await fs.copyFile(seedInRepo, path.join(backupRoot, "learnings-seed.json"));
} catch (err) {
	if (!isEnoent(err)) throw err;
	seedSource = seedExample;
	await fs.copyFile(seedExample, path.join(backupRoot, "learnings-seed.json"));
}

const clearResult = await clearProjectEvolutionData({ cwd: repoCwd, globalStore, agentDir });

await fs.mkdir(memoryRoot, { recursive: true });
if (backedUpMemory) {
	await fs.copyFile(path.join(backupRoot, "MEMORY.md"), memoryMdPath);
}

const db = getEvolutionDb(repoCwd, globalStore);
initSchema(db);
const learningStore = new SqliteLearningStore(db);

await fs.mkdir(evolutionDir, { recursive: true });
const seedDest = defaultLearningsSeedPath(evolutionDir);
await fs.copyFile(path.join(backupRoot, "learnings-seed.json"), seedDest);

const entries = await readLearningsSeedFile(seedDest);
const seedResult = await applyLearningsSeed(learningStore, repoCwd, entries);
await projectLearnings(db, { outputDir: evolutionDir });
const summary = await ensureMemorySummaryFromMemory(memoryRoot);

const learningCounts = db
	.prepare(`SELECT lifecycle, COUNT(*) as c FROM learnings WHERE cwd = ? GROUP BY lifecycle`)
	.all(repoCwd) as Array<{ lifecycle: string; c: number }>;

closeEvolutionDb(repoCwd, globalStore);

console.log(
	JSON.stringify(
		{
			repoCwd,
			globalStore,
			backupRoot,
			seedSource,
			clearResult,
			seedResult,
			summary,
			learningCounts,
			memoryMdPath,
			seedDest,
		},
		null,
		2,
	),
);
