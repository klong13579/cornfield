import type { AuthStorage, ExtensionUIContext, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import { type AskQuestionsListItem, type AskUserContext, askMissingInputs, askQuestionsList } from "./ask-user";
import discoveryPromptTemplate from "./prompts/discovery.md" with { type: "text" };
import rewritePromptTemplate from "./prompts/rewrite.md" with { type: "text" };
import synthesisPromptTemplate from "./prompts/synthesis.md" with { type: "text" };
import { resolveSettings } from "./settings";
import { spawnMoaWorker, type WorkerOutput } from "./subprocess";
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
	MoaExecutionResult,
	MoaOutputSchema,
	MoaPlan,
	MoaPlanWorker,
	MoaRoundQuestion,
	MoaRoundTrace,
	MoaSettings,
	MoaWorkerResult,
} from "./types";
import { DEFAULT_OUTPUT_SCHEMA } from "./types";
import { applyWorkerParsing, hasOpenQuestions, parseWorkerOutputBySchema } from "./worker-parser";

export interface ExecutePlanOptions {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** TUI context for the ask-user stage. Required when `hasUI=true`. */
	ui?: ExtensionUIContext;
	hasUI?: boolean;
	signal?: AbortSignal;
	/** Optional override of the MoaSettings (defaults to resolveSettings({})). */
	moaSettings?: MoaSettings;
}

// ----------------------------------------------------------------------------
// Plan options (re-derived for execution). The static MoaPlan has no
// discovery/rewrite fields — those are derived from MoaSettings at runtime.
// ----------------------------------------------------------------------------

interface ResolvedPlanOptions {
	task: string;
	settings: MoaSettings;
	hasUI: boolean;
}

function resolvePlanOptions(plan: MoaPlan, options: ExecutePlanOptions): ResolvedPlanOptions {
	return {
		task: plan.task,
		settings: options.moaSettings ?? resolveSettings(),
		hasUI: options.hasUI ?? false,
	};
}

// ----------------------------------------------------------------------------
// Model resolution (same as before, hoisted)
// ----------------------------------------------------------------------------

function resolveModel(requested: string | undefined, modelRegistry: ModelRegistry): string | undefined {
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
		// Test mocks may not implement getAvailable; fall through to undefined
		// so the subprocess uses OMP's own default-model resolution path.
	}
	return undefined;
}

// ----------------------------------------------------------------------------
// Result mapping helpers
// ----------------------------------------------------------------------------

function mapWorkerOutput(
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

function mapExecutionError(name: string, role: string, error: unknown, model?: string): MoaWorkerResult {
	const message = error instanceof Error ? error.message : String(error);
	return { name, role, ok: false, output: "", stderr: message, exitCode: null, model };
}

// ----------------------------------------------------------------------------
// Discovery stage
// ----------------------------------------------------------------------------

async function runDiscovery(
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
		const result = await spawnMoaWorker({
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

// ----------------------------------------------------------------------------
// Ask user stage
// ----------------------------------------------------------------------------

async function runAskUser(
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

function createNoopUI(): ExtensionUIContext {
	const noop = async (): Promise<string | undefined> => undefined;
	return {
		select: noop,
		input: noop,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorking: () => {},
		setEditorText: () => {},
		pasteEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		setCustomEditor: () => {},
		// Minimal shape — call sites that use more will error loudly
		// if hasUI=false so this noop is never reached.
	} as unknown as ExtensionUIContext;
}

// ----------------------------------------------------------------------------
// Rewrite stage
// ----------------------------------------------------------------------------

async function runRewrite(
	tco: TaskContextObject,
	plan: MoaPlan,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
): Promise<{ result: MoaWorkerResult | undefined; workers: MoaPlanWorker[] }> {
	if (!planOptions.settings.rewriteEnabled) {
		return { result: undefined, workers: plan.workers };
	}
	const tcoBlock = renderTcoForPrompt(tco, { maxBytes: planOptions.settings.tcoInjectMaxBytes });
	const systemPrompt = prompt.render(rewritePromptTemplate, {
		task: planOptions.task,
		tco_block: tcoBlock,
	});
	// Rewrite reuses the synthesis model (strong model good at structured
	// generation). User can override via discoveryModel too if they want
	// to be deliberate about it.
	const resolvedModel = resolveModel(planOptions.settings.synthesisModel, options.modelRegistry);
	const workerName = "rewrite";
	const workerRole = "Generate role-specific worker prompts from TCO";
	try {
		const result = await spawnMoaWorker({
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

/**
 * Parse the rewrite LLM's output. Expected format:
 *   ## divergent
 *   <prompt text>
 *   ## grounded
 *   <prompt text>
 *   ## critical
 *   <prompt text>
 *
 * Returns the parsed workers if all 3 names are present; otherwise null so
 * the caller can fall back to the original plan.workers.
 */
function parseRewriteOutput(raw: string, fallback: MoaPlanWorker[]): MoaPlanWorker[] | null {
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

// ----------------------------------------------------------------------------
// Worker / synthesis stages
// ----------------------------------------------------------------------------

/**
 * Build the round-context block prepended to each worker's system prompt.
 *
 * Multi-round design (docs/moa-multi-round-design.md §7): workers behave
 * differently per round.
 *   - Round 1 (discovery): emit ONLY `## open_questions`. No plan, no
 *     prose复述 — go straight to the questions section.
 *   - Round 2+ (planning): the user has answered. Emit ONLY `## plan`.
 *     No new `## open_questions`.
 *   - Single-round (maxRounds=0): treated as planning with no prior
 *     answers. Workers emit best-effort plan with assumptions.
 *
 * The block is prepended to the system prompt so it is the strongest
 * signal the worker sees, overriding the generic hard rules in
 * `prompts/worker.md` (which assume a single-round, plan-first world).
 */
function buildRoundContextBlock(
	roundNumber: number,
	phase: "discovery" | "planning",
	previousAnswersText: string,
): string {
	if (phase === "discovery") {
		return [
			`## Round ${roundNumber} context: DISCOVERY (questions only)`,
			``,
			`**STOP. Read this before producing output.**`,
			``,
			`This is round ${roundNumber} of a multi-round MoA run. In this round you must:`,
			``,
			`1. **Output ONLY \`## open_questions\`** (and \`## assumptions\` if needed).`,
			`2. **DO NOT output a \`## plan\` section.** The orchestrator discards it.`,
			`3. **DO NOT write prose复述 / "step 1 复述理解".** Go straight to the questions section.`,
			`4. Each \`## open_questions\` item must include \`question\`, \`context\`, and \`suggested_default\` fields.`,
			`5. The orchestrator will dedupe questions across workers, ask the user, then re-spawn you in the next round (planning) with the answers in your context.`,
			``,
			`Be specific. Generic "what do you want" / "请确认" / "could you clarify" questions are auto-merged and counted as 1 question.`,
		].join("\n");
	}
	return [
		`## Round ${roundNumber} context: PLANNING (plan only)`,
		``,
		`**STOP. Read this before producing output.**`,
		``,
		`This is round ${roundNumber} of a multi-round MoA run. The user has answered your questions from the previous round.`,
		``,
		previousAnswersText
			? [
					`**The user's answers to your questions**:`,
					``,
					previousAnswersText,
					``,
				].join("\n")
			: `_No prior round answers (this is a single-round / no-Q&A run). State your assumptions in \`## assumptions\`._`,
		``,
		`In this round you must:`,
		``,
		`1. **Output ONLY \`## plan\`** (substantive, ≥ 200 chars).`,
		`2. **DO NOT output a new \`## open_questions\` section.** The Q&A loop is closed.`,
		`3. **Reference the user's answers** (above) directly in your plan. If the user did not answer, state which assumptions you made.`,
		`4. You MAY output \`## assumptions\` for things you had to decide that the user did not specify.`,
	].join("\n");
}

/**
 * Format TCO.known_inputs entries (filtered to user-sourced) as a
 * readable bullet list for injection into the planning-round prompt.
 */
function formatPreviousAnswers(tco: TaskContextObject): string {
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
	_planOptions: ResolvedPlanOptions, // reserved for per-worker timeouts / retry (PR2)
	options: ExecutePlanOptions,
	tcoBlock: string,
	roundNumber: number,
	phase: "discovery" | "planning",
	previousAnswersText: string,
): Promise<MoaWorkerResult> {
	const resolvedModel = resolveModel(worker.model, options.modelRegistry);
	const tcoPlusWorker = prependTco(worker.prompt, tcoBlock);
	const roundContext = buildRoundContextBlock(roundNumber, phase, previousAnswersText);
	const promptText = `${roundContext}\n\n---\n\n${tcoPlusWorker}`;
	try {
		const result = await spawnMoaWorker({
			cwd: options.cwd,
			systemPrompt: promptText,
			task: plan.task,
			model: resolvedModel,
			thinkingLevel: worker.thinking,
			tools: worker.tools === "all" ? "all" : [...worker.tools],
			signal: options.signal,
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

async function runSynthesis(
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
		const result = await spawnMoaWorker({
			cwd: options.cwd,
			systemPrompt: finalPrompt,
			task: plan.task,
			model: resolvedSynthesisModel,
			thinkingLevel: plan.synthesisThinking,
			tools: "none",
			signal: options.signal,
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

// ----------------------------------------------------------------------------
// Top-level executor
// ----------------------------------------------------------------------------

/**
 * Collect the top-N unique open_questions across surviving workers for
 * the per-round ask. Dedup is fuzzy (lowercased, whitespace-stripped) so
 * "How big is the team?" and "how big is the team" collapse. Workers that
 * already had their question asked+answered in earlier rounds are filtered
 * out via `previousQuestions`.
 */
function collectOpenQuestions(
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

/** Parse bullet items in an `## open_questions` section body. */
function parseBulletQuestions(text: string): ParsedBulletQuestion[] {
	const out: ParsedBulletQuestion[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
		if (!m) continue;
		const body = m[1]!.trim();
		if (!body) continue;
		// Tolerate "Question — context" or "Question: context" splits
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

function hasAnyOpenQuestions(worker: MoaWorkerResult, schema: MoaOutputSchema): boolean {
	return hasOpenQuestions(worker, schema);
}

function allWorkersComplete(workers: ReadonlyArray<MoaWorkerResult>, schema: MoaOutputSchema): boolean {
	if (workers.length === 0) return false;
	return workers.every(w => (w.qualityScore ?? 0) >= 80 && !hasAnyOpenQuestions(w, schema));
}

function buildRoundTrace(
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

function appendAskSummary(
	target: MoaAskUserSummary[],
	asked: number,
	answered: number,
	assumed: number,
	timedOut: number,
): void {
	target.push({ asked, answered, assumed, timedOut, enabled: true });
}

function pickConvergenceSignal(
	allDropped: boolean,
	userStopped: boolean,
	atMaxRound: boolean,
	allComplete: boolean,
	noNewQuestions: boolean,
): MoaConvergenceSignal {
	if (allDropped) return "max_rounds";
	if (userStopped) return "user_stop";
	// `all_complete` takes priority over `max_rounds`: a clean convergence
	// (e.g. a single-round TUI run that finishes well) is more informative
	// than a generic "we ran out of budget".
	if (allComplete) return "all_complete";
	if (atMaxRound) return "max_rounds";
	if (noNewQuestions) return "no_new_questions";
	return null;
}

export async function executePlan(plan: MoaPlan, options: ExecutePlanOptions): Promise<MoaExecutionResult> {
	const planOptions = resolvePlanOptions(plan, options);
	// Hard constraint: gateway/cron/batch (hasUI=false) get the single-round
	// path. PR2 multi-round is TUI-only. PR1's design doc D1: gateway forces 0.
	const effectiveMaxRounds = planOptions.hasUI ? planOptions.settings.maxRounds : 0;

	// Stage 1: discovery → TCO + output_schema
	const { result: discoveryResult, tco, outputSchema } = await runDiscovery(planOptions, options);

	// Stage 2: ask user (TUI) or fall back to assumptions
	const askSummary = await runAskUser(tco, planOptions, options);

	// Stage 3: rewrite (optional) → updated worker prompts
	let tcoBlock = renderTcoForPrompt(tco, { maxBytes: planOptions.settings.tcoInjectMaxBytes });
	const { result: rewriteResult, workers: rewrittenWorkers } = await runRewrite(tco, plan, planOptions, options);
	const baseWorkers = rewrittenWorkers.length > 0 ? rewrittenWorkers : plan.workers;

	// Stage 4: multi-round loop (or single-round fallback)
	const rounds: MoaRoundTrace[] = [];
	const askRoundSummaries: MoaAskUserSummary[] = [];
	const allWorkerInvocations: MoaWorkerResult[] = [];
	const currentTco = tco;
	let lastRoundSurviving: MoaWorkerResult[] = [];
	let userStopped = false;

	if (effectiveMaxRounds === 0) {
		// Single-round path (gateway / cron / batch). All work goes into
		// round 1 for archive purposes; no per-round ask.
		// Phase = planning (no discovery round precedes); no prior answers
		// to inject since the user never gets asked.
		const roundStartedAt = new Date().toISOString();
		const { workers: roundWorkers, durations } = await runWorkerFanout(
			baseWorkers,
			plan,
			planOptions,
			options,
			tcoBlock,
			1,
			"planning",
			"",
		);
		const parsed = roundWorkers.map(w =>
			applyWorkerParsing(w, outputSchema, { minScore: planOptions.settings.qualityMinScore }),
		);
		allWorkerInvocations.push(...parsed);
		lastRoundSurviving = parsed.filter(w => !w.qualityDropped);
		// Single-round doesn't have a "max rounds" pressure — derive signal
		// from real conditions so a clean single-round run is reported as
		// `all_complete` (or `no_new_questions`) rather than `max_rounds`.
		const signal = pickConvergenceSignal(
			lastRoundSurviving.length === 0,
			false,
			false,
			allWorkersComplete(lastRoundSurviving, outputSchema),
			false,
		);
		const roundEndedAt = new Date().toISOString();
		rounds.push(buildRoundTrace(1, parsed, durations, [], [], signal, roundStartedAt, roundEndedAt));
	} else {
		// Multi-round path (TUI). Re-spawn all 3 workers each round per D3.
		for (let round = 1; round <= effectiveMaxRounds; round++) {
			const roundStartedAt = new Date().toISOString();
			// Round 1 = discovery (only emit ## open_questions). Round 2+
			// = planning (user has answered; only emit ## plan). The
			// previous-answers block surfaces the user's Q&A history so
			// the worker can reference it instead of re-asking.
			const phase: "discovery" | "planning" = round === 1 ? "discovery" : "planning";
			const previousAnswersText = phase === "planning" ? formatPreviousAnswers(currentTco) : "";
			const { workers: roundWorkers, durations } = await runWorkerFanout(
				baseWorkers,
				plan,
				planOptions,
				options,
				tcoBlock,
				round,
				phase,
				previousAnswersText,
			);
			const parsed = roundWorkers.map(w =>
				applyWorkerParsing(w, outputSchema, { minScore: planOptions.settings.qualityMinScore }),
			);
			allWorkerInvocations.push(...parsed);

			const surviving = parsed.filter(w => !w.qualityDropped);
			lastRoundSurviving = surviving;

			const allDropped = surviving.length === 0;
			const atMaxRound = round >= effectiveMaxRounds;
			const allComplete = !allDropped && allWorkersComplete(surviving, outputSchema);

			// Collect questions for the per-round ask.
			const questions =
				!allDropped && !atMaxRound
					? collectOpenQuestions(surviving, outputSchema, planOptions.settings.maxQuestionsPerRound)
					: [];
			const noNew = questions.length === 0;

			let signal = pickConvergenceSignal(allDropped, userStopped, atMaxRound, allComplete, noNew);
			const converged = signal !== null;

			// Per-round ask (only if not converged and we have questions).
			let questionsAsked: MoaRoundQuestion[] = [];
			let questionsSkipped: Array<{ question: string; inferredFrom: string }> = [];
			if (!converged && questions.length > 0) {
				const askCtx: AskUserContext = {
					ui: options.ui ?? createNoopUI(),
					hasUI: planOptions.hasUI,
				};
				const askResult = await askQuestionsList(questions, askCtx, {
					timeoutMs: planOptions.settings.askTimeoutMs,
					enabled: planOptions.settings.askEnabled,
				});

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

				// Re-render TCO block with the new answers / assumptions so
				// the next round's worker prompt injects the fresh context.
				tcoBlock = renderTcoForPrompt(currentTco, {
					maxBytes: planOptions.settings.tcoInjectMaxBytes,
				});
			}

			// Recompute convergence after the ask (user may have hit STOP).
			if (userStopped) {
				signal = "user_stop";
			} else if (!converged && questions.length > 0 && atMaxRound) {
				signal = "max_rounds";
			}

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

	// Stage 5: synthesis. Use the last round's surviving workers (or fall
	// back to all-ok invocations if everything was dropped). If the last
	// round dropped everyone, synthesis runs with a "no surviving worker"
	// preamble so the user sees a clear failure rather than silent skip.
	const survivingForSynthesis =
		lastRoundSurviving.length > 0 ? lastRoundSurviving : allWorkerInvocations.filter(w => w.ok && !w.qualityDropped);
	const synthesis = await runSynthesis(plan, survivingForSynthesis, planOptions, options, tcoBlock);

	return {
		plan,
		tco,
		askSummary,
		discovery: discoveryResult,
		rewrite: rewriteResult,
		workers: allWorkerInvocations,
		synthesis,
		outputSchema,
		rounds,
		askRoundSummaries,
	};
}

async function runWorkerFanout(
	workers: ReadonlyArray<MoaPlanWorker>,
	plan: MoaPlan,
	planOptions: ResolvedPlanOptions,
	options: ExecutePlanOptions,
	tcoBlock: string,
	roundNumber: number,
	phase: "discovery" | "planning",
	previousAnswersText: string,
): Promise<{ workers: MoaWorkerResult[]; durations: Map<string, number> }> {
	const startedAt = new Map<string, number>();
	const settled = await Promise.all(
		workers.map(async worker => {
			startedAt.set(worker.name, Date.now());
			const result = await runWorker(worker, plan, planOptions, options, tcoBlock, roundNumber, phase, previousAnswersText);
			return result;
		}),
	);
	const durations = new Map<string, number>();
	for (const w of settled) {
		const start = startedAt.get(w.name) ?? Date.now();
		durations.set(w.name, Math.max(0, Date.now() - start));
	}
	return { workers: settled, durations };
}
