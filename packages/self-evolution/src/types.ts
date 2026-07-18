/**
 * Core types for the self-evolution plugin.
 */
import type { Model } from "@oh-my-pi/pi-ai";

// ============================================================================
// Session Trace (in-memory, per-session)
// ============================================================================

export interface TraceEntry {
	type:
		| "tool_call"
		| "tool_result"
		| "user_input"
		| "assistant_message"
		| "model_error"
		| "session_start"
		| "session_end";
	timestamp: number;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	result?: unknown;
	output?: unknown;
	isError?: boolean;
	content?: string;
	sessionId?: string;
	cwd?: string;
	userPrompt?: string;
	success?: boolean;
	duration?: number;
}

export interface SessionTrace {
	sessionId: string;
	cwd: string;
	/** Model captured at agent_start for background LLM extraction on agent_end */
	backgroundModel?: Model;
	userPrompt: string;
	startTime: number;
	endTime: number;
	entries: TraceEntry[];
	toolCallCount: number;
	errorCount: number;
	hadRecovery: boolean;
	completedSuccessfully: boolean;
	source?: "omp" | "external";
	errorDetails?: string[];
	nudges?: Nudge[];
	injectedEpisodeIds?: string[];
	injectedSkillNames?: string[];
	injectedLearningIds?: string[];
}
// ============================================================================
// Episode (persisted)
// ============================================================================

export interface Episode {
	id: string;
	sessionId: string;
	cwd: string;
	userPrompt: string;
	timestamp: number;
	durationMs: number;
	toolCallCount: number;
	errorCount: number;
	hadRecovery: boolean;
	completedSuccessfully: boolean;
	summary: string;
	toolsUsed: string[];
	filesModified: string[];
}

// ============================================================================
// EvolvedSkill (persisted)
// ============================================================================

export interface EvolvedSkill {
	name: string;
	description: string;
	taskPattern: string;
	approach: string;
	tools: string[];
	pitfalls: string[];
	createdAt: number;
	usageCount: number;
	lastUsedAt: number;
	successCount: number;
	failureCount: number;
	version: number;
	qualityScore?: number;
	optimizedPrompt?: string;
	deprecated?: boolean;
	deprecationReason?: string;
	autonomyNotes?: string;
	lastOptimizedAt?: number;
	optimizationCount?: number;
	userRating?: number; // 1-5 star rating from user
}

// ============================================================================
// Skill Version (persisted snapshot)
// ============================================================================

export interface SkillVersion {
	name: string;
	version: number;
	skill: EvolvedSkill;
	changedAt: number;
	changeType: "extracted" | "merged" | "optimized" | "deprecated" | "rolled_back";
	changeReason?: string;
}

// ============================================================================
// Activity Log
// ============================================================================

export interface LogEntry {
	timestamp: number;
	event: string;
	details: Record<string, unknown>;
}

// ============================================================================
// Skill Extraction Result
// ============================================================================

export interface ExtractedSkill {
	name: string;
	description: string;
	taskPattern: string;
	approach: string;
	tools: string[];
	pitfalls: string[];
	qualityScore: number;
	llmRefined: boolean;
	autonomyNotes?: string;
}

// ============================================================================
// Plugin Flags
// ============================================================================

export interface SelfEvolutionFlags {
	enabled: boolean;
	skillThreshold: number;
	maxEpisodes: number;
	enablePromptInjection: boolean;
	/** Inject retrieved episode summaries into system prompt (learnings/skills unaffected) */
	enableEpisodeInjection: boolean;
	/** Inject pending session nudges into the next LLM context (disable for live A/B control arm) */
	enableNudgeContextInjection: boolean;
	/** Show nudge notifications in the chat UI */
	enableNudgeUI: boolean;
	llmRefinement: boolean;
	llmRerank: boolean;
	enableVersioning: boolean;
	enableActivityLog: boolean;
	/** Use a global store shared across all projects instead of per-project isolation */
	globalStore: boolean;
	/** Regression replay backend: heuristic | llm (background LLM judge) | subagent (omp -p rerun, falls back to llm/heuristic) */
	regressionReplayBackend: "heuristic" | "llm" | "subagent";
	/** Sessions between convention reclassify runs when using llm/subagent replay (heuristic always every session) */
	admissionReclassifyInterval: number;
	/** Show Evolution stuck escalation warnings in the chat UI */
	enableStuckWarning: boolean;
}

// ============================================================================
// Episode Retrieval
// ============================================================================

export interface EpisodeCandidate {
	episode: Episode;
	keywordScore: number;
}

export interface RerankedEpisode {
	episode: Episode;
	relevanceScore: number;
	reason: string;
}

// ============================================================================
// Intent Classification (v2)
// ============================================================================

export type IntentCategory =
	| "refactoring"
	| "bugfix"
	| "feature-add"
	| "testing"
	| "documentation"
	| "configuration"
	| "exploration"
	| "optimization"
	| "integration";

export interface IntentResult {
	intent: IntentCategory;
	confidence: number;
	source: "rule" | "llm";
	allScores: Record<IntentCategory, number>;
}

export interface EpisodeIntent {
	episodeId: string;
	intent: IntentCategory;
	confidence: number;
	source: "rule" | "llm";
}

// ============================================================================
// Workflow Patterns (v2)
// ============================================================================

export interface WorkflowPattern {
	id: string;
	intent: IntentCategory;
	toolSequence: string[];
	/** Command-level sequence (e.g., "bash:dws" instead of just "bash"), extracted from tool args */
	commandSequence?: string[];
	occurrenceCount: number;
	avgQualityScore: number;
	lastSeenAt: number;
}

// ============================================================================
// Episode Effectiveness (v2)
// ============================================================================

export interface EpisodeEffectiveness {
	episodeId: string;
	timesInjected: number;
	timesHelped: number;
	timesFailed: number;
}
// ============================================================================
// Skill Effectiveness (v2)
// ============================================================================

export interface SkillEffectiveness {
	skillName: string;
	timesInjected: number;
	timesHelped: number;
	timesFailed: number;
	lastInjectedAt: number;
}

// ============================================================================
// Cross-Session Nudges
// ============================================================================

export interface Nudge {
	type: string;
	severity: "info" | "warn";
	message: string;
	suggestion: string;
}

export interface CrossSessionNudge {
	type: string;
	severity: "info" | "warn";
	message: string;
	suggestion: string;
	detectedAt: number;
}

export interface QueuedAgentNudge {
	nudge: Nudge;
	historyId: string;
}

export interface NudgeRecord {
	id: string;
	sessionId: string;
	project: string;
	type: string;
	severity: string;
	message: string;
	suggestion: string;
	detectedAt: number;
	dismissedAt?: number;
	acknowledged?: boolean;
	contextInjected?: boolean;
	injectedAt?: number;
	postToolCalls?: number;
	patternRepeated?: boolean;
	outcomeScore?: number;
	outcomeRecordedAt?: number;
}

export interface NudgeOutcomeUpdate {
	postToolCalls: number;
	patternRepeated: boolean;
	outcomeScore: number;
}

// ============================================================================
// Learnings (V3 prompt injection)
// ============================================================================

export type LearningKind = "preference" | "fact" | "procedure" | "skill_hint";
export type LearningSource = "user_explicit" | "session_llm" | "manual_pin" | "agent_written";
export type LearningLifecycle = "candidate" | "active" | "archived";
export type LearningScope = "global" | "project" | "ephemeral";

export interface Learning {
	id: string;
	cwd: string;
	kind: LearningKind;
	content: string;
	source: LearningSource;
	/** 1–5 at write time */
	confidence: number;
	lifecycle: LearningLifecycle;
	/** Scope distinguishes behavioral rules from one-time task descriptions.
	 * global: applies across all sessions (communication style, safety).
	 * project: applies within this project (code conventions).
	 * ephemeral: one-time task ask — should not be injected. */
	scope: LearningScope;
	sessionId: string;
	createdAt: number;
	updatedAt: number;
	timesInjected: number;
	timesHelped: number;
	timesIgnored: number;
}

// ============================================================================
// User Profile (aggregate stats over recent sessions, used by /profile and /evolution fit)
// ============================================================================

export interface UserProfile {
	sessionCount: number;
	avgToolCallsPerSession: number;
	avgFilesModifiedPerSession: number;
	errorRate: number;
	recoveryRate: number;
	preferredLanguages: string[];
	toolFrequency: Record<string, number>;
	intentDistribution: Record<string, number>;
}

export interface ProfileStore {
	get(key: string): Promise<UserProfile | null>;
}

// ============================================================================
// Regression fixtures (failed-session replay)
// ============================================================================

export interface RegressionFixture {
	id: string;
	sessionId: string;
	episodeId: string;
	cwd: string;
	userPrompt: string;
	errorCount: number;
	completedSuccessfully: boolean;
	dominantErrorTool?: string;
	dominantErrorPattern?: string;
	entries: TraceEntry[];
	createdAt: number;
}

export type RegressionVerdict = "keep" | "discard" | "pending";

export interface RegressionTrial {
	id: string;
	targetType: "skill";
	targetId: string;
	fixtureId: string;
	verdict: RegressionVerdict;
	reason: string;
	createdAt: number;
}

export type EvolutionEscalationStatus = "open" | "acknowledged" | "resolved";

export interface EvolutionEscalation {
	id: string;
	patternKey: string;
	patternLabel: string;
	dominantErrorTool?: string;
	dominantErrorPattern?: string;
	occurrenceCount: number;
	failedImprovementCount: number;
	status: EvolutionEscalationStatus;
	message: string;
	suggestion: string;
	createdAt: number;
	updatedAt: number;
	acknowledgedAt?: number;
	resolvedAt?: number;
}

// ============================================================================
// Injection Outcome — multi-dimensional effectiveness scoring (v2.5)
// ============================================================================

export interface InjectionOutcome {
	episodeId: string;
	helpfulness: number;
	hasExplicitCorrection: boolean;
	hasExplicitApproval: boolean;
	wasRedundant: boolean;
	avoidedPreviousErrors: boolean;
	toolEfficiency: number;
}

export interface ErrorPattern {
	id: string;
	name: string;
	description: string;
	regex: string;
	category: "syntax" | "format" | "runtime" | "permission" | "not_found" | "type" | "other";
	affectedSessions: string[];
	count: number;
	firstSeenAt: number;
	lastSeenAt: number;
	extractedConventions: string[];
}

export interface DailyReport {
	date: string;
	totalSessions: number;
	successfulSessions: number;
	failedSessions: number;
	emptySessions: number;
	partialSessions: number;
	sessions: Array<{
		sessionId: string;
		userPrompt: string;
		toolCallCount: number;
		errorCount: number;
		completedSuccessfully: boolean;
		errors: string[];
		highlights: string[];
	}>;
	topErrorPatterns: ErrorPattern[];
	newLearnings: Learning[];
	topTools: Array<{ tool: string; count: number }>;
	keyMoments: Array<{
		type: "error" | "recovery" | "success" | "correction";
		sessionId: string;
		description: string;
		timestamp: number;
	}>;
	skillsToday: Array<{
		skill: EvolvedSkill;
		wasCreatedToday: boolean;
		wasUpdatedToday: boolean;
	}>;
	injectionEffectiveness: {
		skillCount: number;
		skillRates: Array<{
			name: string;
			version: number;
			qualityScore?: number;
			usageCount: number;
			helpRate: string;
		}>;
		learningCount: number;
		learningRates: Array<{
			content: string;
			confidence: number;
			timesInjected: number;
			helpRate: string;
		}>;
	};
}

// ============================================================================
// Fit Evaluation — "懂我程度" personal fit scoring
// ============================================================================

export type FitVerdict = "明显更懂我" | "轻微更懂我" | "持平" | "变生疏" | "明显不懂我";

export interface FitScoreRecord {
	date: string; // YYYY-MM-DD
	totalScore: number;
	memoryScore: number;
	thinkingScore: number;
	styleScore: number;
	predictionScore: number;
	historyScore: number;
	changeFromLast: number | null;
	verdict: FitVerdict;
	detailJson: string;
	computedAt: number;
}

export interface FitDimensionScore {
	name: string;
	score: number;
	maxScore: number;
	change: number | null;
	description: string;
}

export interface FitReport {
	date: string;
	totalScore: number;
	maxScore: 100;
	change: number | null;
	verdict: FitVerdict;
	dimensions: FitDimensionScore[];
	history: FitScoreRecord[];
	improvements: string[];
}

// ============================================================================
// Trace Analysis — causal tool-chain diagnosis (v2.6)
// ============================================================================

export interface ToolCallResult {
	call: TraceEntry;
	result: TraceEntry;
	index: number;
}

export interface CascadePattern {
	triggerTool: string;
	triggerError: string;
	followUpTool: string;
	followUpError?: string;
	rootCause: string;
	count: number;
}

export type ReadFailureType =
	| "path_not_found"
	| "permission_denied"
	| "invalid_sel"
	| "verify_after_edit_failure"
	| "search_misled"
	| "other";

export interface ReadFailureAnalysis {
	failureType: ReadFailureType;
	attemptedPath?: string;
	precedingTool?: string;
	precedingToolSuccess?: boolean;
	suggestion: string;
}

export interface ImplicitSignals {
	/** User manually reverted a modification (edit followed by reversal edit). */
	userRevertedEdit: boolean;
	/** Number of times the same request was repeated. */
	duplicateRequestCount: number;
	/** Duplicate request text if detected ≥ 2 times. */
	duplicateRequestText?: string;
	/** Tools that failed 3+ times consecutively. */
	consecutiveFailureTools: Array<{ tool: string; count: number }>;
	/** Whether user accepted modifications without follow-up corrections. */
	userAcceptedWithoutCorrection: boolean;
}

export interface TraceEnhancement {
	/** Last 3 assistant_message entries (truncated to 500 chars each). */
	lastAssistantMessages: string[];
	/** Model error entries with status codes. */
	modelErrors: Array<{ timestamp: number; content: string }>;
	/** Tool results truncated to 2KB for storage. */
	truncatedToolResults: Array<{ toolName: string; resultSnippet: string }>;
}

export interface ToolChainDiagnosis {
	sessionId: string;
	readFailures: ReadFailureAnalysis[];
	cascadePatterns: CascadePattern[];
	redundantSearches: boolean;
	slowLoop: boolean;
	toolEfficiency: number; // successful_modifications / total_calls
	dominantErrorTool?: string;
	dominantErrorPattern?: string;
	suggestedAction: string;
	/** Implicit signals extracted from trace patterns. */
	implicitSignals?: ImplicitSignals;
	/** Enhanced trace data for downstream analysis. */
	traceEnhancement?: TraceEnhancement;
}

export interface CrossSessionDiagnosis {
	project: string;
	totalEpisodes: number;
	failedEpisodes: number;
	readFailureRate: number;
	readFailureBreakdown: Record<ReadFailureType, number>;
	topCascadePattern?: CascadePattern;
	trend: "improving" | "stable" | "degrading";
	rootCauseSummary: string;
}

export type SkillPopulationState = "candidate" | "experimental" | "graduated" | "deprecated" | "archived";

export interface SkillPopulationQualityMetrics {
	successRate: number;
	usageCount: number;
	qualityScore: number;
	userRating: number;
	recencyScore: number;
}

export interface SkillPopulationEvolutionEvent {
	at: number;
	fromState: SkillPopulationState;
	toState: SkillPopulationState;
	reason: string;
	evolutionScore: number;
}

export interface SkillPopulationRecord {
	name: string;
	createdAt: number;
	updatedAt: number;
	usageCount: number;
	successRate: number;
	state: SkillPopulationState;
	evolutionScore: number;
	lastEvaluatedAt?: number;
	nextEvaluationAt?: number;
	qualityMetrics?: SkillPopulationQualityMetrics;
	evolutionHistory?: SkillPopulationEvolutionEvent[];
}

// ============================================================================
// Episodic Record (Phase 3)
// ============================================================================

export type EpisodicReviewStatus = "active" | "pending_review" | "reviewed" | "promoted" | "deleted";

export interface EpisodicRecord {
	id: string;
	sessionId: string;
	cwd: string;
	timestamp: number;
	eventType: string;
	eventData: Record<string, unknown>;
	importanceScore: number;
	ttlSeconds?: number;
	expirationTime?: number;
	archived?: boolean;
	/** Review status for the pending-review state machine. */
	reviewStatus?: EpisodicReviewStatus;
	/** When the review was completed (for reviewed/promoted/deleted). */
	reviewedAt?: number;
}
