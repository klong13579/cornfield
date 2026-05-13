/**
 * Pruning Logic
 *
 * Handles the lifecycle of skills based on Sandbox feedback.
 * - Updates confidence scores.
 * - Deprecates skills that fall below a threshold.
 */

import type { Database } from "bun:sqlite";
import type { SandboxReport } from "@oh-my-pi/cognitive-coordination";
import { logger } from "@oh-my-pi/pi-utils";
import { SqliteSkillStore } from "./storage/skills";

export interface PruningConfig {
	deprecationThreshold: number; // e.g., 0.2
	minUsageCount: number; // Don't deprecate if used frequently but failed once?
}

const DEFAULT_CONFIG: PruningConfig = {
	deprecationThreshold: 0.2,
	minUsageCount: 5,
};

/**
 * Apply sandbox results to the database.
 */
export async function applySandboxReports(
	db: Database,
	reports: SandboxReport[],
	config: PruningConfig = DEFAULT_CONFIG,
): Promise<void> {
	const store = new SqliteSkillStore(db);

	for (const report of reports) {
		// Extract skill name from ID (format: source:name)
		const parts = report.skillId.split(":");
		const name = parts.length > 1 ? parts.slice(1).join(":") : parts[0];

		try {
			const skill = await store.get(name);
			if (!skill) continue;

			// Update score
			let newScore = (skill.qualityScore ?? 50) + report.scoreDelta * 100;

			// Clamp 0-100
			newScore = Math.max(0, Math.min(100, newScore));

			// Determine status
			let deprecated = skill.deprecated;
			if (newScore < config.deprecationThreshold * 100 && skill.usageCount < config.minUsageCount) {
				deprecated = true;
			}

			// Only write if changed
			if (Math.abs(newScore - (skill.qualityScore ?? 50)) > 0.1 || deprecated !== skill.deprecated) {
				skill.qualityScore = newScore;
				skill.deprecated = deprecated;
				skill.autonomyNotes = `[Auto] ${report.reason}`;
				await store.upsert(skill);

				logger.debug("Skill pruned/updated", { name, newScore, deprecated });
			}
		} catch (err) {
			logger.warn("Failed to prune skill", { name, error: String(err) });
		}
	}
}
