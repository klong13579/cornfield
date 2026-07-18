/**
 * Slash commands for the self-evolution plugin.
 *
 * Consolidated under a single /evolution command with subcommands,
 * similar to /memory. Old flat commands are kept for backward
 * compatibility but redirect to the new hierarchy.
 */
import type { Database } from "bun:sqlite";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getAgentDir, getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { queryAdmissionAuditStats } from "./audit-admission-stats";
import { formatAuditReport } from "./audit-report";
import { refreshBenefitAdmissionState } from "./benefit-admission-refresh";
import { clearProjectEvolutionData } from "./clear-project-evolution";
import { DailyReportGenerator } from "./daily-report";
import type { EmbeddingGenerator } from "./embedding";
import type { EpisodicManager } from "./episodic-manager";
import { syncEvolutionEscalations } from "./escalation/sync";
import { formatFitReport, runFitEval, saveFitScore } from "./eval/fit-evaluator";
import { HeuristicSkillEvaluator } from "./evaluator";
import { EVOLUTION_MEMORY_SUBCOMMANDS, runEvolutionMemorySubcommand } from "./evolution-memory";
import { applyLearningsSeed, defaultLearningsSeedPath, readLearningsSeedFile } from "./learnings-seed";
import type { ActivityLogger } from "./logging/activity-logger";
import type { SkillManager } from "./manager";
import { ensureMemorySummaryFromMemory } from "./memory/summary";
import { ModelScorer } from "./model-scorer";
import { getMemoryRoot, resolveEvolutionPathLayout } from "./paths";
import { projectLearnings } from "./projection/learnings";
import { projectSystemDiagnosis } from "./projection/system-diagnosis";
import auditSystemDiagnosisTemplate from "./prompts/audit-system-diagnosis.md" with { type: "text" };
import { backfillSessionTracesFromEpisodes } from "./regression/backfill-traces";
import { repairRegressionFixtureLabels } from "./regression/repair-regression-fixture-labels";
import { parseReplayBackendFromTrialReason, parseToolchainTagFromTrialReason } from "./regression/trial-reason";
import type { SkillPopulationEngine } from "./skill-population-engine";
import { getUnifiedSkillsDir, resolveEvolutionProjectionDir } from "./skill-storage";
import { SqliteEpisodeDiagnosisStore } from "./storage/diagnoses";
import type { SqliteEvolutionEscalationStore } from "./storage/evolution-escalations";
import type { SqliteLearningStore } from "./storage/learnings";
import type { SqliteRegressionFixtureStore } from "./storage/regression-fixtures";
import type { SqliteRegressionTrialStore } from "./storage/regression-trials";
import { SqliteSessionModelStatsStore } from "./storage/session-model-stats";
import type { SqliteSessionTraceStore } from "./storage/session-traces";
import type { SqliteStatsStore } from "./storage/skills";
import { SqliteFitScoreStore } from "./storage/sqlite-fit-scores";
import type {
	EffectivenessStore,
	EpisodeStore,
	FitScoreStore,
	NudgeHistoryStore,
	SkillEffectivenessStore,
	SkillPopulationStore,
	SkillStore,
	SkillVersionStore,
	WorkflowPatternStore,
} from "./storage/types";
import { syncSkillsToFiles } from "./sync";
import type { ProfileStore, SelfEvolutionFlags, UserProfile } from "./types";
import { createBackgroundLlmAuth } from "./utils/background-llm-auth";
import { resolveBackgroundModel } from "./utils/background-model";
import { callBackgroundLlm } from "./utils/llm";

export interface CommandStores {
	ensureInit(cwd: string): void;
	episodeStore(): EpisodeStore;
	skillStore(): SkillStore;
	versionStore(): SkillVersionStore;
	statsStore(): SqliteStatsStore;
	skillManager(): SkillManager;
	activityLogger(): ActivityLogger;
	workflowPatternStore(): WorkflowPatternStore;
	learningStore(): SqliteLearningStore;
	effectivenessStore(): EffectivenessStore;
	skillEffectivenessStore(): SkillEffectivenessStore;
	populationStore(): SkillPopulationStore;
	populationEngine(): SkillPopulationEngine;
	nudgeHistoryStore(): NudgeHistoryStore;
	db(): Database;
	flags(): SelfEvolutionFlags;
	episodicManager(): EpisodicManager;
	escalationStore(): SqliteEvolutionEscalationStore;
	regressionFixtureStore(): SqliteRegressionFixtureStore;
	regressionTrialStore(): SqliteRegressionTrialStore;
	sessionTraceStore(): SqliteSessionTraceStore;
	memoryDb(): Database | undefined;
	embeddingGenerator(): EmbeddingGenerator | undefined;
	profileStore(): ProfileStore;
}

function getFitStore(db: () => Database): FitScoreStore {
	return new SqliteFitScoreStore(db());
}

// ─────────────────────────────────────────────────────────────────────────────
// /episodic command
// ─────────────────────────────────────────────────────────────────────────────

const EPISODIC_SUBCOMMANDS = [
	{ name: "sessions", description: "List recent sessions" },
	{ name: "show", description: "Show events for a session" },
	{ name: "clear", description: "Clear episodic data" },
];

export function registerEpisodicCommands(api: ExtensionAPI, stores: CommandStores): void {
	api.registerCommand("episodic", {
		description: "Episodic memory command hub. Usage: /episodic <subcommand> [args]",
		getArgumentCompletions(argumentPrefix: string) {
			if (argumentPrefix.includes(" ")) return null;
			const lower = argumentPrefix.toLowerCase();
			const matches = EPISODIC_SUBCOMMANDS.filter(s => s.name.startsWith(lower)).map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
			}));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			const trimmed = args.trim();
			const subcommand = trimmed.split(/\s+/, 1)[0]?.toLowerCase() || "sessions";
			const rest = trimmed.slice(subcommand.length).trim();

			const manager = stores.episodicManager();
			if (!manager) {
				ctx.ui.notify("Episodic store not available", "error");
				return;
			}

			switch (subcommand) {
				case "sessions": {
					const events = await manager.getRecentEvents(20);
					if (events.length === 0) {
						ctx.ui.notify("No episodic records yet", "info");
						return;
					}
					const sessionSet = new Set<string>();
					const lines: string[] = [];
					for (const e of events) {
						if (!sessionSet.has(e.sessionId)) {
							sessionSet.add(e.sessionId);
							lines.push(
								`Session: ${e.sessionId} | ${new Date(e.timestamp).toISOString().slice(0, 19).replace("T", " ")}`,
							);
						}
					}
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
				case "show": {
					if (!rest) {
						ctx.ui.notify("Usage: /episodic show <session-id>", "warning");
						return;
					}
					const events = await manager.getSessionEvents(rest);
					if (events.length === 0) {
						ctx.ui.notify(`No events found for session "${rest}"`, "info");
						return;
					}
					const lines = events.map(
						e =>
							`[${new Date(e.timestamp).toISOString().slice(0, 19).replace("T", " ")}] ${e.eventType}: ${JSON.stringify(e.eventData).slice(0, 80)}`,
					);
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
				case "clear": {
					const confirmed = await ctx.ui.confirm(
						"Clear episodic data",
						"This will delete all episodic records. Continue?",
					);
					if (!confirmed) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					const db = stores.db();
					db.exec("DELETE FROM episodic_records");
					ctx.ui.notify("Episodic data cleared", "info");
					break;
				}
			}
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Main /evolution command dispatcher
// ─────────────────────────────────────────────────────────────────────────────

// Subcommand definitions for TUI autocomplete
const EVOLUTION_SUBCOMMANDS = [
	{ name: "status", description: "Show statistics (episodes, skills, versions)" },
	{ name: "skills", description: "List evolved skills" },
	{ name: "rate", description: "Rate a skill" },
	{ name: "clear", description: "Delete .omp/evolution/memory + .omp/evolution + .omp/skills (full project reset)" },
	{ name: "memory", description: "Memory hub: search, view, enqueue, clear (memory only), …" },
	{ name: "archive", description: "Archive low-quality skills" },
	{ name: "history", description: "View version history for a skill" },
	{ name: "rollback", description: "Rollback a skill to a version" },
	{ name: "workflows", description: "List mined workflow patterns" },
	{ name: "audit", description: "Generate health report" },
	{ name: "report", description: "Generate daily report" },
	{ name: "population", description: "Show skill population status" },
	{ name: "fit", description: "Run fit evaluation" },
	{ name: "learnings", description: "List/search/pin/archive/seed learnings" },
	{ name: "log", description: "Show evolution event timeline" },
	{ name: "nudges", description: "Show recent nudges" },
	{ name: "stuck", description: "Show or acknowledge evolution deadlocks needing human help" },
	{ name: "sync-skills", description: "Export skills to <cwd>/.omp/skills/ (or global user store)" },
	{ name: "backfill-traces", description: "Backfill session_traces from omp session JSONL for regression replay" },
	{ name: "refresh-admission", description: "Re-run skill benefit admission (+ skill regression when configured)" },
	{ name: "regression", description: "List recent regression trials (keep/discard audit)" },
];

export function registerSelfEvolutionCommands(api: ExtensionAPI, stores: CommandStores): void {
	api.registerCommand("evolution", {
		description: "Self-evolution command hub. Usage: /evolution <subcommand> [args]",
		getArgumentCompletions(argumentPrefix: string) {
			const lower = argumentPrefix.toLowerCase();
			if (lower.startsWith("memory ")) {
				const rest = lower.slice("memory ".length);
				const matches = EVOLUTION_MEMORY_SUBCOMMANDS.filter(s => s.name.startsWith(rest)).map(s => ({
					value: `memory ${s.name} `,
					label: s.name,
					description: s.description,
				}));
				return matches.length > 0 ? matches : null;
			}
			if (argumentPrefix.includes(" ")) return null;
			const matches = EVOLUTION_SUBCOMMANDS.filter(s => s.name.startsWith(lower)).map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
			}));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			const trimmed = args.trim();
			const subcommand = trimmed.split(/\s+/, 1)[0]?.toLowerCase() || "help";
			const rest = trimmed.slice(subcommand.length).trim();

			switch (subcommand) {
				case "status":
					return handleStatus(stores, ctx);
				case "skills":
					return handleSkills(stores, ctx, rest);
				case "rate":
					return handleRate(stores, ctx, rest);
				case "clear":
					return handleClear(stores, ctx);
				case "archive":
					return handleArchive(stores, ctx);
				case "history":
					return handleHistory(stores, ctx, rest);
				case "rollback":
					return handleRollback(stores, ctx, rest);
				case "workflows":
					return handleWorkflows(stores, ctx, rest);
				case "audit":
					return handleAudit(stores, ctx);
				case "report":
					return handleReport(stores, ctx);
				case "fit":
					return handleFit(stores, ctx);
				case "population":
					return handlePopulation(stores, ctx);
				case "memory":
					return handleEvolutionMemory(stores, ctx, rest);
				case "learnings":
					return handleLearnings(stores, ctx, rest);
				case "log":
					return handleLog(stores, ctx, rest);
				case "nudges":
					return handleNudges(stores, ctx, rest);
				case "stuck":
					return handleStuck(stores, ctx, rest);
				case "sync-skills":
					return handleSyncSkills(stores, ctx);
				case "backfill-traces":
					return handleBackfillTraces(stores, ctx, rest);
				case "refresh-admission":
					return handleRefreshAdmission(stores, ctx);
				case "regression":
					return handleRegressionTrials(stores, ctx, rest);
				default:
					return handleHelp(ctx);
			}
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatus(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const [episodeCount, skillCount, versionCount, archivedSessions] = await Promise.all([
			stores.episodeStore().count(),
			stores.skillStore().count(),
			stores.versionStore().count(),
			stores.statsStore().get("sessions_archived"),
		]);
		const admission = queryAdmissionAuditStats(stores.db());
		const flags = stores.flags();
		ctx.ui.notify(
			[
				`Episodes: ${episodeCount} | Skills: ${skillCount} | Versions: ${versionCount} | Sessions archived: ${archivedSessions}`,
				`Regression: traces ${admission.sessionTraceCount}, fixtures ${admission.regressionFixtureCount}, trials keep ${admission.regressionKeep} / discard ${admission.regressionDiscard}`,
				`Replay backend: ${flags.regressionReplayBackend} | reclassify every ${flags.admissionReclassifyInterval} session(s) (llm/subagent)`,
			].join("\n"),
			"info",
		);
	} catch (err) {
		logger.error("evolution status failed", { error: String(err) });
		ctx.ui.notify("Failed to load evolution status", "error");
	}
}

async function handleSkills(stores: CommandStores, ctx: any, args: string): Promise<void> {
	try {
		const skills = await stores.skillStore().list();
		if (skills.length === 0) {
			ctx.ui.notify("No evolved skills yet", "info");
			return;
		}

		const showDetail = args.trim() === "--detail";
		const evaluator = new HeuristicSkillEvaluator();

		const lines: string[] = [];
		for (const s of skills) {
			const total = s.successCount + s.failureCount;
			const rate = total > 0 ? `${Math.round((s.successCount / total) * 100)}%` : "n/a";
			const userStars = s.userRating ? "★".repeat(s.userRating) + "☆".repeat(5 - s.userRating) : "unrated";

			lines.push(
				`${s.name} (v${s.version}) | quality: ${s.qualityScore ?? "?"} | success: ${rate} | used: ${s.usageCount} | your rating: ${userStars}${s.deprecated ? " [DEPRECATED]" : ""}`,
			);

			if (showDetail) {
				const breakdown = evaluator.reevaluate(s);
				lines.push(
					`  └─ successRate=${breakdown.successRate} diversity=${breakdown.toolDiversity} pitfalls=${breakdown.pitfallCoverage} ` +
						`pattern=${breakdown.taskPatternSubstance} approach=${breakdown.approachSubstance} desc=${breakdown.descriptionQuality} ` +
						`history=${breakdown.reusesHistory} recovery=${breakdown.recoveryExperience} autonomy=${breakdown.autonomy} user=${breakdown.userRating} ` +
						`- TOTAL=${breakdown.total}`,
				);
			}
		}
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution skills failed", { error: String(err) });
		ctx.ui.notify("Failed to list skills", "error");
	}
}

async function handleRate(stores: CommandStores, ctx: any, args: string): Promise<void> {
	const trimmed = args.trim();
	const parts = trimmed.split(/\s+/);
	if (parts.length < 2) {
		ctx.ui.notify("Usage: /evolution rate <skill-name> <1-5>", "warning");
		return;
	}

	const ratingStr = parts.pop()!;
	const name = parts.join(" ");
	const rating = Number.parseInt(ratingStr, 10);

	if (Number.isNaN(rating) || rating < 1 || rating > 5) {
		ctx.ui.notify("Rating must be a number between 1 and 5", "error");
		return;
	}

	try {
		const skill = await stores.skillStore().get(name);
		if (!skill) {
			ctx.ui.notify(`Skill "${name}" not found. Use /evolution skills to list.`, "error");
			return;
		}

		skill.userRating = rating;
		const evaluator = new HeuristicSkillEvaluator();
		const breakdown = evaluator.reevaluate(skill);
		skill.qualityScore = breakdown.total;

		await stores.skillStore().upsert(skill);
		await stores.activityLogger().log("skill_user_rated", {
			skillName: name,
			rating,
			newQualityScore: skill.qualityScore,
		});

		const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
		ctx.ui.notify(`Rated "${name}" ${stars} (quality updated to ${skill.qualityScore})`, "info");
	} catch (err) {
		logger.error("evolution rate failed", { error: String(err) });
		ctx.ui.notify("Failed to rate skill", "error");
	}
}

async function handleClear(stores: CommandStores, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const globalStore = stores.flags().globalStore;
		const layout = resolveEvolutionPathLayout(ctx.cwd, globalStore);
		const scopeLabel = globalStore ? "global user store" : "this project";
		const confirmed = await ctx.ui.confirm(
			"Clear project OMP data",
			`Full reset — deletes memory, evolution DB, and skills:\n${layout.memoryDir}\n${layout.evolutionDir}\n${layout.skillsDir}\n\n(Memory-only clear: /evolution memory clear)\n\nContinue?`,
		);
		if (!confirmed) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		const { removedDirs } = await clearProjectEvolutionData({
			cwd: ctx.cwd,
			globalStore,
		});
		ctx.ui.notify(`Cleared ${scopeLabel} evolution data:\n${removedDirs.map(d => `  ${d}`).join("\n")}`, "info");
	} catch (err) {
		logger.error("evolution clear failed", { error: String(err) });
		ctx.ui.notify("Failed to clear evolution data", "error");
	}
}

async function handleArchive(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const count = await stores.skillManager().archiveLowQuality();
		ctx.ui.notify(`Archived ${count} low-quality skill(s)`, "info");
	} catch (err) {
		logger.error("evolution archive failed", { error: String(err) });
		ctx.ui.notify("Failed to archive skills", "error");
	}
}

async function handleHistory(stores: CommandStores, ctx: any, args: string): Promise<void> {
	const name = args.trim();
	if (!name) {
		ctx.ui.notify("Usage: /evolution history <skill-name>", "warning");
		return;
	}
	try {
		const history = await stores.skillManager().getHistory(name);
		if (history.length === 0) {
			ctx.ui.notify(`No history found for skill "${name}"`, "info");
			return;
		}
		const lines = history.map(
			h =>
				`v${h.version} | ${h.changeType} | ${new Date(h.changedAt).toISOString()}${h.changeReason ? ` | ${h.changeReason}` : ""}`,
		);
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution history failed", { error: String(err) });
		ctx.ui.notify("Failed to load skill history", "error");
	}
}

async function handleRollback(stores: CommandStores, ctx: any, args: string): Promise<void> {
	const parts = args.trim().split(/\s+/);
	if (parts.length < 2) {
		ctx.ui.notify("Usage: /evolution rollback <skill-name> <version>", "warning");
		return;
	}
	const version = Number.parseInt(parts[parts.length - 1]!, 10);
	const name = parts.slice(0, -1).join(" ");
	if (Number.isNaN(version)) {
		ctx.ui.notify("Invalid version number", "error");
		return;
	}
	try {
		const restored = await stores.skillManager().rollback(name, version);
		if (restored) {
			ctx.ui.notify(`Rolled back "${name}" to v${version} (new version: v${restored.version})`, "info");
		} else {
			ctx.ui.notify(`Version ${version} of "${name}" not found`, "error");
		}
	} catch (err) {
		logger.error("evolution rollback failed", { error: String(err) });
		ctx.ui.notify("Rollback failed", "error");
	}
}

async function handleWorkflows(stores: CommandStores, ctx: any, args: string): Promise<void> {
	try {
		const intentFilter = args.trim();
		const patterns = intentFilter
			? await stores.workflowPatternStore().getByIntent(intentFilter, 20)
			: await stores.workflowPatternStore().listAll();
		if (patterns.length === 0) {
			const msg = intentFilter
				? `No workflow patterns found for intent "${intentFilter}"`
				: "No workflow patterns mined yet";
			ctx.ui.notify(msg, "info");
			return;
		}
		const lines = patterns.map(p => `${p.intent}: ${p.toolSequence.join(" → ")} (seen ${p.occurrenceCount}x)`);
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution workflows failed", { error: String(err) });
		ctx.ui.notify("Failed to list workflow patterns", "error");
	}
}

async function handleAudit(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const outputDir = resolveEvolutionProjectionDir(ctx.cwd, stores.flags().globalStore);
		const flags = stores.flags();
		const { path: outPath, report } = await projectSystemDiagnosis(stores.db(), {
			outputDir,
			maxEpisodes: flags.maxEpisodes,
			episodeStore: stores.episodeStore(),
			skillStore: stores.skillStore(),
			activityLogger: stores.activityLogger(),
			auditRuntime: {
				regressionReplayBackend: flags.regressionReplayBackend,
				admissionReclassifyInterval: flags.admissionReclassifyInterval,
			},
		});

		let diagnosis = "";
		try {
			const model = resolveBackgroundModel(ctx);
			if (model) {
				const reportText = formatAuditReport(report);
				const auth = createBackgroundLlmAuth(ctx);
				const response = await callBackgroundLlm(model, auditSystemDiagnosisTemplate, reportText, {
					auth,
					maxTokens: 2000,
				});
				if (response) {
					diagnosis = `\n\n## LLM 系统诊断\n${response}`;
				}
			}
		} catch (diagErr) {
			logger.warn("LLM audit diagnosis failed", { error: String(diagErr) });
		}

		ctx.ui.notify(`${formatAuditReport(report)}\n\nWritten to ${outPath}${diagnosis}`, "info");
	} catch (err) {
		logger.error("evolution audit failed", { error: String(err) });
		ctx.ui.notify("Failed to generate audit report", "error");
	}
}

async function handleReport(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const generator = new DailyReportGenerator(
			stores.episodeStore(),
			stores.learningStore(),
			stores.effectivenessStore(),
			stores.skillStore(),
		);
		const report = await generator.generate();
		const text = generator.formatReport(report);
		ctx.ui.notify(text, "info");
	} catch (err) {
		logger.error("evolution report failed", { error: String(err) });
		ctx.ui.notify("Failed to generate daily report", "error");
	}
}

async function handleFit(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const db = stores.db();
		const fitStore = getFitStore(() => db);

		const profile = await stores.profileStore().get("default");
		const taskResponses = buildHeuristicResponses(profile);

		const { report, record } = await runFitEval(db, taskResponses);
		await saveFitScore(db, record);
		await fitStore.upsert(record);

		const text = formatFitReport(report);
		ctx.ui.notify(text, "info");
	} catch (err) {
		logger.error("evolution fit failed", { error: String(err) });
		ctx.ui.notify("Failed to run fit evaluation", "error");
	}
}

async function handlePopulation(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const engine = stores.populationEngine();
		const result = await engine.evaluateAll();

		const states = ["candidate", "experimental", "graduated", "deprecated", "archived"] as const;
		const counts: Record<string, number> = {};
		for (const state of states) {
			counts[state] = await stores.populationStore().countByState(state);
		}

		const lines = [
			"Skill Population Status:",
			`  Evaluated: ${result.evaluated} | Transitions: ${result.transitions} | Graduated: ${result.graduated} | Eliminated: ${result.eliminated} | Regression blocked: ${result.regressionBlocked}`,
			`  candidate: ${counts.candidate} | experimental: ${counts.experimental} | graduated: ${counts.graduated} | deprecated: ${counts.deprecated} | archived: ${counts.archived}`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution population failed", { error: String(err) });
		ctx.ui.notify("Failed to evaluate skill population", "error");
	}
}

async function handleEvolutionMemory(stores: CommandStores, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const db = stores.memoryDb();
	if (!db) {
		ctx.ui.notify("Memory DB not available. Start a coding session first.", "error");
		return;
	}
	await runEvolutionMemorySubcommand({
		db,
		ctx,
		args,
		globalStore: stores.flags().globalStore,
		getEmbeddingGenerator: () => stores.embeddingGenerator(),
	});
}

async function handleLearnings(stores: CommandStores, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const subAction = args.trim().split(/\s+/, 1)[0]?.toLowerCase() || "list";
	const rest = args.trim().slice(subAction.length).trim();
	try {
		const store = stores.learningStore();
		const learnings = await store.listAll();
		const cwdLearnings = learnings.filter(l => l.cwd === ctx.cwd);
		if (cwdLearnings.length === 0 && subAction !== "pin" && subAction !== "seed") {
			ctx.ui.notify("No learnings for this project yet (V3 extracts after each session).", "info");
			return;
		}
		switch (subAction) {
			case "seed": {
				const outputDir = resolveEvolutionProjectionDir(ctx.cwd, stores.flags().globalStore);
				const seedPath = rest.trim() || defaultLearningsSeedPath(outputDir);
				const entries = await readLearningsSeedFile(seedPath);
				if (entries.length === 0) {
					ctx.ui.notify(`No valid entries in ${seedPath}`, "warning");
					return;
				}
				const result = await applyLearningsSeed(store, ctx.cwd, entries);
				await projectLearnings(stores.db(), { outputDir });
				const memoryRoot = getMemoryRoot(getAgentDir(), ctx.cwd, {
					globalStore: stores.flags().globalStore,
				});
				const summary = await ensureMemorySummaryFromMemory(memoryRoot);
				const lines = [`Loaded ${result.loaded} learning(s), pinned ${result.pinned}.`, `Seed: ${seedPath}`];
				if (result.skipped > 0) {
					lines.push(`Skipped ${result.skipped} invalid row(s).`);
				}
				if (summary.written) {
					lines.push(`memory_summary.md refreshed (${summary.length} chars, from ${summary.source}).`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				break;
			}
			case "search": {
				const query = rest.toLowerCase();
				const filtered = cwdLearnings.filter(l => l.content.toLowerCase().includes(query));
				if (filtered.length === 0) {
					ctx.ui.notify(`No learnings matching "${rest}"`, "info");
					return;
				}
				const lines = filtered.map(
					l => `[${l.lifecycle}] ${l.kind}: ${l.content} (id: ${l.id}, source: ${l.source})`,
				);
				ctx.ui.notify(lines.join("\n"), "info");
				break;
			}
			case "pin": {
				const id = rest;
				if (!id) {
					ctx.ui.notify("Usage: /evolution learnings pin <id>", "warning");
					return;
				}
				const ok = await store.pin(id);
				if (!ok) {
					ctx.ui.notify(`Learning "${id}" not found`, "error");
					return;
				}
				const outputDir = resolveEvolutionProjectionDir(ctx.cwd, stores.flags().globalStore);
				await projectLearnings(stores.db(), { outputDir });
				ctx.ui.notify(`Pinned learning ${id} (active, injected on next turn)`, "info");
				break;
			}
			case "archive": {
				const id = rest;
				if (!id) {
					ctx.ui.notify("Usage: /evolution learnings archive <id>", "warning");
					return;
				}
				const ok = await store.archive(id);
				if (!ok) {
					ctx.ui.notify(`Learning "${id}" not found`, "error");
					return;
				}
				ctx.ui.notify(`Archived learning ${id}`, "info");
				break;
			}
			case "delete": {
				const id = rest;
				if (!id) {
					ctx.ui.notify("Usage: /evolution learnings delete <id>", "warning");
					return;
				}
				const ok = await store.delete(id);
				ctx.ui.notify(ok ? `Deleted learning ${id}` : `Learning "${id}" not found`, ok ? "info" : "error");
				break;
			}
			default: {
				const lines = cwdLearnings
					.slice(0, 30)
					.map(
						l =>
							`[${l.lifecycle}] ${l.kind}: ${l.content.slice(0, 100)} (conf ${l.confidence}, ${l.source}, id: ${l.id})`,
					);
				if (cwdLearnings.length > 30) {
					lines.push(`... and ${cwdLearnings.length - 30} more. Use /evolution learnings search <keyword>`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			}
		}
	} catch (err) {
		logger.error("evolution learnings failed", { error: String(err) });
		ctx.ui.notify("Failed to manage learnings", "error");
	}
}

async function handleLog(stores: CommandStores, ctx: any, _args: string): Promise<void> {
	try {
		const logger = stores.activityLogger();
		const entries = await logger.query({ limit: 50 });
		if (entries.length === 0) {
			ctx.ui.notify("No activity log entries yet", "info");
			return;
		}
		const lines = entries.map(
			e =>
				`[${new Date(e.timestamp).toISOString().slice(0, 19).replace("T", " ")}] ${e.event}: ${JSON.stringify(e.details).slice(0, 80)}`,
		);
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution log failed", { error: String(err) });
		ctx.ui.notify("Failed to read activity log", "error");
	}
}

async function handleNudges(stores: CommandStores, ctx: any, args: string): Promise<void> {
	try {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const sub = parts[0]?.toLowerCase();
		const id = parts[1];

		if (sub === "ack" && id) {
			const record = await stores.nudgeHistoryStore().get(id);
			if (!record) {
				ctx.ui.notify(`Nudge not found: ${id}`, "warning");
				return;
			}
			await stores.nudgeHistoryStore().acknowledge(id);
			ctx.ui.notify(`Acknowledged nudge ${id}`, "info");
			return;
		}

		if (sub === "dismiss" && id) {
			const record = await stores.nudgeHistoryStore().get(id);
			if (!record) {
				ctx.ui.notify(`Nudge not found: ${id}`, "warning");
				return;
			}
			await stores.nudgeHistoryStore().dismiss(id);
			ctx.ui.notify(`Dismissed nudge ${id} (suppressed for 7 days)`, "info");
			return;
		}

		const nudges = await stores.nudgeHistoryStore().listRecent(20);
		if (nudges.length === 0) {
			ctx.ui.notify("No nudges recorded yet", "info");
			return;
		}
		const lines = nudges.map(n => {
			const flags = [
				n.contextInjected ? "injected" : "pending",
				n.acknowledged ? "ack" : null,
				n.dismissedAt ? "dismissed" : null,
				n.outcomeScore !== undefined ? `score:${n.outcomeScore.toFixed(2)}` : null,
				n.patternRepeated ? "repeated" : null,
			]
				.filter(Boolean)
				.join(", ");
			return `${n.id}\n  [${n.type}] ${n.severity} (${flags})\n  ${n.message}`;
		});
		ctx.ui.notify(`${lines.join("\n\n")}\n\nUsage: /evolution nudges ack <id> | dismiss <id>`, "info");
	} catch (err) {
		logger.error("evolution nudges failed", { error: String(err) });
		ctx.ui.notify("Failed to list nudges", "error");
	}
}

async function handleStuck(stores: CommandStores, ctx: any, args: string): Promise<void> {
	try {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const sub = parts[0]?.toLowerCase();
		const id = parts[1];
		const escalationStore = stores.escalationStore();

		if (sub === "sync") {
			await syncEvolutionEscalations({
				escalationStore,
				fixtureStore: stores.regressionFixtureStore(),
				learningStore: stores.learningStore(),
				trialStore: stores.regressionTrialStore(),
			});
			ctx.ui.notify("Escalation scan complete", "info");
			return;
		}

		if (sub === "ack" && id) {
			const record = await escalationStore.get(id);
			if (!record) {
				ctx.ui.notify(`Escalation not found: ${id}`, "warning");
				return;
			}
			await escalationStore.acknowledge(id);
			ctx.ui.notify(`Acknowledged escalation ${id}`, "info");
			return;
		}

		if (sub === "resolve" && id) {
			const record = await escalationStore.get(id);
			if (!record) {
				ctx.ui.notify(`Escalation not found: ${id}`, "warning");
				return;
			}
			await escalationStore.resolve(id);
			ctx.ui.notify(`Resolved escalation ${id} — auto-insert for this pattern re-enabled`, "info");
			return;
		}

		const open = await escalationStore.listOpen();
		if (open.length === 0) {
			ctx.ui.notify("No open evolution deadlocks. System is not stuck on a recurring pattern.", "info");
			return;
		}

		const lines = open.map(
			e =>
				`${e.id} [${e.status}] (${e.occurrenceCount}x, ${e.failedImprovementCount} failed auto-fixes)\n  Label: ${e.patternLabel}\n  Tool: ${e.dominantErrorTool ?? "—"}\n  Error: ${e.dominantErrorPattern ?? "—"}\n  ${e.message}\n  ${e.suggestion}`,
		);
		ctx.ui.notify(`${lines.join("\n\n")}\n\nUsage: /evolution stuck ack <id> | resolve <id> | sync`, "warning");
	} catch (err) {
		logger.error("evolution stuck failed", { error: String(err) });
		ctx.ui.notify("Failed to load evolution escalations", "error");
	}
}

async function handleHelp(ctx: any): Promise<void> {
	const lines = [
		"Usage: /evolution <subcommand> [args]",
		"",
		"Subcommands:",
		"  status              Show statistics (episodes, skills, versions)",
		"  skills [--detail]   List evolved skills with optional score breakdown",
		"  rate <name> <1-5>   Rate a skill",
		"  clear               Delete .omp/evolution/memory + evolution + skills (full reset)",
		"  memory <sub>        Memory: search|stats|report|view|enqueue|refresh-summary|clear",
		"  archive             Archive low-quality skills",
		"  history <name>      View version history for a skill",
		"  rollback <n> <v>    Rollback a skill to a version",
		"  profile             Display user behavioral profile",
		"  workflows [intent]  List mined workflow patterns",
		"  audit               Generate health report",
		"  report              Generate daily report",
		"  fit                 Run '懂我程度' evaluation",
		"  population          Show skill population status",
		"  learnings [search|pin|archive|delete|seed [file]]  Learnings; seed imports JSON rules",
		"  log                     Show evolution event timeline",
		"  nudges [ack|dismiss] <id>  List nudges or acknowledge/dismiss by id",
		"  stuck [ack|resolve|sync]   Evolution deadlocks needing human intervention",
		"  sync-skills             Export skills with scores to markdown files",
		"  backfill-traces [limit] Backfill session_traces from omp session JSONL",
		"  refresh-admission       Skill benefit admission (+ skill regression when configured)",
		"  regression [limit]      List recent regression trials",
		"",
		"",
		"/memory is an alias for /evolution memory.",
		"CLI flags: --self-evolution-regression-replay=heuristic|llm|subagent",
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleRefreshAdmission(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const result = await refreshBenefitAdmissionState({
			skillStore: stores.skillStore(),
			skillEffectivenessStore: stores.skillEffectivenessStore(),
			populationStore: stores.populationStore(),
		});
		ctx.ui.notify(
			[`Admission refresh complete.`, `Skills deprecated: ${result.skillsDeprecated}`].join("\n"),
			"info",
		);
	} catch (err) {
		logger.error("evolution refresh-admission failed", { error: String(err) });
		ctx.ui.notify("Failed to refresh benefit admission", "error");
	}
}

async function handleRegressionTrials(stores: CommandStores, ctx: any, args: string): Promise<void> {
	try {
		const limit = args.trim() ? Number.parseInt(args.trim(), 10) : 15;
		if (!Number.isFinite(limit) || limit < 1) {
			ctx.ui.notify("Usage: /evolution regression [limit]", "warning");
			return;
		}
		const trials = await stores.regressionTrialStore().listRecent(limit);
		if (trials.length === 0) {
			ctx.ui.notify("No regression trials recorded yet. Run sessions or /evolution backfill-traces first.", "info");
			return;
		}
		const lines = trials.map(t => {
			const backend = parseReplayBackendFromTrialReason(t.reason) ?? "?";
			const chain = parseToolchainTagFromTrialReason(t.reason);
			const chainLabel = chain ? ` toolchain:${chain}` : "";
			const shortReason = t.reason.length > 100 ? `${t.reason.slice(0, 97)}...` : t.reason;
			return `${t.id} [${t.verdict}] ${t.targetType}/${t.targetId} replay:${backend}${chainLabel}\n  ${shortReason}`;
		});
		ctx.ui.notify(lines.join("\n\n"), "info");
	} catch (err) {
		logger.error("evolution regression trials failed", { error: String(err) });
		ctx.ui.notify("Failed to list regression trials", "error");
	}
}

async function handleBackfillTraces(stores: CommandStores, ctx: any, args: string): Promise<void> {
	try {
		const limit = args.trim() ? Number.parseInt(args.trim(), 10) : 200;
		if (!Number.isFinite(limit) || limit < 1) {
			ctx.ui.notify("Usage: /evolution backfill-traces [limit]", "warning");
			return;
		}
		const result = await backfillSessionTracesFromEpisodes({
			episodeStore: stores.episodeStore(),
			traceStore: stores.sessionTraceStore(),
			fixtureStore: stores.regressionFixtureStore(),
			sessionsRoot: getSessionsDir(),
			limit,
		});
		const repair = await repairRegressionFixtureLabels({
			db: stores.db(),
			fixtureStore: stores.regressionFixtureStore(),
			traceStore: stores.sessionTraceStore(),
			diagnosisStore: new SqliteEpisodeDiagnosisStore(stores.db()),
		});
		await syncEvolutionEscalationsAfterRepair(stores);
		await refreshBenefitAdmissionAfterBackfill(stores);
		ctx.ui.notify(
			[
				`Backfill: scanned ${result.scanned}, traces ${result.tracesWritten}, upgraded ${result.tracesUpgraded}, fixtures ${result.fixturesWritten}, skipped ${result.skippedExisting}, jsonl misses ${result.jsonlMisses}`,
				`Fixture labels repaired: ${repair.updated} updated (${repair.unchanged} unchanged, ${repair.missingTrace} missing trace)`,
			].join("\n"),
			"info",
		);
	} catch (err) {
		logger.error("evolution backfill-traces failed", { error: String(err) });
		ctx.ui.notify("Failed to backfill session traces", "error");
	}
}

async function syncEvolutionEscalationsAfterRepair(stores: CommandStores): Promise<void> {
	await syncEvolutionEscalations({
		escalationStore: stores.escalationStore(),
		fixtureStore: stores.regressionFixtureStore(),
		learningStore: stores.learningStore(),
		trialStore: stores.regressionTrialStore(),
		fixtureLookback: 80,
	});
}

async function refreshBenefitAdmissionAfterBackfill(stores: CommandStores): Promise<void> {
	await refreshBenefitAdmissionState({
		skillStore: stores.skillStore(),
		skillEffectivenessStore: stores.skillEffectivenessStore(),
		populationStore: stores.populationStore(),
	});
}

async function handleSyncSkills(stores: CommandStores, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const outputDir = getUnifiedSkillsDir(ctx.cwd, stores.flags().globalStore);
		const result = await syncSkillsToFiles(stores.db(), outputDir);
		ctx.ui.notify(
			`Synced ${result.written} skills to ${outputDir}` +
				(result.skippedQuality > 0 ? ` (skipped ${result.skippedQuality} below template)` : "") +
				(result.purgedInvalid > 0 ? ` (purged ${result.purgedInvalid} invalid)` : "") +
				(result.repairedPopulationScores > 0
					? ` (repaired ${result.repairedPopulationScores} population scores)`
					: ""),
			"info",
		);
	} catch (err) {
		logger.error("evolution sync-skills failed", { error: String(err) });
		ctx.ui.notify("Failed to sync skills to files", "error");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// /profile standalone command
// ─────────────────────────────────────────────────────────────────────────────

export function registerProfileCommand(api: ExtensionAPI, stores: CommandStores): void {
	api.registerCommand("profile", {
		description: "User profile. Usage: /profile <subcommand> [args]",
		getArgumentCompletions(argumentPrefix: string) {
			if (argumentPrefix.includes(" ")) return null;
			const subs = [
				{ name: "show", description: "Show user profile" },
				{ name: "stats", description: "Show profile statistics" },
			];
			const lower = argumentPrefix.toLowerCase();
			return subs
				.filter(s => s.name.startsWith(lower))
				.map(s => ({ value: `${s.name} `, label: s.name, description: s.description }));
		},
		async handler(args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			const trimmed = args.trim();
			const subcommand = trimmed.split(/\s+/, 1)[0]?.toLowerCase() || "show";

			try {
				const profile = await stores.profileStore().get("default");
				if (!profile) {
					ctx.ui.notify("No profile data yet", "info");
					return;
				}
				switch (subcommand) {
					case "show": {
						const lines = [
							`Sessions: ${profile.sessionCount}`,
							`Avg tools/session: ${profile.avgToolCallsPerSession.toFixed(1)}`,
							`Avg files/session: ${profile.avgFilesModifiedPerSession.toFixed(1)}`,
							`Avg tool errors/session: ${profile.errorRate.toFixed(1)}`,
							`Recovery rate: ${(profile.recoveryRate * 100).toFixed(0)}%`,
							`Languages: ${profile.preferredLanguages.join(", ") || "none"}`,
							`Top tools: ${Object.entries(profile.toolFrequency)
								.sort((a, b) => b[1] - a[1])
								.slice(0, 5)
								.map(([t, c]) => `${t}(${c})`)
								.join(", ")}`,
						];
						ctx.ui.notify(lines.join("\n"), "info");
						break;
					}
					case "stats": {
						const topIntents = Object.entries(profile.intentDistribution)
							.sort((a, b) => b[1] - a[1])
							.map(([i, c]) => `${i}: ${c}`)
							.join(", ");
						ctx.ui.notify(`Intents: ${topIntents || "none"}`, "info");
						break;
					}
				}
			} catch (err) {
				logger.error("profile command failed", { error: String(err) });
				ctx.ui.notify("Failed to load profile", "error");
			}
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// /model standalone command
// ─────────────────────────────────────────────────────────────────────────────

export function registerModelStatsCommand(api: ExtensionAPI, stores: CommandStores): void {
	api.registerCommand("model-stats", {
		description: "Model scores and routing. Usage: /model-stats",
		getArgumentCompletions(argumentPrefix: string) {
			if (argumentPrefix.includes(" ")) return null;
			const subs = [{ name: "scores", description: "Show model scores and stats" }];
			const lower = argumentPrefix.toLowerCase();
			return subs
				.filter(s => s.name.startsWith(lower))
				.map(s => ({ value: `${s.name} `, label: s.name, description: s.description }));
		},
		async handler(_args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			try {
				const statsStore = new SqliteSessionModelStatsStore(stores.db());
				const _scorer = new ModelScorer(statsStore);
				const allStats = await statsStore.getAggregates();
				const lines: string[] = [];
				if (allStats.totalSessions === 0) {
					lines.push("No model data collected yet. Stats are recorded during agent sessions.");
				} else {
					lines.push(`Total sessions tracked: ${allStats.totalSessions}`);
					lines.push(
						`Overall avg tokens: ${allStats.avgTokens.toFixed(0)} | avg duration: ${(allStats.avgDuration / 1000).toFixed(1)}s | success rate: ${(allStats.successRate * 100).toFixed(0)}%`,
					);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				logger.error("model scores failed", { error: String(err) });
				ctx.ui.notify("Model scoring not yet available", "info");
			}
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

/** Build heuristic mock responses from profile data for fit evaluation. */
function buildHeuristicResponses(profile: UserProfile | null | undefined): Map<string, string> {
	const responses = new Map<string, string>();
	const topTools =
		Object.entries(profile?.toolFrequency ?? {})
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([t]) => t)
			.join(", ") || "search, read, edit";
	const languages = profile?.preferredLanguages.join(", ") || "TypeScript, Rust";

	// MEMORY dimension responses
	responses.set("MEMORY-001", `技术栈: ${languages}`);
	responses.set("MEMORY-002", "业务方向: 需要更多上下文");
	responses.set("MEMORY-003", "做事风格: 架构先行、结论前置、精简输出");
	responses.set("MEMORY-004", "核心项目: 暂无历史记录");
	responses.set("MEMORY-005", "资产关注点: 暂无数据");

	// THINKING dimension responses
	responses.set(
		"THINK-001",
		`- 架构分层：数据源 → 处理引擎 → 报表渲染
- 模块拆分：采集层、计算层、存储层、展示层
- 落地路径：先跑通最小可用版本，再迭代优化
- 风险点：数据一致性、查询性能、权限控制`,
	);
	responses.set(
		"THINK-002",
		`- 技术风险：性能瓶颈、扩展性受限
- 业务风险：需求变更、用户接受度
- 运维风险：部署复杂度、监控覆盖
- 缓解：分阶段上线、回退方案、灰度发布`,
	);
	responses.set(
		"THINK-003",
		"| 维度 | 方案A | 方案B |\n|---|---|---|\n| 成本 | 低 | 中 |\n| 效率 | 中 | 高 |\n| 维护 | 高 | 低 |\n推荐：方案A（综合成本更低）",
	);
	responses.set(
		"THINK-004",
		`- 架构层：服务拆分、缓存策略、异步化
- 算法层：时间复杂度优化、批量处理
- IO层：连接池、批处理、压缩
优先级：先定位瓶颈（profiling），再针对性优化`,
	);
	responses.set(
		"THINK-005",
		`- 阶段1：评估现状（代码扫描、依赖分析）
- 阶段2：设计新架构（接口定义、模块边界）
- 阶段3：渐进迁移（Strangler Fig模式）
- 阶段4：验证回退（并行运行、对比测试）
风险：数据迁移、接口不兼容；回退：保留旧版本`,
	);

	// STYLE dimension responses
	responses.set("STYLE-001", "结论：方案可行，建议分阶段实施。详见：1. 架构设计 2. 风险评估");
	responses.set("STYLE-002", "- 完成功能X开发\n- 修复Bug #123\n- 优化构建速度 30%");
	responses.set("STYLE-003", "修复步骤：\n1. 定位错误行\n2. 修正类型声明\n3. 补充边界测试");
	responses.set("STYLE-004", "# 技术方案\n## 1. 概述\n## 2. 架构设计\n## 3. 模块说明\n## 4. 部署方案\n## 5. 风险评估");

	// PREDICTION dimension responses
	responses.set(
		"PREDICT-001",
		`需要明确：1. 哪个模块性能差？2. 当前瓶颈在哪？3. 量化指标是什么？
预判建议：先跑 profiling，再针对性优化`,
	);
	responses.set(
		"PREDICT-002",
		`风险清单：
1. [高] 性能下降 → 缓解：压测验证
2. [中] 兼容性 → 缓解：版本兼容层
3. [低] 运维复杂度 → 缓解：自动化脚本`,
	);
	responses.set(
		"PREDICT-003",
		`审查结果：
- [严重] 空指针风险：第42行未判空
- [警告] 未处理边界条件：数组越界
- [建议] 可缓存重复查询结果`,
	);

	// HISTORY dimension responses
	responses.set(
		"HISTORY-001",
		`上次讨论的方案是分阶段实施报表系统。当前进展：已完成数据采集层设计。下一步：处理引擎选型`,
	);
	responses.set("HISTORY-002", "记得你提过性能优化的问题。之前建议的方向是缓存策略和异步化，需要我继续展开吗？");
	responses.set("HISTORY-003", "上次讨论到架构分层方案，确定了数据源→处理→展示三层结构。接下来可以细化每层的接口定义");

	// Enrich responses with profile data if available
	if (profile) {
		const toolStr = `常用工具: ${topTools}`;
		const langStr = `偏好语言: ${languages}`;
		responses.set("MEMORY-001", `${langStr}\n${toolStr}`);
	}

	return responses;
}
