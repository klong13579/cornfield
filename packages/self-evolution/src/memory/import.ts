/**
 * Reverse import: parse user-edited MEMORY.md and sync changes back into the database.
 *
 * Reads the markdown format produced by projection.ts and upserts entries
 * into the vector_embeddings table.
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { insertVectorEmbedding } from "./storage";

export interface ParsedMemoryEntry {
	id: string;
	namespace: string;
	content: string;
	importance: number;
	lastAccessedAt: number;
	metadata?: Record<string, unknown>;
}

export interface ImportResult {
	imported: number;
	updated: number;
	unchanged: number;
	deleted: number;
	entries: ParsedMemoryEntry[];
}

export interface ImportOptions {
	/** If true, delete DB entries not present in the markdown file */
	sync?: boolean;
}

const IMPORTANCE_RE = /Importance:\s*(\d+(?:\.\d+)?)%/;
const LAST_ACCESSED_RE = /Last accessed:\s*(\d{4}-\d{2}-\d{2})/;
const ID_RE = /ID:\s*`([^`]+)`/;
const METADATA_RE = /Metadata:\s*(.+)/;

function parseDate(dateStr: string): number {
	return new Date(dateStr).getTime();
}

function parseMetadata(line: string): Record<string, unknown> | undefined {
	const match = METADATA_RE.exec(line);
	if (!match) return undefined;

	const result: Record<string, unknown> = {};
	const pairs = match[1]!.split(",");
	for (const pair of pairs) {
		const [k, ...v] = pair.split("=");
		if (k && v.length > 0) {
			const key = k.trim();
			const value = v.join("=").trim();
			// Try to parse as number or boolean
			if (/^-?\d+(\.\d+)?$/.test(value)) {
				result[key] = value.includes(".") ? parseFloat(value) : parseInt(value, 10);
			} else if (value === "true" || value === "false") {
				result[key] = value === "true";
			} else {
				result[key] = value;
			}
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse a MEMORY.md string into structured entries grouped by namespace.
 */
export function parseMemoryMd(md: string): ParsedMemoryEntry[] {
	const entries: ParsedMemoryEntry[] = [];
	const lines = md.split("\n");

	let currentNamespace = "";
	let currentContent = "";
	let currentDetailLines: string[] = [];
	let inEntry = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();

		// Namespace heading
		if (trimmed.startsWith("## ") && !trimmed.startsWith("## Thread:")) {
			// Flush any in-progress entry before switching namespace
			if (inEntry && currentContent) {
				const entry = buildEntry(currentNamespace, currentContent, currentDetailLines);
				if (entry) entries.push(entry);
				inEntry = false;
				currentContent = "";
			}
			currentNamespace = trimmed.slice(3).trim();
			continue;
		}

		// Entry content line: "- content"
		if (trimmed.startsWith("- ") && !trimmed.startsWith("- Importance:") && !trimmed.startsWith("- Metadata:")) {
			// Flush previous entry if any
			if (inEntry && currentContent) {
				const entry = buildEntry(currentNamespace, currentContent, currentDetailLines);
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
		const entry = buildEntry(currentNamespace, currentContent, currentDetailLines);
		if (entry) entries.push(entry);
	}

	return entries;
}

function buildEntry(namespace: string, content: string, detailLines: string[]): ParsedMemoryEntry | null {
	let id = "";
	let importance = 0.5;
	let lastAccessedAt = Date.now();
	let metadata: Record<string, unknown> | undefined;

	for (const line of detailLines) {
		const importanceMatch = IMPORTANCE_RE.exec(line);
		if (importanceMatch) {
			importance = parseFloat(importanceMatch[1]!) / 100;
		}

		const lastAccessedMatch = LAST_ACCESSED_RE.exec(line);
		if (lastAccessedMatch) {
			lastAccessedAt = parseDate(lastAccessedMatch[1]!);
		}

		const idMatch = ID_RE.exec(line);
		if (idMatch) {
			id = idMatch[1]!;
		}

		const metadataLine = parseMetadata(line);
		if (metadataLine) {
			metadata = metadataLine;
		}
	}

	// If no ID was found, generate a deterministic one from namespace + content hash
	if (!id) {
		id = `${namespace}-${Bun.hash(content)}`;
	}

	return {
		id,
		namespace,
		content,
		importance,
		lastAccessedAt,
		metadata,
	};
}

/**
 * Import parsed entries into the vector_embeddings table.
 * Uses an empty embedding array as placeholder (embedding must be recomputed
 * by a separate pass for vector similarity search to work).
 */
export function importMemoryEntries(db: Database, entries: ParsedMemoryEntry[]): { imported: number; updated: number } {
	let imported = 0;
	let updated = 0;
	const now = Date.now();

	for (const entry of entries) {
		const existing = db.prepare("SELECT id FROM vector_embeddings WHERE id = ?").get(entry.id) as
			| { id?: string }
			| undefined;

		insertVectorEmbedding(db, {
			id: entry.id,
			namespace: entry.namespace,
			content: entry.content,
			embedding: [], // placeholder; vector search requires recomputation
			metadata: entry.metadata,
			importance: entry.importance,
			createdAt: existing ? now : now, // Preserve creation time logic via ON CONFLICT in insertVectorEmbedding
			lastAccessedAt: entry.lastAccessedAt,
		});

		if (existing) {
			updated++;
		} else {
			imported++;
		}
	}

	return { imported, updated };
}

/**
 * Delete DB entries that are not present in the given set of IDs.
 */
export function deleteMissingEntries(db: Database, ids: Set<string>): number {
	const allRows = db.prepare("SELECT id FROM vector_embeddings").all() as Array<{ id: string }>;
	let deleted = 0;
	const stmt = db.prepare("DELETE FROM vector_embeddings WHERE id = ?");
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
 * Main entry point: read MEMORY.md, parse it, and sync into the database.
 */
export async function importMemoryMd(db: Database, mdPath: string, options: ImportOptions = {}): Promise<ImportResult> {
	let md: string;
	try {
		md = await Bun.file(mdPath).text();
	} catch (_err) {
		logger.warn("MEMORY.md not found for import", { path: mdPath });
		return { imported: 0, updated: 0, unchanged: 0, deleted: 0, entries: [] };
	}

	const entries = parseMemoryMd(md);
	const { imported, updated } = importMemoryEntries(db, entries);

	// Entries with matching content and importance are counted as unchanged
	// (importMemoryEntries uses ON CONFLICT DO UPDATE, so we don't have a clean
	// unchanged count from SQLite; approximate it).
	const unchanged = Math.max(0, entries.length - imported - updated);

	let deleted = 0;
	if (options.sync) {
		const ids = new Set(entries.map(e => e.id));
		deleted = deleteMissingEntries(db, ids);
	}

	logger.debug("MEMORY.md import complete", {
		path: mdPath,
		entries: entries.length,
		imported,
		updated,
		unchanged,
		deleted,
	});

	return { imported, updated, unchanged, deleted, entries };
}
