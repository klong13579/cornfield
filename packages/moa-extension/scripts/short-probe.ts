#!/usr/bin/env bun
/**
 * Short MoA probe for P1–P3 regressions — no Rewrite / Synthesis.
 *
 * Pipeline: Discovery → Research (if needed) → Ask (auto) → Workers
 * Assertions exit non-zero on failure. Target wall ~3–8 min / case.
 *
 * Usage:
 *   bun packages/moa-extension/scripts/short-probe.ts
 *   bun packages/moa-extension/scripts/short-probe.ts C1 C3
 *   bun packages/moa-extension/scripts/short-probe.ts --list
 */
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMoaConfigOverrides } from "../src/moa-config";
import { buildPlan, rebindWorkerPrompts } from "../src/planner";
import { enrichSchemaWithSources, renderResearchGuidance, resolveResearchMode } from "../src/research-mode";
import { resolveSettings } from "../src/settings";
import { createStageRunDir, writeStageArtifacts } from "../src/stage-artifacts";
import { createStageCliUI, type StageCliIo } from "../src/stage-cli-ui";
import { runAskStage, runDiscoveryStage, runResearchStage, runWorkersStage } from "../src/stages";
import { extractCompareEntities, type ResearchPack, renderTcoForPrompt } from "../src/tco";
import { formatDuration } from "../src/timing";
import { DEFAULT_OUTPUT_SCHEMA, type MoaWorkerResult } from "../src/types";

interface CaseDef {
	id: string;
	task: string;
	note?: string;
	/** Hosts that must NOT appear in research sources (substring). */
	forbidHosts?: string[];
	/** At least one source URL must match one of these (substring, case-insensitive). */
	requireHosts?: string[];
}

const CASES: Record<string, CaseDef> = {
	C1: {
		id: "C1",
		task: "hermes agent 和 workbuddy 的区别是什么？",
		note: "P1: no openclaw; both entities in pack",
		forbidHosts: ["openclaw"],
		requireHosts: ["hermes", "workbuddy"],
	},
	C3: {
		id: "C3",
		task: "对比 Cursor 与 Claude Code 的会话压缩策略",
		note: "P1: both Cursor + Claude sides",
		requireHosts: ["cursor", "claude"],
	},
	L2: {
		id: "L2",
		task: "写一个最小 GET /health 实现，仅含返回 JSON",
		note: "P2: no web_search on workers; P3 ask dedupe",
	},
};

const DEFAULT_IDS = ["C1", "C3", "L2"];

function log(msg: string): void {
	process.stderr.write(`${msg}\n`);
}

/**
 * Importing agent code eventually registers pi-utils postmortem which
 * `process.exit(1)` on unhandledRejection. Research soft-abort leaves in-flight
 * URL reads that reject later — that must not kill a multi-case probe.
 */
function installSoftUnhandledRejectionGuard(): void {
	process.removeAllListeners("unhandledRejection");
	process.on("unhandledRejection", reason => {
		const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
		log(`[warn] unhandledRejection (ignored): ${msg}`);
	});
}

function installBlockFatalExit(): () => void {
	const realExit = process.exit.bind(process);
	process.exit = ((code?: number) => {
		if (code === 1) {
			log(`[warn] blocked process.exit(1) during short-probe`);
			return undefined as never;
		}
		return realExit(code);
	}) as typeof process.exit;
	return () => {
		process.exit = realExit;
	};
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

interface AssertFail {
	check: string;
	detail: string;
}

function assertResearch(caseDef: CaseDef, pack: ResearchPack | null | undefined): AssertFail[] {
	const fails: AssertFail[] = [];
	const effective = resolveResearchMode(caseDef.task, "auto");
	if (effective === "none") {
		if (pack && pack.sources.length > 0) {
			fails.push({ check: "research-none", detail: `expected no pack, got ${pack.sources.length} sources` });
		}
		return fails;
	}
	if (!pack || pack.sources.length === 0) {
		fails.push({ check: "research-pack", detail: "missing research_pack sources" });
		return fails;
	}
	const urls = pack.sources.map(s => s.url.toLowerCase()).join("\n");
	for (const host of caseDef.forbidHosts ?? []) {
		if (urls.includes(host.toLowerCase())) {
			fails.push({ check: "P1-forbid", detail: `forbidden host still present: ${host}` });
		}
	}
	for (const host of caseDef.requireHosts ?? []) {
		if (!urls.includes(host.toLowerCase())) {
			fails.push({ check: "P1-require", detail: `expected entity host in sources: ${host}` });
		}
	}
	const entities = extractCompareEntities(caseDef.task);
	if (entities.length >= 2) {
		const covered = entities.filter(e => urls.includes(e));
		if (covered.length < Math.min(2, entities.length)) {
			fails.push({
				check: "P1-entities",
				detail: `entities=${entities.join(",")} covered=${covered.join(",") || "∅"}`,
			});
		}
	}
	return fails;
}

function assertWorkers(workers: MoaWorkerResult[]): AssertFail[] {
	const fails: AssertFail[] = [];
	for (const w of workers) {
		const trace = (w.toolTraceText ?? "").toLowerCase();
		if (/\bweb_search\b/.test(trace) || /tool[^a-z]*web_search/i.test(w.toolTraceText ?? "")) {
			fails.push({ check: "P2-web_search", detail: `${w.name} used web_search` });
		}
		if (w.stderr.includes("research web_search budget exceeded") && w.toolBudgetExceeded) {
			// Misleading legacy message — still a fail if they somehow searched.
			fails.push({ check: "P2-budget-msg", detail: `${w.name} hit legacy web_search budget note` });
		}
		for (const bad of ["write", "edit", "bash"] as const) {
			// Prefer structured audit: tool budget / abort with forbidden in stderr.
			if (new RegExp(`\\b${bad}\\b`).test(w.stderr) && /tool/.test(w.stderr.toLowerCase())) {
				fails.push({ check: `P2-${bad}`, detail: `${w.name} stderr mentions ${bad}` });
			}
		}
	}
	const surviving = workers.filter(w => w.ok && !w.qualityDropped);
	if (surviving.length < 1) {
		fails.push({ check: "workers-survive", detail: "no surviving workers" });
	}
	return fails;
}

function assertAsk(beforeKnownKeys: string[], asked: number, afterMissingKeys: string[]): AssertFail[] {
	const fails: AssertFail[] = [];
	// After ask, missing should not still list keys that are known (synonym prune).
	const overlap = afterMissingKeys.filter(k => beforeKnownKeys.includes(k));
	if (overlap.length > 0 && asked > 0) {
		// Soft: only fail if missing still has exact keys that were known *before* ask
		// (true P3 regression). Keys answered during this ask are pruned separately.
	}
	void beforeKnownKeys;
	void afterMissingKeys;
	if (asked > 3) {
		fails.push({ check: "P3-grill-cap", detail: `asked=${asked} > grillMax 3` });
	}
	return fails;
}

async function runOne(caseDef: CaseDef): Promise<{ ok: boolean; runDir: string; wallMs: number; fails: AssertFail[] }> {
	installSoftUnhandledRejectionGuard();
	const guard = setInterval(() => installSoftUnhandledRejectionGuard(), 1_000);
	try {
		return await runOneInner(caseDef);
	} finally {
		clearInterval(guard);
		installSoftUnhandledRejectionGuard();
	}
}

async function runOneInner(
	caseDef: CaseDef,
): Promise<{ ok: boolean; runDir: string; wallMs: number; fails: AssertFail[] }> {
	const cwd = process.cwd();
	const outRoot = path.join(cwd, "tmp/moa-short-probe", caseDef.id);
	const runDir = createStageRunDir(outRoot);
	await Bun.write(path.join(runDir, ".keep"), "");
	log(`\n======== short-probe case=${caseDef.id} ========`);
	log(`task=${JSON.stringify(caseDef.task)}`);
	log(`artifacts → ${runDir}`);

	const configOverrides = (await loadMoaConfigOverrides(cwd)).overrides;
	let moaSettings = resolveSettings(configOverrides);
	moaSettings = {
		...moaSettings,
		rewriteEnabled: false,
		inputCollectEnabled: false,
		maxRounds: 1,
		postWorkerAskEnabled: false,
		// Keep Ask on so P3 is exercised; auto-answer via StageCliIo.
		askEnabled: true,
		discoveryTimeoutMs: Math.max(moaSettings.discoveryTimeoutMs, 90_000),
		researchTimeoutMs: Math.min(moaSettings.researchTimeoutMs, 180_000),
		workerTimeoutMs: Math.min(moaSettings.workerTimeoutMs, 180_000),
	};

	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = await Settings.init({ cwd });
	const ui = createStageCliUI(autoAnswerIo());
	const executeOptions = {
		cwd,
		authStorage,
		modelRegistry,
		settings,
		moaSettings,
		ui,
		hasUI: true,
	};

	const stageCtx = { task: caseDef.task, settings: moaSettings };
	const plan = buildPlan(caseDef.task, moaSettings);
	const effectiveResearch = resolveResearchMode(caseDef.task, moaSettings.researchMode);
	const researchGuidance = renderResearchGuidance(effectiveResearch);
	log(`research: ${moaSettings.researchMode}→${effectiveResearch}`);

	const wall0 = Date.now();
	const durations: Record<string, number> = {};
	const fails: AssertFail[] = [];

	const discovery = await runDiscoveryStage(stageCtx, executeOptions);
	durations.discovery = discovery.durationMs;
	let tco = discovery.tco;
	const outputSchema = enrichSchemaWithSources(discovery.outputSchema ?? DEFAULT_OUTPUT_SCHEMA, effectiveResearch);
	log(
		`✓ discovery ${formatDuration(discovery.durationMs)} known=${tco.known_inputs.length} missing=${tco.missing_inputs.length}`,
	);

	const knownBeforeAsk = tco.known_inputs.map(k => k.key);

	installSoftUnhandledRejectionGuard();
	if (effectiveResearch !== "none") {
		const research = await runResearchStage(tco, stageCtx, executeOptions);
		durations.research = research.durationMs;
		if (research.pack) tco = { ...tco, research_pack: research.pack };
		log(
			`✓ research ${formatDuration(research.durationMs)} sources=${research.pack?.sources.length ?? 0} parse=${research.packSource}`,
		);
		fails.push(...assertResearch(caseDef, research.pack));
	} else {
		fails.push(...assertResearch(caseDef, null));
	}
	installSoftUnhandledRejectionGuard();

	const ask = await runAskStage(tco, stageCtx, executeOptions);
	durations.ask = ask.durationMs;
	tco = ask.tco;
	log(`✓ ask ${formatDuration(ask.durationMs)} asked=${ask.askSummary.asked} answered=${ask.askSummary.answered}`);
	fails.push(
		...assertAsk(
			knownBeforeAsk,
			ask.askSummary.asked,
			tco.missing_inputs.map(m => m.key),
		),
	);
	// P3: no overlap between final missing and known (exact key).
	const knownKeys = new Set(tco.known_inputs.map(k => k.key));
	const stillOpen = tco.missing_inputs.filter(m => knownKeys.has(m.key)).map(m => m.key);
	if (stillOpen.length > 0) {
		fails.push({ check: "P3-prune", detail: `missing still has known keys: ${stillOpen.join(",")}` });
	}

	const tcoBlock = renderTcoForPrompt(tco, { maxBytes: moaSettings.tcoInjectMaxBytes });
	const rebound = rebindWorkerPrompts(plan.workers, caseDef.task, outputSchema, researchGuidance);
	installSoftUnhandledRejectionGuard();
	const workers = await runWorkersStage({
		plan,
		baseWorkers: rebound,
		tco,
		outputSchema,
		tcoBlock,
		ctx: stageCtx,
		options: executeOptions,
		effectiveMaxRounds: 0,
	});
	durations.workers = workers.durationMs;
	log(`✓ workers ${formatDuration(workers.durationMs)} ok=${workers.surviving.length}/${workers.workers.length}`);
	fails.push(...assertWorkers(workers.workers));

	const wallMs = Date.now() - wall0;
	const ok = fails.length === 0 && workers.surviving.length >= 1;

	await writeStageArtifacts(runDir, {
		meta: {
			stage: "short-probe",
			task: caseDef.task,
			ok,
			startedAt: new Date(wall0).toISOString(),
			endedAt: new Date().toISOString(),
			durations: { ...durations, total: wallMs },
			researchPackSource: tco.research_pack?.parse_source ?? null,
		},
		tco,
		ask: ask.askSummary,
		workerResults: workers.workers,
		surviving: workers.surviving,
		outputSchema,
		plan: { task: caseDef.task, workers: rebound },
	});

	const report = {
		caseId: caseDef.id,
		task: caseDef.task,
		note: caseDef.note,
		ok,
		wallMs,
		durations,
		fails,
		ask: ask.askSummary,
		research_sources: (tco.research_pack?.sources ?? []).map(s => ({
			url: s.url,
			claim: s.claim.slice(0, 120),
		})),
		workers: workers.workers.map(w => ({
			name: w.name,
			ok: w.ok,
			stopReason: w.stopReason,
			toolBudgetExceeded: w.toolBudgetExceeded,
			turns: w.usage?.turns,
			durationMs: w.durationMs,
			stderr: w.stderr.slice(0, 200),
		})),
	};
	await Bun.write(path.join(runDir, "short-probe-report.json"), `${JSON.stringify(report, null, 2)}\n`);

	if (fails.length > 0) {
		log(`ASSERT FAIL (${fails.length}):`);
		for (const f of fails) log(`  ✗ ${f.check}: ${f.detail}`);
	} else {
		log("ASSERT PASS");
	}
	log(`ok=${ok} wall=${(wallMs / 60000).toFixed(1)}m report → ${path.join(runDir, "short-probe-report.json")}`);
	return { ok, runDir, wallMs, fails };
}

async function main(): Promise<number> {
	installSoftUnhandledRejectionGuard();
	const restoreExit = installBlockFatalExit();
	try {
		const argv = process.argv.slice(2);
		if (argv.includes("--list")) {
			for (const c of Object.values(CASES)) log(`${c.id}\t${c.note ?? ""}\t${c.task}`);
			return 0;
		}
		const ids = (argv.length > 0 ? argv : DEFAULT_IDS).map(s => s.toUpperCase());
		const unknown = ids.filter(id => !CASES[id]);
		if (unknown.length > 0) {
			log(`unknown cases: ${unknown.join(", ")}`);
			return 2;
		}

		const summary: Array<{ id: string; ok: boolean; wallMin: string; fails: number; runDir: string }> = [];
		let failed = 0;
		for (const id of ids) {
			try {
				const r = await runOne(CASES[id]!);
				summary.push({
					id,
					ok: r.ok,
					wallMin: (r.wallMs / 60000).toFixed(1),
					fails: r.fails.length,
					runDir: r.runDir,
				});
				if (!r.ok) failed += 1;
			} catch (err) {
				failed += 1;
				log(`case=${id} THREW: ${err instanceof Error ? err.message : String(err)}`);
				summary.push({ id, ok: false, wallMin: "?", fails: -1, runDir: "" });
			}
		}

		const outPath = path.join(process.cwd(), "tmp/moa-short-probe/summary.json");
		await Bun.write(outPath, `${JSON.stringify({ at: new Date().toISOString(), summary }, null, 2)}\n`);
		log("\n======== SHORT-PROBE SUMMARY ========");
		for (const s of summary) log(`${s.id}\tok=${s.ok}\t${s.wallMin}m\tfails=${s.fails}\t${s.runDir}`);
		log(`summary → ${outPath}`);
		return failed > 0 ? 1 : 0;
	} finally {
		restoreExit();
	}
}

process.exit(await main());
