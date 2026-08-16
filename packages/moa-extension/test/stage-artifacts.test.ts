import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadStageRun, requireArtifacts, type StageRunMeta, writeStageArtifacts } from "../src/stage-artifacts";
import { emptyTco } from "../src/tco";
import { DEFAULT_OUTPUT_SCHEMA } from "../src/types";

describe("stage-artifacts", () => {
	it("writeStageArtifacts creates tco.json and meta.json", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moa-stage-art-"));
		const tco = emptyTco("task", "test");
		const meta: StageRunMeta = {
			stage: "discovery",
			task: "task",
			ok: true,
			startedAt: new Date().toISOString(),
			durations: { discovery: 12 },
		};
		await writeStageArtifacts(dir, {
			meta,
			tco,
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
		});
		const tcoRaw = await Bun.file(path.join(dir, "tco.json")).json();
		expect(tcoRaw.task_understanding).toBeTruthy();
		const metaRaw = await Bun.file(path.join(dir, "meta.json")).json();
		expect(metaRaw.stage).toBe("discovery");
		expect(metaRaw.ok).toBe(true);
	});

	it("loadStageRun reads back artifacts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moa-stage-art-"));
		const tco = emptyTco("roundtrip", "test");
		await writeStageArtifacts(dir, {
			meta: {
				stage: "ask",
				task: "roundtrip",
				ok: true,
				startedAt: new Date().toISOString(),
				durations: {},
			},
			tco,
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
		});
		const loaded = await loadStageRun(dir);
		expect(loaded.tco?.task_understanding).toContain("roundtrip");
		expect(loaded.outputSchema).toEqual(DEFAULT_OUTPUT_SCHEMA);
		expect(loaded.meta?.task).toBe("roundtrip");
	});

	it("requireArtifacts throws listing missing files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moa-stage-art-"));
		expect(() => requireArtifacts(dir, ["tco.json", "output_schema.json"])).toThrow(/tco\.json/);
	});

	it("writes worker-audit sidecars for timed-out workers", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moa-stage-art-"));
		await writeStageArtifacts(dir, {
			meta: {
				stage: "workers",
				task: "t",
				ok: false,
				startedAt: new Date().toISOString(),
				durations: {},
			},
			workerResults: [
				{
					name: "grounded",
					role: "r",
					ok: false,
					output: "",
					stderr: "timed out",
					exitCode: 1,
					timedOut: true,
					durationMs: 480_000,
					streamPreview: "still thinking…",
					toolTraceText: "[read]\nfoo.ts",
				},
				{
					name: "divergent",
					role: "r",
					ok: true,
					output: "## plan\nok",
					stderr: "",
					exitCode: 0,
				},
			],
		});
		const audit = await Bun.file(path.join(dir, "worker-audit/grounded.json")).json();
		expect(audit.timedOut).toBe(true);
		expect(audit.streamPreview).toContain("thinking");
		expect(audit.toolTraceText).toContain("[read]");
		expect(await Bun.file(path.join(dir, "worker-audit/divergent.json")).exists()).toBe(false);
	});
});
