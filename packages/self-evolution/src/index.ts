/**
 * Self-evolution extension factory.
 *
 * Registers event handlers, commands, tools, and flags for automatic
 * skill extraction and episodic memory retrieval.
 */
import type { Database } from "bun:sqlite";
import * as path from "node:path";
import { Pipeline } from "@oh-my-pi/cognitive-coordination/assembler";
import { validateSkill } from "@oh-my-pi/cognitive-coordination/sandbox";
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import { getAgentDir, getSessionsDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { isSkillEligibleForInjection } from "./benefit-admission";
import { refreshBenefitAdmissionState } from "./benefit-admission-refresh";
import {
	registerEpisodicCommands,
	registerModelStatsCommand,
	registerProfileCommand,
	registerSelfEvolutionCommands,
} from "./commands";
import { ContextAwareRetriever, type RetrievedEpisode } from "./context-aware-retriever";
import { CrossSessionNudgeEngine } from "./cross-session-nudge";
import { EffectivenessAnalyzer } from "./effectiveness-analyzer";
import { EpisodicManager } from "./episodic-manager";
import { diagnoseToolError } from "./error-diagnosis/tool-error-diagnoser";
import { ErrorPatternExtractor } from "./error-pattern-extractor";
import { errorPatternKey } from "./escalation/pattern-key";
import { syncEvolutionEscalations } from "./escalation/sync";
import { FeedbackTracker } from "./feedback-tracker";
import type { InjectionFormatter } from "./injection-formatter";
import { IntentClassifier } from "./intent-classifier";
import { checkLearningRelevance } from "./learning-relevance";
import { type ActivityLogger, closeActivityLogger, getActivityLogger } from "./logging/activity-logger";
import { projectEvolutionLog } from "./logging/evolution-log";
import { SkillManager } from "./manager";
import { registerMemoryCommands } from "./memory-commands";
import { buildNudgeContextUserMessage } from "./nudge-context-injector";
import { NudgeDeliverer } from "./nudge-deliverer";
import { NudgeEffectivenessTracker } from "./nudge-effectiveness";
import { persistNudgeRecord } from "./nudge-persist";
import { crossSessionNudgeToNudge, NudgeSuppressionCache } from "./nudge-suppression";
import { getMemoryRoot, getUnifiedSkillsDir, resolveEvolutionProjectionDir, resolveGlobalStoreFromFlag } from "./paths";
import { projectLearnings } from "./projection/learnings";
import { projectSystemDiagnosis } from "./projection/system-diagnosis";
import { hydrateSessionTraceFromJsonlIfRicher } from "./regression/backfill-traces";
import { buildRegressionFixtureFromTrace } from "./regression/fixture-from-trace";
import {
	createRegressionReplayBackend,
	parseRegressionReplayBackendKind,
	type RegressionReplayBackend,
} from "./regression/replay-backend";
import { EpisodeRetriever } from "./retrieval";
import { extractSessionLearnings } from "./session-learner";
import { SkillPopulationEngine } from "./skill-population-engine";
import { closeEvolutionDb, getEvolutionDb } from "./storage/db";
import { SqliteDetailedOutcomeStore } from "./storage/detailed-outcomes";
import { SqliteEpisodeDiagnosisStore } from "./storage/diagnoses";
import { SqliteEffectivenessStore } from "./storage/effectiveness";
import { SqliteEpisodeStore } from "./storage/episodes";
import { SqliteEvolutionEscalationStore } from "./storage/evolution-escalations";
import { SqliteIntentStore } from "./storage/intents";
import { SqliteLearningStore } from "./storage/learnings";
import { SqliteNudgeHistoryStore } from "./storage/nudge-history";
import { SqliteRegressionFixtureStore } from "./storage/regression-fixtures";
import { SqliteRegressionTrialStore } from "./storage/regression-trials";
import { SqliteSessionTraceStore } from "./storage/session-traces";
import { SqliteSkillEffectivenessStore } from "./storage/skill-effectiveness";
import { SqliteSkillPopulationStore } from "./storage/skill-population";
import { SqliteSkillStore, SqliteSkillVersionStore, SqliteStatsStore } from "./storage/skills";
import { SqliteWorkflowPatternStore } from "./storage/workflow-patterns";
import { registerSelfEvolutionTools } from "./tools";
import { summarizeTrace, TraceRecorder } from "./trace";
import { ingestExternalTraces } from "./trace-ingester";
import type { IntentResult, SelfEvolutionFlags } from "./types";
import { loadUnifiedSkillsForInjection } from "./unified-skills";
import { extractUserExplicitLearnings } from "./user-explicit-learnings";

import { createBackgroundLlmAuth } from "./utils/background-llm-auth";
import { resolveBackgroundModel } from "./utils/background-model";
import { setupSkillsWatcher } from "./watcher";
import { WorkflowMiner } from "./workflow-miner";

export { DEFAULT_EVOLUTION_GLOBAL_STORE, resolveGlobalStoreFromFlag } from "./paths";
export type { SelfEvolutionFlags };

export function parseFlags(api: ExtensionAPI): SelfEvolutionFlags {
	return {
		enabled: api.getFlag("self-evolution") !== false,
		skillThreshold: Number(api.getFlag("self-evolution-skill-threshold") ?? "5"),
		maxEpisodes: Number(api.getFlag("self-evolution-max-episodes") ?? "100"),
		enablePromptInjection: api.getFlag("self-evolution-enable-prompt-injection") !== false,
		enableNudgeContextInjection: api.getFlag("self-evolution-enable-nudge-context-injection") === true,
		enableNudgeUI: api.getFlag("self-evolution-enable-nudge-ui") !== false,
		llmRefinement: api.getFlag("self-evolution-llm-refinement") !== false,
		llmRerank: api.getFlag("self-evolution-llm-rerank") !== false,
		enableVersioning: api.getFlag("self-evolution-enable-versioning") !== false,
		enableActivityLog: api.getFlag("self-evolution-enable-activity-log") !== false,
		globalStore: resolveGlobalStoreFromFlag(api.getFlag.bind(api)),
		regressionReplayBackend: parseRegressionReplayBackendKind(api.getFlag("self-evolution-regression-replay")),
		admissionReclassifyInterval: Math.max(
			1,
			Number(api.getFlag("self-evolution-admission-reclassify-interval") ?? "5"),
		),
		enableStuckWarning: api.getFlag("self-evolution-enable-stuck-warning") !== false,
	};
}
export const createSelfEvolutionExtension: ExtensionFactory = api => {
	// Register CLI flags
	api.registerFlag("self-evolution", { type: "boolean", default: true, description: "Enable self-evolution plugin" });
	api.registerFlag("self-evolution-skill-threshold", {
		type: "string",
		default: "5",
		description: "Min tool calls to trigger skill extraction",
	});
	api.registerFlag("self-evolution-max-episodes", {
		type: "string",
		default: "500",
		description: "Max episodes to retain for retrieval",
	});
	api.registerFlag("self-evolution-enable-nudge-context-injection", {
		type: "boolean",
		default: true,
		description: "Inject session nudges into the next LLM context (off = control arm for A/B)",
	});
	api.registerFlag("self-evolution-enable-nudge-ui", {
		type: "boolean",
		default: true,
		description: "Show nudge notifications in the chat UI",
	});
	api.registerFlag("self-evolution-enable-prompt-injection", {
		type: "boolean",
		default: true,
		description: "Inject learnings/skills into system prompt",
	});
	api.registerFlag("self-evolution-enable-episode-injection", {
		type: "boolean",
		default: false,
		description: "Inject retrieved episode summaries into system prompt (default off; learnings/skills unchanged)",
	});
	api.registerFlag("self-evolution-llm-refinement", {
		type: "boolean",
		default: true,
		description: "Use LLM to refine extracted skills",
	});
	api.registerFlag("self-evolution-llm-rerank", {
		type: "boolean",
		default: true,
		description: "Use LLM to rerank retrieved episodes",
	});
	api.registerFlag("self-evolution-enable-versioning", {
		type: "boolean",
		default: true,
		description: "Enable skill version snapshots",
	});
	api.registerFlag("self-evolution-enable-activity-log", {
		type: "boolean",
		default: true,
		description: "Enable JSONL activity logging",
	});
	api.registerFlag("self-evolution-enable-stuck-warning", {
		type: "boolean",
		default: true,
		description: "Show Evolution stuck escalation warnings in the chat UI",
	});
	api.registerFlag("self-evolution-global-store", {
		type: "boolean",
		default: false,
		description:
			"Global user store: ~/.omp/self-evolution + memory under ~/.omp/self-evolution/memory/ (enable to override project store)",
	});
	api.registerFlag("self-evolution-project-store", {
		type: "boolean",
		default: true,
		description: "Per-project store (default): <cwd>/.omp/evolution/memory, evolution.db, skills",
	});
	api.registerFlag("self-evolution-regression-replay", {
		type: "string",
		default: "llm",
		description:
			"Regression replay backend: heuristic | llm | subagent (subagent spawns omp -p with --no-self-evolution)",
	});
	api.registerFlag("self-evolution-admission-reclassify-interval", {
		type: "string",
		default: "5",
		description: "Reserved for skill regression cadence when using llm/subagent replay backends",
	});

	let flags = parseFlags(api);
	if (!flags.enabled) {
		logger.debug("Self-evolution extension disabled by flag");
		return;
	}

	// Lazily initialize per-session state. Variables are declared here
	// and populated by ensureInit when first needed (event handler or command).
	let latestCwd = "";
	let diagnosisStore: SqliteEpisodeDiagnosisStore | undefined;
	let recorder: TraceRecorder | undefined;
	let activityLogger: ActivityLogger | undefined;
	let episodeStore: SqliteEpisodeStore | undefined;
	let skillStore: SqliteSkillStore | undefined;
	let versionStore: SqliteSkillVersionStore | undefined;
	let statsStore: SqliteStatsStore | undefined;
	let skillManager: SkillManager | undefined;
	let intentStore: SqliteIntentStore | undefined;
	let effectivenessStore: SqliteEffectivenessStore | undefined;
	let skillEffectivenessStore: SqliteSkillEffectivenessStore | undefined;
	let intentClassifier: IntentClassifier | undefined;
	let workflowMiner: WorkflowMiner | undefined;
	let workflowPatternStore: SqliteWorkflowPatternStore | undefined;
	let feedbackTracker: FeedbackTracker | undefined;
	let contextAwareRetriever: ContextAwareRetriever | undefined;
	let episodeRetriever: EpisodeRetriever | undefined;
	let nudgeHistoryStore: SqliteNudgeHistoryStore | undefined;
	let nudgeSuppressionCache: NudgeSuppressionCache | undefined;
	let nudgeEffectivenessTracker: NudgeEffectivenessTracker | undefined;
	let crossSessionNudgeEngine: CrossSessionNudgeEngine | undefined;

	let errorPatternExtractor: ErrorPatternExtractor | undefined;
	let effectivenessAnalyzer: EffectivenessAnalyzer | undefined;
	let populationStore: SqliteSkillPopulationStore | undefined;
	let populationEngine: SkillPopulationEngine | undefined;
	let detailedOutcomeStore: SqliteDetailedOutcomeStore | undefined;
	let injectionFormatter: InjectionFormatter | undefined;
	let episodicManager: EpisodicManager | undefined;
	let pipeline: Pipeline | undefined;
	let db: Database | undefined;
	let memoryDb: Database | undefined;
	let stopSkillsWatcher: (() => void) | undefined;
	let sessionTraceStore: SqliteSessionTraceStore | undefined;
	let regressionFixtureStore: SqliteRegressionFixtureStore | undefined;
	let regressionTrialStore: SqliteRegressionTrialStore | undefined;
	let evolutionEscalationStore: SqliteEvolutionEscalationStore | undefined;
	let learningStore: SqliteLearningStore | undefined;
	let benefitAdmissionRefreshed = false;
	let regressionReplayBackend: RegressionReplayBackend | undefined;
	const _admissionSessionOrdinal = 0;

	function _regressionReplayBackend(): RegressionReplayBackend {
		if (!regressionReplayBackend) {
			regressionReplayBackend = createRegressionReplayBackend(flags.regressionReplayBackend);
		}
		return regressionReplayBackend;
	}

	async function _ensureBenefitAdmissionRefresh(): Promise<void> {
		if (benefitAdmissionRefreshed || !skillStore || !skillEffectivenessStore) return;
		benefitAdmissionRefreshed = true;
		try {
			const result = await refreshBenefitAdmissionState({
				skillStore,
				skillEffectivenessStore,
				populationStore,
			});
			if (result.skillsDeprecated > 0) {
				logger.debug("Benefit admission refresh applied", { ...result });
			}
		} catch (err) {
			logger.warn("Benefit admission refresh failed", { error: String(err) });
			benefitAdmissionRefreshed = false;
		}
	}

	function _ensureInit(cwd: string): void {
		if (recorder) return;
		latestCwd = cwd;
		flags = parseFlags(api);
		regressionReplayBackend = undefined;
		recorder = new TraceRecorder();
		activityLogger = getActivityLogger(cwd, flags.globalStore);
		const evolutionDb = getEvolutionDb(cwd, flags.globalStore);
		db = evolutionDb;
		skillStore = new SqliteSkillStore(db);
		versionStore = new SqliteSkillVersionStore(db);
		skillEffectivenessStore = new SqliteSkillEffectivenessStore(db);
		episodeStore = new SqliteEpisodeStore(db);
		populationStore = new SqliteSkillPopulationStore(db);
		populationEngine = new SkillPopulationEngine(populationStore, skillStore);
		if (regressionFixtureStore && regressionTrialStore) {
			populationEngine.setRegressionDeps({
				fixtureStore: regressionFixtureStore,
				trialStore: regressionTrialStore,
				replayBackend: _regressionReplayBackend(),
			});
		}
		skillManager = new SkillManager(
			skillStore,
			versionStore,
			activityLogger,
			skillEffectivenessStore,
			episodeStore,
			{
				enableVersioning: flags.enableVersioning,
				maxVersions: 20,
			},
			populationEngine,
		);

		intentStore = new SqliteIntentStore(db);
		workflowPatternStore = new SqliteWorkflowPatternStore(db);
		effectivenessStore = new SqliteEffectivenessStore(db);
		contextAwareRetriever = new ContextAwareRetriever(episodeStore, intentStore, effectivenessStore);
		episodeRetriever = new EpisodeRetriever(episodeStore);
		intentClassifier = new IntentClassifier();
		workflowMiner = new WorkflowMiner();
		detailedOutcomeStore = new SqliteDetailedOutcomeStore(db);
		feedbackTracker = new FeedbackTracker(effectivenessStore, skillEffectivenessStore, detailedOutcomeStore);
		nudgeHistoryStore = new SqliteNudgeHistoryStore(db);
		nudgeSuppressionCache = new NudgeSuppressionCache();
		nudgeEffectivenessTracker = new NudgeEffectivenessTracker();
		crossSessionNudgeEngine = new CrossSessionNudgeEngine(nudgeHistoryStore, episodeStore, diagnosisStore);
		sessionTraceStore = new SqliteSessionTraceStore(db);
		regressionFixtureStore = new SqliteRegressionFixtureStore(db);
		regressionTrialStore = new SqliteRegressionTrialStore(db);
		evolutionEscalationStore = new SqliteEvolutionEscalationStore(db);
		learningStore = new SqliteLearningStore(db);
		errorPatternExtractor = new ErrorPatternExtractor();
		effectivenessAnalyzer = new EffectivenessAnalyzer();
		diagnosisStore = new SqliteEpisodeDiagnosisStore(db);
		statsStore = new SqliteStatsStore(db);
		episodicManager = EpisodicManager.create(db);
		pipeline = new Pipeline({ maxTokens: 2000 });

		if (!stopSkillsWatcher && db) {
			const skillsDir = getUnifiedSkillsDir(cwd, flags.globalStore);
			stopSkillsWatcher = setupSkillsWatcher(skillsDir, db);
		}

		memoryDb = evolutionDb;
	}

	async function _retrieveRelevantSkills(
		query: string,
	): Promise<Array<{ name: string; taskPattern: string; approach: string }>> {
		// Use population engine for selection bias (prefers graduated > high-score experimental)
		const selected = await populationEngine?.selectForInjection(query);
		if (selected && selected.length > 0) {
			// Fetch full skill details for the selected population records
			const skills: Array<{ name: string; taskPattern: string; approach: string }> = [];
			for (const record of selected) {
				const skill = await skillStore?.get(record.name);
				if (!skill || skill.deprecated) continue;
				const eff = await skillEffectivenessStore?.get(skill.name);
				if (!isSkillEligibleForInjection(skill, eff)) continue;
				skills.push({ name: skill.name, taskPattern: skill.taskPattern, approach: skill.approach });
			}
			return skills;
		}

		// Fallback to simple keyword matching if population engine is unavailable
		if (!skillStore) return [];
		const skills = await skillStore.list({ deprecated: false });
		if (skills.length === 0) return [];

		const queryWords = query
			.toLowerCase()
			.split(/\W+/)
			.filter(w => w.length > 2);

		const scored = skills.map(skill => {
			const text = `${skill.name} ${skill.description} ${skill.taskPattern} ${skill.approach}`.toLowerCase();
			let matches = 0;
			for (const word of queryWords) {
				if (text.includes(word)) matches++;
			}
			const score = queryWords.length > 0 ? (matches / queryWords.length) * 100 : 50;
			return { skill, score };
		});

		scored.sort((a, b) => b.score - a.score);
		return scored
			.filter(s => s.score >= 30)
			.slice(0, 3)
			.map(s => ({ name: s.skill.name, taskPattern: s.skill.taskPattern, approach: s.skill.approach }));
	}

	// Register commands and tools in the factory body so they are collected
	// by the extension loader. Handlers call ensureInit on demand.
	const commandStores = {
		ensureInit: _ensureInit,
		episodeStore: () => episodeStore!,
		skillStore: () => skillStore!,
		versionStore: () => versionStore!,
		statsStore: () => statsStore!,
		skillManager: () => skillManager!,
		activityLogger: () => activityLogger!,
		workflowPatternStore: () => workflowPatternStore!,
		learningStore: () => learningStore!,
		effectivenessStore: () => effectivenessStore!,
		skillEffectivenessStore: () => skillEffectivenessStore!,
		populationStore: () => populationStore!,
		populationEngine: () => populationEngine!,
		nudgeHistoryStore: () => nudgeHistoryStore!,
		db: () => db!,
		flags: () => flags,
		episodicManager: () => episodicManager!,
		escalationStore: () => evolutionEscalationStore!,
		regressionFixtureStore: () => regressionFixtureStore!,
		regressionTrialStore: () => regressionTrialStore!,
		sessionTraceStore: () => sessionTraceStore!,
		memoryDb: () => memoryDb,
		embeddingGenerator: () => undefined,
	};

	registerSelfEvolutionCommands(api, commandStores);
	registerEpisodicCommands(api, commandStores);
	registerProfileCommand(api, commandStores);
	registerModelStatsCommand(api, commandStores);
	registerMemoryCommands(
		api,
		() => memoryDb,
		undefined,
		() => flags.globalStore,
	);

	registerSelfEvolutionTools(api, {
		ensureInit: _ensureInit,
		episodeRetriever: () => episodeRetriever!,
		learningStore: () => learningStore!,
		skillStore: () => skillStore!,
		skillManager: () => skillManager!,
		activityLogger: () => activityLogger!,
		getCwd: () => latestCwd,
	});

	api.on("agent_start", async (event, ctx) => {
		try {
			_ensureInit(ctx.cwd);
			recorder!.seedBackgroundModel(resolveBackgroundModel(ctx));
			recorder!.onAgentStart(event, ctx);
			crossSessionNudgeEngine?.resetSession();
			const cycleUserPrompt = recorder!.getTrace()?.userPrompt.trim() ?? "";
			activityLogger!
				.log("trace_started", {
					sessionId: ctx.sessionManager.getSessionId(),
					cwd: ctx.cwd,
					userPrompt: cycleUserPrompt,
				})
				.catch((err: unknown) => logger.warn("activity log failed", { error: String(err) }));
			episodicManager
				?.recordEvent({
					sessionId: ctx.sessionManager.getSessionId(),
					cwd: ctx.cwd,
					eventType: "session_started",
					eventData: { userPrompt: cycleUserPrompt },
					importanceScore: 0.5,
				})
				.catch((err: unknown) => logger.warn("episodic record failed", { error: String(err) }));
		} catch (err) {
			logger.error("Self-evolution agent_start handler failed", { error: String(err) });
		}

		// Fire-and-forget: ingest completed external traces
		(async () => {
			try {
				const _cwd = ctx.cwd;
				const result = await ingestExternalTraces(
					async sessionId => {
						const existing = await sessionTraceStore?.getBySessionId(sessionId);
						return !existing;
					},
					async trace => {
						const { summary, toolsUsed, filesModified } = summarizeTrace(trace);
						const episode = {
							id: `${trace.sessionId}-${trace.startTime}`,
							sessionId: trace.sessionId,
							cwd: trace.cwd,
							userPrompt: trace.userPrompt,
							timestamp: trace.startTime,
							durationMs: trace.endTime - trace.startTime,
							toolCallCount: trace.toolCallCount,
							errorCount: trace.errorCount,
							hadRecovery: trace.hadRecovery,
							completedSuccessfully: trace.completedSuccessfully,
							summary,
							toolsUsed,
							filesModified,
						};
						await episodeStore?.insert(episode);
						await sessionTraceStore?.upsert(trace, episode.id);
						await statsStore?.increment("sessions_archived");
						await activityLogger?.log("external_trace_ingested", { sessionId: trace.sessionId, summary });

						// Run session learner for learnings
						const backgroundModel = trace.backgroundModel ?? resolveBackgroundModel(ctx);
						const backgroundAuth = createBackgroundLlmAuth(ctx);
						const learnings = await extractSessionLearnings(trace, episode.id, backgroundModel, backgroundAuth);
						if (learnings.length > 0) {
							for (const l of learnings) {
								await learningStore?.insert(l);
							}
						}
					},
				);
				if (result.ingested > 0 || result.errors.length > 0) {
					logger.info("External trace ingestion complete", result);
				}
			} catch (err) {
				logger.warn("External trace ingestion failed", { error: String(err) });
			}
		})();
	});

	api.on("input", (event, _ctx) => {
		try {
			recorder?.onInput(event.text);
		} catch (err) {
			logger.error("Self-evolution input handler failed", { error: String(err) });
		}
	});

	api.on("tool_execution_start", (event, _ctx) => {
		try {
			recorder?.onToolExecutionStart(event);
			activityLogger
				?.log("tool_called", {
					sessionId: recorder?.getTrace()?.sessionId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
				})
				.catch((err: unknown) => logger.warn("activity log failed", { error: String(err) }));
			episodicManager
				?.recordEvent({
					sessionId: recorder?.getTrace()?.sessionId ?? "unknown",
					cwd: _ctx.cwd,
					eventType: "tool_called",
					eventData: { toolName: event.toolName, toolCallId: event.toolCallId },
					importanceScore: 0.3,
				})
				.catch((err: unknown) => logger.warn("episodic record failed", { error: String(err) }));
		} catch (err) {
			logger.error("Self-evolution tool_execution_start handler failed", { error: String(err) });
		}
	});

	api.on("tool_execution_end", async (event, _ctx) => {
		try {
			recorder?.onToolExecutionEnd(event);
			activityLogger
				?.log("tool_result", {
					sessionId: recorder?.getTrace()?.sessionId,
					toolCallId: event.toolCallId,
					isError: event.isError,
				})
				.catch((err: unknown) => logger.warn("activity log failed", { error: String(err) }));

			// LLM-based error diagnosis - diagnose tool failures and store learnings
			if (event.isError && learningStore) {
				diagnoseToolError(learningStore, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: (event as any).args ?? {},
					result: event.result,
					errorMessage: String(event.result ?? ""),
					sessionId: recorder?.getTrace()?.sessionId ?? _ctx.sessionManager.getSessionId(),
					cwd: _ctx.cwd,
				}).catch((err: unknown) => logger.warn("tool error diagnosis failed", { error: String(err) }));
			}
			const isNudgeTypeAllowed = (type: string) => !nudgeSuppressionCache?.isSuppressed(type);
			const nudge = recorder?.checkForNudges(isNudgeTypeAllowed);
			if (nudge && nudgeHistoryStore && recorder) {
				const trace = recorder.getTrace();
				const sessionId = trace?.sessionId ?? _ctx.sessionManager.getSessionId();
				const historyId = await persistNudgeRecord(nudgeHistoryStore, {
					sessionId,
					project: trace?.cwd ?? _ctx.cwd,
					nudge,
				}).catch((err: unknown) => {
					logger.warn("nudge history insert failed", { error: String(err) });
					return undefined;
				});
				if (historyId) {
					recorder.enqueuePendingAgentNudge(nudge, historyId);
					if (_ctx.hasUI && flags.enableNudgeUI) {
						new NudgeDeliverer().deliver(nudge, _ctx);
					}
					activityLogger
						?.log("session_nudge_detected", {
							sessionId,
							type: nudge.type,
							severity: nudge.severity,
							historyId,
						})
						.catch((err: unknown) => logger.warn("activity log failed", { error: String(err) }));
				}
			}
			nudgeEffectivenessTracker?.onToolExecution();
		} catch (err) {
			logger.error("Self-evolution tool_execution_end handler failed", { error: String(err) });
		}
	});

	api.on("message_end", (event, _ctx) => {
		try {
			recorder?.onMessageEnd(event);
		} catch (err) {
			logger.error("Self-evolution message_end handler failed", { error: String(err) });
		}
	});

	// ── Cognitive Pipeline: inject context before each LLM call ──
	api.on("context", async (event, _ctx) => {
		try {
			_ensureInit(_ctx.cwd);

			if (flags.enableNudgeContextInjection) {
				const pendingNudges = recorder?.drainPendingAgentNudges() ?? [];
				const nudgeContextMsg = buildNudgeContextUserMessage(pendingNudges);
				if (nudgeContextMsg) {
					event.messages.push(nudgeContextMsg as (typeof event.messages)[0]);
					const injectedAt = Date.now();
					const ids = pendingNudges.map(q => q.historyId);
					await nudgeHistoryStore?.markContextInjected(ids, injectedAt);
					nudgeEffectivenessTracker?.registerInjected(pendingNudges, injectedAt);
					logger.debug("Nudge context injected", {
						count: pendingNudges.length,
						types: pendingNudges.map(q => q.nudge.type),
						sessionId: recorder?.getTrace()?.sessionId,
					});
				}
			} else {
				recorder?.drainPendingAgentNudges();
			}

			if (!pipeline || !skillStore || !learningStore) return;

			const messages = event.messages;
			let userQuery = "";
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i] as { role?: string; content?: string | unknown[] };
				if (msg.role === "user") {
					userQuery = typeof msg.content === "string" ? msg.content : "";
					break;
				}
			}
			if (!userQuery) return;

			const unifiedSkills = await loadUnifiedSkillsForInjection(_ctx.cwd, skillStore!, {
				globalStore: flags.globalStore,
			});
			const implicitRules = (await learningStore.listForInjection(_ctx.cwd, 8)).map(l => ({
				rule: l.content,
				confidence: l.confidence / 5,
				sourceSessionId: l.sessionId,
			}));

			// Sandbox: validate skills before injection
			const sandboxedSkills = unifiedSkills.filter(s => {
				const report = validateSkill(s, userQuery);
				return report.passed;
			});

			const pctx = await pipeline!.run(userQuery, sandboxedSkills, implicitRules);
			if (pctx.contextMd && pctx.contextMd.length > 0) {
				const contextMsg = { role: "user", content: `[System Context]\n${pctx.contextMd}` };
				event.messages.unshift(contextMsg as (typeof messages)[0]);
			}
		} catch (err) {
			logger.warn("Pipeline context injection failed", { error: String(err) });
		}
	});

	api.on("agent_end", async (_event, ctx) => {
		try {
			_ensureInit(ctx.cwd);
			let trace = recorder?.onAgentEnd(_event);
			if (!trace) return;

			const episodeStub = {
				id: `${trace.sessionId}-${trace.startTime}`,
				sessionId: trace.sessionId,
				cwd: trace.cwd,
				userPrompt: trace.userPrompt,
				timestamp: trace.startTime,
				durationMs: trace.endTime - trace.startTime,
				toolCallCount: trace.toolCallCount,
				errorCount: trace.errorCount,
				hadRecovery: trace.hadRecovery,
				completedSuccessfully: trace.completedSuccessfully,
				summary: "",
				toolsUsed: [] as string[],
				filesModified: [] as string[],
			};
			trace = await hydrateSessionTraceFromJsonlIfRicher(trace, episodeStub, getSessionsDir());

			if (nudgeHistoryStore && nudgeEffectivenessTracker) {
				await nudgeEffectivenessTracker.finalizeSession(trace, nudgeHistoryStore);
			}

			await activityLogger?.log("trace_finalized", {
				sessionId: trace.sessionId,
				toolCallCount: trace.toolCallCount,
				errorCount: trace.errorCount,
				completedSuccessfully: trace.completedSuccessfully,
			});

			// Archive episode
			const { summary, toolsUsed, filesModified } = summarizeTrace(trace);
			const episode = {
				id: `${trace.sessionId}-${trace.startTime}`,
				sessionId: trace.sessionId,
				cwd: trace.cwd,
				userPrompt: trace.userPrompt,
				timestamp: trace.startTime,
				durationMs: trace.endTime - trace.startTime,
				toolCallCount: trace.toolCallCount,
				errorCount: trace.errorCount,
				hadRecovery: trace.hadRecovery,
				completedSuccessfully: trace.completedSuccessfully,
				summary,
				toolsUsed,
				filesModified,
			};
			await episodeStore?.insert(episode);
			await sessionTraceStore?.upsert(trace, episode.id);
			await statsStore?.increment("sessions_archived");
			await activityLogger?.log("episode_archived", {
				episodeId: episode.id,
				sessionId: trace.sessionId,
				summary,
				toolCallCount: trace.toolCallCount,
			});
			await episodicManager?.markSessionEnded(trace.sessionId, {
				toolCallCount: trace.toolCallCount,
				errorCount: trace.errorCount,
				hadRecovery: trace.hadRecovery,
				completedSuccessfully: trace.completedSuccessfully,
				durationMs: trace.endTime - trace.startTime,
			});

			// Schedule md projections asynchronously (fire-and-forget)
			const outputDir = resolveEvolutionProjectionDir(ctx.cwd, flags.globalStore);
			const activityLogPath = path.join(outputDir, "activity.log");
			projectLearnings(db!, { outputDir }).catch(e => logger.warn("projectLearnings failed", { error: String(e) }));
			projectEvolutionLog(activityLogPath, { outputDir }).catch(e =>
				logger.warn("projectEvolutionLog failed", { error: String(e) }),
			);
			if (episodeStore && skillStore) {
				projectSystemDiagnosis(db!, {
					outputDir,
					maxEpisodes: flags.maxEpisodes,
					episodeStore,
					skillStore,
					activityLogger,
					auditRuntime: {
						regressionReplayBackend: flags.regressionReplayBackend,
						admissionReclassifyInterval: flags.admissionReclassifyInterval,
					},
				}).catch(e => logger.warn("projectSystemDiagnosis failed", { error: String(e) }));
			}

			const backgroundModel = trace.backgroundModel ?? resolveBackgroundModel(ctx);
			const backgroundAuth = createBackgroundLlmAuth(ctx);

			// Deep causal diagnosis removed in V4 — no per-turn LLM diagnosis

			const regressionFixture = buildRegressionFixtureFromTrace(trace, episode.id, {
				dominantErrorTool: undefined,
				dominantErrorPattern: undefined,
			});
			if (regressionFixture) {
				await regressionFixtureStore?.insert(regressionFixture);
				await activityLogger?.log("regression_fixture_created", {
					fixtureId: regressionFixture.id,
					sessionId: trace.sessionId,
					errorCount: regressionFixture.errorCount,
				});
			}

			// Extract intent (rule first; LLM when rule confidence is low and model is available)
			const intentResult = await intentClassifier?.classify(trace, backgroundModel, backgroundAuth);
			if (intentResult) {
				await intentStore?.insert({
					episodeId: episode.id,
					intent: intentResult.intent,
					confidence: intentResult.confidence,
					source: intentResult.source,
				});
				await activityLogger?.log("intent_classified", {
					episodeId: episode.id,
					intent: intentResult.intent,
					confidence: intentResult.confidence,
					source: intentResult.source,
				});
			}

			// Mine workflow pattern
			const pattern = workflowMiner?.mine(trace, intentResult?.intent ?? "exploration");
			if (pattern) {
				await workflowPatternStore?.upsert(pattern);
				await activityLogger?.log("workflow_mined", {
					patternId: pattern.id,
					intent: pattern.intent,
					sequence: pattern.toolSequence,
					commandSequence: pattern.commandSequence,
				});
			}

			// V4: User explicit (regex, 0 LLM) + SessionLearner (LLM, only for significant turns)
			if (learningStore) {
				const explicit = extractUserExplicitLearnings(trace, episode.id);
				for (const l of explicit) {
					await learningStore.insert(l);
				}
				// SessionLearner only when significant turn and user_explicit found nothing
				const isShortTurn = trace.toolCallCount <= 3 && trace.errorCount === 0 && trace.userPrompt.length < 30;
				const fromLlm =
					!isShortTurn && explicit.length === 0
						? await extractSessionLearnings(trace, episode.id, backgroundModel, backgroundAuth)
						: [];
				for (const l of fromLlm) {
					await learningStore.insert(l);
				}
				const learningCount = explicit.length + fromLlm.length;
				if (learningCount > 0) {
					await activityLogger?.log("learnings_extracted", { count: learningCount, episodeId: episode.id });
				}
				await learningStore.refreshLifecycles();
			}

			// Error patterns → escalations only (no convention writes)
			if (errorPatternExtractor) {
				const patterns = errorPatternExtractor.extract(trace);
				for (const p of patterns) {
					if (await evolutionEscalationStore?.isPatternSuppressed(errorPatternKey(p.id))) {
						await activityLogger?.log("error_pattern_suppressed", {
							patternId: p.id,
							sessionId: trace.sessionId,
						});
					}
				}
				if (patterns.length > 0) {
					await activityLogger?.log("error_patterns_detected", {
						count: patterns.length,
						sessionId: trace.sessionId,
					});
				}
			}

			const prevInjectedLearnings = trace.injectedLearningIds;
			// Skip feedback for trivial sessions (no tool calls — learnings weren't relevant)
			const isTrivialSession = trace.toolCallCount === 0 && trace.errorCount === 0;
			if (prevInjectedLearnings && prevInjectedLearnings.length > 0 && learningStore && !isTrivialSession) {
				const sessionHelped = trace.completedSuccessfully && trace.errorCount === 0;
				for (const id of prevInjectedLearnings) {
					const learning = await learningStore.get(id);
					if (!learning) continue;
					const { score, shouldRecord } = checkLearningRelevance(learning, trace);
					if (!shouldRecord) {
						logger.debug("learning feedback skipped: not relevant", { id, score, kind: learning.kind });
						continue;
					}
					await learningStore.recordOutcome(id, sessionHelped);
					logger.debug("learning feedback recorded", { id, helped: sessionHelped, score, kind: learning.kind });
				}
				await learningStore.refreshLifecycles();
			}

			// Record feedback for previously injected episodes using multi-dimensional analysis
			const prevInjected = trace.injectedEpisodeIds;
			if (
				prevInjected &&
				prevInjected.length > 0 &&
				feedbackTracker &&
				effectivenessAnalyzer &&
				episodeStore &&
				!isTrivialSession
			) {
				const outcomes = [];
				for (const id of prevInjected) {
					const episode = await episodeStore.get(id);
					if (episode) {
						const outcome = effectivenessAnalyzer.analyze(trace, episode);
						outcomes.push(outcome);
					}
				}
				if (outcomes.length > 0) {
					await feedbackTracker.recordDetailedOutcome(outcomes);
				}
			}
			// Record feedback for previously injected skills
			const prevInjectedSkills = trace.injectedSkillNames;
			if (prevInjectedSkills && prevInjectedSkills.length > 0 && feedbackTracker && !isTrivialSession) {
				const succeeded = trace.completedSuccessfully && trace.errorCount === 0;
				await feedbackTracker.recordSkillOutcome(prevInjectedSkills, trace);
				if (succeeded && skillManager) {
					for (const name of prevInjectedSkills) {
						await skillManager.recordSkillUsage(name, true);
					}
				}
			}

			if (
				flags.enableStuckWarning &&
				evolutionEscalationStore &&
				regressionFixtureStore &&
				learningStore &&
				regressionTrialStore
			) {
				const escalated = await syncEvolutionEscalations({
					escalationStore: evolutionEscalationStore,
					fixtureStore: regressionFixtureStore,
					learningStore,
					trialStore: regressionTrialStore,
				});
				if (escalated > 0) {
					await activityLogger?.log("evolution_escalations_synced", { count: escalated });
				}
			}

			// Cleanup old episodes
			await episodeStore?.deleteOld(flags.maxEpisodes);
		} catch (err) {
			logger.error("Self-evolution agent_end handler failed", { error: String(err) });
		}
	});

	api.on("before_agent_start", async (event, ctx) => {
		try {
			_ensureInit(ctx.cwd);
			await _ensureBenefitAdmissionRefresh();

			if (evolutionEscalationStore && ctx.hasUI && flags.enableStuckWarning) {
				const openEscalations = await evolutionEscalationStore.listOpen();
				for (const escalation of openEscalations.filter(e => e.status === "open").slice(0, 2)) {
					ctx.ui.notify(`[Evolution stuck] ${escalation.message} — ${escalation.suggestion}`, "warning");
				}
			}

			// Capture user prompt from before_agent_start before trace exists
			recorder?.seedPrompt(event.prompt);
			recorder?.beginTurn();
			if (nudgeHistoryStore && nudgeSuppressionCache) {
				await nudgeSuppressionCache.refreshFromRecent(nudgeHistoryStore);
			}

			if (flags.enableNudgeContextInjection && crossSessionNudgeEngine && recorder) {
				const crossNudge = await crossSessionNudgeEngine.analyze(ctx.cwd, event.prompt);
				if (crossNudge && !nudgeSuppressionCache?.isSuppressed(crossNudge.type)) {
					const nudge = crossSessionNudgeToNudge(crossNudge);
					const sessionId = ctx.sessionManager.getSessionId();
					const historyId = nudgeHistoryStore
						? await persistNudgeRecord(nudgeHistoryStore, {
								sessionId,
								project: ctx.cwd,
								nudge,
							}).catch((err: unknown) => {
								logger.warn("nudge history insert failed", { error: String(err) });
								return undefined;
							})
						: undefined;
					if (historyId && recorder.enqueuePendingAgentNudge(nudge, historyId)) {
						if (ctx.hasUI) {
							ctx.ui.notify(
								`[Cross-Session ${crossNudge.severity === "warn" ? "Warning" : "Tip"}] ${crossNudge.message} (added to agent context)`,
								crossNudge.severity === "warn" ? "warning" : "info",
							);
						}
						await activityLogger
							?.log("cross_session_nudge_queued", {
								sessionId,
								type: crossNudge.type,
								historyId,
							})
							.catch((err: unknown) => logger.warn("activity log failed", { error: String(err) }));
					}
				}
			}

			if (!flags.enablePromptInjection) return;
			if (!contextAwareRetriever || !recorder) return;

			let intentResult: IntentResult | undefined;
			let episodes: RetrievedEpisode[] = [];
			if (flags.enableEpisodeInjection) {
				intentResult = intentClassifier?.ruleClassify({
					sessionId: "",
					cwd: ctx.cwd,
					userPrompt: event.prompt,
					startTime: Date.now(),
					endTime: 0,
					entries: [],
					toolCallCount: 0,
					errorCount: 0,
					hadRecovery: false,
					completedSuccessfully: false,
				});

				episodes = await contextAwareRetriever.retrieve(event.prompt, {
					maxEpisodes: flags.maxEpisodes,
					llmRerank: flags.llmRerank,
					model: ctx.model,
					auth: createBackgroundLlmAuth(ctx),
					currentIntent: intentResult?.intent,
				});
			}
			const relevantSkills = await _retrieveRelevantSkills(event.prompt);
			const learnings = learningStore ? await learningStore.listForInjection(ctx.cwd, 8) : [];

			let memorySummary: string | undefined;
			try {
				const memoryRoot = getMemoryRoot(getAgentDir(), ctx.cwd, { globalStore: flags.globalStore });
				const text = (await Bun.file(path.join(memoryRoot, "memory_summary.md")).text()).trim();
				if (text.length > 0) memorySummary = text;
			} catch (err) {
				if (!isEnoent(err)) {
					logger.warn("memory_summary read failed", { error: String(err) });
				}
			}

			if (episodes.length === 0 && relevantSkills.length === 0 && learnings.length === 0 && !memorySummary) {
				return;
			}

			// Track injected episodes for feedback
			recorder?.setInjectedEpisodes(episodes.map(e => e.episode.id));
			await feedbackTracker?.trackInjection(episodes.map(e => e.episode.id));

			// Track injected skills for feedback
			recorder?.setInjectedSkills(relevantSkills.map(s => s.name));
			await feedbackTracker?.trackSkillInjection(relevantSkills.map(s => s.name));

			recorder?.setInjectedLearnings(learnings.map(l => l.id));
			for (const l of learnings) {
				await learningStore?.recordInjection(l.id);
			}

			// Build injection using formatter
			let injection = "";
			if (injectionFormatter) {
				injection = injectionFormatter.formatInjection(episodes, relevantSkills, { memorySummary }, learnings);
				// Fallback: old inline formatting
				if (episodes.length > 0) {
					injection += "\n\n## Relevant Past Experience\n\n";
					for (const e of episodes) {
						const text = e.episode.summary.slice(0, 200);
						injection += `[${e.episode.id}] ${text} (${e.reason})\n`;
					}
				}
				if (relevantSkills.length > 0) {
					injection += "\n\n## Relevant Skills\n\n";
					for (const s of relevantSkills) {
						injection += `**${s.name}**: ${s.taskPattern.slice(0, 120)}\n${s.approach.slice(0, 300)}\n\n`;
					}
				}
				if (injection.length > 2000) {
					injection = injection.slice(0, 2000);
				}
			}

			if (!injection) return;

			await activityLogger?.log("prompt_injected", {
				sessionId: ctx.sessionManager.getSessionId(),
				episodeIds: episodes.map(e => e.episode.id),
				skillNames: relevantSkills.map(s => s.name),
				learningCount: learnings.length,
				tokenCount: Math.ceil(injection.length / 4),
				intent: intentResult?.intent,
			});

			return {
				systemPrompt: event.systemPrompt + injection,
			};
		} catch (err) {
			logger.error("Self-evolution before_agent_start handler failed", { error: String(err) });
		}
	});

	api.on("session_shutdown", async (_event, _ctx) => {
		try {
			closeActivityLogger(_ctx.cwd, flags.globalStore);
			closeEvolutionDb(_ctx.cwd, flags.globalStore);
			recorder = undefined;
			episodeStore = undefined;
			skillStore = undefined;
			versionStore = undefined;
			statsStore = undefined;
			skillManager = undefined;
			episodeRetriever = undefined;
			intentStore = undefined;
			effectivenessStore = undefined;
			skillEffectivenessStore = undefined;
			nudgeHistoryStore = undefined;
			nudgeSuppressionCache = undefined;
			nudgeEffectivenessTracker = undefined;
			crossSessionNudgeEngine = undefined;
			effectivenessAnalyzer = undefined;
			injectionFormatter = undefined;
			errorPatternExtractor = undefined;
			diagnosisStore = undefined;
			detailedOutcomeStore = undefined;

			intentClassifier = undefined;
			workflowMiner = undefined;
			feedbackTracker = undefined;
			contextAwareRetriever = undefined;
			extractor = undefined;
		} catch (err) {
			logger.error("Self-evolution session_shutdown handler failed", { error: String(err) });
		}
	});
};
