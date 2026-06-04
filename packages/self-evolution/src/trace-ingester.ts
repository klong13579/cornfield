/**
 * ExternalTraceIngester — consume tool-execution JSONL from external pipelines.
 *
 * External environments (Cursor, IDE plugins, CI scripts) write JSONL to
 * ~/.omp/traces/external/<sessionId>.jsonl in a subset of the omp session format.
 * This module scans for completed files (containing a "session_end" marker),
 * parses them into SessionTraces, and feeds them into the evolution pipeline
 * (episode store, trace store, session learner, etc.).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveExternalTraceDir } from "./paths";
import { parseOmpSessionJsonlToTrace } from "./regression/omp-session-to-trace";
import type { Episode, SessionTrace } from "./types";

export interface ExternalTraceScanResult {
	scanned: number;
	completed: number;
	ingested: number;
	skipped: number;
	errors: string[];
	skippedIds: string[];
}

/**
 * Scan the external trace directory for completed JSONL files and return
 * those that have not yet been ingested.
 *
 * A file is considered "completed" when it contains a "session_end" line.
 * A file is considered "already ingested" when a matching session_trace
 * exists in the trace store (caller provides the check).
 */
export async function scanExternalTraceFiles(): Promise<Array<{ filePath: string; sessionId: string }>> {
	const dir = resolveExternalTraceDir();
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err: unknown) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") {
			// Directory doesn't exist yet — nothing to scan
			return [];
		}
		throw err;
	}

	const results: Array<{ filePath: string; sessionId: string }> = [];
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const filePath = path.join(dir, name);
		const sessionId = name.slice(0, -6); // strip .jsonl
		results.push({ filePath, sessionId });
	}
	return results;
}

/**
 * Check whether a JSONL file contains a "session_end" line (quick pre-scan).
 * Reads only the last 2KB as an optimization.
 */
async function hasSessionEndMarker(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		const readSize = Math.min(stat.size, 2048);
		const fd = await fs.open(filePath, "r");
		const buffer = Buffer.alloc(readSize);
		await fd.read(buffer, 0, readSize, Math.max(0, stat.size - readSize));
		await fd.close();
		return buffer.toString("utf-8").includes('"session_end"');
	} catch {
		return false;
	}
}

/**
 * Parse a single external trace JSONL file into a SessionTrace.
 * Returns undefined if the file is empty or malformed.
 */
export async function parseExternalTraceFile(
	filePath: string,
	sessionId: string,
	cwd: string,
): Promise<SessionTrace | undefined> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		logger.debug("Failed to read external trace file", { filePath, error: String(err) });
		return undefined;
	}

	// Build a minimal Episode stub for the parser
	const now = Date.now();
	const episode: Episode = {
		id: `${sessionId}-${now}`,
		sessionId,
		cwd,
		userPrompt: "",
		timestamp: now,
		durationMs: 0,
		toolCallCount: 0,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: false,
		summary: "",
		toolsUsed: [],
		filesModified: [],
	};

	const trace = parseOmpSessionJsonlToTrace(text, episode);
	if (!trace) return undefined;

	// Mark as external source
	trace.source = "external";
	return trace;
}

/**
 * Ingest completed external traces into the evolution pipeline.
 *
 * @param checkNotIngested - callback returning true if sessionId is NOT yet ingested
 * @param onTraceReady   - callback to persist the parsed trace (episode + trace store + learner)
 */
export async function ingestExternalTraces(
	checkNotIngested: (sessionId: string) => boolean | Promise<boolean>,
	onTraceReady: (trace: SessionTrace) => Promise<void>,
): Promise<ExternalTraceScanResult> {
	const result: ExternalTraceScanResult = {
		scanned: 0,
		completed: 0,
		ingested: 0,
		skipped: 0,
		errors: [],
		skippedIds: [],
	};

	const files = await scanExternalTraceFiles();
	result.scanned = files.length;

	for (const { filePath, sessionId } of files) {
		// Skip already-ingested
		const notIngested = await checkNotIngested(sessionId);
		if (!notIngested) {
			result.skipped++;
			result.skippedIds.push(sessionId);
			continue;
		}

		// Check session_end marker
		if (!(await hasSessionEndMarker(filePath))) {
			continue;
		}
		result.completed++;

		// Derive cwd from filepath — external traces are per-session flat files
		const cwd = process.cwd();

		const trace = await parseExternalTraceFile(filePath, sessionId, cwd);
		if (!trace) {
			result.errors.push(`Failed to parse: ${sessionId}`);
			continue;
		}

		try {
			await onTraceReady(trace);
			result.ingested++;

			// Archive processed file
			const archiveDir = path.join(path.dirname(filePath), "archived");
			await fs.mkdir(archiveDir, { recursive: true });
			const archivePath = path.join(archiveDir, `${sessionId}.jsonl`);
			await fs.rename(filePath, archivePath);
		} catch (err) {
			result.errors.push(`Ingestion failed for ${sessionId}: ${String(err)}`);
		}
	}

	return result;
}
