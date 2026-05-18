/**
 * UserProfiler: incremental user behavioral profiling.
 */

import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionTrace, UserProfile } from "./types";

function getFileExtension(path: string): string | undefined {
	const match = path.match(/\.([a-zA-Z0-9]+)$/);
	return match ? match[1].toLowerCase() : undefined;
}

function extensionToLanguage(ext: string): string | undefined {
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		rs: "rust",
		py: "python",
		go: "go",
		java: "java",
		kotlin: "kotlin",
		swift: "swift",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		h: "cpp",
		hpp: "cpp",
		c: "c",
		cs: "csharp",
		rb: "ruby",
		php: "php",
		scala: "scala",
		r: "r",
		sh: "shell",
		bash: "shell",
		zsh: "shell",
		md: "markdown",
		yml: "yaml",
		yaml: "yaml",
		json: "json",
		toml: "toml",
	};
	return map[ext];
}

export class UserProfiler {
	#profile: UserProfile;

	constructor(profile?: UserProfile) {
		this.#profile = profile ?? this.#makeDefaultProfile();
	}

	getProfile(): UserProfile {
		return { ...this.#profile };
	}

	updateProfile(trace: SessionTrace, intent: string): void {
		this.#profile.sessionCount++;
		this.#profile.updatedAt = Date.now();

		// Tool frequency
		const toolCalls = trace.entries.filter(e => e.type === "tool_call" && e.toolName);
		for (const entry of toolCalls) {
			const tool = entry.toolName!;
			this.#profile.toolFrequency[tool] = (this.#profile.toolFrequency[tool] ?? 0) + 1;
		}

		// Tool transitions
		const toolNames = toolCalls.map(e => e.toolName!);
		for (let i = 0; i < toolNames.length - 1; i++) {
			const transition = `${toolNames[i]}→${toolNames[i + 1]}`;
			this.#profile.toolTransitions[transition] = (this.#profile.toolTransitions[transition] ?? 0) + 1;
		}

		// Intent distribution
		this.#profile.intentDistribution[intent] = (this.#profile.intentDistribution[intent] ?? 0) + 1;

		// Averages
		const prevCount = this.#profile.sessionCount - 1;
		this.#profile.avgToolCallsPerSession =
			(this.#profile.avgToolCallsPerSession * prevCount + trace.toolCallCount) / this.#profile.sessionCount;

		const filesModified = new Set<string>();
		for (const entry of toolCalls) {
			if (["write", "edit", "ast_edit"].includes(entry.toolName!)) {
				const p = (entry.args as Record<string, unknown>)?.path;
				if (typeof p === "string") filesModified.add(p);
			}
		}
		this.#profile.avgFilesModifiedPerSession =
			(this.#profile.avgFilesModifiedPerSession * prevCount + filesModified.size) / this.#profile.sessionCount;

		// Error rate: use actual error count, not binary per-session flag
		const totalErrors = this.#profile.errorRate * prevCount + trace.errorCount;
		this.#profile.errorRate = totalErrors / this.#profile.sessionCount;

		// Recovery rate
		const totalRecoveries = this.#profile.recoveryRate * prevCount + (trace.hadRecovery ? 1 : 0);
		this.#profile.recoveryRate = totalRecoveries / this.#profile.sessionCount;

		// Preferred languages
		for (const file of filesModified) {
			const ext = getFileExtension(file);
			if (ext) {
				const lang = extensionToLanguage(ext);
				if (lang && !this.#profile.preferredLanguages.includes(lang)) {
					this.#profile.preferredLanguages.push(lang);
				}
			}
		}
	}

	serialize(): string {
		return JSON.stringify(this.#profile);
	}

	static deserialize(json: string): UserProfiler {
		const profile = JSON.parse(json) as UserProfile;
		return new UserProfiler(profile);
	}

	#makeDefaultProfile(): UserProfile {
		return {
			toolFrequency: {},
			toolTransitions: {},
			intentDistribution: {},
			avgToolCallsPerSession: 0,
			avgFilesModifiedPerSession: 0,
			errorRate: 0,
			recoveryRate: 0,
			preferredLanguages: [],
			sessionCount: 0,
			updatedAt: Date.now(),
		};
	}
}
// ============================================================================
// Rolling window aggregation + projection
// ============================================================================

export interface RollingWindowStats {
	days: number;
	sessionCount: number;
	successRate: number;
	errorRate: number;
	recoveryRate: number;
	avgToolCalls: number;
	avgDurationMs: number;
	topIntents: Array<{ intent: string; count: number }>;
	topTools: Array<{ tool: string; count: number }>;
}

export interface UserProfileProjectionOptions {
	outputDir: string;
	windows?: number[];
}

function queryEpisodesForWindow(
	db: Database,
	days: number,
): {
	sessionCount: number;
	successCount: number;
	totalErrors: number;
	totalRecoveries: number;
	totalToolCalls: number;
	totalDurationMs: number;
	intentRows: Array<{ intent: string; count: number }>;
	toolRows: Array<{ tool: string; count: number }>;
} {
	const since = Date.now() - days * 24 * 60 * 60 * 1000;

	const summary = db
		.prepare(
			`SELECT
				COUNT(*) as session_count,
				SUM(completed_successfully) as success_count,
				SUM(error_count) as total_errors,
				SUM(had_recovery) as total_recoveries,
				SUM(tool_call_count) as total_tool_calls,
				SUM(duration_ms) as total_duration_ms
			FROM episodes WHERE timestamp >= ?`,
		)
		.get(since) as {
		session_count: number;
		success_count: number;
		total_errors: number;
		total_recoveries: number;
		total_tool_calls: number;
		total_duration_ms: number;
	};

	const intentRows = db
		.prepare(
			`SELECT intent, COUNT(*) as count FROM episode_intents
			WHERE episode_id IN (SELECT id FROM episodes WHERE timestamp >= ?)
			GROUP BY intent ORDER BY count DESC LIMIT 5`,
		)
		.all(since) as Array<{ intent: string; count: number }>;

	// Parse tools_used from episodes (comma-separated in the table)
	const toolRows: Array<{ tool: string; count: number }> = [];
	const episodeRows = db.prepare("SELECT tools_used FROM episodes WHERE timestamp >= ?").all(since) as Array<{
		tools_used: string;
	}>;
	const toolCounts = new Map<string, number>();
	for (const row of episodeRows) {
		for (const tool of row.tools_used
			.split(",")
			.map(t => t.trim())
			.filter(Boolean)) {
			toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
		}
	}
	for (const [tool, count] of toolCounts) {
		toolRows.push({ tool, count });
	}
	toolRows.sort((a, b) => b.count - a.count);
	toolRows.splice(5);

	return {
		sessionCount: summary.session_count ?? 0,
		successCount: summary.success_count ?? 0,
		totalErrors: summary.total_errors ?? 0,
		totalRecoveries: summary.total_recoveries ?? 0,
		totalToolCalls: summary.total_tool_calls ?? 0,
		totalDurationMs: summary.total_duration_ms ?? 0,
		intentRows,
		toolRows,
	};
}

export function computeRollingWindowStats(db: Database, days: number): RollingWindowStats {
	const raw = queryEpisodesForWindow(db, days);
	const count = raw.sessionCount || 1; // avoid div by zero

	return {
		days,
		sessionCount: raw.sessionCount,
		successRate: raw.sessionCount > 0 ? raw.successCount / raw.sessionCount : 0,
		errorRate: raw.sessionCount > 0 ? raw.totalErrors / count : 0,
		recoveryRate: raw.sessionCount > 0 ? raw.totalRecoveries / count : 0,
		avgToolCalls: raw.sessionCount > 0 ? raw.totalToolCalls / count : 0,
		avgDurationMs: raw.sessionCount > 0 ? raw.totalDurationMs / count : 0,
		topIntents: raw.intentRows,
		topTools: raw.toolRows,
	};
}

function renderDistribution(title: string, data: Record<string, number>, options?: { maxItems?: number }): string {
	const maxItems = options?.maxItems ?? 10;
	const sorted = Object.entries(data)
		.sort((a, b) => b[1] - a[1])
		.slice(0, maxItems);
	if (sorted.length === 0) return "";
	const lines = [`### ${title}`, ""];
	for (const [key, value] of sorted) {
		lines.push(`- ${key}: ${value}`);
	}
	lines.push("");
	return lines.join("\n");
}

function renderRollingWindow(stats: RollingWindowStats): string {
	const lines = [`### Last ${stats.days} days`, ""];
	lines.push(`- Sessions: ${stats.sessionCount}`);
	lines.push(`- Success rate: ${(stats.successRate * 100).toFixed(1)}%`);
	lines.push(`- Avg tool errors/session: ${stats.errorRate.toFixed(1)}`);
	lines.push(`- Recovery rate: ${(stats.recoveryRate * 100).toFixed(1)}%`);
	lines.push(`- Avg tool calls: ${stats.avgToolCalls.toFixed(1)}`);
	lines.push(`- Avg duration: ${(stats.avgDurationMs / 1000).toFixed(1)}s`);
	if (stats.topIntents.length > 0) {
		lines.push(`- Top intents: ${stats.topIntents.map(i => `${i.intent} (${i.count})`).join(", ")}`);
	}
	if (stats.topTools.length > 0) {
		lines.push(`- Top tools: ${stats.topTools.map(t => `${t.tool} (${t.count})`).join(", ")}`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Generate user_profile.md from a UserProfile and optional rolling window stats.
 */
export function generateUserProfileMd(profile: UserProfile, rollingStats?: RollingWindowStats[]): string {
	const lines: string[] = ["# User Profile", ""];
	lines.push(`Last updated: ${new Date(profile.updatedAt).toISOString()}`, "");

	lines.push("## Overview", "");
	lines.push(`- Total sessions: ${profile.sessionCount}`);
	lines.push(`- Avg tool calls / session: ${profile.avgToolCallsPerSession.toFixed(1)}`);
	lines.push(`- Avg files modified / session: ${profile.avgFilesModifiedPerSession.toFixed(1)}`);
	lines.push(`- Avg tool errors/session: ${profile.errorRate.toFixed(1)}`);
	lines.push(`- Recovery rate: ${(profile.recoveryRate * 100).toFixed(1)}%`);
	lines.push(`- Preferred languages: ${profile.preferredLanguages.join(", ") || "none"}`);
	lines.push("");

	if (rollingStats && rollingStats.length > 0) {
		lines.push("## Rolling Windows", "");
		for (const stats of rollingStats) {
			lines.push(renderRollingWindow(stats));
		}
	}

	lines.push(renderDistribution("Tool Frequency", profile.toolFrequency));
	lines.push(renderDistribution("Tool Transitions", profile.toolTransitions));
	lines.push(renderDistribution("Intent Distribution", profile.intentDistribution));

	lines.push("---", `*Generated on ${new Date().toISOString()}*`);
	return lines.join("\n");
}

/**
 * Main entry point: read profile from DB, compute rolling windows, write user_profile.md.
 */
export async function projectUserProfile(db: Database, options: UserProfileProjectionOptions): Promise<string> {
	const profileRow = db.prepare("SELECT profile_json FROM user_profiles WHERE id = 'default'").get() as
		| { profile_json: string }
		| undefined;

	let profile: UserProfile | undefined;
	if (profileRow) {
		try {
			profile = JSON.parse(profileRow.profile_json) as UserProfile;
		} catch {
			profile = undefined;
		}
	}

	const windows = options.windows ?? [7, 30, 90];
	const rollingStats = windows.map(days => computeRollingWindowStats(db, days));

	const md = generateUserProfileMd(profile ?? makeDefaultProfile(), rollingStats);
	const outPath = path.join(options.outputDir, "user_profile.md");
	await Bun.write(outPath, md);

	logger.debug("User profile projected", {
		path: outPath,
		windows: windows.length,
		hasProfile: !!profile,
	});

	return outPath;
}

function makeDefaultProfile(): UserProfile {
	return {
		toolFrequency: {},
		toolTransitions: {},
		intentDistribution: {},
		avgToolCallsPerSession: 0,
		avgFilesModifiedPerSession: 0,
		errorRate: 0,
		recoveryRate: 0,
		preferredLanguages: [],
		sessionCount: 0,
		updatedAt: Date.now(),
	};
}
