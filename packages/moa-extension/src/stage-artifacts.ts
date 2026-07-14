/**
 * On-disk artifacts for the MoA stage-test harness (`tmp/moa-stage/<id>/`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { TaskContextObject } from "./tco";
import type { MoaOutputSchema, MoaPlanWorker, MoaWorkerResult } from "./types";

export type StageName = "all" | "discovery" | "ask" | "rewrite" | "workers" | "synthesis";

export interface StageRunMeta {
	stage: StageName;
	task: string;
	ok: boolean;
	startedAt: string;
	endedAt?: string;
	durations: Record<string, number>;
	error?: string;
	models?: Record<string, string | undefined>;
	signal?: string | null;
	fallback?: boolean;
}

export interface StageArtifactsPayload {
	meta: StageRunMeta;
	tco?: TaskContextObject;
	outputSchema?: MoaOutputSchema;
	ask?: unknown;
	discovery?: MoaWorkerResult;
	rewrite?: MoaWorkerResult;
	workers?: MoaPlanWorker[];
	workerResults?: MoaWorkerResult[];
	dispatchLog?: unknown;
	rounds?: unknown;
	surviving?: MoaWorkerResult[];
	synthesis?: MoaWorkerResult;
	plan?: { task: string; workers: MoaPlanWorker[]; synthesisModel?: string; synthesisThinking?: string };
}

export interface LoadedStageRun {
	meta?: StageRunMeta;
	tco?: TaskContextObject;
	outputSchema?: MoaOutputSchema;
	ask?: unknown;
	discovery?: MoaWorkerResult;
	rewrite?: MoaWorkerResult;
	workers?: MoaPlanWorker[];
	workerResults?: MoaWorkerResult[];
	dispatchLog?: unknown;
	rounds?: unknown;
	surviving?: MoaWorkerResult[];
	synthesis?: MoaWorkerResult;
	plan?: StageArtifactsPayload["plan"];
	synthesisMd?: string;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

export async function writeStageArtifacts(dir: string, payload: StageArtifactsPayload): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
	await writeJson(path.join(dir, "meta.json"), payload.meta);
	if (payload.tco !== undefined) await writeJson(path.join(dir, "tco.json"), payload.tco);
	if (payload.outputSchema !== undefined) {
		await writeJson(path.join(dir, "output_schema.json"), payload.outputSchema);
	}
	if (payload.ask !== undefined) await writeJson(path.join(dir, "ask.json"), payload.ask);
	if (payload.discovery !== undefined) await writeJson(path.join(dir, "discovery.json"), payload.discovery);
	if (payload.rewrite !== undefined) await writeJson(path.join(dir, "rewrite.json"), payload.rewrite);
	if (payload.workers !== undefined) await writeJson(path.join(dir, "plan.json"), { workers: payload.workers });
	if (payload.plan !== undefined) await writeJson(path.join(dir, "plan.json"), payload.plan);
	if (payload.workerResults !== undefined) {
		await writeJson(path.join(dir, "workers.json"), {
			workers: payload.workerResults,
			surviving: payload.surviving,
			dispatchLog: payload.dispatchLog,
			rounds: payload.rounds,
		});
	}
	if (payload.synthesis !== undefined) {
		await writeJson(path.join(dir, "synthesis.json"), payload.synthesis);
		await Bun.write(path.join(dir, "synthesis.md"), payload.synthesis.output ?? "");
	}
}

export async function loadStageRun(dir: string): Promise<LoadedStageRun> {
	const meta = await readJson<StageRunMeta>(path.join(dir, "meta.json"));
	const tco = await readJson<TaskContextObject>(path.join(dir, "tco.json"));
	const outputSchema = await readJson<MoaOutputSchema>(path.join(dir, "output_schema.json"));
	const ask = await readJson(path.join(dir, "ask.json"));
	const discovery = await readJson<MoaWorkerResult>(path.join(dir, "discovery.json"));
	const rewrite = await readJson<MoaWorkerResult>(path.join(dir, "rewrite.json"));
	const plan = await readJson<StageArtifactsPayload["plan"] & { workers?: MoaPlanWorker[] }>(
		path.join(dir, "plan.json"),
	);
	const workersBundle = await readJson<{
		workers?: MoaWorkerResult[];
		surviving?: MoaWorkerResult[];
		dispatchLog?: unknown;
		rounds?: unknown;
	}>(path.join(dir, "workers.json"));
	const synthesis = await readJson<MoaWorkerResult>(path.join(dir, "synthesis.json"));
	let synthesisMd: string | undefined;
	try {
		synthesisMd = await Bun.file(path.join(dir, "synthesis.md")).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	return {
		meta,
		tco,
		outputSchema,
		ask,
		discovery,
		rewrite,
		workers: plan?.workers,
		plan,
		workerResults: workersBundle?.workers,
		surviving: workersBundle?.surviving,
		dispatchLog: workersBundle?.dispatchLog,
		rounds: workersBundle?.rounds,
		synthesis,
		synthesisMd,
	};
}

export function requireArtifacts(dir: string, names: string[]): void {
	const missing = names.filter(name => !fs.existsSync(path.join(dir, name)));
	if (missing.length > 0) {
		throw new Error(`Missing stage artifacts in ${dir}: ${missing.join(", ")}`);
	}
}

export function createStageRunDir(outRoot: string, stamp?: string): string {
	const id = stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(outRoot, id);
}
