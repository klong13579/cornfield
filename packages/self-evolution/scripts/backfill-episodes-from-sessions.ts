#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
/**
 * Re-archive omp session JSONL into project evolution.db (episodes, traces, regression fixtures).
 *
 * Usage:
 *   bun packages/self-evolution/scripts/backfill-episodes-from-sessions.ts [--cwd <repo>] [--limit N] [--per-project]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { refreshBenefitAdmissionState } from "../src/benefit-admission-refresh";
import { projectEvolutionLog } from "../src/logging/evolution-log";
import { resolveEvolutionProjectionDir } from "../src/paths";
import { projectLearnings } from "../src/projection/learnings";
import { projectSystemDiagnosis } from "../src/projection/system-diagnosis";
import { buildRegressionFixtureFromTrace } from "../src/regression/fixture-from-trace";
import { parseOmpSessionJsonlToTrace } from "../src/regression/omp-session-to-trace";
import { closeEvolutionDb, getEvolutionDb, initSchema } from "../src/storage/db";
import { SqliteEpisodeStore } from "../src/storage/episodes";
import { SqliteRegressionFixtureStore } from "../src/storage/regression-fixtures";
import { SqliteSessionTraceStore } from "../src/storage/session-traces";
import { SqliteSkillEffectivenessStore } from "../src/storage/skill-effectiveness";
import { SqliteSkillPopulationStore } from "../src/storage/skill-population";
import { SqliteSkillStore } from "../src/storage/skills";
import { summarizeTrace } from "../src/trace";
import type { Episode } from "../src/types";
import { projectUserProfile } from "../src/user-profiler";

interface SessionJsonlHeader {
	type: "session";
	id: string;
	cwd?: string;
	timestamp?: string;
}

export interface BackfillEpisodesFromSessionsResult {
	scannedFiles: number;
	matchedCwd: number;
	episodesUpserted: number;
	tracesWritten: number;
	fixturesWritten: number;
	parseSkipped: number;
}

function parseTimestamp(iso: string | undefined, fallback: number): number {
	if (!iso) return fallback;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : fallback;
}

function sessionIdFromFilename(fileName: string): string | undefined {
	const match = fileName.match(/_([^.]+)\.jsonl$/);
	return match?.[1];
}

function sameProjectCwd(sessionCwd: string, repoRoot: string): boolean {
	const a = path.resolve(sessionCwd);
	const b = path.resolve(repoRoot);
	return a === b || a.startsWith(`${b}${path.sep}`);
}

async function* iterSessionJsonlFiles(sessionsRoot: string): AsyncGenerator<string> {
	let dirEntries: string[];
	try {
		dirEntries = await fs.readdir(sessionsRoot);
	} catch {
		return;
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
			if (file.endsWith(".jsonl")) {
				yield path.join(dirPath, file);
			}
		}
	}
}

function readSessionHeader(jsonlText: string): SessionJsonlHeader | undefined {
	for (const line of jsonlText.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { type?: string };
			if (parsed.type === "session") {
				return parsed as SessionJsonlHeader;
			}
		} catch {}
	}
	return undefined;
}

function upsertEpisode(db: Database, episode: Episode): void {
	db.prepare(
		`
		INSERT OR REPLACE INTO episodes (
			id, session_id, cwd, user_prompt, timestamp, duration_ms,
			tool_call_count, error_count, had_recovery, completed_successfully,
			summary, tools_used, files_modified
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
	).run(
		episode.id,
		episode.sessionId,
		episode.cwd,
		episode.userPrompt,
		episode.timestamp,
		episode.durationMs,
		episode.toolCallCount,
		episode.errorCount,
		episode.hadRecovery ? 1 : 0,
		episode.completedSuccessfully ? 1 : 0,
		episode.summary,
		JSON.stringify(episode.toolsUsed),
		JSON.stringify(episode.filesModified),
	);
}

export async function backfillEpisodesFromSessions(opts: {
	db: Database;
	repoCwd: string;
	sessionsRoot: string;
	limit?: number;
}): Promise<BackfillEpisodesFromSessionsResult> {
	const { db, repoCwd, sessionsRoot, limit = 500 } = opts;
	const traceStore = new SqliteSessionTraceStore(db);
	const fixtureStore = new SqliteRegressionFixtureStore(db);

	const result: BackfillEpisodesFromSessionsResult = {
		scannedFiles: 0,
		matchedCwd: 0,
		episodesUpserted: 0,
		tracesWritten: 0,
		fixturesWritten: 0,
		parseSkipped: 0,
	};

	for await (const jsonlPath of iterSessionJsonlFiles(sessionsRoot)) {
		if (result.matchedCwd >= limit) break;
		result.scannedFiles++;

		const fileName = path.basename(jsonlPath);
		const sessionId = sessionIdFromFilename(fileName);
		if (!sessionId) {
			result.parseSkipped++;
			continue;
		}

		let text: string;
		try {
			text = await Bun.file(jsonlPath).text();
		} catch {
			result.parseSkipped++;
			continue;
		}

		const header = readSessionHeader(text);
		const sessionCwd = header?.cwd ?? "";
		if (!sessionCwd || !sameProjectCwd(sessionCwd, repoCwd)) {
			continue;
		}
		result.matchedCwd++;

		const startTime = parseTimestamp(header?.timestamp, Date.now());
		const stub: Episode = {
			id: `${sessionId}-${startTime}`,
			sessionId,
			cwd: sessionCwd,
			userPrompt: "",
			timestamp: startTime,
			durationMs: 0,
			toolCallCount: 0,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: true,
			summary: "",
			toolsUsed: [],
			filesModified: [],
		};

		const trace = parseOmpSessionJsonlToTrace(text, stub);
		if (!trace) {
			result.parseSkipped++;
			continue;
		}

		const { summary, toolsUsed, filesModified } = summarizeTrace(trace);
		const episode: Episode = {
			id: stub.id,
			sessionId,
			cwd: trace.cwd,
			userPrompt: trace.userPrompt,
			timestamp: trace.startTime,
			durationMs: Math.max(0, trace.endTime - trace.startTime),
			toolCallCount: trace.toolCallCount,
			errorCount: trace.errorCount,
			hadRecovery: trace.hadRecovery,
			completedSuccessfully: trace.completedSuccessfully,
			summary,
			toolsUsed,
			filesModified,
		};

		upsertEpisode(db, episode);
		result.episodesUpserted++;

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

const cwdIdx = process.argv.indexOf("--cwd");
const repoCwd = cwdIdx >= 0 ? path.resolve(process.argv[cwdIdx + 1] ?? process.cwd()) : process.cwd();
const globalStore = !process.argv.includes("--per-project");
const limitArg = process.argv.find(a => /^\d+$/.test(a));
const limit = limitArg ? Number.parseInt(limitArg, 10) : 500;
const db = getEvolutionDb(repoCwd, globalStore);
initSchema(db);

const outputDir = resolveEvolutionProjectionDir(repoCwd, globalStore);

const backfill = await backfillEpisodesFromSessions({
	db,
	repoCwd,
	sessionsRoot: getSessionsDir(),
	limit,
});

const admission = await refreshBenefitAdmissionState({
	skillStore: new SqliteSkillStore(db),
	skillEffectivenessStore: new SqliteSkillEffectivenessStore(db),
	populationStore: new SqliteSkillPopulationStore(db),
});

await projectLearnings(db, { outputDir });
const activityLogPath = path.join(outputDir, "activity.log");
await projectEvolutionLog(activityLogPath, { outputDir }).catch(() => undefined);
await projectUserProfile(db, { outputDir });
const episodeStore = new SqliteEpisodeStore(db);
await projectSystemDiagnosis(db, {
	outputDir,
	maxEpisodes: 500,
	episodeStore,
	skillStore: new SqliteSkillStore(db),
});

const counts = db
	.prepare(
		`SELECT
			(SELECT COUNT(*) FROM episodes) AS episodes,
			(SELECT COUNT(*) FROM session_traces) AS traces,
			(SELECT COUNT(*) FROM regression_fixtures) AS fixtures`,
	)
	.get() as { episodes: number; traces: number; fixtures: number };

console.log(
	JSON.stringify(
		{
			repoCwd,
			globalStore,
			backfill,
			admission,
			counts,
			outputDir,
		},
		null,
		2,
	),
);

closeEvolutionDb(repoCwd, globalStore);
