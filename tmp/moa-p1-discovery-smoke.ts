#!/usr/bin/env bun
/**
 * P1.3 A-only discovery quality smoke — prints missing_inputs for 2–3 tasks.
 * Usage: bun tmp/moa-p1-discovery-smoke.ts
 */
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMoaConfigOverrides } from "../packages/moa-extension/src/moa-config";
import { resolveSettings } from "../packages/moa-extension/src/settings";
import { runDiscoveryStage } from "../packages/moa-extension/src/stages";

const TASKS = [
	"设计一个为期 2 周的校园招聘流程",
	"给内部知识库做一个检索增强问答方案",
	"规划一次线上发布回滚演练",
];

function log(msg: string): void {
	process.stderr.write(`${msg}\n`);
}

async function main(): Promise<number> {
	const cwd = process.cwd();
	const configOverrides = (await loadMoaConfigOverrides(cwd)).overrides;
	const moaSettings = resolveSettings({
		...configOverrides,
		rewriteEnabled: false,
		quality: { judge: { enabled: false } },
	});
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	// Respect ~/.omp/agent/config.yml (e.g. selfEvolution.enabled=false).
	const settings = await Settings.init({ cwd });
	const executeOptions = {
		cwd,
		authStorage,
		modelRegistry,
		settings,
		moaSettings,
		hasUI: false,
		ui: undefined,
	};

	let ok = true;
	for (const task of TASKS) {
		log(`\n=== ${task} ===`);
		const discovery = await runDiscoveryStage({ task, settings: moaSettings }, executeOptions);
		const missing = discovery.tco.missing_inputs;
		log(`understanding: ${discovery.tco.task_understanding}`);
		log(`missing (${missing.length}):`);
		for (const m of missing) {
			log(`  - [${m.required ? "req" : "opt"}] ${m.key}: ${m.question}`);
			log(`    why: ${m.why_critical}`);
		}
		if (missing.length === 0 || missing.length > 5) {
			log(`✗ unexpected missing_inputs length=${missing.length}`);
			ok = false;
		}
		// Heuristic: questions should look like clarifications (short, focused), not essay prompts.
		for (const m of missing) {
			if (m.question.length > 120) {
				log(`✗ question too open-ended (${m.question.length} chars): ${m.key}`);
				ok = false;
			}
		}
	}
	log(ok ? "\n✓ P1.3 discovery smoke OK" : "\n✗ P1.3 discovery smoke FAILED");
	return ok ? 0 : 1;
}

process.exit(await main());
