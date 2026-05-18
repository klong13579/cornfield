/**
 * Project system diagnosis (audit + recent traces + escalations) to markdown on disk.
 */
import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { type AuditReport, type AuditRuntimeContext, formatAuditReport, generateAuditReport } from "../audit-report";
import type { ActivityLogger } from "../logging/activity-logger";
import type { EpisodeStore, SkillStore } from "../storage/types";
import type { ToolChainDiagnosis } from "../types";

export interface SystemDiagnosisProjectionOptions {
	outputDir: string;
	maxEpisodes: number;
	episodeStore: EpisodeStore;
	skillStore: SkillStore;
	activityLogger?: ActivityLogger;
	diagnosisLimit?: number;
	auditRuntime?: AuditRuntimeContext;
}

function formatDiagnosisEntry(d: ToolChainDiagnosis, recordedAt?: number): string {
	const lines = [
		`### ${d.sessionId}`,
		`- Recorded: ${new Date(recordedAt ?? Date.now()).toISOString()}`,
		`- Dominant error tool: ${d.dominantErrorTool ?? "—"}`,
		`- Dominant error pattern: ${d.dominantErrorPattern ?? "—"}`,
		`- Tool efficiency: ${d.toolEfficiency.toFixed(2)}`,
		`- Redundant searches: ${d.redundantSearches ? "yes" : "no"}`,
		`- Slow loop: ${d.slowLoop ? "yes" : "no"}`,
	];
	if (d.suggestedAction) {
		lines.push(`- Suggested action: ${d.suggestedAction}`);
	}
	if (d.readFailures.length > 0) {
		lines.push(`- Read failures: ${d.readFailures.length}`);
	}
	if (d.cascadePatterns.length > 0) {
		lines.push(`- Cascade patterns: ${d.cascadePatterns.length}`);
	}
	return lines.join("\n");
}

function formatEscalationRows(
	rows: Array<{
		id: string;
		status: string;
		pattern_label: string;
		occurrence_count: number;
		failed_improvement_count: number;
		message: string;
		suggestion: string;
	}>,
): string {
	if (rows.length === 0) {
		return "_No open evolution deadlocks._\n";
	}
	const lines: string[] = [];
	for (const e of rows) {
		lines.push(
			`### ${e.id} [${e.status}]`,
			`- Pattern: ${e.pattern_label}`,
			`- Occurrences: ${e.occurrence_count}`,
			`- Failed auto-improvements: ${e.failed_improvement_count}`,
			`- ${e.message}`,
			`- ${e.suggestion}`,
			"",
		);
	}
	return lines.join("\n");
}

export function buildSystemDiagnosisMarkdown(
	auditMarkdown: string,
	diagnoses: Array<{ diagnosis: ToolChainDiagnosis; recordedAt: number }>,
	escalationRows: Array<{
		id: string;
		status: string;
		pattern_label: string;
		occurrence_count: number;
		failed_improvement_count: number;
		message: string;
		suggestion: string;
	}>,
): string {
	const parts = [
		"# System Diagnosis",
		"",
		`Generated: ${new Date().toISOString()}`,
		"",
		"Consolidated health snapshot from evolution DB (audit, per-session diagnoses, stuck patterns).",
		"Regenerated after each archived session and via `/evolution audit`.",
		"",
		"---",
		"",
		auditMarkdown,
		"",
		"---",
		"",
		"## Recent session diagnoses",
		"",
	];
	if (diagnoses.length === 0) {
		parts.push("_No episode diagnoses recorded yet._\n");
	} else {
		for (const { diagnosis, recordedAt } of diagnoses) {
			parts.push(formatDiagnosisEntry(diagnosis, recordedAt), "");
		}
	}
	parts.push("---", "", "## Open escalations (stuck patterns)", "", formatEscalationRows(escalationRows));
	return parts.join("\n");
}

export interface SystemDiagnosisProjectionResult {
	path: string;
	report: AuditReport;
}

export async function projectSystemDiagnosis(
	db: Database,
	options: SystemDiagnosisProjectionOptions,
): Promise<SystemDiagnosisProjectionResult> {
	const diagnosisLimit = options.diagnosisLimit ?? 15;

	const report = await generateAuditReport(
		db,
		options.episodeStore,
		options.skillStore,
		options.maxEpisodes,
		options.activityLogger,
		options.auditRuntime,
	);

	const diagnosisRows = db
		.prepare(
			`SELECT episode_id, read_failures_json, cascade_patterns_json, redundant_searches,
				slow_loop, tool_efficiency, dominant_error_tool, dominant_error_pattern,
				suggested_action, recorded_at
			FROM episode_diagnoses ORDER BY recorded_at DESC LIMIT ?`,
		)
		.all(diagnosisLimit) as Array<{
		episode_id: string;
		read_failures_json: string;
		cascade_patterns_json: string;
		redundant_searches: number;
		slow_loop: number;
		tool_efficiency: number;
		dominant_error_tool: string | null;
		dominant_error_pattern: string | null;
		suggested_action: string;
		recorded_at: number;
	}>;

	const diagnoses = diagnosisRows.map(row => ({
		recordedAt: row.recorded_at,
		diagnosis: {
			sessionId: row.episode_id,
			readFailures: JSON.parse(row.read_failures_json),
			cascadePatterns: JSON.parse(row.cascade_patterns_json),
			redundantSearches: row.redundant_searches === 1,
			slowLoop: row.slow_loop === 1,
			toolEfficiency: row.tool_efficiency,
			dominantErrorTool: row.dominant_error_tool ?? undefined,
			dominantErrorPattern: row.dominant_error_pattern ?? undefined,
			suggestedAction: row.suggested_action,
		} satisfies ToolChainDiagnosis,
	}));

	const escalationRows = db
		.prepare(
			`SELECT id, status, pattern_label, occurrence_count, failed_improvement_count, message, suggestion
			FROM evolution_escalations
			WHERE status IN ('open', 'acknowledged')
			ORDER BY updated_at DESC`,
		)
		.all() as Array<{
		id: string;
		status: string;
		pattern_label: string;
		occurrence_count: number;
		failed_improvement_count: number;
		message: string;
		suggestion: string;
	}>;

	const markdown = buildSystemDiagnosisMarkdown(formatAuditReport(report), diagnoses, escalationRows);
	const outPath = path.join(options.outputDir, "system-diagnosis.md");
	await Bun.write(outPath, markdown);

	logger.debug("System diagnosis projected", {
		path: outPath,
		diagnosisCount: diagnoses.length,
		escalationCount: escalationRows.length,
	});

	return { path: outPath, report };
}
