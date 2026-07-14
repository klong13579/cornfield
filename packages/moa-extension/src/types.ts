export type MoaPlannerToolMode = "all" | "read-only";

export type MoaStage = "discovery" | "rewrite" | "worker" | "synthesis";

export interface MoaWorkerSlot {
	name: string;
	role: string;
	model?: string;
	thinking?: string;
}

export interface MoaSettings {
	discoveryEnabled: boolean;
	rewriteEnabled: boolean;
	workerCount: number;
	workers: MoaWorkerSlot[];
	synthesisModel?: string;
	synthesisThinking?: string;
	plannerToolMode: MoaPlannerToolMode;
	timeoutMs: number;
	resumeContextBytes: number;
	/** TCO fields. See `docs/moa-input-fulfillment.md` for design. */
	discoveryModel?: string;
	discoveryTimeoutMs: number;
	rewriteTimeoutMs: number;
	/** Max items in TCO.missing_inputs (3-5 reasonable). */
	maxMissingInputs: number;
	/** Per-input ask timeout in TUI mode. */
	askTimeoutMs: number;
	/** When false, skip the TUI ask entirely and assume everything. */
	askEnabled: boolean;
	/** Max bytes for TCO block injected into worker/synthesis prompts. */
	tcoInjectMaxBytes: number;
	/** Multi-round loop cap. TUI 3 / gateway-cron 0 (forced by executor when
	 *  hasUI=false — gateway/cron path is hard-required to be single-round). */
	maxRounds: number;
	/** Per-round TUI ask cap. Each round surfaces at most this many of the
	 *  top worker open_questions. */
	maxQuestionsPerRound: number;
	/** Quality heuristic drop line. 0-100; below ⇒ worker is dropped from
	 *  synthesis input (raw still kept in archive). */
	qualityMinScore: number;
}

export interface MoaPlanWorker {
	name: string;
	role: string;
	prompt: string;
	model?: string;
	thinking?: string;
	tools: readonly string[] | "all";
	/** When set by the rewrite stage, this is the rewritten prompt that
	 *  replaces the original `prompt`. Workers run with this prompt. */
	rewrittenPrompt?: string;
}

export interface MoaPlan {
	task: string;
	/** Pre-rendered worker prompts (no TCO yet — TCO is prepended at execution time). */
	workers: MoaPlanWorker[];
	synthesisModel?: string;
	synthesisThinking?: string;
}

export interface MoaWorkerResult {
	name: string;
	role: string;
	ok: boolean;
	output: string;
	stderr: string;
	exitCode: number | null;
	model?: string;
	/** When the worker was given a rewritten prompt, this is the rewritten
	 *  prompt. When undefined, the worker used the plan's original prompt. */
	rewrittenPrompt?: string;
	/** When the worker output was parsed against an output_schema, this is
	 *  the structured result: { sectionName: sectionText }.
	 *  Populated by worker-parser; PR1 sets it in tests + the smoke path,
	 *  PR2 wires the call from executor. */
	parsed?: Record<string, string>;
	/** Quality heuristic score 0-100. < qualityMinScore ⇒ qualityDropped. */
	qualityScore?: number;
	/** When true, this worker's output was dropped from synthesis input due
	 *  to a quality score below `qualityMinScore`. The raw output is still
	 *  kept in `output` for archive / audit. */
	qualityDropped?: boolean;
	/** ISO timestamp of when the parse happened. */
	parsedAt?: string;
}

// ----------------------------------------------------------------------------
// Output schema (multi-round design — PR1: types only, PR2: discovery-driven)
//
// The schema is a per-task description of the sections a worker output must
// contain. Discovery LLM generates it; if Discovery is disabled or its output
// does not include one, `getDefaultOutputSchema()` is used. Worker prompts
// render it as markdown so the worker knows which section names to emit.
// ----------------------------------------------------------------------------

export type MoaSectionType = "markdown" | "list";

export interface MoaOutputSchemaSection {
	/** Section name used in `## <name>` headers. Lowercase, snake_case preferred. */
	name: string;
	/** When true, the section MUST be present in worker output. Missing
	 *  required section ⇒ quality score penalty. */
	required: boolean;
	/** markdown = raw text block; list = bullet list of items. */
	type: MoaSectionType;
	/** For list sections: optional hint for sub-field shape. The worker is
	 *  told to format each item as bullet text including the field names. */
	item?: Record<string, string>;
}

export interface MoaOutputSchema {
	sections: MoaOutputSchemaSection[];
}

/** Default schema used when Discovery does not output one (or is disabled). */
export const DEFAULT_OUTPUT_SCHEMA: MoaOutputSchema = {
	sections: [
		{ name: "plan", required: true, type: "markdown" },
		{
			name: "open_questions",
			required: true,
			type: "list",
			item: { question: "string", context: "string", suggested_default: "string", type: "freeform|choice" },
		},
		{ name: "assumptions", required: false, type: "list", item: { claim: "string", basis: "string" } },
	],
};

// ----------------------------------------------------------------------------
// Dispatch log (per-round worker scheduling audit trail)
//
// PR1 introduces the type and manifest field. PR2's multi-round executor
// populates it. Single-round runs in PR1 leave it empty (back-compat).
// ----------------------------------------------------------------------------

export interface MoaDispatchLogEntry {
	/** Worker name (divergent / grounded / critical / discovery / rewrite / synthesis). */
	workerName: string;
	/** Round number 1-based. Single-round runs use round=1. */
	round: number;
	/** ISO timestamp of when the worker subprocess was spawned. */
	startedAt: string;
	/** Wall-clock duration in milliseconds. */
	durationMs: number;
	/** Exit code from the subprocess. null = crash / signal. */
	exitCode: number | null;
	/** ok status (false on non-zero exit or crash). */
	ok: boolean;
	/** Model used (provider/id). */
	model?: string;
	/** Quality heuristic score 0-100. Undefined if not yet scored. */
	qualityScore?: number;
	/** Whether the worker was dropped due to quality check. */
	qualityDropped?: boolean;
	/** Retry count (0 = first attempt; ≥1 = transient-failure retry). */
	retryCount: number;
}

export interface MoaAskUserSummary {
	asked: number;
	answered: number;
	assumed: number;
	timedOut: number;
	enabled: boolean;
}

/**
 * Per-round audit (PR2 multi-round). One entry per round 1..N where
 * N ≤ settings.maxRounds. Rounds give the user-visible timeline and
 * feed the dispatch_log + trace.
 */
export interface MoaRoundWorker {
	name: string;
	ok: boolean;
	score: number;
	durationMs: number;
	qualityDropped: boolean;
}

export interface MoaRoundQuestion {
	question: string;
	answer?: string;
	sourceWorkers: string[];
}

export type MoaConvergenceSignal = "no_new_questions" | "user_stop" | "max_rounds" | "all_complete" | null;

export interface MoaRoundTrace {
	roundNumber: number;
	workers: MoaRoundWorker[];
	questionsAsked: MoaRoundQuestion[];
	questionsSkipped: Array<{ question: string; inferredFrom: string }>;
	userStopped: boolean;
	convergenceSignal: MoaConvergenceSignal;
	startedAt: string;
	endedAt: string;
}

export interface MoaExecutionResult {
	plan: MoaPlan;
	tco?: import("./tco").TaskContextObject;
	askSummary?: MoaAskUserSummary;
	discovery?: MoaWorkerResult;
	rewrite?: MoaWorkerResult;
	workers: MoaWorkerResult[];
	synthesis?: MoaWorkerResult;
	/** Resolved output schema used to parse worker outputs. Always set
	 *  (falls back to DEFAULT_OUTPUT_SCHEMA when Discovery is silent). */
	outputSchema?: MoaOutputSchema;
	/** Multi-round per-round audit. Empty array for single-round runs. */
	rounds?: MoaRoundTrace[];
	/** Per-round ask summary (separate from the pre-ask `askSummary`).
	 *  Empty when maxRounds=0. */
	askRoundSummaries?: MoaAskUserSummary[];
}

/**
 * Details attached to the visible `moa-result` custom_message. The full
 * transcript lives in the moa-archive entries (not in this details object) so
 * subsequent turns don't see worker full output in their LLM context.
 */
export interface MoaTraceDetails {
	task: string;
	workerCount: number;
	workers: Array<Pick<MoaWorkerResult, "name" | "role" | "ok" | "model">>;
	summary: string;
	/** Resolved synthesis model string (provider/id). Tooling can read this
	 *  from the moa-result details without parsing the archive transcript. */
	synthesisModel?: string;
	/** Stable run id linking this result to its full archive entries. */
	runId: string;
	/** Number of moa-archive chunk entries persisted for this run. */
	archiveChunks: number;
	/** Total byte size of the full archive transcript. */
	archiveBytes: number;
}

export const MOA_ARCHIVE_ENTRY_TYPE = "moa-archive";
export const MOA_ARCHIVE_SCHEMA = "moa.archive.v1";

/** UTF-8 byte size cap for an individual archive chunk entry. */
export const MOA_ARCHIVE_CHUNK_BYTES = 48_000;

export interface MoaArchiveManifest {
	schema: typeof MOA_ARCHIVE_SCHEMA;
	kind: "manifest";
	runId: string;
	createdAt: string;
	task: string;
	workerCount: number;
	completedWorkers: number;
	chunks: number;
	bytes: number;
	/** Per-round worker scheduling audit trail. PR1: optional, defaults to
	 *  undefined. PR2 multi-round executor populates one entry per worker
	 *  invocation. Backward compatible — old readers ignore the field. */
	dispatchLog?: MoaDispatchLogEntry[];
}

export interface MoaArchiveChunk {
	schema: typeof MOA_ARCHIVE_SCHEMA;
	kind: "chunk";
	runId: string;
	index: number;
	total: number;
	content: string;
}

export type MoaArchiveEntry = MoaArchiveManifest | MoaArchiveChunk;

export interface MoaArchiveInput {
	runId: string;
	createdAt?: string;
	task: string;
	workers: MoaWorkerResult[];
	synthesis?: MoaWorkerResult;
}
