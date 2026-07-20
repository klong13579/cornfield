/**
 * Exported MoA pipeline stage runners (design: docs/plans/2026-07-15-moa-stage-test-design.md).
 * `executePlan` orchestrates these; the stage-test CLI calls them directly.
 */
import type { AuthStorage, ExtensionUIContext, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	type AskQuestionsListItem,
	type AskUserContext,
	type AskUserItemEvent,
	askMissingInputs,
	askQuestionsList,
} from "./ask-user";
import { filterDecisionMissing } from "./decision-missing";
import { parseGrillQuestion, runGrillAsk, type GrillQuestion, type GrillQuestionContext } from "./grill-ask";
import { buildWorkerTaskMessage, renderOutputSchemaAsMarkdown } from "./planner";
import discoveryPromptTemplate from "./prompts/discovery.md" with { type: "text" };
import grillAskPromptTemplate from "./prompts/grill-ask.md" with { type: "text" };
import inputCollectPromptTemplate from "./prompts/input-collect.md" with { type: "text" };
import researchPromptTemplate from "./prompts/research.md" with { type: "text" };
import rewritePromptTemplate from "./prompts/rewrite.md" with { type: "text" };
import synthesisPromptTemplate from "./prompts/synthesis.md" with { type: "text" };
import { applyWorkerQuality } from "./quality/apply";
import { createSpawnJudgeFn, type JudgeFnArgs, type JudgeResult } from "./quality/judge";
import { type ResearchMode, resolveResearchMode, resolveWorkerTimeoutMs } from "./research-mode";
import { resolveSettings } from "./settings";
import type { WorkerOutput } from "./subprocess";
import {
	emptyTco,
	formatTcoValue,
	gatherDiscoveryContext,
	parseDiscoveryOutput,
	parseNeededInputs,
	parseResearchPackDetailed,
	type ResearchPack,
	type ResearchPackParseSource,
	renderTcoForPrompt,
	salvageResearchPack,
	type TaskContextObject,
	type TaskIntent,
	type TcoMissingInput,
	validateTco,
} from "./tco";
import type {
	MoaAskUserSummary,
	MoaConvergenceSignal,
	MoaDispatchLogEntry,
	MoaOutputSchema,
	MoaPlan,
	MoaPlanWorker,
	MoaRoundQuestion,
	MoaRoundTrace,
	MoaSettings,
	MoaWorkerResult,
} from "./types";
import { DEFAULT_OUTPUT_SCHEMA } from "./types";
import { createWorkerEngine, type MoaWorkerEngine, type WorkerEngineSharedContext } from "./worker-engine";
import { hasOpenQuestions, parseWorkerOutputBySchema } from "./worker-parser";

export interface ExecutePlanOptions {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	ui?: ExtensionUIContext;
	hasUI?: boolean;
	signal?: AbortSignal;
	moaSettings?: MoaSettings;
}

export interface StageContext {
	task: string;
	settings: MoaSettings;
}

export interface ResolvedPlanOptions {
	task: string;
	settings: MoaSettings;
	hasUI: boolean;
	engine: MoaWorkerEngine;
}

export function resolvePlanOptions(plan: MoaPlan, options: ExecutePlanOptions): ResolvedPlanOptions {
	const settings = options.moaSettings ?? resolveSettings();
	const shared: WorkerEngineSharedContext = {
		cwd: options.cwd,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		settings: options.settings,
	};
	return {
		task: plan.task,
		settings,
		hasUI: options.hasUI ?? false,
		engine: createWorkerEngine(settings.workerExecutionMode, shared),
	};
}

export function resolveStageOptions(ctx: StageContext, options: ExecutePlanOptions): ResolvedPlanOptions {
	const settings = options.moaSettings ?? ctx.settings;
	const shared: WorkerEngineSharedContext = {
		cwd: options.cwd,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		settings: options.settings,
	};
	return {
		task: ctx.task,
		settings,
		hasUI: options.hasUI ?? false,
		engine: createWorkerEngine(settings.workerExecutionMode, shared),
	};
}

export function resolveModel(requested: string | undefined, modelRegistry: ModelRegistry): string | undefined {
	const trimmed = requested?.trim();
	if (trimmed) {
		// Canonicalize when the registry knows the model. Unknown strings are
		// passed through so subprocess `omp --model` can still resolve aliases;
		// in-process fails later with a clear "model not found" stderr if the
		// pattern does not resolve inside createAgentSession.
		try {
			const getAll = (modelRegistry as { getAll?: () => unknown }).getAll;
			if (typeof getAll === "function") {
				const all = getAll.call(modelRegistry);
				if (Array.isArray(all) && all.length > 0) {
					const { model } = parseModelPattern(trimmed, all as never, {}, { modelRegistry });
					if (model && typeof model.provider === "string" && typeof model.id === "string") {
						return `${model.provider}/${model.id}`;
					}
					console.warn(
						`[moa] model "${trimmed}" not found in registry (in-process will fail; subprocess may still fall back)`,
					);
				}
			}
		} catch {
			// Test mocks may not implement getAll / parseModelPattern.
		}
		return trimmed;
	}
	try {
		const available = modelRegistry.getAvailable();
		if (Array.isArray(available) && available.length > 0) {
			const first = available[0]!;
			if (first && typeof first.provider === "string" && typeof first.id === "string") {
				return `${first.provider}/${first.id}`;
			}
		}
	} catch {
		// Test mocks may not implement getAvailable.
	}
	return undefined;
}

function resolveJudgeFn(
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
): ((args: JudgeFnArgs) => Promise<JudgeResult>) | undefined {
	if (!planOptions.settings.quality.judge.enabled) {
		return undefined;
	}
	return createSpawnJudgeFn({
		cwd: options.cwd,
		model: planOptions.settings.quality.judge.model,
		timeoutMs: planOptions.settings.quality.judge.timeoutMs,
	});
}

export function mapWorkerOutput(
	result: WorkerOutput,
	name: string,
	role: string,
	model?: string,
	rewrittenPrompt?: string,
): MoaWorkerResult {
	let stderr = result.stderr;
	if (result.timedOut) {
		const secs = result.durationMs ? Math.round(result.durationMs / 1000) : undefined;
		const timeoutNote = result.idleTimedOut
			? secs !== undefined
				? `idle timeout after ${secs}s (no progress)`
				: "idle timeout (no progress)"
			: secs !== undefined
				? `timed out after ${secs}s`
				: "timed out";
		stderr = stderr.trim() ? `${stderr.trim()}\n(${timeoutNote})` : timeoutNote;
	}
	return {
		name,
		role,
		ok: result.ok,
		output: result.output,
		stderr,
		exitCode: result.exitCode,
		model,
		rewrittenPrompt,
	};
}

export function mapExecutionError(name: string, role: string, error: unknown, model?: string): MoaWorkerResult {
	const message = error instanceof Error ? error.message : String(error);
	return { name, role, ok: false, output: "", stderr: message, exitCode: null, model };
}

export function createNoopUI(): ExtensionUIContext {
	const noop = async (): Promise<string | undefined> => undefined;
	return {
		select: noop,
		input: noop,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorking: () => {},
		setWorkingMessage: () => {},
		setEditorText: () => {},
		pasteEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		setCustomEditor: () => {},
	} as unknown as ExtensionUIContext;
}

export interface DiscoveryStageResult {
	result: MoaWorkerResult | undefined;
	tco: TaskContextObject;
	outputSchema: MoaOutputSchema;
	durationMs: number;
}

export async function runDiscoveryStage(ctx: StageContext, options: ExecutePlanOptions): Promise<DiscoveryStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const core = await runDiscoveryCore(planOptions, options);
	return { ...core, durationMs: Math.max(0, Date.now() - started) };
}

async function runDiscoveryCore(
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
): Promise<{ result: MoaWorkerResult | undefined; tco: TaskContextObject; outputSchema: MoaOutputSchema }> {
	if (!planOptions.settings.discoveryEnabled) {
		return {
			result: undefined,
			tco: emptyTco(planOptions.task, "discovery disabled"),
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
		};
	}
	const contextBlock = await gatherDiscoveryContext(options.cwd, {
		maxBytes: planOptions.settings.tcoInjectMaxBytes,
	});
	const systemPrompt = prompt.render(discoveryPromptTemplate, {
		task: planOptions.task,
		context_block: contextBlock || undefined,
	});
	const resolvedModel = resolveModel(planOptions.settings.discoveryModel, options.modelRegistry);
	const workerName = "discovery";
	const workerRole = "Extract task intent and missing inputs";
	try {
		const result = await planOptions.engine.execute({
			cwd: options.cwd,
			systemPrompt,
			task: planOptions.task,
			model: resolvedModel,
			tools: "none",
			timeoutMs: planOptions.settings.discoveryTimeoutMs,
			signal: options.signal,
		});
		const mapped = mapWorkerOutput(result, workerName, workerRole, resolvedModel);
		const { tco, outputSchema } = parseDiscoveryOutput(result.output, {
			maxMissingInputs: planOptions.settings.maxMissingInputs,
		});
		const validation = validateTco(tco, planOptions.settings.maxMissingInputs);
		if (!validation.ok) {
			mapped.stderr = `${mapped.stderr}\n[tco validation] ${validation.errors.join("; ")}`.trim();
		}
		if (validation.warnings.length > 0) {
			mapped.stderr = `${mapped.stderr}\n[tco warning] ${validation.warnings.join("; ")}`.trim();
		}
		return { result: mapped, tco, outputSchema };
	} catch (error) {
		return {
			result: mapExecutionError(workerName, workerRole, error, resolvedModel),
			tco: emptyTco(planOptions.task, "discovery crashed"),
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
		};
	}
}

export interface InputCollectStageResult {
	/** B-sourced missing inputs, each tagged `source: "worker"` + `roles`. */
	missing: TcoMissingInput[];
	/** Per-worker raw results (for archive / audit; not merged into synthesis). */
	results: MoaWorkerResult[];
	durationMs: number;
}

/**
 * B stage (once-right): lightweight fan-out where each worker reports the
 * inputs it would otherwise have to guess (`needed_inputs`). Runs BEFORE the
 * single Ask so its items can be merged (A∪B). Workers are read-only, get no
 * tools, and are told NOT to produce a plan. Failures are non-fatal — a crashed
 * worker just contributes no items.
 */
export async function runInputCollectStage(
	plan: MoaPlan,
	tco: TaskContextObject,
	ctx: StageContext,
	options: ExecutePlanOptions,
): Promise<InputCollectStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const core = await runInputCollectCore(plan, tco, planOptions, options);
	return { ...core, durationMs: Math.max(0, Date.now() - started) };
}

async function runInputCollectCore(
	plan: MoaPlan,
	tco: TaskContextObject,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
): Promise<{ missing: TcoMissingInput[]; results: MoaWorkerResult[] }> {
	if (!planOptions.settings.inputCollectEnabled) {
		return { missing: [], results: [] };
	}
	const tcoBlock = renderTcoForPrompt(tco, { maxBytes: planOptions.settings.tcoInjectMaxBytes });
	const maxItems = Math.max(1, planOptions.settings.maxQuestionsPerRound);
	const settled = await Promise.all(
		plan.workers.map(async worker => {
			const resolvedModel = resolveModel(worker.model, options.modelRegistry);
			const workerName = `input-collect:${worker.name}`;
			const systemPrompt = prompt.render(inputCollectPromptTemplate, {
				role: worker.role,
				task: plan.task,
				tco_block: tcoBlock || undefined,
				max_items: maxItems,
			});
			try {
				const result = await planOptions.engine.execute({
					cwd: options.cwd,
					systemPrompt,
					task: plan.task,
					model: resolvedModel,
					tools: "none",
					timeoutMs: planOptions.settings.discoveryTimeoutMs,
					signal: options.signal,
				});
				const mapped = mapWorkerOutput(result, workerName, worker.role, resolvedModel);
				const items: TcoMissingInput[] = parseNeededInputs(result.output).map(item => ({
					...item,
					source: "worker",
					roles: [worker.name],
				}));
				return { mapped, items };
			} catch (error) {
				return {
					mapped: mapExecutionError(workerName, worker.role, error, resolvedModel),
					items: [] as TcoMissingInput[],
				};
			}
		}),
	);
	return {
		missing: settled.flatMap(s => s.items),
		results: settled.map(s => s.mapped),
	};
}

// ----------------------------------------------------------------------------
// Research stage (Phase 7)
//
// Runs ONCE before the grill/form Ask when researchMode !== "none", so Ask can
// use the evidence pack and plan workers don't each redo expensive searches.
// Output is a `research_pack` attached to the TCO.
// ----------------------------------------------------------------------------

/** Tools the research agent gets. It is the only stage allowed long web_search. */
export const RESEARCH_TOOLS = ["read", "search", "find", "web_search", "ast_grep"] as const;

/** Read-only plan-worker tools with web_search removed (after Research stage). */
export const PLAN_WORKER_TOOLS_NO_SEARCH = ["read", "search", "find", "ast_grep"] as const;

/**
 * Strip `web_search` from a plan worker's tool list once the Research stage has
 * gathered evidence. Plan workers build on the shared `research_pack` instead of
 * each re-running searches. `none` mode passes through unchanged. `"all"` expands
 * to the read-only set without `web_search` so in-process / subprocess both honor
 * the ban (in-process previously treated `"all"` as the full IN_PROCESS_TOOLS).
 */
export function restrictPlanWorkerTools(
	tools: readonly string[] | "all",
	researchMode: ResearchMode,
): readonly string[] | "all" {
	if (researchMode === "none") return tools;
	if (tools === "all") return [...PLAN_WORKER_TOOLS_NO_SEARCH];
	return tools.filter(t => t !== "web_search");
}

export interface ResearchStageResult {
	pack: ResearchPack | null;
	/** How the pack was parsed (`json` / `markdown`), or null when no pack. */
	packSource: ResearchPackParseSource | null;
	results: MoaWorkerResult[];
	durationMs: number;
}

export async function runResearchStage(
	tco: TaskContextObject,
	ctx: StageContext,
	options: ExecutePlanOptions,
): Promise<ResearchStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const core = await runResearchCore(tco, planOptions, options);
	return { ...core, durationMs: Math.max(0, Date.now() - started) };
}

async function runResearchCore(
	tco: TaskContextObject,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
): Promise<{ pack: ResearchPack | null; packSource: ResearchPackParseSource | null; results: MoaWorkerResult[] }> {
	const mode = resolveResearchMode(planOptions.task, planOptions.settings.researchMode);
	if (mode === "none") return { pack: null, packSource: null, results: [] };
	const tcoBlock = renderTcoForPrompt(tco, { maxBytes: planOptions.settings.tcoInjectMaxBytes });
	const maxQueries = planOptions.settings.researchMaxQueries;
	const maxToolRounds = planOptions.settings.researchMaxToolRounds;
	const systemPrompt = prompt.render(researchPromptTemplate, {
		task: planOptions.task,
		tco_block: tcoBlock || undefined,
		max_queries: maxQueries,
		max_tool_rounds: maxToolRounds > 0 ? maxToolRounds : undefined,
	});
	// Research uses the strong synthesis model (evidence quality > diversity here).
	const resolvedModel = resolveModel(planOptions.settings.synthesisModel, options.modelRegistry);
	const workerName = "research";
	const workerRole = "Gather external + repo evidence once for all plan workers";
	try {
		const result = await planOptions.engine.execute({
			cwd: options.cwd,
			systemPrompt,
			task: planOptions.task,
			model: resolvedModel,
			tools: [...RESEARCH_TOOLS],
			timeoutMs: planOptions.settings.researchTimeoutMs,
			idleTimeoutMs: planOptions.settings.workerIdleTimeoutMs,
			maxToolRounds: maxToolRounds > 0 ? maxToolRounds : undefined,
			signal: options.signal,
		});
		const mapped = mapWorkerOutput(result, workerName, workerRole, resolvedModel);
		const packMode = mode === "required" ? "required" : "encouraged";
		const detailed = parseResearchPackDetailed(result.output, packMode);
		if (detailed.pack) {
			return { pack: detailed.pack, packSource: detailed.source, results: [mapped] };
		}
		// Soft-stop / empty finalize: never leave research with a null pack once
		// the agent ran — workers need a shared stub (gaps + any recovered URLs).
		const reason = result.toolBudgetExceeded
			? `research interrupted: web_search budget exceeded (${maxToolRounds})`
			: result.timedOut || result.idleTimedOut
				? "research interrupted: timeout"
				: result.stderr.trim()
					? `research interrupted: ${result.stderr.trim().slice(0, 200)}`
					: "research output unparseable or empty";
		const salvaged = salvageResearchPack(`${result.output}\n${result.stderr}`, packMode, reason);
		return { pack: salvaged, packSource: "salvage", results: [mapped] };
	} catch (error) {
		const packMode = mode === "required" ? "required" : "encouraged";
		const message = error instanceof Error ? error.message : String(error);
		const salvaged = salvageResearchPack("", packMode, `research interrupted: ${message}`);
		return {
			pack: salvaged,
			packSource: "salvage",
			results: [mapExecutionError(workerName, workerRole, error, resolvedModel)],
		};
	}
}

export interface AskStageHooks {
	onProgress?: (info: { index: number; total: number }) => void;
	onItemComplete?: (event: AskUserItemEvent) => void;
}

export interface AskStageResult {
	askSummary: MoaAskUserSummary;
	tco: TaskContextObject;
	durationMs: number;
}

export async function runAskStage(
	tco: TaskContextObject,
	ctx: StageContext,
	options: ExecutePlanOptions,
	hooks: AskStageHooks = {},
): Promise<AskStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const askSummary = await runAskUserCore(tco, planOptions, options, hooks);
	return { askSummary, tco, durationMs: Math.max(0, Date.now() - started) };
}

async function runAskUserCore(
	tco: TaskContextObject,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
	hooks: AskStageHooks = {},
): Promise<MoaAskUserSummary> {
	const askCtx: AskUserContext = {
		ui: options.ui ?? createNoopUI(),
		hasUI: planOptions.hasUI,
	};
	// Drop definition-style questions before any Ask path (Research owns those).
	tco.missing_inputs = filterDecisionMissing(tco.missing_inputs);

	const strategy = resolveEffectiveAskStrategy(planOptions.settings.askStrategy, tco, planOptions.task);
	if (strategy === "grill-me") {
		try {
			const researchDigest = formatResearchDigest(tco);
			let grillIndex = 0;
			const result = await runGrillAsk(tco, askCtx, {
				enabled: planOptions.settings.askEnabled,
				maxQuestions: planOptions.settings.grillMaxQuestions,
				task: planOptions.task,
				researchDigest,
				nextQuestion: createGrillNextQuestion(planOptions, options),
				onTurn: turn => {
					if ("kind" in turn) return;
					grillIndex += 1;
					hooks.onProgress?.({
						index: grillIndex,
						total: planOptions.settings.grillMaxQuestions,
					});
					hooks.onItemComplete?.({
						index: grillIndex,
						total: planOptions.settings.grillMaxQuestions,
						key: turn.key,
						question: turn.question,
						kind: "answered",
						value: turn.answer,
					});
				},
			});
			return {
				asked: result.asked,
				answered: result.answered,
				assumed: result.assumed,
				timedOut: 0,
				enabled: planOptions.settings.askEnabled && planOptions.hasUI,
			};
		} catch {
			// Fall through to form Ask on grill LLM/UI failures.
		}
	}

	const result = await askMissingInputs(tco, askCtx, {
		timeoutMs: planOptions.settings.askTimeoutMs,
		enabled: planOptions.settings.askEnabled,
		onProgress: hooks.onProgress,
		onItemComplete: hooks.onItemComplete,
	});
	return {
		asked: result.asked,
		answered: result.answered,
		assumed: result.assumed,
		timedOut: result.timedOut,
		enabled: planOptions.settings.askEnabled && planOptions.hasUI,
	};
}

/** Resolve `auto` against task_intent / task text. */
export function resolveEffectiveAskStrategy(
	strategy: MoaSettings["askStrategy"],
	tco: TaskContextObject,
	task: string,
): "grill-me" | "form" {
	if (strategy === "grill-me") return "grill-me";
	if (strategy === "form") return "form";
	const intent = tco.task_intent ?? inferTaskIntentFromText(task);
	if (intent === "compare" || intent === "design") return "grill-me";
	return "form";
}

function inferTaskIntentFromText(task: string): TaskIntent {
	const t = task.toLowerCase();
	if (/区别|对比|vs\.?|versus|比起|相比较|竞品/.test(t)) return "compare";
	if (/架构|设计|方案|trade.?off|how should|怎么设计/.test(t)) return "design";
	return "local-impl";
}

function formatResearchDigest(tco: TaskContextObject): string | undefined {
	const pack = tco.research_pack;
	if (!pack) return undefined;
	const lines: string[] = [];
	for (const s of pack.sources.slice(0, 12)) {
		lines.push(`- ${s.claim} — ${s.url} (${s.relevance})`);
	}
	for (const f of pack.repo_facts.slice(0, 8)) lines.push(`- repo: ${f}`);
	for (const g of pack.gaps.slice(0, 6)) lines.push(`- gap: ${g}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function createGrillNextQuestion(
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
): (ctx: GrillQuestionContext) => Promise<GrillQuestion> {
	return async ctx => {
		const systemPrompt = prompt.render(grillAskPromptTemplate, {
			task: ctx.task || planOptions.task,
			task_understanding: ctx.tco.task_understanding || planOptions.task,
			known_inputs_json: JSON.stringify(ctx.tco.known_inputs, null, 2),
			prior_turns_json: JSON.stringify(ctx.turns, null, 2),
			research_digest: ctx.researchDigest || undefined,
			seed_missing_json: ctx.seedMissing.length > 0 ? JSON.stringify(ctx.seedMissing, null, 2) : undefined,
		});
		const resolvedModel = resolveModel(planOptions.settings.discoveryModel, options.modelRegistry);
		const result = await planOptions.engine.execute({
			cwd: options.cwd,
			systemPrompt,
			task: "Emit the next grill question as JSON only.",
			model: resolvedModel,
			tools: "none",
			timeoutMs: planOptions.settings.discoveryTimeoutMs,
			signal: options.signal,
		});
		return parseGrillQuestion(result.output ?? "");
	};
}

export interface RewriteStageResult {
	result: MoaWorkerResult | undefined;
	workers: MoaPlanWorker[];
	/** True when LLM output was ok but sections could not be applied — original prompts kept. */
	fallbackUsed: boolean;
	durationMs: number;
}

export async function runRewriteStage(
	tco: TaskContextObject,
	plan: MoaPlan,
	ctx: StageContext,
	options: ExecutePlanOptions,
	outputSchema: MoaOutputSchema,
	researchGuidance = "",
): Promise<RewriteStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const core = await runRewriteCore(tco, plan, planOptions, options, outputSchema, researchGuidance);
	return { ...core, durationMs: Math.max(0, Date.now() - started) };
}

async function runRewriteCore(
	tco: TaskContextObject,
	plan: MoaPlan,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
	outputSchema: MoaOutputSchema,
	researchGuidance = "",
): Promise<{ result: MoaWorkerResult | undefined; workers: MoaPlanWorker[]; fallbackUsed: boolean }> {
	if (!planOptions.settings.rewriteEnabled) {
		return { result: undefined, workers: plan.workers, fallbackUsed: false };
	}
	const tcoBlock = renderTcoForPrompt(tco, { maxBytes: planOptions.settings.tcoInjectMaxBytes });
	const systemPrompt = prompt.render(rewritePromptTemplate, {
		task: planOptions.task,
		tco_block: tcoBlock,
		output_schema: renderOutputSchemaAsMarkdown(outputSchema),
		research_guidance: researchGuidance || undefined,
	});
	const resolvedModel = resolveModel(planOptions.settings.synthesisModel, options.modelRegistry);
	const workerName = "rewrite";
	const workerRole = "Generate role-specific worker prompts from TCO";
	try {
		const result = await planOptions.engine.execute({
			cwd: options.cwd,
			systemPrompt,
			task: planOptions.task,
			model: resolvedModel,
			tools: "none",
			timeoutMs: planOptions.settings.rewriteTimeoutMs,
			signal: options.signal,
		});
		const mapped = mapWorkerOutput(result, workerName, workerRole, resolvedModel);
		const parsed = parseRewriteOutput(result.output, plan.workers);
		const fallbackUsed = parsed === null && result.ok;
		const finalWorkers = parsed ?? plan.workers;
		if (!fallbackUsed) {
			return { result: mapped, workers: finalWorkers, fallbackUsed: false };
		}
		const note = "rewrite unparsed — fallback to original prompts";
		return {
			result: {
				...mapped,
				stderr: mapped.stderr.trim() ? `${mapped.stderr.trim()}\n(${note})` : note,
			},
			workers: finalWorkers,
			fallbackUsed: true,
		};
	} catch (error) {
		return {
			result: mapExecutionError(workerName, workerRole, error, resolvedModel),
			workers: plan.workers,
			fallbackUsed: true,
		};
	}
}

/** Exported for unit tests / CLI inspection. */
export function parseRewriteOutput(raw: string, fallback: MoaPlanWorker[]): MoaPlanWorker[] | null {
	if (!raw) return null;
	const sections = new Map<string, string>();
	const re = /##\s+([a-zA-Z][\w-]*)\s*\n([\s\S]*?)(?=\n##\s+[a-zA-Z][\w-]*\s*\n|$)/g;
	for (const match of raw.matchAll(re)) {
		sections.set(match[1]!.trim().toLowerCase(), match[2]!.trim());
	}
	const byName = new Map(fallback.map(w => [w.name.toLowerCase(), w] as const));
	const out: MoaPlanWorker[] = [];
	for (const [name, worker] of byName) {
		const text = sections.get(name);
		if (!text) return null;
		out.push({ ...worker, prompt: text, rewrittenPrompt: text });
	}
	return out.length === byName.size ? out : null;
}

function buildRoundHistoryBlock(
	roundNumber: number,
	previousAnswersText: string,
	previousQuestions: ReadonlyArray<string>,
): string {
	if (!previousAnswersText && previousQuestions.length === 0) {
		return "";
	}
	const parts = [
		`## Round ${roundNumber} context`,
		``,
		`Continue emitting the sections required by the output schema (typically \`## plan\` and \`## open_questions\`).`,
		`Do not re-ask questions already listed below; reference prior answers in your plan.`,
	];
	if (previousAnswersText) {
		parts.push(``, `### Previous answers`, previousAnswersText);
	}
	if (previousQuestions.length > 0) {
		parts.push(``, `### Questions already asked (do not repeat)`, ...previousQuestions.map(q => `- ${q}`));
	}
	return parts.join("\n");
}

export function normalizeQuestionKey(question: string): string {
	return question.toLowerCase().replace(/\s+/g, " ").trim();
}

export function formatPreviousAnswers(tco: TaskContextObject): string {
	const userAnswers = tco.known_inputs.filter(k => k.source === "user");
	if (userAnswers.length === 0) return "";
	return userAnswers
		.map((k, i) => `- Q${i + 1} [${k.key}]: ${typeof k.value === "string" ? k.value : JSON.stringify(k.value)}`)
		.join("\n");
}

function prependTco(promptText: string, tcoBlock: string): string {
	if (!tcoBlock) return promptText;
	return `${tcoBlock}\n\n---\n\n${promptText}`;
}

async function runWorker(
	worker: MoaPlanWorker,
	plan: MoaPlan,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
	tcoBlock: string,
	roundNumber: number,
	previousAnswersText: string,
	previousQuestions: ReadonlyArray<string>,
	outputSchema: MoaOutputSchema,
	onPartial?: (chunk: { name: string; text: string }) => void,
): Promise<MoaWorkerResult> {
	const resolvedModel = resolveModel(worker.model, options.modelRegistry);
	const tcoPlusWorker = prependTco(worker.prompt, tcoBlock);
	const roundContext = buildRoundHistoryBlock(roundNumber, previousAnswersText, previousQuestions);
	const promptText = roundContext ? `${roundContext}\n\n---\n\n${tcoPlusWorker}` : tcoPlusWorker;
	try {
		const researchMode = resolveResearchMode(plan.task, planOptions.settings.researchMode);
		// Phase 7: the Research stage already did the expensive web_search
		// fan-out. Plan workers build on the shared research_pack and use the
		// (shorter) workerTimeoutMs; only research gets researchTimeoutMs.
		const restrictedTools = restrictPlanWorkerTools(worker.tools, researchMode);
		const workerTimeoutMs =
			researchMode === "none"
				? resolveWorkerTimeoutMs(planOptions.settings.timeoutMs, researchMode)
				: planOptions.settings.workerTimeoutMs;
		const result = await planOptions.engine.execute({
			cwd: options.cwd,
			systemPrompt: promptText,
			task: buildWorkerTaskMessage(plan.task, outputSchema),
			model: resolvedModel,
			thinkingLevel: worker.thinking,
			tools: restrictedTools === "all" ? "all" : [...restrictedTools],
			signal: options.signal,
			timeoutMs: workerTimeoutMs,
			idleTimeoutMs: planOptions.settings.workerIdleTimeoutMs,
			onPartial: onPartial ? partial => onPartial({ name: worker.name, text: partial.text }) : undefined,
		});
		return mapWorkerOutput(result, worker.name, worker.role, resolvedModel ?? worker.model, worker.rewrittenPrompt);
	} catch (error) {
		return mapExecutionError(worker.name, worker.role, error, resolvedModel ?? worker.model);
	}
}

function buildWorkerDigest(result: MoaWorkerResult): string {
	const status = result.ok ? "ok" : `failed${result.exitCode === null ? "" : ` (${result.exitCode})`}`;
	const sections = [`## ${result.name}`, `- role: ${result.role}`, `- status: ${status}`];
	if (result.output.trim()) {
		sections.push("", "### output", result.output.trim());
	}
	if (result.stderr.trim()) {
		sections.push("", "### stderr", result.stderr.trim());
	}
	if (!result.output.trim() && !result.stderr.trim()) {
		sections.push("", "(no output)");
	}
	return sections.join("\n");
}

export async function runWorkerFanout(
	workers: ReadonlyArray<MoaPlanWorker>,
	plan: MoaPlan,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
	tcoBlock: string,
	roundNumber: number,
	previousAnswersText: string,
	previousQuestions: ReadonlyArray<string>,
	outputSchema: MoaOutputSchema,
	onPartial?: (chunk: { name: string; text: string }) => void,
): Promise<{
	workers: MoaWorkerResult[];
	durations: Map<string, number>;
	startedAts: Map<string, string>;
}> {
	const startedAtMs = new Map<string, number>();
	const startedAtIso = new Map<string, string>();
	const staggerMs = Math.max(0, planOptions.settings.workerStaggerMs ?? 0);
	const settled = await Promise.all(
		workers.map(async (worker, index) => {
			if (staggerMs > 0 && index > 0) {
				await Bun.sleep(staggerMs * index);
			}
			const now = Date.now();
			startedAtMs.set(worker.name, now);
			startedAtIso.set(worker.name, new Date(now).toISOString());
			return runWorker(
				worker,
				plan,
				planOptions,
				options,
				tcoBlock,
				roundNumber,
				previousAnswersText,
				previousQuestions,
				outputSchema,
				onPartial,
			);
		}),
	);
	const durations = new Map<string, number>();
	for (const w of settled) {
		const start = startedAtMs.get(w.name) ?? Date.now();
		durations.set(w.name, Math.max(0, Date.now() - start));
	}
	return { workers: settled, durations, startedAts: startedAtIso };
}

export interface SynthesisStageResult {
	synthesis: MoaWorkerResult;
	durationMs: number;
}

export async function runSynthesisStage(
	plan: MoaPlan,
	workers: MoaWorkerResult[],
	ctx: StageContext,
	options: ExecutePlanOptions,
	tcoBlock: string,
	tco: TaskContextObject,
): Promise<SynthesisStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const synthesis = await runSynthesisCore(plan, workers, planOptions, options, tcoBlock, tco);
	return { synthesis, durationMs: Math.max(0, Date.now() - started) };
}

async function runSynthesisCore(
	plan: MoaPlan,
	workers: MoaWorkerResult[],
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
	tcoBlock: string,
	tco: TaskContextObject,
): Promise<MoaWorkerResult> {
	const workerOutputs = workers.map(buildWorkerDigest).join("\n\n");
	const assumptionsBlock =
		tco.assumptions.length > 0
			? tco.assumptions
					.map(assumption => {
						const value = formatTcoValue(assumption.value);
						const note = assumption.note ? `; note=${assumption.note}` : "";
						return `- \`${assumption.key}\` = ${value} (reason=${assumption.reason}${note})`;
					})
					.join("\n")
			: undefined;
	const systemPrompt = prompt.render(synthesisPromptTemplate, {
		task: plan.task,
		tco_block: tcoBlock || undefined,
		worker_outputs: workerOutputs,
		assumptions_block: assumptionsBlock,
	});
	const resolvedSynthesisModel = resolveModel(plan.synthesisModel, options.modelRegistry);
	try {
		const result = await planOptions.engine.execute({
			cwd: options.cwd,
			systemPrompt,
			task: plan.task,
			model: resolvedSynthesisModel,
			thinkingLevel: plan.synthesisThinking,
			tools: "none",
			signal: options.signal,
			timeoutMs: planOptions.settings.timeoutMs,
		});
		return mapWorkerOutput(
			result,
			"synthesis",
			"Merge surviving worker plans into one recommendation",
			resolvedSynthesisModel ?? plan.synthesisModel,
		);
	} catch (error) {
		return mapExecutionError(
			"synthesis",
			"Merge surviving worker plans into one recommendation",
			error,
			resolvedSynthesisModel ?? plan.synthesisModel,
		);
	}
}

export function collectOpenQuestions(
	surviving: ReadonlyArray<MoaWorkerResult>,
	schema: MoaOutputSchema,
	max: number,
	previousQuestions: ReadonlySet<string> = new Set(),
): AskQuestionsListItem[] {
	if (max <= 0) return [];
	const seen = new Set<string>(previousQuestions);
	const out: AskQuestionsListItem[] = [];
	for (const w of surviving) {
		const parsed = parseWorkerOutputBySchema(w.output, schema);
		const sectionText = parsed.sections.open_questions;
		if (!sectionText) continue;
		for (const item of parseBulletQuestions(sectionText)) {
			const key = item.question.toLowerCase().replace(/\s+/g, " ").trim();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				key: `${w.name}.${out.length}`,
				question: item.question,
				type: item.type === "choice" ? "choice" : "freeform",
				context: item.context,
				suggested_default: item.suggested_default,
				options: item.options,
				sourceWorkers: [w.name],
			});
			if (out.length >= max) return out;
		}
	}
	return out;
}

interface ParsedBulletQuestion {
	question: string;
	context: string;
	suggested_default: string;
	type: "freeform" | "choice";
	options: string[];
}

function parseBulletQuestions(text: string): ParsedBulletQuestion[] {
	const out: ParsedBulletQuestion[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
		if (!m) continue;
		const body = m[1]!.trim();
		if (!body) continue;
		const sep = body.match(/[:——]\s*/);
		const question = sep ? body.slice(0, sep.index).trim() : body;
		const context = sep ? body.slice((sep.index ?? 0) + sep[0].length).trim() : "";
		out.push({
			question: question || body,
			context,
			suggested_default: "",
			type: "freeform",
			options: [],
		});
	}
	return out;
}

function allWorkersComplete(workers: ReadonlyArray<MoaWorkerResult>, schema: MoaOutputSchema): boolean {
	if (workers.length === 0) return false;
	return workers.every(w => (w.qualityScore ?? 0) >= 80 && !hasOpenQuestions(w, schema));
}

export function buildRoundTrace(
	roundNumber: number,
	parsed: ReadonlyArray<MoaWorkerResult>,
	workerDurations: ReadonlyMap<string, number>,
	asked: MoaRoundQuestion[],
	skipped: Array<{ question: string; inferredFrom: string }>,
	signal: MoaConvergenceSignal,
	startedAt: string,
	endedAt: string,
): MoaRoundTrace {
	return {
		roundNumber,
		workers: parsed.map(w => ({
			name: w.name,
			ok: w.ok,
			score: w.qualityScore ?? 0,
			durationMs: workerDurations.get(w.name) ?? 0,
			qualityDropped: w.qualityDropped ?? false,
		})),
		questionsAsked: asked,
		questionsSkipped: skipped,
		userStopped: signal === "user_stop",
		convergenceSignal: signal,
		startedAt,
		endedAt,
	};
}

export function appendAskSummary(
	target: MoaAskUserSummary[],
	asked: number,
	answered: number,
	assumed: number,
	timedOut: number,
): void {
	target.push({ asked, answered, assumed, timedOut, enabled: true });
}

export function pickConvergenceSignal(
	allDropped: boolean,
	userStopped: boolean,
	atMaxRound: boolean,
	allComplete: boolean,
	noNewQuestions: boolean,
): MoaConvergenceSignal {
	if (allDropped) return "quality_failed";
	if (userStopped) return "user_stop";
	if (allComplete) return "all_complete";
	if (atMaxRound) return "max_rounds";
	if (noNewQuestions) return "no_new_questions";
	return null;
}

export function appendDispatchEntries(
	dispatchLog: MoaDispatchLogEntry[],
	parsed: ReadonlyArray<MoaWorkerResult>,
	workerDurations: ReadonlyMap<string, number>,
	roundNumber: number,
	workerStartedAts: ReadonlyMap<string, string>,
): void {
	for (const w of parsed) {
		const entry: MoaDispatchLogEntry = {
			workerName: w.name,
			round: roundNumber,
			startedAt: workerStartedAts.get(w.name) ?? "",
			durationMs: workerDurations.get(w.name) ?? 0,
			exitCode: w.exitCode,
			ok: w.ok,
			retryCount: 0,
		};
		if (w.model !== undefined) entry.model = w.model;
		if (w.qualityScore !== undefined) entry.qualityScore = w.qualityScore;
		if (w.qualityDropped) entry.qualityDropped = true;
		if (w.qualityMeta !== undefined) entry.qualityMeta = w.qualityMeta;
		dispatchLog.push(entry);
	}
}

export function qualityFailedSynthesis(): MoaWorkerResult {
	return {
		name: "synthesis",
		role: "Merge surviving worker plans into one recommendation",
		ok: false,
		output: "",
		stderr: "all workers quality-failed",
		exitCode: null,
	};
}

/**
 * Whether a degraded synthesis would carry anything genuinely useful. True when
 * we have a research_pack, or when at least one worker produced a real `## plan`
 * section with substance (a timed-out-but-partial plan). Junk / contract-fail
 * output like a bare "no schema" string does NOT count — those stay fail-loud.
 */
export function hasSalvageableMaterial(tco: TaskContextObject, workers: ReadonlyArray<MoaWorkerResult>): boolean {
	if (tco.research_pack) return true;
	return workers.some(w => {
		if (!/(^|\n)\s*##\s*plan\b/i.test(w.output)) return false;
		return w.output.replace(/\s+/g, "").length > 80;
	});
}

/**
 * Phase 7 "never empty" fallback. When too few workers survive quality (e.g.
 * every worker timed out) we must NOT return an empty synthesis — the user
 * already answered the Ask and deserves something actionable. This builds a
 * deterministic degraded report (no extra LLM call, so it can't time out again)
 * from whatever we DO have: the research_pack, the TCO assumptions, and any
 * partial worker output. It is marked `ok:false` (the run did not fully
 * succeed) but always carries usable content plus a clear "narrow scope and
 * rerun" instruction.
 */
export function buildDegradedSynthesis(
	tco: TaskContextObject,
	workers: ReadonlyArray<MoaWorkerResult>,
): MoaWorkerResult {
	const lines: string[] = [
		"## plan",
		"> ⚠️ 降级输出：本次 worker 未能产出完整方案（多为超时/质量不达标）。",
		"> 以下是已收集到的证据与半成品，请据此**缩小任务范围后重跑**（rerun with a narrower scope）。",
	];
	const pack = tco.research_pack;
	if (pack) {
		if (pack.sources.length > 0) {
			lines.push("", "### 已收集证据（sources）");
			for (const s of pack.sources) lines.push(`- ${s.claim} — ${s.url}（${s.relevance}）`);
		}
		if (pack.repo_facts.length > 0) {
			lines.push("", "### 仓库事实（repo facts）");
			for (const f of pack.repo_facts) lines.push(`- ${f}`);
		}
		if (pack.gaps.length > 0) {
			lines.push("", "### 待确认缺口（gaps）");
			for (const g of pack.gaps) lines.push(`- ${g}`);
		}
	}
	const partials = workers.filter(w => w.output.trim().length > 0);
	if (partials.length > 0) {
		lines.push("", "### Worker 半成品输出");
		for (const w of partials) {
			lines.push(`#### ${w.name}${w.ok ? "" : "（未完成）"}`, w.output.trim());
		}
	}
	if (tco.assumptions.length > 0) {
		lines.push("", "## assumptions");
		for (const a of tco.assumptions) {
			lines.push(`- \`${a.key}\` = ${formatTcoValue(a.value)} (reason=${a.reason})`);
		}
	}
	lines.push("", "## open_questions", "- 是否可将任务拆成更小、边界清晰的子问题后重跑？");
	return {
		name: "synthesis",
		role: "Merge surviving worker plans into one recommendation",
		ok: false,
		output: lines.join("\n"),
		stderr: "degraded synthesis: insufficient surviving workers",
		exitCode: null,
	};
}

export interface WorkersStageHooks {
	notify?: (msg: string, type?: "info" | "warning" | "error") => void;
	/** Once-right P5: cumulative text deltas from each plan worker. */
	onWorkerPartial?: (chunk: { name: string; text: string }) => void;
	onRoundWorkers?: (info: {
		round: number;
		maxRounds: number;
		baseWorkers: ReadonlyArray<MoaPlanWorker>;
	}) => { stop: () => number } | undefined;
	onRoundAskStart?: (info: {
		round: number;
		maxRounds: number;
		questionTotal: number;
		workerStatus: Array<{ name: string; ok: boolean; qualityDropped?: boolean }>;
	}) => { stop: () => void } | undefined;
	onAskProgress?: (info: {
		round: number;
		maxRounds: number;
		index: number;
		total: number;
		workerStatus: Array<{ name: string; ok: boolean; qualityDropped?: boolean }>;
	}) => void;
	formatWorkersDone?: (okCount: number, total: number, workersMs: number) => string;
}

export interface WorkersStageResult {
	workers: MoaWorkerResult[];
	rounds: MoaRoundTrace[];
	askRoundSummaries: MoaAskUserSummary[];
	dispatchLog: MoaDispatchLogEntry[];
	surviving: MoaWorkerResult[];
	signal: MoaConvergenceSignal;
	tco: TaskContextObject;
	tcoBlock: string;
	durationMs: number;
}

export async function runWorkersStage(input: {
	plan: MoaPlan;
	baseWorkers: MoaPlanWorker[];
	tco: TaskContextObject;
	outputSchema: MoaOutputSchema;
	tcoBlock: string;
	ctx: StageContext;
	options: ExecutePlanOptions;
	/** Already-effective max rounds (0 = single-round). */
	effectiveMaxRounds: number;
	hooks?: WorkersStageHooks;
}): Promise<WorkersStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(input.ctx, input.options);
	const judgeFn = resolveJudgeFn(planOptions, input.options);
	const { plan, baseWorkers, outputSchema, options, effectiveMaxRounds, hooks = {} } = input;
	const researchMode = resolveResearchMode(plan.task, planOptions.settings.researchMode);
	let tcoBlock = input.tcoBlock;
	const currentTco = input.tco;
	const rounds: MoaRoundTrace[] = [];
	const askRoundSummaries: MoaAskUserSummary[] = [];
	const allWorkerInvocations: MoaWorkerResult[] = [];
	const dispatchLog: MoaDispatchLogEntry[] = [];
	const previousQuestionKeys = new Set<string>();
	let lastRoundSurviving: MoaWorkerResult[] = [];
	let userStopped = false;
	let lastSignal: MoaConvergenceSignal = null;

	const notify = hooks.notify ?? (() => {});

	if (effectiveMaxRounds === 0) {
		const roundStartedAt = new Date().toISOString();
		const live = hooks.onRoundWorkers?.({ round: 1, maxRounds: 1, baseWorkers });
		const {
			workers: roundWorkers,
			durations,
			startedAts,
		} = await runWorkerFanout(
			baseWorkers,
			plan,
			planOptions,
			options,
			tcoBlock,
			1,
			"",
			[],
			outputSchema,
			hooks.onWorkerPartial,
		);
		const workersMs = live?.stop() ?? 0;
		const parsed = await Promise.all(
			roundWorkers.map(w =>
				applyWorkerQuality(w, outputSchema, {
					minScore: planOptions.settings.qualityMinScore,
					quality: planOptions.settings.quality,
					task: plan.task,
					signal: options.signal,
					judgeFn,
					researchMode,
				}),
			),
		);
		allWorkerInvocations.push(...parsed);
		appendDispatchEntries(dispatchLog, parsed, durations, 1, startedAts);
		lastRoundSurviving = parsed.filter(w => !w.qualityDropped);
		const okCount = parsed.filter(w => w.ok).length;
		notify(
			hooks.formatWorkersDone?.(okCount, baseWorkers.length, workersMs) ??
				`Worker 完成 ${okCount}/${baseWorkers.length} ✓`,
		);
		lastSignal = pickConvergenceSignal(
			lastRoundSurviving.length === 0,
			false,
			false,
			allWorkersComplete(lastRoundSurviving, outputSchema),
			false,
		);
		const roundEndedAt = new Date().toISOString();
		rounds.push(buildRoundTrace(1, parsed, durations, [], [], lastSignal, roundStartedAt, roundEndedAt));
	} else {
		for (let round = 1; round <= effectiveMaxRounds; round++) {
			const roundStartedAt = new Date().toISOString();
			const previousAnswersText = formatPreviousAnswers(currentTco);
			const previousQuestionsList = [...previousQuestionKeys];
			const live = hooks.onRoundWorkers?.({ round, maxRounds: effectiveMaxRounds, baseWorkers });
			const {
				workers: roundWorkers,
				durations,
				startedAts,
			} = await runWorkerFanout(
				baseWorkers,
				plan,
				planOptions,
				options,
				tcoBlock,
				round,
				previousAnswersText,
				previousQuestionsList,
				outputSchema,
				hooks.onWorkerPartial,
			);
			const workersMs = live?.stop() ?? 0;
			const parsed = await Promise.all(
				roundWorkers.map(w =>
					applyWorkerQuality(w, outputSchema, {
						minScore: planOptions.settings.qualityMinScore,
						quality: planOptions.settings.quality,
						task: plan.task,
						signal: options.signal,
						judgeFn,
						researchMode,
					}),
				),
			);
			allWorkerInvocations.push(...parsed);
			appendDispatchEntries(dispatchLog, parsed, durations, round, startedAts);

			const surviving = parsed.filter(w => !w.qualityDropped);
			lastRoundSurviving = surviving;

			const allDropped = surviving.length === 0;
			const atMaxRound = round >= effectiveMaxRounds;
			const allComplete = !allDropped && allWorkersComplete(surviving, outputSchema);
			const workerStatus = parsed.map(w => ({
				name: w.name,
				ok: w.ok,
				qualityDropped: w.qualityDropped,
			}));

			const questions =
				!allDropped && !atMaxRound
					? collectOpenQuestions(
							surviving,
							outputSchema,
							planOptions.settings.maxQuestionsPerRound,
							previousQuestionKeys,
						)
					: [];
			const noNew = questions.length === 0;

			let signal = pickConvergenceSignal(allDropped, userStopped, atMaxRound, allComplete, noNew);
			const converged = signal !== null;

			let questionsAsked: MoaRoundQuestion[] = [];
			let questionsSkipped: Array<{ question: string; inferredFrom: string }> = [];
			if (!converged && questions.length > 0) {
				const askCtx: AskUserContext = {
					ui: options.ui ?? createNoopUI(),
					hasUI: planOptions.hasUI,
				};
				const askLive = hooks.onRoundAskStart?.({
					round,
					maxRounds: effectiveMaxRounds,
					questionTotal: questions.length,
					workerStatus,
				});
				const askResult = await askQuestionsList(questions, askCtx, {
					timeoutMs: planOptions.settings.askTimeoutMs,
					enabled: planOptions.settings.askEnabled,
					onProgress: ({ index, total }) => {
						hooks.onAskProgress?.({
							round,
							maxRounds: effectiveMaxRounds,
							index,
							total,
							workerStatus,
						});
					},
				});
				askLive?.stop();

				for (const a of askResult.answered) {
					currentTco.known_inputs.push({ key: a.key, value: a.answer, source: "user" });
				}
				for (const s of askResult.skipped) {
					currentTco.assumptions.push({
						key: s.key,
						value: undefined,
						reason: s.reason === "non_interactive_fallback" ? "non_interactive_fallback" : "user_skipped",
						note: s.reason,
					});
				}

				for (const q of questions) {
					previousQuestionKeys.add(normalizeQuestionKey(q.question));
				}

				questionsAsked = askResult.answered.map(a => ({
					question: a.question,
					answer: a.answer,
					sourceWorkers: a.sourceWorkers,
				}));
				questionsSkipped = askResult.skipped.map(s => ({
					question: s.question,
					inferredFrom: s.reason,
				}));

				appendAskSummary(
					askRoundSummaries,
					askResult.answered.length + askResult.skipped.length,
					askResult.answered.length,
					askResult.skipped.length,
					askResult.timedOut,
				);

				if (askResult.stopped) {
					userStopped = true;
				}

				tcoBlock = renderTcoForPrompt(currentTco, {
					maxBytes: planOptions.settings.tcoInjectMaxBytes,
				});
			}

			if (userStopped) {
				signal = "user_stop";
			} else if (!converged && questions.length > 0 && atMaxRound) {
				signal = "max_rounds";
			}

			lastSignal = signal;
			notify(
				hooks.formatWorkersDone?.(parsed.filter(w => w.ok).length, baseWorkers.length, workersMs) ??
					`Worker 完成 ${parsed.filter(w => w.ok).length}/${baseWorkers.length} ✓`,
			);

			const roundEndedAt = new Date().toISOString();
			rounds.push(
				buildRoundTrace(
					round,
					parsed,
					durations,
					questionsAsked,
					questionsSkipped,
					signal,
					roundStartedAt,
					roundEndedAt,
				),
			);

			if (signal !== null) break;
		}
	}

	return {
		workers: allWorkerInvocations,
		rounds,
		askRoundSummaries,
		dispatchLog,
		surviving: lastRoundSurviving,
		signal: lastSignal ?? (lastRoundSurviving.length === 0 ? "quality_failed" : "all_complete"),
		tco: currentTco,
		tcoBlock,
		durationMs: Math.max(0, Date.now() - started),
	};
}

/** Internal cores used by executePlan when it already holds ResolvedPlanOptions. */
export const stageInternals = {
	runDiscoveryCore,
	runAskUserCore,
	runRewriteCore,
	runSynthesisCore,
};
