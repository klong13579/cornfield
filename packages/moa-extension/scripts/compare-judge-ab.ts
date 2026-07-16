#!/usr/bin/env bun
/**
 * A/B: re-score the same workers.json with judge off vs on.
 *
 * Usage:
 *   bun packages/moa-extension/scripts/compare-judge-ab.ts --from tmp/moa-stage/<id>
 */
import * as path from "node:path";
import { loadMoaConfigOverrides } from "../src/moa-config";
import { applyWorkerQuality } from "../src/quality/apply";
import { createSpawnJudgeFn } from "../src/quality/judge";
import { resolveSettings } from "../src/settings";
import { loadStageRun } from "../src/stage-artifacts";
import { DEFAULT_OUTPUT_SCHEMA, type MoaWorkerResult } from "../src/types";

function stripQuality(w: MoaWorkerResult): MoaWorkerResult {
	const { qualityScore: _s, qualityDropped: _d, qualityMeta: _m, parsed: _p, parsedAt: _a, ...rest } = w;
	return rest;
}

function row(w: MoaWorkerResult): string {
	const meta = w.qualityMeta;
	const score = w.qualityScore ?? "?";
	const dropped = w.qualityDropped ? "DROP" : "keep";
	if (!meta) return `${w.name}\t${score}\t${dropped}\t(no meta)`;
	const judge =
		meta.judged && meta.judgeScore !== undefined
			? `judged=${meta.judgeScore}`
			: meta.contractHardFail
				? "hardFail"
				: meta.judgeError
					? `err=${meta.judgeError.slice(0, 40)}`
					: "no-judge";
	return `${w.name}\t${score}\t${dropped}\t${meta.source}\theur=${meta.heuristicScore}\t${judge}`;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const fromIdx = argv.indexOf("--from");
	const from = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;
	if (!from) {
		console.error("Usage: bun packages/moa-extension/scripts/compare-judge-ab.ts --from <stage-run-dir>");
		return 2;
	}
	const runDir = path.resolve(from);
	const prior = await loadStageRun(runDir);
	const workers = prior.workerResults;
	if (!workers || workers.length === 0) {
		console.error(`No workers.json in ${runDir}`);
		return 1;
	}
	const schema = prior.outputSchema ?? DEFAULT_OUTPUT_SCHEMA;
	const task = prior.meta?.task ?? prior.plan?.task ?? "";
	const cwd = process.cwd();
	const base = resolveSettings((await loadMoaConfigOverrides(cwd)).overrides);
	const minScore = base.qualityMinScore;

	const judgeOffSettings = {
		...base.quality,
		judge: { ...base.quality.judge, enabled: false },
	};
	const judgeOnSettings = {
		...base.quality,
		judge: { ...base.quality.judge, enabled: true },
	};
	const judgeFn = createSpawnJudgeFn({
		cwd,
		model: judgeOnSettings.judge.model,
		timeoutMs: judgeOnSettings.judge.timeoutMs,
	});

	console.log(`compare-judge-ab: from=${runDir}`);
	console.log(`task=${task.slice(0, 120)}`);
	console.log(`minScore=${minScore} judgeModel=${judgeOnSettings.judge.model} grayMargin=${judgeOnSettings.judge.grayMargin}`);
	console.log(`workers=${workers.length}\n`);

	const offRows: MoaWorkerResult[] = [];
	const onRows: MoaWorkerResult[] = [];

	for (const raw of workers) {
		const clean = stripQuality(raw);
		const off = await applyWorkerQuality(clean, schema, {
			minScore,
			quality: judgeOffSettings,
			task,
		});
		offRows.push(off);
		console.log(`[off] ${row(off)}`);
	}

	console.log("");
	for (const raw of workers) {
		const clean = stripQuality(raw);
		console.log(`[on ] scoring ${raw.name}…`);
		const on = await applyWorkerQuality(clean, schema, {
			minScore,
			quality: judgeOnSettings,
			judgeFn,
			task,
		});
		onRows.push(on);
		console.log(`[on ] ${row(on)}`);
	}

	console.log("\n=== Diff (off → on) ===");
	console.log("name\toffScore\toffDrop\tonScore\tonDrop\tdelta\tjudged");
	for (let i = 0; i < workers.length; i++) {
		const off = offRows[i]!;
		const on = onRows[i]!;
		const d = (on.qualityScore ?? 0) - (off.qualityScore ?? 0);
		const judged = on.qualityMeta?.judged ? "yes" : "no";
		console.log(
			`${off.name}\t${off.qualityScore}\t${off.qualityDropped ? "DROP" : "keep"}\t${on.qualityScore}\t${on.qualityDropped ? "DROP" : "keep"}\t${d >= 0 ? "+" : ""}${d}\t${judged}`,
		);
	}

	const offKeep = offRows.filter(w => !w.qualityDropped).map(w => w.name);
	const onKeep = onRows.filter(w => !w.qualityDropped).map(w => w.name);
	console.log(`\nsurviving off: [${offKeep.join(", ")}]`);
	console.log(`surviving on:  [${onKeep.join(", ")}]`);
	const setEq = offKeep.length === onKeep.length && offKeep.every((n, i) => n === onKeep[i]);
	console.log(setEq ? "surviving set: UNCHANGED" : "surviving set: CHANGED");

	const outPath = path.join(runDir, "judge-ab.json");
	await Bun.write(
		outPath,
		`${JSON.stringify(
			{
				task,
				minScore,
				judgeModel: judgeOnSettings.judge.model,
				off: offRows.map(w => ({
					name: w.name,
					qualityScore: w.qualityScore,
					qualityDropped: w.qualityDropped,
					qualityMeta: w.qualityMeta,
				})),
				on: onRows.map(w => ({
					name: w.name,
					qualityScore: w.qualityScore,
					qualityDropped: w.qualityDropped,
					qualityMeta: w.qualityMeta,
				})),
			},
			null,
			2,
		)}\n`,
	);
	console.log(`\nwrote ${outPath}`);
	return 0;
}

const code = await main();
process.exit(code);
