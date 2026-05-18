/**
 * Projection of conventions to markdown files and reverse import.
 *
 * Generates conventions.md from the conventions table and parses
 * user-edited conventions.md back into the database.
 */
import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Convention, ConventionType, ProvenanceLevel } from "./types";

export interface ConventionProjectionOptions {
	outputDir: string;
	maxEntriesPerType?: number;
	includeStats?: boolean;
}

export interface ParsedConventionEntry {
	id: string;
	type: ConventionType;
	content: string;
	confidence: number;
	provenance: ProvenanceLevel;
	timesApplied: number;
	timesViolated: number;
	createdAt: number;
	lastSeenAt: number;
}

export interface ConventionImportResult {
	imported: number;
	updated: number;
	unchanged: number;
	deleted: number;
	entries: ParsedConventionEntry[];
}

export interface ConventionImportOptions {
	/** If true, delete DB entries not present in the markdown file */
	sync?: boolean;
}

const CONFIDENCE_RE = /Confidence:\s*(\d+(?:\.\d+)?)%/;
const CREATED_RE = /Created:\s*(\d{4}-\d{2}-\d{2})/;
const ID_RE = /ID:\s*`([^`]+)`/;
const PROVENANCE_RE = /Provenance:\s*(user_stated|implied|inferred|fallback)/;
const STATS_RE = /Stats:\s*applied\s*(\d+),\s*violated\s*(\d+)/;

function formatDate(ts: number): string {
	return new Date(ts).toISOString().split("T")[0]!;
}

function parseDate(dateStr: string): number {
	return new Date(dateStr).getTime();
}

function rowToConvention(row: {
	id: string;
	type: string;
	content: string;
	confidence: number;
	times_applied: number;
	times_violated: number;
	created_at: number;
	last_seen_at: number;
	provenance: string;
}): Convention {
	return {
		id: row.id,
		type: row.type as ConventionType,
		content: row.content,
		sourceEpisodeId: "", // not used in projection
		confidence: row.confidence,
		timesApplied: row.times_applied,
		timesViolated: row.times_violated,
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
		provenance: row.provenance as ProvenanceLevel,
	};
}

// ============================================================================
// Projection: DB → Markdown
// ============================================================================

/**
 * Generate conventions.md content from a list of conventions grouped by type.
 */
export function generateConventionsMd(
	conventions: Convention[],
	options?: { maxEntriesPerType?: number; includeStats?: boolean },
): string {
	const maxEntries = options?.maxEntriesPerType ?? 100;
	const includeStats = options?.includeStats ?? true;

	// Group by type
	const byType = new Map<ConventionType, Convention[]>();
	for (const c of conventions) {
		const list = byType.get(c.type) ?? [];
		list.push(c);
		byType.set(c.type, list);
	}

	const lines: string[] = ["# Conventions", ""];
	lines.push("Project-specific rules and preferences extracted from user dialogue.", "");

	for (const [type, list] of byType) {
		lines.push(`## ${type}`, "");

		const sorted = list.sort((a, b) => b.confidence - a.confidence).slice(0, maxEntries);

		for (const c of sorted) {
			lines.push(`- ${c.content}`);
			lines.push(
				`  - Confidence: ${c.confidence}% | Created: ${formatDate(c.createdAt)} | ID: \`${c.id}\` | Provenance: ${c.provenance ?? "inferred"}`,
			);
			if (includeStats) {
				lines.push(`  - Stats: applied ${c.timesApplied}, violated ${c.timesViolated}`);
			}
			lines.push("");
		}

		if (list.length > maxEntries) {
			lines.push(`_... and ${list.length - maxEntries} more entries_`, "");
		}
	}

	lines.push("---", `*Generated on ${new Date().toISOString()} | ${conventions.length} conventions*`);
	return lines.join("\n");
}

/**
 * Load all conventions from the database.
 */
export function loadConventionsFromDb(db: Database): Convention[] {
	const rows = db
		.prepare(
			"SELECT id, type, content, confidence, times_applied, times_violated, created_at, last_seen_at, provenance FROM conventions ORDER BY type, confidence DESC",
		)
		.all() as Array<{
		id: string;
		type: string;
		content: string;
		confidence: number;
		times_applied: number;
		times_violated: number;
		created_at: number;
		last_seen_at: number;
		provenance: string;
	}>;

	return rows.map(rowToConvention);
}

/**
 * Main projection function: write conventions.md.
 */
export async function projectConventions(db: Database, options: ConventionProjectionOptions): Promise<string> {
	const conventions = loadConventionsFromDb(db);
	const md = generateConventionsMd(conventions, {
		maxEntriesPerType: options.maxEntriesPerType,
		includeStats: options.includeStats,
	});

	const outPath = path.join(options.outputDir, "conventions.md");
	await Bun.write(outPath, md);

	logger.debug("Conventions projection generated", {
		path: outPath,
		count: conventions.length,
	});

	return outPath;
}

// ============================================================================
// Import: Markdown → DB
// ============================================================================

function buildConventionEntry(
	type: ConventionType,
	content: string,
	detailLines: string[],
): ParsedConventionEntry | null {
	let id = "";
	let confidence = 50;
	let createdAt = Date.now();
	let provenance: ProvenanceLevel = "user_stated";
	let timesApplied = 0;
	let timesViolated = 0;

	for (const line of detailLines) {
		const confidenceMatch = CONFIDENCE_RE.exec(line);
		if (confidenceMatch) {
			confidence = Math.round(parseFloat(confidenceMatch[1]!));
		}

		const createdMatch = CREATED_RE.exec(line);
		if (createdMatch) {
			createdAt = parseDate(createdMatch[1]!);
		}

		const idMatch = ID_RE.exec(line);
		if (idMatch) {
			id = idMatch[1]!;
		}

		const provenanceMatch = PROVENANCE_RE.exec(line);
		if (provenanceMatch) {
			provenance = provenanceMatch[1] as ProvenanceLevel;
		}

		const statsMatch = STATS_RE.exec(line);
		if (statsMatch) {
			timesApplied = parseInt(statsMatch[1]!, 10);
			timesViolated = parseInt(statsMatch[2]!, 10);
		}
	}

	if (!id) {
		id = `${type}-${Bun.hash(content)}`;
	}

	return {
		id,
		type,
		content,
		confidence,
		provenance,
		timesApplied,
		timesViolated,
		createdAt,
		lastSeenAt: Date.now(),
	};
}

/**
 * Parse a conventions.md string into structured entries.
 */
export function parseConventionsMd(md: string): ParsedConventionEntry[] {
	const entries: ParsedConventionEntry[] = [];
	const lines = md.split("\n");

	let currentType: ConventionType | "" = "";
	let currentContent = "";
	let currentDetailLines: string[] = [];
	let inEntry = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();

		// Type heading
		if (trimmed.startsWith("## ") && !trimmed.startsWith("## Thread:")) {
			// Flush any in-progress entry before switching type
			if (inEntry && currentContent) {
				const entry = buildConventionEntry(currentType as ConventionType, currentContent, currentDetailLines);
				if (entry) entries.push(entry);
				inEntry = false;
				currentContent = "";
			}
			currentType = trimmed.slice(3).trim() as ConventionType;
			continue;
		}

		// Entry content line: "- content"
		if (trimmed.startsWith("- ") && !trimmed.startsWith("- Confidence:") && !trimmed.startsWith("- Stats:")) {
			if (inEntry && currentContent) {
				const entry = buildConventionEntry(currentType as ConventionType, currentContent, currentDetailLines);
				if (entry) entries.push(entry);
			}
			currentContent = trimmed.slice(2).trim();
			currentDetailLines = [];
			inEntry = true;
			continue;
		}

		// Detail lines under an entry (indented)
		if (inEntry && (line.startsWith("  ") || line.startsWith("\t"))) {
			currentDetailLines.push(trimmed);
		}
	}

	// Flush final entry
	if (inEntry && currentContent) {
		const entry = buildConventionEntry(currentType as ConventionType, currentContent, currentDetailLines);
		if (entry) entries.push(entry);
	}

	return entries;
}

/**
 * Import parsed convention entries into the database.
 * Uses "user-edited" as source_episode_id for imported entries.
 */
export function importConventionEntries(
	db: Database,
	entries: ParsedConventionEntry[],
): { imported: number; updated: number } {
	let imported = 0;
	let updated = 0;

	const stmt = db.prepare(`
		INSERT INTO conventions (
			id, type, content, source_episode_id, confidence,
			times_applied, times_violated, created_at, last_seen_at, provenance
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			type = excluded.type,
			content = excluded.content,
			confidence = excluded.confidence,
			times_applied = excluded.times_applied,
			times_violated = excluded.times_violated,
			last_seen_at = excluded.last_seen_at,
			provenance = excluded.provenance
	`);

	for (const entry of entries) {
		const existing = db.prepare("SELECT id FROM conventions WHERE id = ?").get(entry.id) as
			| { id?: string }
			| undefined;

		stmt.run(
			entry.id,
			entry.type,
			entry.content,
			"user-edited",
			entry.confidence,
			entry.timesApplied,
			entry.timesViolated,
			entry.createdAt,
			entry.lastSeenAt,
			entry.provenance,
		);

		if (existing) {
			updated++;
		} else {
			imported++;
		}
	}

	stmt.finalize();
	return { imported, updated };
}

/**
 * Delete DB entries not in the provided ID set.
 */
export function deleteMissingConventions(db: Database, ids: Set<string>): number {
	const allRows = db.prepare("SELECT id FROM conventions").all() as Array<{ id: string }>;
	let deleted = 0;
	const stmt = db.prepare("DELETE FROM conventions WHERE id = ?");
	for (const row of allRows) {
		if (!ids.has(row.id)) {
			stmt.run(row.id);
			deleted++;
		}
	}
	stmt.finalize();
	return deleted;
}

/**
 * Main entry point: read conventions.md, parse it, and sync into the database.
 */
export async function importConventionsMd(
	db: Database,
	mdPath: string,
	options: ConventionImportOptions = {},
): Promise<ConventionImportResult> {
	let md: string;
	try {
		md = await Bun.file(mdPath).text();
	} catch (_err) {
		logger.warn("conventions.md not found for import", { path: mdPath });
		return { imported: 0, updated: 0, unchanged: 0, deleted: 0, entries: [] };
	}

	const entries = parseConventionsMd(md);
	const { imported, updated } = importConventionEntries(db, entries);
	const unchanged = Math.max(0, entries.length - imported - updated);

	let deleted = 0;
	if (options.sync) {
		const ids = new Set(entries.map(e => e.id));
		deleted = deleteMissingConventions(db, ids);
	}

	logger.debug("conventions.md import complete", {
		path: mdPath,
		entries: entries.length,
		imported,
		updated,
		unchanged,
		deleted,
	});

	return { imported, updated, unchanged, deleted, entries };
}
