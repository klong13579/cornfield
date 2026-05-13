import * as fs from "node:fs/promises";
import { logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { SkillFrontmatter, UnifiedSkill } from "./types.js";

/**
 * Unified Skill Registry
 * Loads and merges skills from Memory and Self-Evolution systems.
 */
export class UnifiedSkillRegistry {
	/**
	 * Load and merge skills from memory and evolution roots.
	 * @param memoryRoot - Root path of memory skills (subdirectories with SKILL.md)
	 * @param evolutionRoot - Root path of evolution skills (<name>.md files)
	 */
	async load(memoryRoot: string, evolutionRoot: string): Promise<UnifiedSkill[]> {
		const skills: UnifiedSkill[] = [];

		// Load memory consolidation skills
		const memorySkills = await this.loadMemorySkills(memoryRoot);
		skills.push(...memorySkills);

		// Load evolution extraction skills
		const evolutionSkills = await this.loadEvolutionSkills(evolutionRoot);
		skills.push(...evolutionSkills);

		// Merge by name, resolving conflicts based on confidence_score and source
		const merged = this.mergeByName(skills);

		logger.debug("UnifiedSkillRegistry.load", {
			memoryCount: memorySkills.length,
			evolutionCount: evolutionSkills.length,
			mergedCount: merged.length,
		});

		return merged;
	}

	/**
	 * Load skills from memory root's skills directory.
	 * Each subdirectory contains a SKILL.md file.
	 */
	private async loadMemorySkills(memoryRoot: string): Promise<UnifiedSkill[]> {
		const skills: UnifiedSkill[] = [];
		const skillsDir = `${memoryRoot}/skills`;

		try {
			const entries = await this.listDirectory(skillsDir);
			if (entries.length === 0) return skills;

			for (const entry of entries) {
				if (!entry.isDirectory) continue;

				const skillPath = `${skillsDir}/${entry.name}/SKILL.md`;
				try {
					const file = Bun.file(skillPath);
					if (!(await file.exists())) continue;

					const content = await file.text();
					const parsed = this.parseSkillFile(content, entry.name);
					if (parsed) skills.push(this.toUnifiedSkill(parsed, "memory_consolidation"));
				} catch (err) {
					logger.warn("UnifiedSkillRegistry: failed to load memory skill", {
						skill: entry.name,
						error: String(err),
					});
				}
			}
		} catch {
			logger.debug("UnifiedSkillRegistry: memory skills directory not found", { path: skillsDir });
		}

		return skills;
	}

	/**
	 * Load skills from evolution root's skills directory.
	 * Each file is a <name>.md file.
	 */
	private async loadEvolutionSkills(evolutionRoot: string): Promise<UnifiedSkill[]> {
		const skills: UnifiedSkill[] = [];
		const skillsDir = `${evolutionRoot}/skills`;

		try {
			const entries = await this.listDirectory(skillsDir);
			if (entries.length === 0) return skills;

			for (const entry of entries) {
				if (!entry.isFile || !entry.name.endsWith(".md")) continue;

				const skillPath = `${skillsDir}/${entry.name}`;
				const skillName = entry.name.replace(/\.md$/, "");

				try {
					const content = await Bun.file(skillPath).text();
					const parsed = this.parseSkillFile(content, skillName);
					if (parsed) skills.push(this.toUnifiedSkill(parsed, "evolution_extraction"));
				} catch (err) {
					logger.warn("UnifiedSkillRegistry: failed to load evolution skill", {
						skill: skillName,
						error: String(err),
					});
				}
			}
		} catch {
			logger.debug("UnifiedSkillRegistry: evolution skills directory not found", { path: skillsDir });
		}

		return skills;
	}

	/**
	 * Parse a skill file, extracting frontmatter and content.
	 */
	private parseSkillFile(content: string, fallbackName: string): (SkillFrontmatter & { content: string }) | null {
		const { frontmatter, body } = parseFrontmatter(content, { source: fallbackName });

		// Validate required fields
		const name = frontmatter.name as string | undefined;
		const version = frontmatter.version as string | undefined;
		const confidenceScore = frontmatter.confidenceScore as number | undefined;
		const lastUsedAt = frontmatter.lastUsedAt as string | undefined;
		const status = frontmatter.status as string | undefined;

		if (!name || !version || confidenceScore === undefined || !lastUsedAt || !status) {
			logger.debug("UnifiedSkillRegistry: incomplete skill frontmatter", {
				skill: fallbackName,
				hasName: !!name,
				hasVersion: !!version,
				hasConfidenceScore: confidenceScore !== undefined,
				hasLastUsedAt: !!lastUsedAt,
				hasStatus: !!status,
			});
			return null;
		}
		if (!["active", "deprecated", "experimental"].includes(status)) {
			logger.warn("UnifiedSkillRegistry: invalid skill status", { skill: fallbackName, status });
			return null;
		}

		if (typeof confidenceScore !== "number" || Number.isNaN(confidenceScore)) {
			logger.warn("UnifiedSkillRegistry: invalid confidenceScore", { skill: fallbackName, confidenceScore });
			return null;
		}

		return {
			name,
			version,
			confidence_score: confidenceScore,
			last_used_at: lastUsedAt,
			status: status as "active" | "deprecated" | "experimental",
			source: (frontmatter.source as "memory" | "evolution" | "manual") || "manual",
			description: frontmatter.description as string | undefined,
			content: body,
		};
	}

	/**
	 * Convert parsed skill to UnifiedSkill format.
	 */
	private toUnifiedSkill(
		skill: SkillFrontmatter & { content: string },
		source: "memory_consolidation" | "evolution_extraction",
	): UnifiedSkill {
		const lastUsedTimestamp = this.parseTimestamp(skill.last_used_at);

		return {
			id: `${source}:${skill.name}`,
			source,
			name: skill.name,
			content: skill.content,
			confidenceScore: skill.confidence_score,
			lastUsedAt: lastUsedTimestamp,
			version: skill.version,
			status: skill.status,
			metadata: {
				description: skill.description,
			},
		};
	}

	/**
	 * Parse timestamp string to Unix timestamp (seconds).
	 */
	private parseTimestamp(ts: string): number {
		const date = new Date(ts);
		if (!Number.isNaN(date.getTime())) {
			return Math.floor(date.getTime() / 1000);
		}

		const num = Number(ts);
		if (!Number.isNaN(num)) {
			if (num < 1e12) return num;
			return Math.floor(num / 1000);
		}

		return Math.floor(Date.now() / 1000);
	}

	/**
	 * List directory contents.
	 */
	private async listDirectory(dirPath: string): Promise<{ name: string; isFile: boolean; isDirectory: boolean }[]> {
		const entries: { name: string; isFile: boolean; isDirectory: boolean }[] = [];

		try {
			const dirents = await fs.readdir(dirPath, { withFileTypes: true });
			for (const entry of dirents) {
				entries.push({
					name: entry.name,
					isFile: entry.isFile(),
					isDirectory: entry.isDirectory(),
				});
			}
		} catch (err) {
			logger.debug("UnifiedSkillRegistry: directory listing failed", { path: dirPath, error: String(err) });
		}

		return entries;
	}

	/**
	 * Merge skills by name, applying conflict resolution rules.
	 * Priority:
	 * 1. Higher confidence_score wins
	 * 2. If equal confidence_score, evolution_extraction wins over memory_consolidation
	 */
	private mergeByName(skills: UnifiedSkill[]): UnifiedSkill[] {
		const byName = new Map<string, UnifiedSkill[]>();

		for (const skill of skills) {
			const existing = byName.get(skill.name) ?? [];
			existing.push(skill);
			byName.set(skill.name, existing);
		}

		const merged: UnifiedSkill[] = [];

		for (const [, skillList] of byName) {
			if (skillList.length === 1) {
				merged.push(skillList[0]);
				continue;
			}

			skillList.sort((a, b) => {
				if (a.confidenceScore !== b.confidenceScore) {
					return b.confidenceScore - a.confidenceScore;
				}

				const sourcePriority = (s: UnifiedSkill): number => {
					switch (s.source) {
						case "evolution_extraction":
							return 2;
						case "memory_consolidation":
							return 1;
						case "user_manual":
							return 0;
					}
				};

				return sourcePriority(b) - sourcePriority(a);
			});

			merged.push(skillList[0]);

			logger.debug("UnifiedSkillRegistry: resolved skill conflict", {
				name: skillList[0].name,
				selectedSource: skillList[0].source,
				selectedConfidence: skillList[0].confidenceScore,
				discardedCount: skillList.length - 1,
			});
		}

		return merged;
	}
}
