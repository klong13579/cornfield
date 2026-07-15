/**
 * Exported MoA pipeline stage runners (design: docs/plans/2026-07-15-moa-stage-test-design.md).
 * `executePlan` orchestrates these; the stage-test CLI calls them directly.
 */
import type { AuthStorage, ExtensionUIContext, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import { type AskQuestionsListItem, type AskUserContext, askMissingInputs, askQuestionsList } from "./ask-user";
import discoveryPromptTemplate from "./prompts/discovery.md" with { type: "text" };
import rewritePromptTemplate from "./prompts/rewrite.md" with { type: "text" };
import synthesisPromptTemplate from "./prompts/synthesis.md" with { type: "text" };
import { renderOutputSchemaAsMarkdown } from "./planner";
import { resolveSettings } from "./settings";
import type { WorkerOutput } from "./subprocess";
import {
	emptyTco,
	gatherDiscoveryContext,
	parseDiscoveryOutput,
	renderTcoForPrompt,
	type TaskContextObject,
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
import { applyWorkerQuality } from "./quality/apply";
import { createSpawnJudgeFn, type JudgeFnArgs, type JudgeResult } from "./quality/judge";
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
	if (requested && requested.trim().length > 0) return requested;
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
	return {
		name,
		role,
		ok: result.ok,
		output: result.output,
		stderr: result.stderr,
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

export async function runDiscoveryStage(
	ctx: StageContext,
	options: ExecutePlanOptions,
): Promise<DiscoveryStageResult> {
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

export interface AskStageResult {
	askSummary: MoaAskUserSummary;
	tco: TaskContextObject;
	durationMs: number;
}

export async function runAskStage(
	tco: TaskContextObject,
	ctx: StageContext,
	options: ExecutePlanOptions,
): Promise<AskStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const askSummary = await runAskUserCore(tco, planOptions, options);
	return { askSummary, tco, durationMs: Math.max(0, Date.now() - started) };
}

async function runAskUserCore(
	tco: TaskContextObject,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
): Promise<MoaAskUserSummary> {
	const askCtx: AskUserContext = {
		ui: options.ui ?? createNoopUI(),
		hasUI: planOptions.hasUI,
	};
	const result = await askMissingInputs(tco, askCtx, {
		timeoutMs: planOptions.settings.askTimeoutMs,
		enabled: planOptions.settings.askEnabled,
	});
	return {
		asked: result.asked,
		answered: result.answered,
		assumed: result.assumed,
		timedOut: result.timedOut,
		enabled: planOptions.settings.askEnabled && planOptions.hasUI,
	};
}

export interface RewriteStageResult {
	result: MoaWorkerResult | undefined;
	workers: MoaPlanWorker[];
	durationMs: number;
}

export async function runRewriteStage(
	tco: TaskContextObject,
	plan: MoaPlan,
	ctx: StageContext,
	options: ExecutePlanOptions,
	outputSchema: MoaOutputSchema,
): Promise<RewriteStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const core = await runRewriteCore(tco, plan, planOptions, options, outputSchema);
	return { ...core, durationMs: Math.max(0, Date.now() - started) };
}

async function runRewriteCore(
	tco: TaskContextObject,
	plan: MoaPlan,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
	outputSchema: MoaOutputSchema,
): Promise<{ result: MoaWorkerResult | undefined; workers: MoaPlanWorker[] }> {
	if (!planOptions.settings.rewriteEnabled) {
		return { result: undefined, workers: plan.workers };
	}
	const tcoBlock = renderTcoForPrompt(tco, { maxBytes: planOptions.settings.tcoInjectMaxBytes });
	const systemPrompt = prompt.render(rewritePromptTemplate, {
		task: planOptions.task,
		tco_block: tcoBlock,
		output_schema: renderOutputSchemaAsMarkdown(outputSchema),
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
		const finalWorkers = parsed ?? plan.workers;
		return { result: mapped, workers: finalWorkers };
	} catch (error) {
		return {
			result: mapExecutionError(workerName, workerRole, error, resolvedModel),
			workers: plan.workers,
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
		parts.push(
			``,
			`### Questions already asked (do not repeat)`,
			...previousQuestions.map(q => `- ${q}`),
		);
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
): Promise<MoaWorkerResult> {
	const resolvedModel = resolveModel(worker.model, options.modelRegistry);
	const tcoPlusWorker = prependTco(worker.prompt, tcoBlock);
	const roundContext = buildRoundHistoryBlock(roundNumber, previousAnswersText, previousQuestions);
	const promptText = roundContext ? `${roundContext}\n\n---\n\n${tcoPlusWorker}` : tcoPlusWorker;
	try {
		const result = await planOptions.engine.execute({
			cwd: options.cwd,
			systemPrompt: promptText,
			task: plan.task,
			model: resolvedModel,
			thinkingLevel: worker.thinking,
			tools: worker.tools === "all" ? "all" : [...worker.tools],
			signal: options.signal,
			timeoutMs: planOptions.settings.timeoutMs,
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
): Promise<SynthesisStageResult> {
	const started = Date.now();
	const planOptions = resolveStageOptions(ctx, options);
	const synthesis = await runSynthesisCore(plan, workers, planOptions, options, tcoBlock);
	return { synthesis, durationMs: Math.max(0, Date.now() - started) };
}

async function runSynthesisCore(
	plan: MoaPlan,
	workers: MoaWorkerResult[],
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
	tcoBlock: string,
): Promise<MoaWorkerResult> {
	const workerOutputs = workers.map(buildWorkerDigest).join("\n\n");
	const assumptionsBlock = planOptions.settings.askEnabled
		? undefined
		: "(assumptions were auto-filled; non-interactive run)";
	const systemPrompt = prompt.render(synthesisPromptTemplate, {
		task: plan.task,
		tco_block: tcoBlock || undefined,
		worker_outputs: workerOutputs,
		assumptions_block: assumptionsBlock,
	});
	const resolvedSynthesisModel = resolveModel(plan.synthesisModel, options.modelRegistry);
	const finalPrompt = prependTco(systemPrompt, tcoBlock);
	try {
		const result = await planOptions.engine.execute({
			cwd: options.cwd,
			systemPrompt: finalPrompt,
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

export interface WorkersStageHooks {
	notify?: (msg: string, type?: "info" | "warning" | "error") => void;
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
	const {
		plan,
		baseWorkers,
		outputSchema,
		options,
		effectiveMaxRounds,
		hooks = {},
	} = input;
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
		const { workers: roundWorkers, durations, startedAts } = await runWorkerFanout(
			baseWorkers,
			plan,
			planOptions,
			options,
			tcoBlock,
			1,
			"",
			[],
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
			const { workers: roundWorkers, durations, startedAts } = await runWorkerFanout(
				baseWorkers,
				plan,
				planOptions,
				options,
				tcoBlock,
				round,
				previousAnswersText,
				previousQuestionsList,
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
				hooks.formatWorkersDone?.(
					parsed.filter(w => w.ok).length,
					baseWorkers.length,
					workersMs,
				) ?? `Worker 完成 ${parsed.filter(w => w.ok).length}/${baseWorkers.length} ✓`,
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
