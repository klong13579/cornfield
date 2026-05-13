/**
 * File Watcher
 *
 * Monitors the skills directory for modifications by the Agent (Self-Programming).
 * When a skill file is edited, this watcher updates the SQLite database to reflect
 * the new content and version.
 */

import type { Database } from "bun:sqlite";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { parseFrontmatter } from "@oh-my-pi/pi-utils/frontmatter";
import { SqliteSkillStore } from "./storage/skills";
import type { EvolvedSkill } from "./types";

const DEBOUNCE_MS = 500;

export function setupSkillsWatcher(skillsDir: string, db: Database): () => void {
	const store = new SqliteSkillStore(db);
	const debounceTimers = new Map<string, NodeJS.Timeout>();

	logger.debug("Starting skills directory watcher", { path: skillsDir });

	// Ensure dir exists
	fs.mkdir(skillsDir, { recursive: true }).catch(() => {});

	const watcher = fsSync.watch(skillsDir, { persistent: false }, async (_eventType, filename) => {
		if (!filename?.endsWith(".md")) return;

		// Debounce to avoid processing the same file multiple times during a save
		const timer = debounceTimers.get(filename);
		if (timer) clearTimeout(timer);

		debounceTimers.set(
			filename,
			setTimeout(async () => {
				try {
					await handleFileChange(path.join(skillsDir, filename), store);
				} catch (err) {
					logger.warn("Watcher failed to process file change", { file: filename, error: String(err) });
				} finally {
					debounceTimers.delete(filename);
				}
			}, DEBOUNCE_MS),
		);
	});

	watcher.on("error", err => {
		logger.error("Skills directory watcher error", { error: String(err) });
	});

	return () => {
		// Clear all pending debounce timers
		for (const [, timer] of debounceTimers) {
			clearTimeout(timer);
		}
		debounceTimers.clear();
		watcher.close();
		logger.debug("Skills directory watcher stopped");
	};
}

async function handleFileChange(filePath: string, store: SqliteSkillStore): Promise<void> {
	const content = await fs.readFile(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });

	const name = frontmatter.name as string;
	if (!name) {
		logger.warn("Watcher ignored file without name frontmatter", { path: filePath });
		return;
	}

	// Fetch existing skill to preserve stats (usageCount, etc.)
	const existing = await store.get(name);

	const now = Date.now();

	// Construct the updated skill
	const updatedSkill: EvolvedSkill = {
		name: name,
		description: (frontmatter.description as string) || existing?.description || "",
		taskPattern: (frontmatter.taskPattern as string) || existing?.taskPattern || "",
		approach: body.trim(), // The markdown body is the approach
		tools: existing?.tools || [],
		pitfalls: existing?.pitfalls || [],
		createdAt: existing?.createdAt || now,
		usageCount: existing?.usageCount || 0,
		lastUsedAt: existing?.lastUsedAt || now,
		successCount: existing?.successCount || 0,
		failureCount: existing?.failureCount || 0,
		version: (existing?.version || 0) + 1, // Increment version on edit
		qualityScore: existing?.qualityScore,
		deprecated: existing?.deprecated || false,
	};

	await store.upsert(updatedSkill);
	logger.debug("Skill updated via self-modification", { name, version: updatedSkill.version });
}
