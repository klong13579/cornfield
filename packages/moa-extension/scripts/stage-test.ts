#!/usr/bin/env bun
/**
 * MoA stage-test harness — real LLM, optional interactive Ask.
 *
 * Usage:
 *   bun packages/moa-extension/scripts/stage-test.ts --stage discovery --task "..."
 *   bun packages/moa-extension/scripts/stage-test.ts --stage all --task "..."
 *   bun packages/moa-extension/scripts/stage-test.ts --stage rewrite --from tmp/moa-stage/<id>
 *
 * See docs/plans/2026-07-15-moa-stage-test-design.md
 */
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMoaConfigOverrides } from "../src/moa-config";
import { buildPlan, rebindWorkerPrompts } from "../src/planner";
import { resolveSettings } from "../src/settings";
import {
	createStageRunDir,
	loadStageRun,
	requireArtifacts,
	type StageName,
	writeStageArtifacts,
} from "../src/stage-artifacts";
import { createStageCliUI } from "../src/stage-cli-ui";
import {
	qualityFailedSynthesis,
	runAskStage,
	runDiscoveryStage,
	runRewriteStage,
	runSynthesisStage,
	runWorkersStage,
} from "../src/stages";
import { formatDuration } from "../src/timing";
import { renderTcoForPrompt } from "../src/tco";
import { DEFAULT_OUTPUT_SCHEMA } from "../src/types";

const STAGES = new Set<StageName>(["all", "discovery", "ask", "rewrite", "workers", "synthesis"]);

interface CliArgs {
	stage: StageName;
	task?: string;
	from?: string;
	out: string;
	rounds?: number;
	continueOnFail: boolean;
	help: boolean;
}

function usage(): string {
	return [
		"MoA stage-test harness",
		"",
		"  bun packages/moa-extension/scripts/stage-test.ts \\",
		"    --stage all|discovery|ask|rewrite|workers|synthesis \\",
		"    --task \"...\" \\",
		"    [--from tmp/moa-stage/<id>] \\",
		"    [--out tmp/moa-stage] \\",
		"    [--rounds N] \\",
		"    [--continue-on-fail]",
		"",
		"Artifacts are written under <out>/<timestamp>/.",
	].join("\n");
}

function parseArgs(argv: string[]): CliArgs {
	const out: CliArgs = {
		stage: "all",
		out: path.join(process.cwd(), "tmp/moa-stage"),
		continueOnFail: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`Missing value after ${a}`);
			return v;
		};
		if (a === "--help" || a === "-h") out.help = true;
		else if (a === "--stage") {
			const v = next() as StageName;
			if (!STAGES.has(v)) throw new Error(`Invalid --stage: ${v}`);
			out.stage = v;
		} else if (a === "--task") out.task = next();
		else if (a === "--from") out.from = path.resolve(next());
		else if (a === "--out") out.out = path.resolve(next());
		else if (a === "--rounds") out.rounds = Number(next());
		else if (a === "--continue-on-fail") out.continueOnFail = true;
		else throw new Error(`Unknown argument: ${a}`);
	}
	return out;
}

function log(msg: string): void {
	process.stderr.write(`${msg}\n`);
}

async function main(): Promise<number> {
	let args: CliArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		log(String(err instanceof Error ? err.message : err));
		log(usage());
		return 2;
	}
	if (args.help) {
		log(usage());
		return 0;
	}

	const cwd = process.cwd();
	const runDir = createStageRunDir(args.out);
	await Bun.write(path.join(runDir, ".keep"), "");

	const configOverrides = (await loadMoaConfigOverrides(cwd)).overrides;
	let moaSettings = resolveSettings(configOverrides);
	if (args.rounds !== undefined && Number.isFinite(args.rounds)) {
		moaSettings = { ...moaSettings, maxRounds: Math.max(0, Math.floor(args.rounds)) };
	}

	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated({}, { cwd });
	const ui = createStageCliUI();
	const interactive = args.stage === "ask" || args.stage === "all" || args.stage === "workers";
	const executeOptions = {
		cwd,
		authStorage,
		modelRegistry,
		settings,
		moaSettings,
		ui,
		hasUI: interactive,
	};

	const prior = args.from ? await loadStageRun(args.from) : undefined;
	const resolvedTask = args.task?.trim() || prior?.meta?.task || prior?.plan?.task || "";

	if (!resolvedTask && (args.stage === "discovery" || args.stage === "all")) {
		log("Missing --task (required for discovery/all)");
		return 2;
	}
	if (!resolvedTask) {
		log("Missing --task (or --from with meta.json / plan.json task)");
		return 2;
	}

	const stageCtx = { task: resolvedTask, settings: moaSettings };
	const startedAt = new Date().toISOString();
	const durations: Record<string, number> = {};
	let ok = true;
	let lastError: string | undefined;
	let signal: string | null | undefined;

	const planBase = buildPlan(resolvedTask, moaSettings);
	if (prior?.workers && prior.workers.length > 0) {
		planBase.workers = prior.workers;
	}

	log(`stage-test: stage=${args.stage} out=${runDir}`);
	if (args.from) log(`  from=${args.from}`);

	try {
		let tco = prior?.tco;
		let outputSchema = prior?.outputSchema ?? DEFAULT_OUTPUT_SCHEMA;
		let discovery = prior?.discovery;
		let rewrite = prior?.rewrite;
		let workers = prior?.workers ?? planBase.workers;
		let workerResults = prior?.workerResults;
		let surviving = prior?.surviving;
		let askSummary = prior?.ask;
		let synthesis = prior?.synthesis;
		let tcoBlock = tco
			? renderTcoForPrompt(tco, { maxBytes: moaSettings.tcoInjectMaxBytes })
			: "";
		let rounds = prior?.rounds;
		let dispatchLog = prior?.dispatchLog;

		const runDiscovery = async () => {
			log("→ discovery…");
			const result = await runDiscoveryStage(stageCtx, executeOptions);
			durations.discovery = result.durationMs;
			tco = result.tco;
			outputSchema = result.outputSchema;
			discovery = result.result;
			tcoBlock = renderTcoForPrompt(tco, { maxBytes: moaSettings.tcoInjectMaxBytes });
			log(`✓ discovery ${formatDuration(result.durationMs)}`);
			if (result.result && !result.result.ok) {
				ok = false;
				lastError = result.result.stderr || "discovery failed";
			}
		};

		const runAsk = async () => {
			if (!tco) {
				requireArtifacts(args.from ?? runDir, ["tco.json"]);
				throw new Error("ask requires tco.json (run discovery or pass --from)");
			}
			log("→ ask (interactive)…");
			const result = await runAskStage(tco, stageCtx, { ...executeOptions, hasUI: true });
			durations.ask = result.durationMs;
			tco = result.tco;
			askSummary = result.askSummary;
			tcoBlock = renderTcoForPrompt(tco, { maxBytes: moaSettings.tcoInjectMaxBytes });
			log(
				`✓ ask ${formatDuration(result.durationMs)} (answered=${result.askSummary.answered}, assumed=${result.askSummary.assumed})`,
			);
		};

		const runRewrite = async () => {
			if (!tco) {
				throw new Error("rewrite requires tco (run discovery/ask or pass --from with tco.json)");
			}
			const schemaAware = {
				...planBase,
				workers: rebindWorkerPrompts(planBase.workers, planBase.task, outputSchema),
			};
			log("→ rewrite…");
			const result = await runRewriteStage(tco, schemaAware, stageCtx, executeOptions, outputSchema);
			durations.rewrite = result.durationMs;
			rewrite = result.result;
			workers = result.workers;
			log(`✓ rewrite ${formatDuration(result.durationMs)} (workers=${workers.length})`);
			if (result.result && !result.result.ok && moaSettings.rewriteEnabled) {
				ok = false;
				lastError = result.result.stderr || "rewrite failed (using fallback prompts)";
			}
		};

		const runWorkers = async () => {
			if (!tco) throw new Error("workers requires tco");
			const schemaAware = {
				...planBase,
				workers: rebindWorkerPrompts(workers, planBase.task, outputSchema),
			};
			const baseWorkers = workers.length > 0 ? workers : schemaAware.workers;
			const effectiveMaxRounds = interactive ? moaSettings.maxRounds : 0;
			log(`→ workers (maxRounds=${effectiveMaxRounds})…`);
			const result = await runWorkersStage({
				plan: schemaAware,
				baseWorkers,
				tco,
				outputSchema,
				tcoBlock,
				ctx: stageCtx,
				options: { ...executeOptions, hasUI: interactive },
				effectiveMaxRounds,
				hooks: {
					notify: (msg, type) => ui.notify(msg, type),
				},
			});
			durations.workers = result.durationMs;
			workerResults = result.workers;
			surviving = result.surviving;
			rounds = result.rounds;
			dispatchLog = result.dispatchLog;
			tco = result.tco;
			tcoBlock = result.tcoBlock;
			signal = result.signal;
			log(`✓ workers ${formatDuration(result.durationMs)} signal=${result.signal}`);
			if (result.signal === "quality_failed") {
				ok = false;
				lastError = "all workers quality-failed";
			}
		};

		const runSynthesis = async () => {
			const surv = surviving ?? [];
			if (surv.length === 0) {
				synthesis = qualityFailedSynthesis();
				ok = false;
				lastError = lastError ?? "no surviving workers for synthesis";
				log("✗ synthesis skipped (quality_failed)");
				return;
			}
			const finalPlan = {
				...planBase,
				workers: workers.length > 0 ? workers : planBase.workers,
			};
			log("→ synthesis…");
			const result = await runSynthesisStage(finalPlan, surv, stageCtx, executeOptions, tcoBlock);
			durations.synthesis = result.durationMs;
			synthesis = result.synthesis;
			log(`✓ synthesis ${formatDuration(result.durationMs)}`);
			if (!result.synthesis.ok) {
				ok = false;
				lastError = result.synthesis.stderr || "synthesis failed";
			}
		};

		const stagesToRun: Array<() => Promise<void>> = [];
		if (args.stage === "all") {
			stagesToRun.push(runDiscovery, runAsk, runRewrite, runWorkers, runSynthesis);
		} else if (args.stage === "discovery") {
			stagesToRun.push(runDiscovery);
		} else if (args.stage === "ask") {
			if (!tco && args.from) requireArtifacts(args.from, ["tco.json"]);
			if (!tco) await runDiscovery();
			stagesToRun.push(runAsk);
		} else if (args.stage === "rewrite") {
			if (!tco) {
				if (args.from) requireArtifacts(args.from, ["tco.json"]);
				else throw new Error("rewrite needs --from with tco.json or run discovery first via --stage all");
			}
			stagesToRun.push(runRewrite);
		} else if (args.stage === "workers") {
			if (!tco) {
				if (args.from) requireArtifacts(args.from, ["tco.json"]);
				else throw new Error("workers needs --from with tco.json");
			}
			stagesToRun.push(runWorkers);
		} else if (args.stage === "synthesis") {
			if (!surviving || surviving.length === 0) {
				if (args.from) requireArtifacts(args.from, ["workers.json"]);
				else throw new Error("synthesis needs --from with workers.json");
			}
			stagesToRun.push(runSynthesis);
		}

		for (const step of stagesToRun) {
			await step();
			if (!ok && !args.continueOnFail && args.stage === "all") break;
		}

		await writeStageArtifacts(runDir, {
			meta: {
				stage: args.stage,
				task: resolvedTask,
				ok,
				startedAt,
				endedAt: new Date().toISOString(),
				durations,
				error: lastError,
				signal,
			},
			tco,
			outputSchema,
			ask: askSummary,
			discovery,
			rewrite,
			workers,
			plan: {
				task: resolvedTask,
				workers,
				synthesisModel: planBase.synthesisModel,
				synthesisThinking: planBase.synthesisThinking,
			},
			workerResults,
			surviving,
			dispatchLog,
			rounds,
			synthesis,
		});

		log(`done: ok=${ok} artifacts=${runDir}`);
		if (!ok) return signal === "quality_failed" ? 1 : 1;
		return 0;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`fatal: ${message}`);
		await writeStageArtifacts(runDir, {
			meta: {
				stage: args.stage,
				task: resolvedTask,
				ok: false,
				startedAt,
				endedAt: new Date().toISOString(),
				durations,
				error: message,
			},
		}).catch(() => {});
		return message.includes("Missing") || message.includes("requires") || message.includes("Invalid") ? 2 : 1;
	}
}

const code = await main();
process.exit(code);
