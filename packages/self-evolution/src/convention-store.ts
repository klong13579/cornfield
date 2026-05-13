/**
 * Convention Store
 *
 * Manages persistence and lifecycle of implicit conventions mined from sessions.
 * Storage format: JSONL (conventions.jsonl)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImplicitConvention } from "@oh-my-pi/cognitive-coordination";
import { logger } from "@oh-my-pi/pi-utils";

const CONVENTIONS_FILE = "conventions.jsonl";

/**
 * Load all persisted conventions.
 */
export async function loadConventions(evolutionRoot: string): Promise<ImplicitConvention[]> {
	const filePath = path.join(evolutionRoot, CONVENTIONS_FILE);
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return content
			.split("\n")
			.filter(line => line.trim())
			.map(line => {
				try {
					return JSON.parse(line) as ImplicitConvention;
				} catch {
					return null;
				}
			})
			.filter(Boolean) as ImplicitConvention[];
	} catch {
		return [];
	}
}

/**
 * Save conventions to disk (overwrite).
 */
export async function saveConventions(evolutionRoot: string, conventions: ImplicitConvention[]): Promise<void> {
	const filePath = path.join(evolutionRoot, CONVENTIONS_FILE);

	// Sort by confidence descending for readability
	const sorted = [...conventions].sort((a, b) => b.confidence - a.confidence);

	const lines = `${sorted.map(c => JSON.stringify(c)).join("\n")}\n`;
	await fs.writeFile(filePath, lines, "utf-8");
	logger.debug("Saved conventions", { count: sorted.length, path: filePath });
}

/**
 * Merge new conventions with existing ones.
 * Strategy:
 * - Deduplication based on rule text (exact match).
 * - If a rule exists in both, keep the one with higher confidence.
 */
export function mergeConventions(existing: ImplicitConvention[], newOnes: ImplicitConvention[]): ImplicitConvention[] {
	const map = new Map<string, ImplicitConvention>();

	// Add existing
	for (const c of existing) {
		if (!map.has(c.rule) || map.get(c.rule)!.confidence < c.confidence) {
			map.set(c.rule, c);
		}
	}

	// Merge new
	for (const c of newOnes) {
		const current = map.get(c.rule);
		if (!current) {
			map.set(c.rule, c);
		} else if (c.confidence > current.confidence) {
			// Update if new one is more confident
			map.set(c.rule, { ...c, sourceSessionId: c.sourceSessionId || current.sourceSessionId });
		} else {
			// Just update source if not present
			if (!current.sourceSessionId && c.sourceSessionId) {
				current.sourceSessionId = c.sourceSessionId;
			}
		}
	}

	return Array.from(map.values());
}
