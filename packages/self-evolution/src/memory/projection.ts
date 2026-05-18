/**
 * Projection of memory contents to markdown files.
 *
 * Generates MEMORY.md (full report) and memory_summary.md (condensed view)
 * from vector_embeddings table data.
 */
import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

export interface ProjectionOptions {
	memoryRoot: string;
	includeRawMemories?: boolean;
	maxEntriesPerSection?: number;
	/** Importance threshold for summary inclusion (default: 0.7) */
	summaryImportanceThreshold?: number;
}

export interface MemorySection {
	namespace: string;
	entries: Array<{
		id: string;
		content: string;
		importance: number;
		metadata?: Record<string, unknown>;
		lastAccessedAt: number;
	}>;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_SUMMARY_THRESHOLD = 0.7;

function formatDate(ts: number): string {
	return new Date(ts).toISOString().split("T")[0]!;
}

/**
 * Generate full MEMORY.md content from sections.
 */
export function generateMemoryMd(sections: MemorySection[], options?: { maxEntriesPerSection?: number }): string {
	const maxEntries = options?.maxEntriesPerSection ?? DEFAULT_MAX_ENTRIES;
	const lines: string[] = ["# Memory Report", ""];

	for (const section of sections) {
		lines.push(`## ${section.namespace}`, "");

		const sorted = section.entries.sort((a, b) => b.importance - a.importance).slice(0, maxEntries);

		for (const entry of sorted) {
			lines.push(`- ${entry.content}`);
			lines.push(
				`  - Importance: ${(entry.importance * 100).toFixed(0)}% | Last accessed: ${formatDate(entry.lastAccessedAt)} | ID: \`${entry.id}\``,
			);
			if (entry.metadata && Object.keys(entry.metadata).length > 0) {
				const metaStr = Object.entries(entry.metadata)
					.map(([k, v]) => `${k}=${String(v)}`)
					.join(", ");
				lines.push(`  - Metadata: ${metaStr}`);
			}
			lines.push("");
		}

		if (section.entries.length > maxEntries) {
			lines.push(`_... and ${section.entries.length - maxEntries} more entries_`, "");
		}
	}

	return lines.join("\n");
}

/**
 * Generate condensed memory_summary.md from sections.
 * Only includes high-importance entries.
 */
export function generateMemorySummary(sections: MemorySection[], options?: { threshold?: number }): string {
	const threshold = options?.threshold ?? DEFAULT_SUMMARY_THRESHOLD;
	const lines: string[] = ["# Memory Summary", "", "High-importance memory entries across all namespaces.", ""];

	let totalIncluded = 0;
	for (const section of sections) {
		const important = section.entries
			.filter(e => e.importance >= threshold)
			.sort((a, b) => b.importance - a.importance);

		if (important.length === 0) continue;

		lines.push(`## ${section.namespace}`, "");
		for (const entry of important) {
			lines.push(`- ${entry.content} (${(entry.importance * 100).toFixed(0)}%)`);
		}
		lines.push("");
		totalIncluded += important.length;
	}

	lines.push("---", `*Generated on ${new Date().toISOString()} | ${totalIncluded} high-importance entries*`, "");

	return lines.join("\n");
}

/**
 * Load sections from the vector_embeddings table.
 */
export function loadSectionsFromDb(db: Database): MemorySection[] {
	const rows = db
		.prepare(
			"SELECT id, namespace, content, metadata_json, importance, last_accessed_at FROM vector_embeddings ORDER BY namespace, importance DESC",
		)
		.all() as Array<{
		id: string;
		namespace: string;
		content: string;
		metadata_json: string | null;
		importance: number;
		last_accessed_at: number;
	}>;

	const sections = new Map<string, MemorySection>();
	for (const row of rows) {
		const section = sections.get(row.namespace) ?? { namespace: row.namespace, entries: [] };
		section.entries.push({
			id: row.id,
			content: row.content,
			importance: row.importance,
			metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
			lastAccessedAt: row.last_accessed_at,
		});
		sections.set(row.namespace, section);
	}

	return Array.from(sections.values());
}

/**
 * Main projection function: generate both MEMORY.md and memory_summary.md.
 */
export async function projectMemory(
	db: Database,
	options: ProjectionOptions,
): Promise<{ memoryPath: string; summaryPath: string }> {
	const sections = loadSectionsFromDb(db);

	const memoryMd = generateMemoryMd(sections, { maxEntriesPerSection: options.maxEntriesPerSection });
	const summaryMd = generateMemorySummary(sections, { threshold: options.summaryImportanceThreshold });

	const memoryPath = path.join(options.memoryRoot, "MEMORY.md");
	const summaryPath = path.join(options.memoryRoot, "memory_summary.md");

	await Bun.write(memoryPath, memoryMd);
	await Bun.write(summaryPath, summaryMd);

	logger.debug("Memory projection generated", {
		memoryPath,
		summaryPath,
		sections: sections.length,
		totalEntries: sections.reduce((sum, s) => sum + s.entries.length, 0),
	});

	return { memoryPath, summaryPath };
}

/**
 * Project raw memory strings (from stage1_outputs) into a single raw memory file.
 * This is used when includeRawMemories is enabled.
 */
export async function projectRawMemories(db: Database, memoryRoot: string): Promise<string | undefined> {
	const rows = db
		.prepare(
			"SELECT thread_id, raw_memory, rollout_summary FROM stage1_outputs WHERE TRIM(COALESCE(raw_memory, '')) != ''",
		)
		.all() as Array<{ thread_id: string; raw_memory: string; rollout_summary: string }>;

	if (rows.length === 0) return undefined;

	const lines: string[] = ["# Raw Memory Dump", ""];
	for (const row of rows) {
		lines.push(`## Thread: ${row.thread_id}`, "", row.raw_memory, "");
		if (row.rollout_summary) {
			lines.push(`**Summary**: ${row.rollout_summary}`, "");
		}
	}

	const rawPath = path.join(memoryRoot, "raw_memories.md");
	await Bun.write(rawPath, lines.join("\n"));
	return rawPath;
}
