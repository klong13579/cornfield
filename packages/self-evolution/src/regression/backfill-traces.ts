/**
 * Backfill session_traces (+ regression_fixtures) from archived episodes and omp session JSONL.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { EpisodeStore, RegressionFixtureStore, SessionTraceStore } from "../storage/types";
import type { Episode, SessionTrace } from "../types";
import { buildRegressionFixtureFromTrace } from "./fixture-from-trace";
import { parseOmpSessionJsonlToTrace } from "./omp-session-to-trace";

export interface BackfillSessionTracesResult {
	scanned: number;
	tracesWritten: number;
	tracesUpgraded: number;
	fixturesWritten: number;
	jsonlMisses: number;
	skippedExisting: number;
}

function toolEntryCount(trace: SessionTrace): number {
	return trace.entries.filter(e => e.type === "tool_call" || e.type === "tool_result").length;
}

function shouldUpgradeTraceFromJsonl(existing: SessionTrace, parsedFromJsonl: SessionTrace): boolean {
	return toolEntryCount(parsedFromJsonl) > toolEntryCount(existing);
}

export async function findOmpSessionJsonlPath(sessionsRoot: string, sessionId: string): Promise<string | undefined> {
	const suffix = `_${sessionId}.jsonl`;
	let dirEntries: string[];
	try {
		dirEntries = await fs.readdir(sessionsRoot);
	} catch {
		return undefined;
	}

	for (const dirName of dirEntries) {
		const dirPath = path.join(sessionsRoot, dirName);
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(dirPath);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;

		let files: string[];
		try {
			files = await fs.readdir(dirPath);
		} catch {
			continue;
		}

		for (const file of files) {
			if (file.endsWith(suffix)) {
				return path.join(dirPath, file);
			}
		}
	}
	return undefined;
}

/**
 * Prefer omp session JSONL when it has richer tool chains than the in-memory trace.
 */
export async function hydrateSessionTraceFromJsonlIfRicher(
	trace: SessionTrace,
	episode: Episode,
	sessionsRoot: string,
): Promise<SessionTrace> {
	const jsonlPath = await findOmpSessionJsonlPath(sessionsRoot, episode.sessionId);
	if (!jsonlPath) return trace;
	try {
		const text = await Bun.file(jsonlPath).text();
		const parsed = parseOmpSessionJsonlToTrace(text, episode);
		if (parsed && shouldUpgradeTraceFromJsonl(trace, parsed)) {
			return { ...parsed, backgroundModel: trace.backgroundModel ?? parsed.backgroundModel };
		}
	} catch (err) {
		logger.debug("hydrateSessionTraceFromJsonlIfRicher failed", {
			sessionId: episode.sessionId,
			error: String(err),
		});
	}
	return trace;
}

function syntheticTraceFromEpisode(episode: Episode): SessionTrace {
	return {
		sessionId: episode.sessionId,
		cwd: episode.cwd,
		userPrompt: episode.userPrompt,
		startTime: episode.timestamp,
		endTime: episode.timestamp + episode.durationMs,
		entries: [],
		toolCallCount: episode.toolCallCount,
		errorCount: episode.errorCount,
		hadRecovery: episode.hadRecovery,
		completedSuccessfully: episode.completedSuccessfully,
	};
}

export async function backfillSessionTracesFromEpisodes(opts: {
	episodeStore: EpisodeStore;
	traceStore: SessionTraceStore;
	fixtureStore: RegressionFixtureStore;
	sessionsRoot: string;
	limit?: number;
	skipExisting?: boolean;
}): Promise<BackfillSessionTracesResult> {
	const { episodeStore, traceStore, fixtureStore, sessionsRoot, limit = 200, skipExisting = true } = opts;

	const episodes = await episodeStore.listRecent(limit);
	const result: BackfillSessionTracesResult = {
		scanned: episodes.length,
		tracesWritten: 0,
		tracesUpgraded: 0,
		fixturesWritten: 0,
		jsonlMisses: 0,
		skippedExisting: 0,
	};

	for (const episode of episodes) {
		const existing = await traceStore.getBySessionId(episode.sessionId);

		let parsedFromJsonl: SessionTrace | undefined;
		const jsonlPath = await findOmpSessionJsonlPath(sessionsRoot, episode.sessionId);
		if (jsonlPath) {
			try {
				const text = await Bun.file(jsonlPath).text();
				parsedFromJsonl = parseOmpSessionJsonlToTrace(text, episode);
			} catch (err) {
				logger.debug("Backfill: failed to parse session jsonl", { jsonlPath, error: String(err) });
			}
		}

		if (existing && parsedFromJsonl && shouldUpgradeTraceFromJsonl(existing, parsedFromJsonl)) {
			await traceStore.upsert(parsedFromJsonl, episode.id);
			result.tracesUpgraded++;
			const fixture = buildRegressionFixtureFromTrace(parsedFromJsonl, episode.id);
			if (fixture) {
				await fixtureStore.insert(fixture);
			}
			continue;
		}

		if (skipExisting && existing) {
			result.skippedExisting++;
			continue;
		}

		let trace: SessionTrace | undefined = parsedFromJsonl;
		if (!trace) {
			result.jsonlMisses++;
			trace = syntheticTraceFromEpisode(episode);
		}

		await traceStore.upsert(trace, episode.id);
		result.tracesWritten++;

		const fixture = buildRegressionFixtureFromTrace(trace, episode.id);
		if (fixture) {
			await fixtureStore.insert(fixture);
			result.fixturesWritten++;
		}
	}

	return result;
}
