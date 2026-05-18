/**
 * Sync Evolution Skills from SQLite to Files
 *
 * Exports skills to ~/.omp/self-evolution/skills/*.md per prompts/skill-template.md.
 * Evolution metrics live in YAML only; the body is agent-facing content.
 */

import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

import { HeuristicSkillEvaluator, type ScoreBreakdown } from "./evaluator";
import { formatSkillMarkdown } from "./skill-format";
import { isValidSkillName, normalizeEvolutionScore } from "./skill-score";
import { getUnifiedSkillsDir } from "./skill-storage";
import { validateSkillContent } from "./skill-validation";
import { SqliteSkillEffectivenessStore } from "./storage/skill-effectiveness";
import { SqliteSkillPopulationStore } from "./storage/skill-population";
import { SqliteSkillStore } from "./storage/skills";
import type { EvolvedSkill, SkillEffectiveness, SkillPopulationRecord } from "./types";

export interface SkillSyncResult {
	written: number;
	skippedInvalid: number;
	skippedQuality: number;
	purgedInvalid: number;
	repairedPopulationScores: number;
}

export interface SkillExportContext {
	breakdown: ScoreBreakdown;
	population?: SkillPopulationRecord;
	effectiveness?: SkillEffectiveness;
}

/**
 * Directory for evolution skill markdown exports (alongside evolution.db).
 */
/** @deprecated Use getUnifiedSkillsDir */
export function resolveEvolutionSkillsDir(cwd: string, globalStore?: boolean): string {
	return getUnifiedSkillsDir(cwd, globalStore ?? true);
}

/**
 * Remove skills with empty/invalid names and related population/effectiveness rows.
 */
export async function purgeInvalidSkills(db: Database): Promise<number> {
	const store = new SqliteSkillStore(db);
	const populationStore = new SqliteSkillPopulationStore(db);
	const effectivenessStore = new SqliteSkillEffectivenessStore(db);
	const all = await store.list();
	let purged = 0;

	for (const skill of all) {
		if (isValidSkillName(skill.name)) continue;
		await store.delete(skill.name);
		if (tableExists(db, "skill_population")) {
			await populationStore.delete(skill.name).catch(() => {});
		}
		if (tableExists(db, "skill_effectiveness")) {
			const eff = await effectivenessStore.get(skill.name);
			if (eff) {
				const stmt = db.prepare("DELETE FROM skill_effectiveness WHERE skill_name = ?");
				stmt.run(skill.name);
				stmt.finalize();
			}
		}
		purged++;
		logger.warn("Purged invalid skill from database", { name: JSON.stringify(skill.name) });
	}

	return purged;
}

function tableExists(db: Database, table: string): boolean {
	const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
	return row !== undefined && row !== null;
}

export function repairPopulationScores(db: Database): number {
	if (!tableExists(db, "skill_population")) return 0;

	const rows = db
		.prepare("SELECT name, evolution_score FROM skill_population WHERE evolution_score > 1")
		.all() as Array<{ name: string; evolution_score: number }>;
	if (rows.length === 0) return 0;

	const update = db.prepare("UPDATE skill_population SET evolution_score = ? WHERE name = ?");
	for (const row of rows) {
		update.run(normalizeEvolutionScore(row.evolution_score), row.name);
	}
	update.finalize();
	logger.debug("Repaired population evolution scores", { count: rows.length });
	return rows.length;
}

/**
 * Sync all active skills from SQLite to Markdown files.
 */
export async function syncSkillsToFiles(db: Database, outputDir: string): Promise<SkillSyncResult> {
	logger.debug(`Starting skill sync to ${outputDir}`);

	const purgedInvalid = await purgeInvalidSkills(db);
	const repairedPopulationScores = repairPopulationScores(db);

	await ensureDirectory(outputDir);

	const store = new SqliteSkillStore(db);
	const populationStore = new SqliteSkillPopulationStore(db);
	const effectivenessStore = new SqliteSkillEffectivenessStore(db);
	const evaluator = new HeuristicSkillEvaluator();

	const skills = await store.list({ deprecated: false });
	const writtenFiles = new Set<string>();
	let written = 0;
	let skippedInvalid = 0;
	let skippedQuality = 0;

	for (const skill of skills) {
		if (!isValidSkillName(skill.name)) {
			skippedInvalid++;
			continue;
		}

		const validation = validateSkillContent({
			name: skill.name,
			description: skill.description,
			taskPattern: skill.taskPattern,
			approach: skill.approach,
			pitfalls: skill.pitfalls,
		});
		if (!validation.ok) {
			skippedQuality++;
			logger.debug("Skipped skill export (template validation)", {
				name: skill.name,
				failures: validation.failures,
			});
			continue;
		}

		const breakdown = evaluator.reevaluate(skill);
		const population = tableExists(db, "skill_population") ? await populationStore.get(skill.name) : undefined;
		const effectiveness = tableExists(db, "skill_effectiveness")
			? await effectivenessStore.get(skill.name)
			: undefined;
		const ctx: SkillExportContext = { breakdown, population, effectiveness };

		const filename = `${sanitizeFilename(skill.name)}.md`;
		await writeSkillFile(skill, ctx, outputDir, filename);
		writtenFiles.add(filename);
		written++;
	}

	await cleanupRemovedSkills(outputDir, writtenFiles);

	logger.debug(`Skill sync completed`, {
		written,
		skippedInvalid,
		skippedQuality,
		purgedInvalid,
		repairedPopulationScores,
	});

	return { written, skippedInvalid, skippedQuality, purgedInvalid, repairedPopulationScores };
}

async function ensureDirectory(dirPath: string): Promise<void> {
	try {
		await fs.access(dirPath);
	} catch {
		await fs.mkdir(dirPath, { recursive: true });
		logger.debug(`Created output directory: ${dirPath}`);
	}
}

async function writeSkillFile(
	skill: EvolvedSkill,
	ctx: SkillExportContext,
	outputDir: string,
	filename: string,
): Promise<void> {
	const tmpFilename = filename.replace(/\.md$/, ".tmp");
	const tmpPath = path.join(outputDir, tmpFilename);
	const finalPath = path.join(outputDir, filename);

	const content = formatSkillMarkdown(skill, {
		source: "evolution",
		qualityScore: ctx.breakdown.total,
		population: ctx.population
			? {
					state: ctx.population.state,
					evolutionScore: ctx.population.evolutionScore,
					successRate: ctx.population.successRate,
				}
			: undefined,
		effectiveness: ctx.effectiveness
			? {
					timesInjected: ctx.effectiveness.timesInjected,
					timesHelped: ctx.effectiveness.timesHelped,
					timesFailed: ctx.effectiveness.timesFailed,
				}
			: undefined,
	});

	await Bun.write(tmpPath, content);
	await fs.rename(tmpPath, finalPath);

	logger.debug(`Synced skill: ${skill.name}`);
}

function sanitizeFilename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

async function cleanupRemovedSkills(outputDir: string, writtenFiles: Set<string>): Promise<void> {
	const entries = await fs.readdir(outputDir);
	let removedCount = 0;

	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		if (entry === ".sync-state.json") continue;
		if (writtenFiles.has(entry)) continue;

		const filepath = path.join(outputDir, entry);
		try {
			const content = await fs.readFile(filepath, "utf-8");
			if (content.includes('source: "evolution"')) {
				await fs.unlink(filepath);
				removedCount++;
				logger.debug(`Removed deprecated skill file: ${entry}`);
			}
		} catch {
			// Ignore read errors
		}
	}

	if (removedCount > 0) {
		logger.debug(`Cleanup: removed ${removedCount} deprecated skill files`);
	}
}
