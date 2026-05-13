/**
 * Sync Evolution Skills from SQLite to Files
 *
 * Phase 1 of Project Synapse: Export skills from the SQLite database
 * to individual Markdown files with YAML frontmatter.
 */

import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SkillFrontmatter } from "@oh-my-pi/cognitive-coordination";
import { logger } from "@oh-my-pi/pi-utils";

import { SqliteSkillStore } from "./storage/skills";
import type { EvolvedSkill } from "./types";

/**
 * Sync all active skills from SQLite to Markdown files.
 *
 * @param db - SQLite database instance
 * @param outputDir - Directory to write skill Markdown files
 */
export async function syncSkillsToFiles(db: Database, outputDir: string): Promise<void> {
	logger.debug(`Starting skill sync to ${outputDir}`);

	// Ensure output directory exists
	await ensureDirectory(outputDir);

	// Fetch all active (non-deprecated) skills from the database
	const store = new SqliteSkillStore(db);
	const skills = await store.list({ deprecated: false });

	logger.debug(`Found ${skills.length} active skills to sync`);

	// Track which skill files were written for cleanup
	const writtenFiles = new Set<string>();

	// Write each skill to a Markdown file
	for (const skill of skills) {
		const filename = `${sanitizeFilename(skill.name)}.md`;

		await writeSkillFile(skill, outputDir, filename);
		writtenFiles.add(filename);
	}

	// Cleanup: remove files for deprecated/deleted skills
	await cleanupRemovedSkills(outputDir, writtenFiles);

	logger.debug(`Skill sync completed: ${skills.length} skills written`);
}

/**
 * Ensure a directory exists, creating it if necessary.
 */
async function ensureDirectory(dirPath: string): Promise<void> {
	const dirExists = await fs
		.access(dirPath)
		.then(() => true)
		.catch(() => false);
	if (!dirExists) {
		await fs.mkdir(dirPath, { recursive: true });
		logger.debug(`Created output directory: ${dirPath}`);
	}
}

/**
 * Write a single skill to a Markdown file with YAML frontmatter.
 * Uses atomic write: write to .tmp first, then rename to .md
 */
async function writeSkillFile(skill: EvolvedSkill, outputDir: string, filename: string): Promise<void> {
	const tmpFilename = filename.replace(/\.md$/, ".tmp");
	const tmpPath = path.join(outputDir, tmpFilename);
	const finalPath = path.join(outputDir, filename);

	const frontmatter = buildFrontmatter(skill);
	const content = formatSkillContent(frontmatter, skill.approach);

	// Atomic write: write to .tmp first, then rename
	await Bun.write(tmpPath, content);
	await fs.rename(tmpPath, finalPath);

	logger.debug(`Synced skill: ${skill.name}`);
}

/**
 * Build YAML frontmatter from a skill.
 */
function buildFrontmatter(skill: EvolvedSkill): SkillFrontmatter {
	// Calculate confidence score from qualityScore or success/usage ratio
	let confidenceScore: number;
	if (skill.qualityScore !== undefined) {
		confidenceScore = skill.qualityScore / 100; // qualityScore is 0-100
	} else if (skill.usageCount > 0) {
		confidenceScore = skill.successCount / skill.usageCount;
	} else {
		confidenceScore = 0;
	}

	// Determine status
	const status: SkillFrontmatter["status"] = skill.deprecated ? "deprecated" : "active";

	// Format last_used_at as ISO string
	const lastUsedAt = skill.lastUsedAt ? new Date(skill.lastUsedAt * 1000).toISOString() : new Date().toISOString();

	return {
		name: skill.name,
		version: String(skill.version),
		source: "evolution",
		confidence_score: Math.round(confidenceScore * 100) / 100,
		last_used_at: lastUsedAt,
		status,
		description: skill.description || undefined,
	};
}

/**
 * Format skill content with YAML frontmatter and body.
 */
function formatSkillContent(frontmatter: SkillFrontmatter, approach: string): string {
	const yamlLines = [
		"---",
		`name: "${frontmatter.name}"`,
		`version: "${frontmatter.version}"`,
		`source: "${frontmatter.source}"`,
		`confidence_score: ${frontmatter.confidence_score}`,
		`last_used_at: "${frontmatter.last_used_at}"`,
		`status: "${frontmatter.status}"`,
	];

	if (frontmatter.description) {
		yamlLines.push(`description: "${escapeYamlString(frontmatter.description)}"`);
	}

	yamlLines.push("---", "", approach);

	return yamlLines.join("\n");
}

/**
 * Escape special characters in YAML string values.
 */
function escapeYamlString(str: string): string {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Sanitize a skill name for use as a filename.
 */
function sanitizeFilename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Remove skill files that are no longer in the database (deprecated/deleted).
 * Only removes files that were previously created by this sync process.
 */
async function cleanupRemovedSkills(outputDir: string, writtenFiles: Set<string>): Promise<void> {
	const entries = await fs.readdir(outputDir);
	let removedCount = 0;

	for (const entry of entries) {
		// Skip non-markdown files
		if (!entry.endsWith(".md")) continue;

		// Skip the sync state file if it exists
		if (entry === ".sync-state.json") continue;

		// Only remove files that were previously written by this sync process
		// and are no longer in the database
		if (!writtenFiles.has(entry)) {
			const filepath = path.join(outputDir, entry);
			// Safety: only remove if the file has our frontmatter marker
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
	}

	if (removedCount > 0) {
		logger.debug(`Cleanup: removed ${removedCount} deprecated skill files`);
	}
}
