/**
 * Self-evolution audit report generator.
 *
 * Produces a structured health check of the self-evolution system,
 * highlighting data quality issues and actionable fixes.
 */
import type { Database } from "bun:sqlite";
import { type AdmissionAuditStats, queryAdmissionAuditStats } from "./audit-admission-stats";
import type { SelfEvolutionFlags } from "./types";

export interface AuditRuntimeContext {
	regressionReplayBackend?: SelfEvolutionFlags["regressionReplayBackend"];
	admissionReclassifyInterval?: number;
}

import type { ActivityLogger } from "./logging/activity-logger";
import type { EpisodeStore, SkillStore } from "./storage/types";

export interface AuditReport {
	generatedAt: number;
	episodes: {
		total: number;
		maxAllowed: number;
		atCapacity: boolean;
		successRate: number;
		avgToolCalls: number;
		avgErrors: number;
	};
	skills: {
		total: number;
		deprecated: number;
		names: string[];
		qualityScores: number[];
	};
	effectiveness: {
		episodesTracked: number;
		totalInjections: number;
		totalHelped: number;
		helpRate: number;
		skillsTracked: number;
	};
	intents: Array<{ intent: string; count: number; avgConfidence: number }>;
	workflows: {
		totalPatterns: number;
		meaningfulPatterns: number;
	};
	conventions: {
		total: number;
		byType: Record<string, number>;
	};
	learnings: {
		total: number;
		byLifecycle: Record<string, number>;
		active: number;
		pinned: number;
		totalInjected: number;
		totalHelped: number;
	};
	profile: {
		sessionCount: number;
		errorRate: number;
		topIntent: string;
	};
	nudges: {
		total: number;
		contextInjected: number;
		outcomesRecorded: number;
		helpRate: number;
		repeatRate: number;
	};
	escalations: {
		open: number;
		total: number;
		recent: Array<{ id: string; patternLabel: string; status: string; occurrenceCount: number }>;
	};
	admission: AdmissionAuditStats;
	runtime?: AuditRuntimeContext;
	issues: string[];
	recommendations: string[];
}

export async function generateAuditReport(
	db: Database,
	episodeStore: EpisodeStore,
	skillStore: SkillStore,
	maxEpisodes: number,
	activityLogger?: ActivityLogger,
	runtime?: AuditRuntimeContext,
): Promise<AuditReport> {
	const issues: string[] = [];
	const recommendations: string[] = [];

	// Episodes
	const episodeCount = await episodeStore.count();
	const recentEpisodes = await episodeStore.listRecent(Math.min(episodeCount, 100));
	const successful = recentEpisodes.filter(e => e.completedSuccessfully).length;
	const totalToolCalls = recentEpisodes.reduce((sum, e) => sum + e.toolCallCount, 0);
	const totalErrors = recentEpisodes.reduce((sum, e) => sum + e.errorCount, 0);
	const successRate = recentEpisodes.length > 0 ? successful / recentEpisodes.length : 0;
	const avgToolCalls = recentEpisodes.length > 0 ? totalToolCalls / recentEpisodes.length : 0;
	const avgErrors = recentEpisodes.length > 0 ? totalErrors / recentEpisodes.length : 0;

	if (episodeCount >= maxEpisodes * 0.9) {
		issues.push(`Episode pool at ${episodeCount}/${maxEpisodes} capacity — old episodes are being rotated out.`);
		recommendations.push("Increase --self-evolution-max-episodes to retain more history.");
	}
	if (successRate < 0.7) {
		issues.push(`Low session success rate: ${(successRate * 100).toFixed(0)}%.`);
		recommendations.push("Review error patterns and consider extracting recovery skills.");
	}

	// Skills
	const skills = await skillStore.list();
	const deprecatedSkills = skills.filter(s => s.deprecated);
	const skillNames = skills.map(s => s.name);
	const qualityScores = skills.map(s => s.qualityScore ?? 0);

	if (skills.length === 0) {
		issues.push("No skills extracted yet.");
		recommendations.push("Lower --self-evolution-skill-threshold to capture more sessions as skills.");
	} else if (skills.length < 5) {
		issues.push(`Only ${skills.length} skill(s) extracted from ${episodeCount} episodes.`);
		recommendations.push("Review skillThreshold — many sessions may be below the tool-call minimum.");
	}

	const badNames = skillNames.filter(n => /^(untitled|task-\d+|yes|no|ok)$/i.test(n));
	if (badNames.length > 0) {
		issues.push(`${badNames.length} skill(s) have meaningless names: ${badNames.join(", ")}.`);
		recommendations.push("Use /evolution-archive to clean up low-quality skills.");
	}

	// Effectiveness
	const effRow = db
		.prepare(
			"SELECT COUNT(*) as c, SUM(times_injected) as injected, SUM(times_helped) as helped FROM episode_effectiveness",
		)
		.get() as { c: number; injected: number; helped: number } | undefined;
	const skillEffRow = db.prepare("SELECT COUNT(*) as c FROM skill_effectiveness").get() as { c: number } | undefined;
	const episodesTracked = effRow?.c ?? 0;
	const totalInjections = effRow?.injected ?? 0;
	const totalHelped = effRow?.helped ?? 0;
	const helpRate = totalInjections > 0 ? totalHelped / totalInjections : 0;

	if (helpRate < 0.5 && totalInjections > 10) {
		issues.push(
			`Episode injection help rate is ${(helpRate * 100).toFixed(0)}% — more than half of injections are not helping.`,
		);
		recommendations.push(
			"Consider disabling prompt injection (--no-self-evolution-enable-prompt-injection) or tuning retrieval.",
		);
	}

	// Intents
	const intentRows = db
		.prepare(
			"SELECT intent, COUNT(*) as count, AVG(confidence) as avg_conf FROM episode_intents GROUP BY intent ORDER BY count DESC",
		)
		.all() as Array<{ intent: string; count: number; avg_conf: number }>;

	// Workflows
	const wfRow = db.prepare("SELECT COUNT(*) as c FROM workflow_patterns").get() as { c: number } | undefined;
	const meaningfulWf = db.prepare("SELECT COUNT(*) as c FROM workflow_patterns WHERE occurrence_count >= 2").get() as
		| { c: number }
		| undefined;

	// Legacy conventions table (V3 drops on init)
	const hasConventionsTable = Boolean(
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conventions'").get(),
	);
	const conventionByType: Record<string, number> = {};
	let totalConventions = 0;
	if (hasConventionsTable) {
		const convRows = db.prepare("SELECT type, COUNT(*) as count FROM conventions GROUP BY type").all() as Array<{
			type: string;
			count: number;
		}>;
		for (const row of convRows) {
			conventionByType[row.type] = row.count;
		}
		totalConventions = convRows.reduce((sum, r) => sum + r.count, 0);
	}

	const learningLifecycleRows = db
		.prepare("SELECT lifecycle, COUNT(*) as c FROM learnings GROUP BY lifecycle")
		.all() as Array<{ lifecycle: string; c: number }>;
	const learningsByLifecycle: Record<string, number> = {};
	let totalLearnings = 0;
	for (const row of learningLifecycleRows) {
		learningsByLifecycle[row.lifecycle] = row.c;
		totalLearnings += row.c;
	}
	const pinnedRow = db
		.prepare("SELECT COUNT(*) as c FROM learnings WHERE source = 'manual_pin' AND lifecycle != 'archived'")
		.get() as { c: number };
	const activeRow = db.prepare("SELECT COUNT(*) as c FROM learnings WHERE lifecycle = 'active'").get() as {
		c: number;
	};
	const learningStatsRow = db
		.prepare("SELECT SUM(times_injected) as injected, SUM(times_helped) as helped FROM learnings")
		.get() as { injected: number | null; helped: number | null };

	const injectable = (activeRow?.c ?? 0) + (pinnedRow?.c ?? 0);
	if (totalLearnings === 0) {
		issues.push("No learnings in DB — run sessions or /evolution learnings seed after clear.");
		recommendations.push(
			"Copy learnings-seed.example.json to .omp/evolution/learnings-seed.json and run /evolution learnings seed.",
		);
	} else if (injectable === 0) {
		issues.push(
			`${totalLearnings} learning(s) exist but none are active/pinned — nothing injects into the next prompt.`,
		);
		recommendations.push(
			"Run /evolution learnings list and /evolution learnings pin <id> for rules you want enforced.",
		);
	}

	// Profile
	const profileRow = db.prepare("SELECT profile_json FROM user_profiles WHERE id = 'default'").get() as
		| { profile_json: string }
		| undefined;
	let sessionCount = 0;
	let errorRate = 0;
	let topIntent = "unknown";
	if (profileRow) {
		try {
			const profile = JSON.parse(profileRow.profile_json) as {
				sessionCount?: number;
				errorRate?: number;
				intentDistribution?: Record<string, number>;
			};
			sessionCount = profile.sessionCount ?? 0;
			errorRate = profile.errorRate ?? 0;
			const intents = Object.entries(profile.intentDistribution ?? {});
			intents.sort((a, b) => b[1] - a[1]);
			topIntent = intents[0]?.[0] ?? "unknown";
		} catch {
			// ignore parse error
		}
	}

	const nudgeRow = db
		.prepare(
			`SELECT
				COUNT(*) as total,
				SUM(context_injected) as injected,
				SUM(CASE WHEN outcome_recorded_at IS NOT NULL THEN 1 ELSE 0 END) as outcomes,
				SUM(CASE WHEN outcome_score > 0 THEN 1 ELSE 0 END) as helped,
				SUM(pattern_repeated) as repeated
			FROM nudge_history`,
		)
		.get() as
		| {
				total: number;
				injected: number;
				outcomes: number;
				helped: number;
				repeated: number;
		  }
		| undefined;
	const nudgeTotal = nudgeRow?.total ?? 0;
	const nudgeInjected = nudgeRow?.injected ?? 0;
	const nudgeOutcomes = nudgeRow?.outcomes ?? 0;
	const nudgeHelped = nudgeRow?.helped ?? 0;
	const nudgeRepeated = nudgeRow?.repeated ?? 0;
	const nudgeHelpRate = nudgeOutcomes > 0 ? nudgeHelped / nudgeOutcomes : 0;
	const nudgeRepeatRate = nudgeOutcomes > 0 ? nudgeRepeated / nudgeOutcomes : 0;

	if (nudgeOutcomes >= 5 && nudgeHelpRate < 0.4) {
		issues.push(
			`Nudge helpfulness is low: ${(nudgeHelpRate * 100).toFixed(0)}% positive outcomes over ${nudgeOutcomes} scored nudges.`,
		);
		recommendations.push(
			"Review /evolution nudges and dismiss noisy types; tune detection thresholds in NudgeDetector.",
		);
	}
	if (nudgeOutcomes >= 5 && nudgeRepeatRate > 0.5) {
		issues.push(
			`Nudge patterns often repeat after injection: ${(nudgeRepeatRate * 100).toFixed(0)}% of scored nudges.`,
		);
		recommendations.push("Strengthen nudge context copy or add convention rules from recurring patterns.");
	}

	const escalationOpenRow = db
		.prepare("SELECT COUNT(*) as c FROM evolution_escalations WHERE status IN ('open', 'acknowledged')")
		.get() as { c: number };
	const escalationTotalRow = db.prepare("SELECT COUNT(*) as c FROM evolution_escalations").get() as {
		c: number;
	};
	const escalationRecentRows = db
		.prepare(
			"SELECT id, pattern_label, status, occurrence_count FROM evolution_escalations ORDER BY updated_at DESC LIMIT 5",
		)
		.all() as Array<{
		id: string;
		pattern_label: string;
		status: string;
		occurrence_count: number;
	}>;

	const escalationOpen = escalationOpenRow.c;
	const admission = queryAdmissionAuditStats(db);

	if (admission.regressionFixtureCount > 0 && admission.regressionKeep + admission.regressionDiscard === 0) {
		recommendations.push(
			`${admission.regressionFixtureCount} regression fixture(s) exist but no trials recorded — run sessions or /evolution backfill-traces, then refresh admission.`,
		);
	}
	if (admission.skillsDeprecated > 0) {
		recommendations.push(
			`${admission.skillsDeprecated} skill(s) deprecated by benefit admission — run /evolution skills to confirm.`,
		);
	}

	if (escalationOpen > 0) {
		issues.push(
			`${escalationOpen} evolution deadlock(s) need human review — automatic fixes did not stabilize recurring errors.`,
		);
		recommendations.push(
			"Run /evolution stuck to acknowledge or resolve; add a manual convention after you fix the root cause.",
		);
	}

	const report: AuditReport = {
		generatedAt: Date.now(),
		episodes: {
			total: episodeCount,
			maxAllowed: maxEpisodes,
			atCapacity: episodeCount >= maxEpisodes,
			successRate,
			avgToolCalls,
			avgErrors,
		},
		skills: {
			total: skills.length,
			deprecated: deprecatedSkills.length,
			names: skillNames,
			qualityScores,
		},
		effectiveness: {
			episodesTracked,
			totalInjections,
			totalHelped,
			helpRate,
			skillsTracked: skillEffRow?.c ?? 0,
		},
		intents: intentRows.map(r => ({
			intent: r.intent,
			count: r.count,
			avgConfidence: r.avg_conf,
		})),
		workflows: {
			totalPatterns: wfRow?.c ?? 0,
			meaningfulPatterns: meaningfulWf?.c ?? 0,
		},
		conventions: {
			total: totalConventions,
			byType: conventionByType,
		},
		learnings: {
			total: totalLearnings,
			byLifecycle: learningsByLifecycle,
			active: activeRow?.c ?? 0,
			pinned: pinnedRow?.c ?? 0,
			totalInjected: learningStatsRow?.injected ?? 0,
			totalHelped: learningStatsRow?.helped ?? 0,
		},
		profile: {
			sessionCount,
			errorRate,
			topIntent,
		},
		nudges: {
			total: nudgeTotal,
			contextInjected: nudgeInjected,
			outcomesRecorded: nudgeOutcomes,
			helpRate: nudgeHelpRate,
			repeatRate: nudgeRepeatRate,
		},
		escalations: {
			open: escalationOpen,
			total: escalationTotalRow.c,
			recent: escalationRecentRows.map(r => ({
				id: r.id,
				patternLabel: r.pattern_label,
				status: r.status,
				occurrenceCount: r.occurrence_count,
			})),
		},
		admission,
		runtime,
		issues,
		recommendations,
	};

	await activityLogger?.log("audit_report_generated", {
		episodeCount,
		skillCount: skills.length,
		issueCount: issues.length,
	});

	return report;
}

export function formatAuditReport(report: AuditReport): string {
	const lines: string[] = [];
	lines.push(`# Self-Evolution Audit Report`);
	lines.push(`Generated: ${new Date(report.generatedAt).toISOString()}`);
	lines.push("");

	lines.push("## Episodes");
	lines.push(`- Total: ${report.episodes.total} / ${report.episodes.maxAllowed} max`);
	lines.push(`- Success rate: ${(report.episodes.successRate * 100).toFixed(0)}%`);
	lines.push(`- Avg tool calls: ${report.episodes.avgToolCalls.toFixed(1)}`);
	lines.push(`- Avg errors: ${report.episodes.avgErrors.toFixed(1)}`);
	lines.push("");

	lines.push("## Skills");
	lines.push(`- Total: ${report.skills.total} (${report.skills.deprecated} deprecated)`);
	if (report.skills.names.length > 0) {
		lines.push(`- Names: ${report.skills.names.join(", ")}`);
		lines.push(`- Quality scores: ${report.skills.qualityScores.join(", ")}`);
	}
	lines.push("");

	lines.push("## Effectiveness");
	lines.push(`- Episodes tracked: ${report.effectiveness.episodesTracked}`);
	lines.push(`- Injections: ${report.effectiveness.totalInjections}`);
	lines.push(`- Helped: ${report.effectiveness.totalHelped}`);
	lines.push(`- Help rate: ${(report.effectiveness.helpRate * 100).toFixed(0)}%`);
	lines.push(`- Skills tracked: ${report.effectiveness.skillsTracked}`);
	lines.push("");

	lines.push("## Nudges");
	lines.push(`- Total recorded: ${report.nudges.total}`);
	lines.push(`- Injected into context: ${report.nudges.contextInjected}`);
	lines.push(`- Outcomes scored: ${report.nudges.outcomesRecorded}`);
	lines.push(`- Help rate: ${(report.nudges.helpRate * 100).toFixed(0)}%`);
	lines.push(`- Pattern repeat rate: ${(report.nudges.repeatRate * 100).toFixed(0)}%`);
	lines.push("");

	lines.push("## Intents");
	for (const i of report.intents) {
		lines.push(`- ${i.intent}: ${i.count} (avg confidence: ${i.avgConfidence.toFixed(1)})`);
	}
	lines.push("");

	lines.push("## Workflow Patterns");
	lines.push(`- Total: ${report.workflows.totalPatterns}`);
	lines.push(`- Meaningful (≥2 occurrences): ${report.workflows.meaningfulPatterns}`);
	lines.push("");

	lines.push("## Conventions (V2 table removed)");
	lines.push(`- Total: ${report.conventions.total}`);
	for (const [type, count] of Object.entries(report.conventions.byType)) {
		lines.push(`  - ${type}: ${count}`);
	}
	lines.push("");

	lines.push("## Learnings (V3)");
	lines.push(`- Total: ${report.learnings.total}`);
	lines.push(`- Active: ${report.learnings.active} | Pinned (manual): ${report.learnings.pinned}`);
	lines.push(`- Injection stats: helped ${report.learnings.totalHelped} / injected ${report.learnings.totalInjected}`);
	for (const [lifecycle, count] of Object.entries(report.learnings.byLifecycle)) {
		lines.push(`  - ${lifecycle}: ${count}`);
	}
	lines.push("");

	lines.push("## Profile");
	lines.push(`- Sessions: ${report.profile.sessionCount}`);
	lines.push(`- Avg tool errors/session: ${report.profile.errorRate.toFixed(1)}`);
	lines.push(`- Top intent: ${report.profile.topIntent}`);
	lines.push("");

	lines.push("## Escalations (stuck patterns)");
	lines.push(`- Open: ${report.escalations.open} / ${report.escalations.total} total`);
	for (const e of report.escalations.recent) {
		lines.push(`  - ${e.id} [${e.status}] ${e.patternLabel} (${e.occurrenceCount}x)`);
	}
	lines.push("");

	lines.push("## Regression replay");
	if (report.runtime?.regressionReplayBackend) {
		lines.push(`- Backend: ${report.runtime.regressionReplayBackend}`);
		if (report.runtime.regressionReplayBackend !== "heuristic" && report.runtime.admissionReclassifyInterval) {
			lines.push(`- Convention reclassify interval: every ${report.runtime.admissionReclassifyInterval} session(s)`);
		}
	}
	lines.push(`- Session traces: ${report.admission.sessionTraceCount}`);
	lines.push(`- Regression fixtures: ${report.admission.regressionFixtureCount}`);
	lines.push(
		`- Trials: keep ${report.admission.regressionKeep}, discard ${report.admission.regressionDiscard}, pending ${report.admission.regressionPending}`,
	);
	const byTarget = report.admission.trialsByTarget;
	lines.push(`  - conventions: keep ${byTarget.convention.keep}, discard ${byTarget.convention.discard}`);
	lines.push(`  - skills: keep ${byTarget.skill.keep}, discard ${byTarget.skill.discard}`);
	const byBackend = report.admission.trialsByReplayBackend;
	lines.push(
		`  - by backend: heuristic ${byBackend.heuristic ?? 0}, llm ${byBackend.llm ?? 0}, subagent ${byBackend.subagent ?? 0}`,
	);
	lines.push(
		`  - tool-chain tags: overturn ${report.admission.regressionToolchainOverturns}, confirm ${report.admission.regressionToolchainConfirm}, only ${report.admission.regressionToolchainOnly}`,
	);
	if (report.admission.recentTrials.length > 0) {
		lines.push("- Recent trials:");
		for (const t of report.admission.recentTrials) {
			const reason = t.reason.length > 72 ? `${t.reason.slice(0, 69)}...` : t.reason;
			lines.push(
				`  - [${t.verdict}] ${t.targetType}/${t.targetId} @ ${new Date(t.createdAt).toISOString()}: ${reason}`,
			);
		}
	}
	lines.push("");

	lines.push("## Benefit admission (reject / deprecate)");
	const life = report.admission.learningsByLifecycle;
	lines.push(
		`- Learnings: active ${life.active ?? 0}, candidate ${life.candidate ?? 0}, archived ${life.archived ?? 0}`,
	);
	lines.push(`- Skills deprecated: ${report.admission.skillsDeprecated}`);
	lines.push(
		`- Nudges dismissed: ${report.admission.nudgesDismissed}, acknowledged: ${report.admission.nudgesAcknowledged}`,
	);
	lines.push("");

	if (report.issues.length > 0) {
		lines.push("## Issues Found");
		for (const issue of report.issues) {
			lines.push(`- ${issue}`);
		}
		lines.push("");
	}

	if (report.recommendations.length > 0) {
		lines.push("## Recommendations");
		for (const rec of report.recommendations) {
			lines.push(`- ${rec}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
