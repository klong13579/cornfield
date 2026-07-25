#!/usr/bin/env bun
/**
 * Real-scenario probe: C2「对比一下 workbuddy 和 openclaw」via executePlan (latest source).
 * Auto-answers Ask (select → 1st option; freeform → short defaults).
 *
 * Usage: bun tmp/moa-c2-probe.ts
 */
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executePlan } from "../packages/moa-extension/src/executor";
import { loadMoaConfigOverrides } from "../packages/moa-extension/src/moa-config";
import { buildPlan } from "../packages/moa-extension/src/planner";
import { resolveResearchMode } from "../packages/moa-extension/src/research-mode";
import { resolveSettings } from "../packages/moa-extension/src/settings";
import { createStageRunDir, writeStageArtifacts } from "../packages/moa-extension/src/stage-artifacts";
import { createStageCliUI, type StageCliIo } from "../packages/moa-extension/src/stage-cli-ui";
import { formatTimingSummary } from "../packages/moa-extension/src/timing";

const TASK = "对比一下 workbuddy 和 openclaw";
const CASE_ID = "C2";

function log(msg: string): void {
	process.stderr.write(`${msg}\n`);
}

/** Prefer first select option (grill recommended); freeform → short defaults. */
function autoAnswerIo(): StageCliIo {
	let pendingSelect = false;
	return {
		write(text: string) {
			process.stderr.write(text);
			if (/\n\s*1\)/.test(text) || text.includes("  1)")) pendingSelect = true;
		},
		async readLine() {
			if (pendingSelect) {
				pendingSelect = false;
				log("[auto] select → 1");
				return "1";
			}
			log("[auto] freeform → 按推荐默认");
			return "按推荐默认";
		},
	};
}

async function main(): Promise<number> {
	const cwd = process.cwd();
	const outRoot = path.join(cwd, "tmp/moa-c2-probe");
	const runDir = createStageRunDir(outRoot);
	await Bun.write(path.join(runDir, ".keep"), "");
	log(`case=${CASE_ID} task=${JSON.stringify(TASK)}`);
	log(`artifacts → ${runDir}`);

	const configOverrides = (await loadMoaConfigOverrides(cwd)).overrides;
	const moaSettings = resolveSettings(configOverrides);
	const effectiveResearch = resolveResearchMode(TASK, moaSettings.researchMode);
	log(
		`settings: researchMode=${moaSettings.researchMode}→${effectiveResearch} researchModel=${moaSettings.researchModel ?? "(synthesis)"} grillMax=${moaSettings.grillMaxQuestions} mode=${moaSettings.workerExecutionMode}`,
	);

	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	// Respect ~/.omp/agent/config.yml (e.g. selfEvolution.enabled=false).
	const settings = await Settings.init({ cwd });
	const ui = createStageCliUI(autoAnswerIo());

	const wall0 = Date.now();
	const result = await executePlan(buildPlan(TASK, moaSettings), {
		cwd,
		authStorage,
		modelRegistry,
		settings,
		moaSettings,
		hasUI: true,
		ui,
	});
	const wallMs = Date.now() - wall0;

	const timings = result.timings ?? {};
	const surviving = result.workers.filter(w => w.ok && !w.qualityDropped);
	const ok = Boolean(result.synthesis?.ok) && surviving.length > 0;
	log("\n" + formatTimingSummary({ ...timings, total: timings.total ?? wallMs }));
	log(`ok=${ok} workers=${result.workers.length} surviving=${surviving.length}`);
	log(`researchMode=${result.researchMode ?? ""} synthesisOk=${result.synthesis?.ok}`);

	const tco = result.tco;
	const pack = tco?.research_pack;
	const issues: string[] = [];

	if ((result.researchMode ?? effectiveResearch) === "none") {
		issues.push("P0: researchMode resolved to none for a compare task");
	}
	if (!pack) {
		issues.push("P0: no research_pack after Research stage");
	} else {
		if (pack.sources.length === 0) issues.push("P1: research_pack.sources empty");
		if (pack.parse_source === "salvage") issues.push("P1: research_pack salvaged (parse failed / interrupted)");
		log(
			`research_pack: sources=${pack.sources.length} repo_facts=${pack.repo_facts.length} gaps=${pack.gaps.length} parse=${pack.parse_source ?? "?"}`,
		);
	}

	const intent = tco?.task_intent;
	log(`task_intent=${intent ?? "(missing)"}`);
	if (intent && intent !== "compare") {
		issues.push(`P1: expected task_intent=compare, got ${intent}`);
	}

	const defAsk = (tco?.missing_inputs ?? []).filter(m =>
		/是什么|分别是什么|具体是哪个|指什么|how is .+ defined/i.test(m.question),
	);
	if (defAsk.length > 0) {
		issues.push(`P0: definition-style missing_inputs still present: ${defAsk.map(m => m.key).join(", ")}`);
	}

	const workersOk = result.workers.filter(w => w.ok).length;
	const workersDropped = result.workers.filter(w => w.qualityDropped).length;
	log(`workers ok=${workersOk}/${result.workers.length} qualityDropped=${workersDropped}`);
	if (workersOk === 0) issues.push("P0: zero workers ok");
	if (workersDropped === result.workers.length && result.workers.length > 0) {
		issues.push("P0: all workers quality-dropped");
	}
	if (!result.synthesis?.ok) {
		issues.push(`P0: synthesis failed: ${(result.synthesis?.stderr || "").slice(0, 200)}`);
	}

	const researchMs = timings.research ?? 0;
	if (researchMs > 600_000) {
		issues.push(`P1: research took ${Math.round(researchMs / 1000)}s (>10min)`);
	} else if (researchMs > 300_000) {
		issues.push(`P2: research took ${Math.round(researchMs / 1000)}s (>5min)`);
	}

	const inputCollectMs = timings.input_collect ?? 0;
	if (inputCollectMs > 180_000) {
		issues.push(`P2: input_collect took ${Math.round(inputCollectMs / 1000)}s`);
	}

	const report = {
		caseId: CASE_ID,
		task: TASK,
		runDir,
		wallMs,
		ok,
		timings,
		task_intent: intent,
		researchEffective: result.researchMode ?? effectiveResearch,
		researchModel: moaSettings.researchModel,
		research_pack: pack
			? {
					sources: pack.sources.length,
					repo_facts: pack.repo_facts.length,
					gaps: pack.gaps.length,
					parse_source: pack.parse_source,
					mode: pack.mode,
				}
			: null,
		ask: result.askSummary,
		workers: result.workers.map(w => ({
			name: w.name,
			ok: w.ok,
			model: w.model,
			qualityScore: w.qualityScore,
			qualityDropped: w.qualityDropped,
			durationMs: w.durationMs,
			stopReason: w.stopReason,
			timedOut: w.timedOut,
			idleTimedOut: w.idleTimedOut,
			toolBudgetExceeded: w.toolBudgetExceeded,
			usage: w.usage,
			hasToolTrace: Boolean(w.toolTraceText?.trim()),
			hasStreamPreview: Boolean(w.streamPreview?.trim()),
			stderr: (w.stderr || "").slice(0, 240),
		})),
		synthesisOk: result.synthesis?.ok,
		issues,
	};

	await Bun.write(path.join(runDir, "probe-report.json"), JSON.stringify(report, null, 2) + "\n");
	await writeStageArtifacts(runDir, {
		meta: {
			stage: "all",
			task: TASK,
			ok,
			startedAt: new Date(wall0).toISOString(),
			endedAt: new Date().toISOString(),
			durations: timings,
			error: ok ? undefined : result.synthesis?.stderr,
			researchPackSource: pack?.parse_source,
		},
		tco: tco ?? undefined,
		workerResults: result.workers,
		surviving,
		synthesis: result.synthesis,
		ask: result.askSummary,
	});

	log("\n=== ISSUES ===");
	if (issues.length === 0) log("(none flagged by heuristics)");
	else for (const i of issues) log(`- ${i}`);
	log(`\nreport → ${path.join(runDir, "probe-report.json")}`);
	return ok && issues.filter(i => i.startsWith("P0:")).length === 0 ? 0 : 1;
}

main().then(code => process.exit(code));
