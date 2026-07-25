#!/usr/bin/env bun
/**
 * P0 manual gate smoke (scripted):
 * Discovery → Ask(auto-skip) → render synthesis prompt the same way as production.
 *
 * Usage: bun tmp/moa-p0-smoke.ts
 */
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { prompt } from "@oh-my-pi/pi-utils";
import { loadMoaConfigOverrides } from "../packages/moa-extension/src/moa-config";
import synthesisPromptTemplate from "../packages/moa-extension/src/prompts/synthesis.md" with { type: "text" };
import { resolveSettings } from "../packages/moa-extension/src/settings";
import { createStageRunDir, writeStageArtifacts } from "../packages/moa-extension/src/stage-artifacts";
import { createStageCliUI, type StageCliIo } from "../packages/moa-extension/src/stage-cli-ui";
import { runAskStage, runDiscoveryStage } from "../packages/moa-extension/src/stages";
import { formatTcoValue, renderTcoForPrompt } from "../packages/moa-extension/src/tco";

const TASK = "设计一个为期 2 周的校园招聘流程，预算未定，目标城市未定";

function log(msg: string): void {
	process.stderr.write(`${msg}\n`);
}

function autoSkipIo(): StageCliIo {
	return {
		write(text: string) {
			process.stderr.write(text);
		},
		async readLine() {
			// Empty ⇒ skip for askMissingInputs and for answer/skip/stop select.
			return "";
		},
	};
}

/** Same assumptions_block construction as runSynthesisCore (keep in sync). */
function renderAssumptionsBlock(
	assumptions: Array<{ key: string; value: unknown; reason: string; note?: string }>,
): string | undefined {
	if (assumptions.length === 0) return undefined;
	return assumptions
		.map(assumption => {
			const value = formatTcoValue(assumption.value);
			const note = assumption.note ? `; note=${assumption.note}` : "";
			return `- \`${assumption.key}\` = ${value} (reason=${assumption.reason}${note})`;
		})
		.join("\n");
}

async function main(): Promise<number> {
	const cwd = process.cwd();
	const runDir = createStageRunDir(path.join(cwd, "tmp/moa-p0-smoke"));
	await Bun.write(path.join(runDir, ".keep"), "");
	log(`artifacts → ${runDir}`);

	const configOverrides = (await loadMoaConfigOverrides(cwd)).overrides;
	const moaSettings = resolveSettings({
		...configOverrides,
		rewriteEnabled: false,
		quality: { judge: { enabled: false } },
		askEnabled: true,
	});

	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	// Respect ~/.omp/agent/config.yml (e.g. selfEvolution.enabled=false).
	const settings = await Settings.init({ cwd });
	const ui = createStageCliUI(autoSkipIo());
	const executeOptions = {
		cwd,
		authStorage,
		modelRegistry,
		settings,
		moaSettings,
		hasUI: true,
		ui,
	};
	const stageCtx = { task: TASK, settings: moaSettings };

	log("→ discovery…");
	const discovery = await runDiscoveryStage(stageCtx, executeOptions);
	let tco = discovery.tco;
	log(`✓ discovery missing_inputs=${tco.missing_inputs.length} known=${tco.known_inputs.length}`);
	if (tco.missing_inputs.length === 0) {
		log("✗ expected Discovery to surface at least one missing input to skip");
		return 1;
	}

	log("→ ask (auto-skip)…");
	const ask = await runAskStage(tco, stageCtx, executeOptions);
	tco = ask.tco;
	log(`✓ ask answered=${ask.askSummary.answered} assumed=${ask.askSummary.assumed}`);
	if (ask.askSummary.assumed < 1 || tco.assumptions.length < 1) {
		log("✗ expected at least one skipped assumption after Ask");
		return 1;
	}

	const tcoBlock = renderTcoForPrompt(tco, { maxBytes: moaSettings.tcoInjectMaxBytes });
	const assumptionsBlock = renderAssumptionsBlock(tco.assumptions);
	const systemPrompt = prompt.render(synthesisPromptTemplate, {
		task: TASK,
		tco_block: tcoBlock || undefined,
		worker_outputs: "## divergent\n(fake surviving worker for prompt contract check)",
		assumptions_block: assumptionsBlock,
	});

	const assumptionKeys = tco.assumptions.map(a => a.key);
	const hasHeader = systemPrompt.includes("Assumptions made during the run");
	const hasKey = assumptionKeys.some(k => systemPrompt.includes(k));
	const hasReason = systemPrompt.includes("user_skipped");
	const tcoMentions = systemPrompt.split("Task Context (from discovery stage)").length - 1;
	const ok = hasHeader && hasKey && hasReason && tcoMentions === 1;

	await Bun.write(path.join(runDir, "synthesis-prompt-check.md"), systemPrompt);
	await writeStageArtifacts(runDir, {
		meta: {
			stage: "ask",
			task: TASK,
			ok,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			durations: { discovery: discovery.durationMs, ask: ask.durationMs },
			error: ok
				? undefined
				: `prompt check failed header=${hasHeader} key=${hasKey} reason=${hasReason} tcoMentions=${tcoMentions}`,
		},
		tco,
		outputSchema: discovery.outputSchema,
		ask: ask.askSummary,
		discovery: discovery.result,
	});

	log(`assumptions: ${JSON.stringify(tco.assumptions, null, 2)}`);
	log(`synthesis prompt has Assumptions header: ${hasHeader}`);
	log(`synthesis prompt contains assumption key: ${hasKey} (${assumptionKeys.join(", ")})`);
	log(`synthesis prompt contains user_skipped: ${hasReason}`);
	log(`tco_block injection count: ${tcoMentions} (want 1)`);

	if (!ok) {
		log("✗ P0 smoke FAILED");
		return 1;
	}
	log(`✓ P0 smoke PASSED artifacts=${runDir}`);
	return 0;
}

process.exit(await main());
