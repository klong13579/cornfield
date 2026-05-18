/**
 * Convention Store (legacy JSONL helpers)
 *
 * Pure functions for conventions.jsonl merge/decay — used in tests and migration tooling only.
 * **Production persistence uses SQLite `conventions` + `conventions.md` projection** (see SqliteConventionStore).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImplicitConvention } from "@oh-my-pi/cognitive-coordination";
import { logger } from "@oh-my-pi/pi-utils";

const CONVENTIONS_FILE = "conventions.jsonl";

/** Provenance priority for conflict resolution. Higher number wins. */
const PROVENANCE_RANK: Record<NonNullable<ImplicitConvention["provenance"]>, number> = {
	user_stated: 4,
	implied: 3,
	inferred: 2,
	fallback: 1,
};

/** Confidence decay half-life in days (default: 30 days). */
const DECAY_HALF_LIFE_DAYS = 30;

/**
 * Load all persisted conventions, applying decay to stale ones.
 */
export async function loadConventions(evolutionRoot: string): Promise<ImplicitConvention[]> {
	const filePath = path.join(evolutionRoot, CONVENTIONS_FILE);
	try {
		const content = await fs.readFile(filePath, "utf-8");
		const now = Date.now();
		return content
			.split("\n")
			.filter(line => line.trim())
			.map(line => {
				try {
					const parsed = JSON.parse(line) as ImplicitConvention;
					return applyDecay(parsed, now);
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
 * Apply confidence decay based on time since last update.
 * Uses exponential decay: confidence *= 0.5^(daysSinceUpdate / DECAY_HALF_LIFE_DAYS)
 * Minimum confidence floor is 1 (never reaches 0).
 */
export function applyDecay(convention: ImplicitConvention, now: number = Date.now()): ImplicitConvention {
	if (!convention.updatedAt) return convention;
	const daysSince = (now - convention.updatedAt) / (1000 * 60 * 60 * 24);
	if (daysSince < 1) return convention; // No decay within first day

	const decayFactor = 0.5 ** (daysSince / DECAY_HALF_LIFE_DAYS);
	const newConfidence = Math.max(1, Math.round(convention.confidence * decayFactor));
	if (newConfidence === convention.confidence) return convention;

	return { ...convention, confidence: newConfidence };
}

/**
 * Merge new conventions with existing ones.
 * Strategy:
 * - Deduplication based on rule text (exact match).
 * - Provenance-aware conflict resolution: higher provenance wins.
 * - If same provenance, higher confidence wins.
 * - Timestamps are updated on merge for accurate decay tracking.
 */
export function mergeConventions(existing: ImplicitConvention[], newOnes: ImplicitConvention[]): ImplicitConvention[] {
	const map = new Map<string, ImplicitConvention>();
	const superseded: ImplicitConvention[] = [];
	const now = Date.now();

	// Add existing
	for (const c of existing) {
		map.set(c.rule, c);
	}

	// Merge new
	for (const c of newOnes) {
		const current = map.get(c.rule);
		if (!current) {
			map.set(c.rule, { ...c, updatedAt: c.updatedAt ?? now });
			continue;
		}

		// Provenance-based arbitration
		const rankNew = c.provenance ? (PROVENANCE_RANK[c.provenance] ?? 0) : 0;
		const rankCur = current.provenance ? (PROVENANCE_RANK[current.provenance] ?? 0) : 0;

		if (rankNew > rankCur) {
			// New has higher provenance — supersede; record audit trail on old
			superseded.push({
				...current,
				supersededBy: c.rule,
				supersededAt: now,
				updatedAt: now,
			});
			map.set(c.rule, {
				...c,
				confidence: Math.max(c.confidence, current.confidence),
				sourceSessionId: c.sourceSessionId || current.sourceSessionId,
				updatedAt: now,
			});
		} else if (rankNew === rankCur && c.confidence > current.confidence) {
			// Same provenance, higher confidence wins
			map.set(c.rule, {
				...c,
				sourceSessionId: c.sourceSessionId || current.sourceSessionId,
				updatedAt: now,
			});
		} else {
			// Current wins — just update source and timestamp
			if (!current.sourceSessionId && c.sourceSessionId) {
				current.sourceSessionId = c.sourceSessionId;
			}
			current.updatedAt = now;
		}
	}

	// Log superseded conventions for audit
	if (superseded.length > 0) {
		logger.debug("Conventions superseded via provenance", {
			count: superseded.length,
			superseded: superseded.map(s => ({ rule: s.rule, provenance: s.provenance, supersededBy: s.supersededBy })),
		});
	}

	return Array.from(map.values());
}
