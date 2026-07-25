#!/usr/bin/env bun
/**
 * Multi-case real-scenario probe from fixtures/real-scenarios.md.
 * Auto-answers Ask (select → 1st; freeform → short default).
 *
 * Usage:
 *   bun tmp/moa-real-probe.ts              # default: C1 C3 L2
 *   bun tmp/moa-real-probe.ts C1 C3 D6
 *   bun tmp/moa-real-probe.ts --list
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

interface CaseDef {
	id: string;
	task: string;
	note?: string;
}

const CASES: Record<string, CaseDef> = {
	C1: { id: "C1", task: "hermes agent 和 workbuddy 的区别是什么？", note: "compare + research required" },
	C2: { id: "C2", task: "对比一下 workbuddy 和 openclaw", note: "compare (prior baseline)" },
	C3: { id: "C3", task: "对比 Cursor 与 Claude Code 的会话压缩策略", note: "compare compression" },
	C4: { id: "C4", task: "比起 OpenClaw，omp 的收益是什么", note: "compare omp vs openclaw" },
	D2: { id: "D2", task: "设计一个为期 2 周的校园招聘流程，预算未定，目标城市未定", note: "design + ask" },
	D6: { id: "D6", task: "为 omp 设计长会话上下文膨胀治理方案，给出可选架构与取舍", note: "design + research encouraged" },
	L2: { id: "L2", task: "写一个最小 GET /health 实现，仅含返回 JSON", note: "local-impl, research none" },
};

const DEFAULT_IDS = ["C1", "C3", "L2"];

function log(msg: string): void {
	process.stderr.write(`${msg}\n`);
}

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

async function runOne(caseDef: CaseDef): Promise<{ ok: boolean; runDir: string; wallMs: number }> {
	const cwd = process.cwd();
	const outRoot = path.join(cwd, "tmp/moa-real-probe", caseDef.id);
	const runDir = createStageRunDir(outRoot);
	await Bun.write(path.join(runDir, ".keep"), "");
	log(`\n======== case=${caseDef.id} ========`);
	log(`task=${JSON.stringify(caseDef.task)}`);
	log(`artifacts → ${runDir}`);

	const configOverrides = (await loadMoaConfigOverrides(cwd)).overrides;
	const moaSettings = resolveSettings(configOverrides);
	const effectiveResearch = resolveResearchMode(caseDef.task, moaSettings.researchMode);
	log(
		`settings: researchMode=${moaSettings.researchMode}→${effectiveResearch} researchModel=${moaSettings.researchModel ?? "(synthesis)"} grillMax=${moaSettings.grillMaxQuestions} mode=${moaSettings.workerExecutionMode}`,
	);

	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	// Load real ~/.omp/agent/config.yml (+ project config) — do NOT use
	// Settings.isolated({}), which skips disk and keeps schema defaults
	// (e.g. selfEvolution.enabled=true) and causes false-positive evolution DB writes.
	const settings = await Settings.init({ cwd });
	log(`coding-agent settings: selfEvolution.enabled=${settings.get("selfEvolution.enabled")}`);
	const ui = createStageCliUI(autoAnswerIo());

	const wall0 = Date.now();
	const result = await executePlan(buildPlan(caseDef.task, moaSettings), {
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
	const pack = result.tco?.research_pack;
	const ok = Boolean(result.synthesis?.ok) && surviving.length >= 1;

	const report = {
		caseId: caseDef.id,
		task: caseDef.task,
		note: caseDef.note,
		runDir,
		wallMs,
		ok,
		timings,
		researchEffective: effectiveResearch,
		research_pack: pack
			? {
					sources: pack.sources.length,
					repo_facts: pack.repo_facts.length,
					gaps: pack.gaps.length,
					parse_source: pack.parse_source,
					mode: pack.mode,
					urls: pack.sources.map(s => s.url),
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
			usage: w.usage,
			hasToolTrace: Boolean(w.toolTraceText?.trim()),
			hasStreamPreview: Boolean(w.streamPreview?.trim()),
			stderr: (w.stderr || "").slice(0, 240),
		})),
		synthesisOk: result.synthesis?.ok,
		timingSummary: formatTimingSummary(timings),
	};

	await Bun.write(path.join(runDir, "probe-report.json"), `${JSON.stringify(report, null, 2)}\n`);
	await writeStageArtifacts(runDir, {
		meta: {
			stage: "all",
			task: caseDef.task,
			ok,
			startedAt: new Date(wall0).toISOString(),
			endedAt: new Date().toISOString(),
			durations: timings,
			researchPackSource: pack?.parse_source,
		},
		tco: result.tco ?? undefined,
		workerResults: result.workers,
		surviving,
		synthesis: result.synthesis,
		ask: result.askSummary,
	});

	log(`ok=${ok} wall=${(wallMs / 60000).toFixed(1)}m workers=${surviving.length}/${result.workers.length}`);
	log(`report → ${path.join(runDir, "probe-report.json")}`);
	return { ok, runDir, wallMs };
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	if (argv.includes("--list")) {
		for (const c of Object.values(CASES)) log(`${c.id}\t${c.note ?? ""}\t${c.task}`);
		return 0;
	}
	const ids = (argv.length > 0 ? argv : DEFAULT_IDS).map(s => s.toUpperCase());
	const unknown = ids.filter(id => !CASES[id]);
	if (unknown.length > 0) {
		log(`unknown cases: ${unknown.join(", ")}`);
		log(`known: ${Object.keys(CASES).join(", ")}`);
		return 2;
	}

	const summary: Array<{ id: string; ok: boolean; wallMin: string; runDir: string }> = [];
	let failed = 0;
	for (const id of ids) {
		const caseDef = CASES[id]!;
		try {
			const r = await runOne(caseDef);
			summary.push({ id, ok: r.ok, wallMin: (r.wallMs / 60000).toFixed(1), runDir: r.runDir });
			if (!r.ok) failed += 1;
		} catch (err) {
			failed += 1;
			const message = err instanceof Error ? err.message : String(err);
			log(`case=${id} THREW: ${message}`);
			summary.push({ id, ok: false, wallMin: "?", runDir: "" });
		}
	}

	const outPath = path.join(process.cwd(), "tmp/moa-real-probe/summary.json");
	await Bun.write(outPath, `${JSON.stringify({ at: new Date().toISOString(), summary }, null, 2)}\n`);
	log(`\n======== SUMMARY ========`);
	for (const s of summary) log(`${s.id}\tok=${s.ok}\t${s.wallMin}m\t${s.runDir}`);
	log(`summary → ${outPath}`);
	return failed > 0 ? 1 : 0;
}

process.exit(await main());
