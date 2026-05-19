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
	lines.push("# 进化审计报告");
	lines.push(`生成时间: ${new Date(report.generatedAt).toISOString()}`);
	lines.push("");

	// ── 1. 概览 ──
	lines.push("## 1. 概览");
	lines.push(`- 归档会话: ${report.episodes.total} / ${report.episodes.maxAllowed} 最大`);
	lines.push(`- 会话成功率: ${(report.episodes.successRate * 100).toFixed(0)}%`);
	lines.push(`- 平均工具调用/会话: ${report.episodes.avgToolCalls.toFixed(1)}`);
	lines.push(`- 平均错误/会话: ${report.episodes.avgErrors.toFixed(1)}`);
	lines.push(`- 用户画像: ${report.profile.sessionCount} 次会话, 主要意图: ${report.profile.topIntent}`);
	lines.push("");

	// ── 2. 已采纳的进化 (Skills) ──
	lines.push("## 2. 已采纳的进化");
	lines.push(`### Skills (${report.skills.total} 个, ${report.skills.deprecated} 个已废弃)`);
	for (let i = 0; i < report.skills.names.length; i++) {
		const name = report.skills.names[i];
		const q = report.skills.qualityScores[i];
		lines.push(`- **${name}** (质量: ${q})`);
	}
	lines.push("");

	lines.push("### 注入表现");
	lines.push(`- Evolution 回放后端: ${report.runtime?.regressionReplayBackend ?? "heuristic"}`);
	lines.push(`- 被追踪的技能数: ${report.effectiveness.skillsTracked}`);
	lines.push(`- 技能注入: ${report.effectiveness.totalInjections} 次`);
	const helpPct = (report.effectiveness.helpRate * 100).toFixed(0);
	lines.push(`- 帮助率: ${helpPct}% (${report.effectiveness.totalHelped} / ${report.effectiveness.totalInjections})`);
	lines.push("");

	lines.push("### Learnings");
	lines.push(`- 总数: ${report.learnings.total}`);
	lines.push(`- Active: ${report.learnings.active} | 手动固定: ${report.learnings.pinned}`);
	lines.push(`- 注入统计: 帮助 ${report.learnings.totalHelped} / 注入 ${report.learnings.totalInjected}`);
	for (const [lifecycle, count] of Object.entries(report.learnings.byLifecycle)) {
		lines.push(`  - ${lifecycle}: ${count}`);
	}
	lines.push("");

	// ── 3. 收益分析 ──
	lines.push("## 3. 收益分析");
	const nudgeHelpPct = (report.nudges.helpRate * 100).toFixed(0);
	const nudgeRepeatPct = (report.nudges.repeatRate * 100).toFixed(0);
	lines.push(`### Nudge 行为修正`);
	lines.push(`- 总检测: ${report.nudges.total} | 注入上下文: ${report.nudges.contextInjected}`);
	lines.push(`- 已评分: ${report.nudges.outcomesRecorded} | 帮助率: ${nudgeHelpPct}% | 重复率: ${nudgeRepeatPct}%`);
	lines.push("");

	lines.push("### 用户意图分布");
	for (const i of report.intents) {
		lines.push(`- ${i.intent}: ${i.count} 次 (平均置信度: ${i.avgConfidence.toFixed(1)})`);
	}
	lines.push("");

	lines.push("### 工作流模式");
	lines.push(`- 总模式: ${report.workflows.totalPatterns} | 有意义的 (>=2次): ${report.workflows.meaningfulPatterns}`);
	lines.push("");

	// ── 4. 问题 ──
	if (report.issues.length > 0) {
		lines.push("## 4. 待解决问题");
		for (const issue of report.issues) {
			lines.push(`- ${issue}`);
		}
		lines.push("");
	}

	// ── 5. 推荐 ──
	if (report.recommendations.length > 0) {
		lines.push("## 5. 改进建议");
		for (const rec of report.recommendations) {
			lines.push(`- ${rec}`);
		}
		lines.push("");
	}

	// ── 6. 技术明细 (简略) ──
	lines.push("## 6. 技术明细");
	lines.push("### Escalations");
	lines.push(`- Open: ${report.escalations.open} / ${report.escalations.total} 总数`);
	for (const e of report.escalations.recent) {
		lines.push(`  - ${e.id} [${e.status}] ${e.patternLabel} (${e.occurrenceCount}x)`);
	}
	lines.push("");

	lines.push("### Regression");
	lines.push(`- Session traces: ${report.admission.sessionTraceCount}`);
	lines.push(`- Regression fixtures: ${report.admission.regressionFixtureCount}`);
	lines.push(
		`- Trials: keep ${report.admission.regressionKeep}, discard ${report.admission.regressionDiscard}, pending ${report.admission.regressionPending}`,
	);
	lines.push("");

	lines.push("### Nudge 明细");
	lines.push(`- 已忽略: ${report.admission.nudgesDismissed}, 已确认: ${report.admission.nudgesAcknowledged}`);
	lines.push("");

	return lines.join("\n");
}
