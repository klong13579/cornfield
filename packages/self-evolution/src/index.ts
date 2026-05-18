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
import { FilePersonaStore } from "@oh-my-pi/pi-coding-agent/persona/store";
import { SchedulerDbStorage } from "@oh-my-pi/pi-coding-agent/scheduler/storage";
import { getNextRun, getSchedulerDbPath } from "@oh-my-pi/pi-coding-agent/scheduler/types";
import { getAgentDir, getSessionsDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { isSkillEligibleForInjection } from "./benefit-admission";
import { refreshAdmissionAfterSessionEnd, refreshBenefitAdmissionState } from "./benefit-admission-refresh";
import {
	registerEpisodicCommands,
	registerModelCommand,
	registerProfileCommand,
	registerSelfEvolutionCommands,
} from "./commands";
import { ContextAwareRetriever } from "./context-aware-retriever";
import { CrossSessionNudgeEngine } from "./cross-session-nudge";
import { EffectivenessAnalyzer } from "./effectiveness-analyzer";
import { EpisodicManager } from "./episodic-manager";
import { ErrorPatternExtractor } from "./error-pattern-extractor";
import { errorPatternKey } from "./escalation/pattern-key";
import { syncEvolutionEscalations } from "./escalation/sync";
import { SkillExtractor } from "./extractor";
import { FeedbackTracker } from "./feedback-tracker";
import type { InjectionFormatter } from "./injection-formatter";
import { IntentClassifier } from "./intent-classifier";
import { type ActivityLogger, closeActivityLogger, getActivityLogger } from "./logging/activity-logger";
import { projectEvolutionLog } from "./logging/evolution-log";
import { SkillManager } from "./manager";
import { registerMemoryCommands } from "./memory-commands";
import { migrateLegacyEvolutionPathsIfNeeded } from "./migrate-paths";
import { buildNudgeContextUserMessage } from "./nudge-context-injector";
import { NudgeDeliverer } from "./nudge-deliverer";
import { NudgeEffectivenessTracker } from "./nudge-effectiveness";
import { persistNudgeRecord } from "./nudge-persist";
import { crossSessionNudgeToNudge, NudgeSuppressionCache } from "./nudge-suppression";
import { getMemoryRoot, getUnifiedSkillsDir, resolveEvolutionProjectionDir } from "./paths";
import { projectLearnings } from "./projection/learnings";
import { projectSystemDiagnosis } from "./projection/system-diagnosis";
import { hydrateSessionTraceFromJsonlIfRicher } from "./regression/backfill-traces";
import { buildRegressionFixtureFromTrace } from "./regression/fixture-from-trace";
import {
	createRegressionReplayBackend,
	parseRegressionReplayBackendKind,
	type RegressionReplayBackend,
} from "./regression/replay-backend";
import { setRegressionReplayRuntime } from "./regression/replay-runtime";
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
import { SqliteProfileStore } from "./storage/profiles";
import { SqliteRegressionFixtureStore } from "./storage/regression-fixtures";
import { SqliteRegressionTrialStore } from "./storage/regression-trials";
import { SqliteSessionTraceStore } from "./storage/session-traces";
import { SqliteSkillEffectivenessStore } from "./storage/skill-effectiveness";
import { SqliteSkillPopulationStore } from "./storage/skill-population";
import { SqliteSkillStore, SqliteSkillVersionStore, SqliteStatsStore } from "./storage/skills";
import { SqliteWorkflowPatternStore } from "./storage/workflow-patterns";
import { registerSelfEvolutionTools } from "./tools";
import { summarizeTrace, TraceRecorder } from "./trace";
import { TraceAnalyzer } from "./trace-analyzer";
import type { SelfEvolutionFlags } from "./types";
import { loadUnifiedSkillsForInjection } from "./unified-skills";
import { extractUserExplicitLearnings } from "./user-explicit-learnings";
import { projectUserProfile, UserProfiler } from "./user-profiler";
import { createBackgroundLlmAuth } from "./utils/background-llm-auth";
import { resolveBackgroundModel } from "./utils/background-model";
import { setupSkillsWatcher } from "./watcher";
import { WorkflowMiner } from "./workflow-miner";

export type { SelfEvolutionFlags };

export function parseFlags(api: ExtensionAPI): SelfEvolutionFlags {
	return {
		enabled: api.getFlag("self-evolution") !== false,
		skillThreshold: Number(api.getFlag("self-evolution-skill-threshold") ?? "5"),
		maxEpisodes: Number(api.getFlag("self-evolution-max-episodes") ?? "100"),
		enablePromptInjection: api.getFlag("self-evolution-enable-prompt-injection") !== false,
		enableNudgeContextInjection: api.getFlag("self-evolution-enable-nudge-context-injection") !== false,
		llmRefinement: api.getFlag("self-evolution-llm-refinement") !== false,
		llmRerank: api.getFlag("self-evolution-llm-rerank") !== false,
		enableVersioning: api.getFlag("self-evolution-enable-versioning") !== false,
		enableActivityLog: api.getFlag("self-evolution-enable-activity-log") !== false,
		globalStore: api.getFlag("self-evolution-global-store") === true,
		regressionReplayBackend: parseRegressionReplayBackendKind(api.getFlag("self-evolution-regression-replay")),
		admissionReclassifyInterval: Math.max(
			1,
			Number(api.getFlag("self-evolution-admission-reclassify-interval") ?? "5"),
		),
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
	api.registerFlag("self-evolution-enable-prompt-injection", {
		type: "boolean",
		default: true,
		description: "Inject past experiences into system prompt",
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
	api.registerFlag("self-evolution-global-store", {
		type: "boolean",
		default: false,
		description:
			"Legacy: use ~/.omp/self-evolution + encoded memory paths. Default is per-project <cwd>/.omp/memory|evolution|skills",
	});
	api.registerFlag("self-evolution-regression-replay", {
		type: "string",
		default: "heuristic",
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
	let traceAnalyzer: TraceAnalyzer | undefined;
	let diagnosisStore: SqliteEpisodeDiagnosisStore | undefined;
	let recorder: TraceRecorder | undefined;
	let activityLogger: ActivityLogger | undefined;
	let episodeStore: SqliteEpisodeStore | undefined;
	let skillStore: SqliteSkillStore | undefined;
	let versionStore: SqliteSkillVersionStore | undefined;
	let statsStore: SqliteStatsStore | undefined;
	let skillManager: SkillManager | undefined;
	let intentStore: SqliteIntentStore | undefined;
	let profileStore: SqliteProfileStore | undefined;
	let effectivenessStore: SqliteEffectivenessStore | undefined;
	let skillEffectivenessStore: SqliteSkillEffectivenessStore | undefined;
	let intentClassifier: IntentClassifier | undefined;
	let workflowMiner: WorkflowMiner | undefined;
	let userProfiler: UserProfiler | undefined;
	let workflowPatternStore: SqliteWorkflowPatternStore | undefined;
	let feedbackTracker: FeedbackTracker | undefined;
	let contextAwareRetriever: ContextAwareRetriever | undefined;
	let episodeRetriever: EpisodeRetriever | undefined;
	let extractor: SkillExtractor | undefined;
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
	let admissionSessionOrdinal = 0;
	const pathsMigratedKeys = new Set<string>();

	async function ensurePathsMigrated(cwd: string): Promise<void> {
		const activeFlags = flags ?? parseFlags(api);
		const key = `${cwd}\0${activeFlags.globalStore}`;
		if (pathsMigratedKeys.has(key)) return;
		pathsMigratedKeys.add(key);
		await migrateLegacyEvolutionPathsIfNeeded(cwd, getAgentDir(), activeFlags.globalStore);
	}

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
		flags = parseFlags(api);
		regressionReplayBackend = undefined;
		traceAnalyzer = new TraceAnalyzer();
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
		profileStore = new SqliteProfileStore(db);
		workflowPatternStore = new SqliteWorkflowPatternStore(db);
		effectivenessStore = new SqliteEffectivenessStore(db);
		contextAwareRetriever = new ContextAwareRetriever(episodeStore, intentStore, effectivenessStore);
		episodeRetriever = new EpisodeRetriever(episodeStore);
		intentClassifier = new IntentClassifier();
		workflowMiner = new WorkflowMiner();
		const savedProfile = profileStore
			.get("default")
			.then(p => p ?? undefined)
			.catch(() => undefined);
		// userProfiler must be initialized here — it was dead code before (issue #1)
		userProfiler = new UserProfiler();
		savedProfile
			.then(p => {
				if (p) userProfiler = UserProfiler.deserialize(JSON.stringify(p));
			})
			.catch(() => {});
		detailedOutcomeStore = new SqliteDetailedOutcomeStore(db);
		feedbackTracker = new FeedbackTracker(effectivenessStore, skillEffectivenessStore, detailedOutcomeStore);
		nudgeHistoryStore = new SqliteNudgeHistoryStore(db);
		nudgeSuppressionCache = new NudgeSuppressionCache();
		nudgeEffectivenessTracker = new NudgeEffectivenessTracker();
		crossSessionNudgeEngine = new CrossSessionNudgeEngine(
			nudgeHistoryStore,
			episodeStore,
			profileStore,
			diagnosisStore,
		);
		sessionTraceStore = new SqliteSessionTraceStore(db);
		regressionFixtureStore = new SqliteRegressionFixtureStore(db);
		regressionTrialStore = new SqliteRegressionTrialStore(db);
		evolutionEscalationStore = new SqliteEvolutionEscalationStore(db);
		learningStore = new SqliteLearningStore(db);
		errorPatternExtractor = new ErrorPatternExtractor();
		effectivenessAnalyzer = new EffectivenessAnalyzer();
		extractor = new SkillExtractor();
		diagnosisStore = new SqliteEpisodeDiagnosisStore(db);
		statsStore = new SqliteStatsStore(db);
		episodicManager = EpisodicManager.create(db);
		pipeline = new Pipeline({ maxTokens: 2000 });

		if (!stopSkillsWatcher && db) {
			const skillsDir = getUnifiedSkillsDir(cwd, flags.globalStore);
			stopSkillsWatcher = setupSkillsWatcher(skillsDir, db);
		}

		memoryDb = evolutionDb;

		// Auto-register daily audit scheduled task if not present
		try {
			const schedulerStorage = new SchedulerDbStorage(getSchedulerDbPath());
			const existing = schedulerStorage.getTaskByName("evolution-audit");
			if (!existing) {
				const cron = "0 9 * * *"; // Daily at 9 AM
				const nextRun = getNextRun(cron);
				schedulerStorage.addTask({
					name: "evolution-audit",
					description: "Daily self-evolution health audit",
					cron,
					command:
						"Analyze the self-evolution database at ./.omp/evolution/evolution.db. " +
						"Query the episodes, skills, effectiveness, episode_intents, workflow_patterns, and conventions tables to assess the health of the learning system. " +
						"Calculate key metrics: episode count, skill extraction rate, average success rate, error rate, intent distribution, and convention coverage. " +
						"Identify data quality issues (e.g., low skill extraction rate, poor episode success rate, stale conventions, workflow pattern noise). " +
						"Suggest concrete, actionable improvements. Report findings in a concise summary.",
					scheduleType: "cron",
					taskType: "agent",
					timeoutMs: 300_000,
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					nextRunAt: nextRun ? nextRun.getTime() : undefined,
					runCount: 0,
					failCount: 0,
				});
				logger.debug("Auto-registered evolution-audit scheduled task");
			}
			schedulerStorage.close();
		} catch {
			// Scheduler DB may not be available; ignore
		}

		// Auto-register fit evaluation scheduled task (every 3 days at 10 AM)
		try {
			const schedulerStorage = new SchedulerDbStorage(getSchedulerDbPath());
			const existing = schedulerStorage.getTaskByName("evolution-fit");
			if (!existing) {
				const cron = "0 10 */3 * *"; // Every 3 days at 10 AM
				const nextRun = getNextRun(cron);
				schedulerStorage.addTask({
					name: "evolution-fit",
					description: "Agent '懂我程度' fit evaluation",
					cron,
					command:
						"Run the '懂我程度' (agent understanding me) fit evaluation. " +
						"Execute each test prompt from the fit-test-tasks dataset (20 prompts across 5 dimensions: memory, thinking, style, prediction, history). " +
						"For each prompt, respond naturally as you would in a real session. " +
						"After responding to all prompts, run '/evolution-fit' to generate the score report. " +
						"The report should show total score out of 100, per-dimension scores, trend vs. last evaluation, and improvement suggestions. " +
						"Output the report directly — no preamble, no explanation.",
					scheduleType: "cron",
					taskType: "agent",
					timeoutMs: 600_000,
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					nextRunAt: nextRun ? nextRun.getTime() : undefined,
					runCount: 0,
					failCount: 0,
				});
				logger.debug("Auto-registered evolution-fit scheduled task");
			}
			schedulerStorage.close();
		} catch {
			// Scheduler DB may not be available; ignore
		}
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
		profileStore: () => profileStore!,
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
	registerModelCommand(api, commandStores);
	registerMemoryCommands(
		api,
		() => memoryDb,
		undefined,
		() => flags.globalStore,
	);

	registerSelfEvolutionTools(api, {
		ensureInit: _ensureInit,
		episodeRetriever: () => episodeRetriever!,
		skillStore: () => skillStore!,
		skillManager: () => skillManager!,
		activityLogger: () => activityLogger!,
	});

	api.on("agent_start", async (event, ctx) => {
		try {
			await ensurePathsMigrated(ctx.cwd);
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
					if (_ctx.hasUI) {
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
			await ensurePathsMigrated(_ctx.cwd);
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
			const implicitConventions = (await learningStore.listForInjection(_ctx.cwd, 8)).map(l => ({
				rule: l.content,
				confidence: l.confidence / 5,
				sourceSessionId: l.sessionId,
			}));

			// Sandbox: validate skills before injection
			const sandboxedSkills = unifiedSkills.filter(s => {
				const report = validateSkill(s, userQuery);
				return report.passed;
			});

			const pctx = await pipeline!.run(userQuery, sandboxedSkills, implicitConventions);
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
			await ensurePathsMigrated(ctx.cwd);
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
			projectUserProfile(db!, { outputDir }).catch(e =>
				logger.warn("projectUserProfile failed", { error: String(e) }),
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

			// Deep causal diagnosis (LLM-enhanced when model is available)
			const diagnosis = await traceAnalyzer?.analyzeWithLlm(trace, backgroundModel, backgroundAuth);
			if (diagnosis) {
				// Align diagnosis sessionId with episode id for FK constraint
				diagnosis.sessionId = episode.id;
				await activityLogger?.log("trace_diagnosed", {
					sessionId: trace.sessionId,
					readFailureCount: diagnosis.readFailures.length,
					cascadePatternCount: diagnosis.cascadePatterns.length,
					dominantErrorTool: diagnosis.dominantErrorTool,
					suggestedAction: diagnosis.suggestedAction,
				});
			}

			if (diagnosis) {
				await diagnosisStore?.insert(diagnosis);
			}

			const regressionFixture = buildRegressionFixtureFromTrace(trace, episode.id, {
				dominantErrorTool: diagnosis?.dominantErrorTool,
				dominantErrorPattern: diagnosis?.dominantErrorPattern,
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
				});
			}

			// Update user profile
			if (userProfiler && intentResult) {
				userProfiler.updateProfile(trace, intentResult.intent);
				const profile = userProfiler.getProfile();
				await profileStore?.upsert("default", profile);
				await activityLogger?.log("profile_updated", {
					sessionCount: profile.sessionCount,
					topIntent: Object.entries(profile.intentDistribution).sort((a, b) => b[1] - a[1])[0]?.[0],
				});
			}

			// SessionLearner + explicit user learnings (≤3 per session)
			if (learningStore) {
				const explicit = extractUserExplicitLearnings(trace, episode.id);
				for (const l of explicit) {
					await learningStore.insert(l);
				}
				const fromLlm = await extractSessionLearnings(trace, episode.id, backgroundModel, backgroundAuth);
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
			if (prevInjectedLearnings && prevInjectedLearnings.length > 0 && learningStore) {
				const helped = trace.completedSuccessfully && trace.errorCount === 0;
				for (const id of prevInjectedLearnings) {
					await learningStore.recordOutcome(id, helped);
				}
				await learningStore.refreshLifecycles();
			}

			// Record feedback for previously injected episodes using multi-dimensional analysis
			const prevInjected = trace.injectedEpisodeIds;
			if (prevInjected && prevInjected.length > 0 && feedbackTracker && effectivenessAnalyzer && episodeStore) {
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
			if (prevInjectedSkills && prevInjectedSkills.length > 0 && feedbackTracker) {
				const succeeded = trace.completedSuccessfully && trace.errorCount === 0;
				await feedbackTracker.recordSkillOutcome(prevInjectedSkills, trace);
				if (succeeded && skillManager) {
					for (const name of prevInjectedSkills) {
						await skillManager.recordSkillUsage(name, true);
					}
				}
			}

			// Extract skill if significant (enhanced with causal diagnosis)
			if (extractor) {
				const extracted = await extractor.extract(
					trace,
					{
						skillThreshold: flags.skillThreshold,
						llmRefinement: flags.llmRefinement,
						model: backgroundModel,
						auth: backgroundAuth,
					},
					diagnosis ?? undefined,
				);
				if (extracted && skillManager) {
					await skillManager.integrate(extracted, backgroundModel, backgroundAuth);
				}
			}

			setRegressionReplayRuntime({ model: backgroundModel, auth: backgroundAuth });
			admissionSessionOrdinal++;
			if (skillStore && skillEffectivenessStore) {
				const admission = await refreshAdmissionAfterSessionEnd({
					skillStore,
					skillEffectivenessStore,
					populationStore,
					fixtureStore: regressionFixtureStore,
					trialStore: regressionTrialStore,
					replayBackend: _regressionReplayBackend(),
					regressionReplayBackend: flags.regressionReplayBackend,
					sessionOrdinal: admissionSessionOrdinal,
					admissionReclassifyInterval: flags.admissionReclassifyInterval,
				});
				if (admission.skillsDeprecated > 0) {
					logger.debug("Session benefit admission refresh", admission);
				}
			}

			if (evolutionEscalationStore && regressionFixtureStore && learningStore && regressionTrialStore) {
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
			await ensurePathsMigrated(ctx.cwd);
			_ensureInit(ctx.cwd);
			await _ensureBenefitAdmissionRefresh();

			if (evolutionEscalationStore && ctx.hasUI) {
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

			const intentResult = intentClassifier?.ruleClassify({
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

			const profile = await profileStore?.get("default");
			const persona = await new FilePersonaStore().load();
			const episodes = await contextAwareRetriever.retrieve(event.prompt, {
				maxEpisodes: flags.maxEpisodes,
				llmRerank: flags.llmRerank,
				model: ctx.model,
				auth: createBackgroundLlmAuth(ctx),
				currentIntent: intentResult?.intent,
				profile: profile ?? undefined,
			});
			const relevantSkills = await _retrieveRelevantSkills(event.prompt);
			const conventions: import("./types").Convention[] = [];
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

			if (
				episodes.length === 0 &&
				relevantSkills.length === 0 &&
				conventions.length === 0 &&
				learnings.length === 0 &&
				!memorySummary &&
				!profile &&
				!persona
			) {
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
				injection = injectionFormatter.formatInjection(
					episodes,
					conventions,
					relevantSkills,
					profile ?? undefined,
					persona ?? undefined,
					{ memorySummary },
					learnings,
				);
			} else {
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
				conventionCount: conventions.length,
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
			traceAnalyzer = undefined;
			recorder = undefined;
			episodeStore = undefined;
			skillStore = undefined;
			versionStore = undefined;
			statsStore = undefined;
			skillManager = undefined;
			episodeRetriever = undefined;
			intentStore = undefined;
			profileStore = undefined;
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
			userProfiler = undefined;
			feedbackTracker = undefined;
			contextAwareRetriever = undefined;
			extractor = undefined;
		} catch (err) {
			logger.error("Self-evolution session_shutdown handler failed", { error: String(err) });
		}
	});
};
