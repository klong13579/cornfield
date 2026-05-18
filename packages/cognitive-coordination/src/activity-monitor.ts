/**
 * Activity Log Monitor
 *
 * Analyzes activity logs to identify trends in skill usage, error rates, and decay patterns.
 */
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Activity log entry types
 */
export interface EvolutionFitEvent {
	type: "evolution-fit";
	timestamp: string;
	score: number;
}

export interface ToolErrorEvent {
	type: "tool_error";
	timestamp: string;
	tool: string;
	error?: string;
}

export interface SkillUsageEvent {
	type: "skill_usage";
	timestamp: string;
	skill_name: string;
	skill_usage_count: number;
}

export type ActivityLogEntry = EvolutionFitEvent | ToolErrorEvent | SkillUsageEvent;

/**
 * Skill decay entry
 */
export interface SkillDecayEntry {
	skillName: string;
	lastUsedAt: string | null;
	daysSinceLastUse: number;
}

/**
 * Trend report containing activity analysis
 */
export interface TrendReport {
	/** Moving average of evolution-fit scores over the last 7 days */
	fitScoreTrend: {
		scores: number[];
		average: number;
		dateRange: { start: string; end: string };
	};
	/** Skills with no usage for > 3 days */
	skillDecay: SkillDecayEntry[];
	/** Ratio of tool_error events to total events */
	errorRate: {
		errorCount: number;
		totalEvents: number;
		rate: number;
	};
	/** Analysis timestamp */
	analyzedAt: string;
}

/**
 * Parse a JSONL line, returning null for invalid JSON
 */
function parseJsonlLine(line: string): ActivityLogEntry | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as ActivityLogEntry;
	} catch {
		return null;
	}
}

/**
 * Extract date from timestamp string (ISO format or Unix timestamp)
 */
function extractDate(timestamp: string): string | null {
	const isoDate = new Date(timestamp);
	if (!Number.isNaN(isoDate.getTime())) {
		return isoDate.toISOString().split("T")[0];
	}

	const unix = Number(timestamp);
	if (!Number.isNaN(unix)) {
		const date = new Date(unix < 1e12 ? unix * 1000 : unix);
		if (!Number.isNaN(date.getTime())) {
			return date.toISOString().split("T")[0];
		}
	}

	return null;
}

/**
 * Calculate moving average of scores over the last N days
 */
function calculateMovingAverage(
	entries: EvolutionFitEvent[],
	days: number,
): { scores: number[]; average: number; dateRange: { start: string; end: string } } {
	if (entries.length === 0) {
		const now = new Date();
		const end = now.toISOString().split("T")[0];
		const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
		return { scores: [], average: 0, dateRange: { start, end } };
	}

	const sorted = [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	const now = new Date();
	const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	const recentEntries = sorted.filter(e => new Date(e.timestamp) >= cutoff);
	const scores = recentEntries.map(e => e.score);
	const average = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

	const dates = recentEntries.map(e => extractDate(e.timestamp)).filter((d): d is string => d !== null);
	const end = dates.length > 0 ? dates[0] : now.toISOString().split("T")[0];
	const start =
		dates.length > 0
			? dates[dates.length - 1]
			: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

	return { scores, average, dateRange: { start, end } };
}

/**
 * Identify skills with decay (no usage for > threshold days)
 */
function calculateSkillDecay(entries: SkillUsageEvent[], decayThresholdDays = 3): SkillDecayEntry[] {
	const bySkill = new Map<string, SkillUsageEvent[]>();
	for (const entry of entries) {
		const existing = bySkill.get(entry.skill_name) ?? [];
		existing.push(entry);
		bySkill.set(entry.skill_name, existing);
	}

	const now = new Date();
	const decay: SkillDecayEntry[] = [];

	for (const [skillName, skillEntries] of bySkill) {
		const sorted = skillEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

		const mostRecent = sorted[0];
		if (mostRecent) {
			const lastUsedAt = mostRecent.timestamp;
			const lastUsedDate = new Date(lastUsedAt);
			const daysSinceLastUse = Math.floor((now.getTime() - lastUsedDate.getTime()) / (24 * 60 * 60 * 1000));

			if (daysSinceLastUse > decayThresholdDays) {
				decay.push({
					skillName,
					lastUsedAt,
					daysSinceLastUse,
				});
			}
		}
	}

	decay.sort((a, b) => b.daysSinceLastUse - a.daysSinceLastUse);

	return decay;
}

/**
 * Calculate error rate
 */
function calculateErrorRate(
	errorEvents: ToolErrorEvent[],
	totalEvents: number,
): { errorCount: number; totalEvents: number; rate: number } {
	const errorCount = errorEvents.length;
	const rate = totalEvents > 0 ? errorCount / totalEvents : 0;
	return { errorCount, totalEvents, rate };
}

/**
 * Analyze activity trends from a JSONL log file.
 */
export async function analyzeActivityTrends(logPath: string): Promise<TrendReport> {
	logger.debug("ActivityMonitor: analyzing activity trends", { path: logPath });

	try {
		const file = Bun.file(logPath);
		if (!(await file.exists())) {
			logger.warn("ActivityMonitor: log file not found", { path: logPath });
			return createEmptyReport();
		}

		const text = await file.text();
		const lines = text.split("\n");

		const entries: ActivityLogEntry[] = [];
		for (const line of lines) {
			const parsed = parseJsonlLine(line);
			if (parsed) {
				entries.push(parsed);
			}
		}

		logger.debug("ActivityMonitor: parsed entries", { count: entries.length });

		const evolutionFitEntries: EvolutionFitEvent[] = [];
		const toolErrorEntries: ToolErrorEvent[] = [];
		const skillUsageEntries: SkillUsageEvent[] = [];

		for (const entry of entries) {
			switch (entry.type) {
				case "evolution-fit":
					if (typeof entry.score === "number") {
						evolutionFitEntries.push(entry);
					}
					break;
				case "tool_error":
					toolErrorEntries.push(entry);
					break;
				case "skill_usage":
					if (typeof entry.skill_name === "string") {
						skillUsageEntries.push(entry);
					}
					break;
			}
		}

		const fitScoreTrend = calculateMovingAverage(evolutionFitEntries, 7);
		const skillDecay = calculateSkillDecay(skillUsageEntries, 3);
		const errorRate = calculateErrorRate(toolErrorEntries, entries.length);

		const report: TrendReport = {
			fitScoreTrend,
			skillDecay,
			errorRate,
			analyzedAt: new Date().toISOString(),
		};

		logger.debug("ActivityMonitor: analysis complete", {
			fitScoreAverage: fitScoreTrend.average,
			decayCount: skillDecay.length,
			errorRate: errorRate.rate,
		});

		return report;
	} catch (err) {
		logger.error("ActivityMonitor: failed to analyze activity trends", {
			path: logPath,
			error: String(err),
		});
		return createEmptyReport();
	}
}

/**
 * Create an empty report for error cases
 */
function createEmptyReport(): TrendReport {
	const now = new Date();
	const end = now.toISOString().split("T")[0];
	const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

	return {
		fitScoreTrend: {
			scores: [],
			average: 0,
			dateRange: { start, end },
		},
		skillDecay: [],
		errorRate: {
			errorCount: 0,
			totalEvents: 0,
			rate: 0,
		},
		analyzedAt: now.toISOString(),
	};
}

// ============================================================================
// Alert thresholds (Phase 7.5)
// ============================================================================

export interface AlertRule {
	name: string;
	description: string;
	evaluate(metrics: AlertMetrics): AlertResult | null;
}

export interface AlertMetrics {
	errorRate: number;
	skillDecayRate: number;
	conventionViolationRate: number;
	populationStagnationDays: number;
}

export interface AlertResult {
	rule: string;
	severity: "info" | "warn" | "critical";
	message: string;
}

export const DEFAULT_ALERT_RULES: AlertRule[] = [
	{
		name: "high_error_rate",
		description: "Error rate exceeds 30% threshold",
		evaluate(metrics) {
			if (metrics.errorRate > 0.3) {
				return {
					rule: "high_error_rate",
					severity: "critical",
					message: `Error rate at ${(metrics.errorRate * 100).toFixed(0)}% (threshold: 30%)`,
				};
			}
			return null;
		},
	},
	{
		name: "skill_decay",
		description: "Skills unused for > 30 days",
		evaluate(metrics) {
			if (metrics.skillDecayRate > 0.5) {
				return {
					rule: "skill_decay",
					severity: "warn",
					message: `${(metrics.skillDecayRate * 100).toFixed(0)}% of skills unused for 30+ days`,
				};
			}
			return null;
		},
	},
	{
		name: "convention_violations",
		description: "Convention violation rate exceeds 20%",
		evaluate(metrics) {
			if (metrics.conventionViolationRate > 0.2) {
				return {
					rule: "convention_violations",
					severity: "warn",
					message: `${(metrics.conventionViolationRate * 100).toFixed(0)}% convention violation rate`,
				};
			}
			return null;
		},
	},
	{
		name: "population_stagnation",
		description: "No population evaluation for > 7 days",
		evaluate(metrics) {
			if (metrics.populationStagnationDays > 7) {
				return {
					rule: "population_stagnation",
					severity: "info",
					message: `Skill population not evaluated for ${metrics.populationStagnationDays} days`,
				};
			}
			return null;
		},
	},
];

export function evaluateAlerts(metrics: AlertMetrics, rules: AlertRule[] = DEFAULT_ALERT_RULES): AlertResult[] {
	const results: AlertResult[] = [];
	for (const rule of rules) {
		const result = rule.evaluate(metrics);
		if (result) results.push(result);
	}
	return results;
}
