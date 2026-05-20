#!/usr/bin/env bun
/**
 * Batch-format all active skills in evolution.db to skill-template.md and sync to disk.
 *
 * Usage:
 *   bun scripts/batch-format-skills.ts [--dry-run]
 */
import { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import { batchFormatSkills } from "../packages/self-evolution/src/skill-batch-format";
import { getUnifiedSkillsDir } from "../packages/self-evolution/src/skill-storage";

const dryRun = process.argv.includes("--dry-run");
const dbPath = path.join(os.homedir(), ".omp", "self-evolution", "evolution.db");
const outputDir = getUnifiedSkillsDir(process.cwd(), true);

const db = new Database(dbPath);
const result = await batchFormatSkills(db, outputDir, { dryRun });
db.close();

const invalid = result.skills.filter(s => !s.valid);
const changed = result.skills.filter(s => s.changed);

console.log(dryRun ? "[dry-run]" : "[applied]");
console.log(`DB: ${dbPath}`);
console.log(`Skills dir: ${outputDir}`);
console.log(`Formatted: ${result.formatted}, unchanged: ${result.unchanged}, still invalid: ${result.stillInvalid}`);
if (!dryRun) {
	console.log(`Synced to disk: ${result.synced}, skipped by sync: ${result.skippedSync}`);
}
console.log("\nChanged:");
for (const s of changed) {
	console.log(`  - ${s.name}${s.valid ? "" : ` (invalid: ${s.failures.join(", ")})`}`);
}
if (invalid.length > 0) {
	console.log("\nStill invalid after format:");
	for (const s of invalid) {
		console.log(`  - ${s.name}: ${s.failures.join(", ")}`);
	}
}
