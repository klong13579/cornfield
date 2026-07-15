import { describe, expect, it } from "bun:test";
import {
	buildDispatchLogFromResults,
	buildMoaArchive,
	buildMoaArchiveEntries,
	buildMoaHandoff,
	buildSummary,
	buildTraceDetails,
	chunkUtf8,
	createMoaRunId,
	formatDispatchQuality,
	listMoaArchiveRuns,
	reconstructMoaArchive,
} from "../src/trace";
import type {
	MoaArchiveChunk,
	MoaArchiveManifest,
	MoaExecutionResult,
	MoaQualityMeta,
	MoaWorkerResult,
} from "../src/types";
import { MOA_ARCHIVE_CHUNK_BYTES } from "../src/types";

function makeWorker(overrides: Partial<MoaWorkerResult> = {}): MoaWorkerResult {
	return {
		name: overrides.name ?? "divergent",
		role: overrides.role ?? "Generate options",
		ok: overrides.ok ?? true,
		output: overrides.output ?? "option A",
		stderr: overrides.stderr ?? "",
		exitCode: overrides.exitCode ?? 0,
		model: overrides.model,
		rewrittenPrompt: overrides.rewrittenPrompt,
		parsed: overrides.parsed,
		qualityScore: overrides.qualityScore,
	qualityDropped: overrides.qualityDropped,
	parsedAt: overrides.parsedAt,
	qualityMeta: overrides.qualityMeta,
	};
}

function makeQualityMeta(overrides: Partial<MoaQualityMeta> = {}): MoaQualityMeta {
	return {
		version: 2,
		heuristicScore: overrides.heuristicScore ?? 45,
		judgeScore: overrides.judgeScore,
		source: overrides.source ?? "heuristic",
		roleKey: overrides.roleKey ?? "divergent",
		contractHardFail: overrides.contractHardFail ?? false,
		judged: overrides.judged ?? false,
		judgeError: overrides.judgeError,
		breakdown: overrides.breakdown,
	};
}

function makeResult(overrides: Partial<MoaExecutionResult> = {}): MoaExecutionResult {
	return {
		plan: { task: "design panel", workers: [] },
		workers: overrides.workers ?? [
			makeWorker({ name: "divergent", output: "opt A\nopt B" }),
			makeWorker({ name: "grounded", output: "realistic" }),
			makeWorker({ name: "critical", output: "edge cases", ok: false, exitCode: 1, stderr: "boom" }),
		],
		synthesis: overrides.synthesis ?? makeWorker({ name: "synthesis", output: "pick A" }),
	};
}

function asCustomMessageEntry(
	details: MoaArchiveManifest | MoaArchiveChunk,
	content: string,
): {
	type: "custom_message";
	customType: string;
	details: MoaArchiveManifest | MoaArchiveChunk;
	content: { type: "text"; text: string }[];
} {
	return {
		type: "custom_message",
		customType: "moa-archive",
		details,
		content: [{ type: "text", text: content }],
	};
}

describe("chunkUtf8", () => {
	it("returns a single chunk for small input", () => {
		const chunks = chunkUtf8("hello", 100);
		expect(chunks).toEqual(["hello"]);
	});

	it("splits input larger than maxBytes", () => {
		const input = "a".repeat(10_000);
		const chunks = chunkUtf8(input, 1024);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(1024);
		}
		expect(chunks.join("")).toBe(input);
	});

	it("does not split a multi-byte code point", () => {
		const input = "中".repeat(5_000);
		const chunks = chunkUtf8(input, 1024);
		expect(chunks.join("")).toBe(input);
		for (const chunk of chunks) {
			expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(1024);
		}
	});

	it("handles empty and zero-budget inputs", () => {
		expect(chunkUtf8("", 1024)).toEqual([""]);
		expect(chunkUtf8("hello", 0)).toEqual(["hello"]);
	});
});

describe("createMoaRunId", () => {
	it("returns a string matching the run-id format", () => {
		const id = createMoaRunId(new Date("2026-07-12T16:45:30.000Z"));
		expect(id).toMatch(/^moa-20260712-164530-[0-9a-z]{6}$/);
	});

	it("returns distinct ids for the same instant", () => {
		const now = new Date("2026-07-12T16:45:30.000Z");
		const a = createMoaRunId(now);
		const b = createMoaRunId(now);
		expect(a).not.toBe(b);
	});
});

describe("buildMoaArchiveEntries", () => {
	it("produces a manifest that matches chunk count and bytes", () => {
		const result = makeResult();
		const { manifest, chunks } = buildMoaArchiveEntries({
			runId: "moa-test-run",
			task: result.plan.task,
			workers: result.workers,
			synthesis: result.synthesis,
		});
		expect(manifest.schema).toBe("moa.archive.v1");
		expect(manifest.kind).toBe("manifest");
		expect(manifest.runId).toBe("moa-test-run");
		expect(manifest.workerCount).toBe(3);
		expect(manifest.completedWorkers).toBe(2);
		expect(manifest.chunks).toBe(chunks.length);
		expect(manifest.bytes).toBe(Buffer.byteLength(chunks.map(c => c.content).join(""), "utf8"));
	});

	it("every chunk is at most MOA_ARCHIVE_CHUNK_BYTES", () => {
		const result = makeResult();
		const { chunks } = buildMoaArchiveEntries({
			runId: "moa-bulk",
			task: result.plan.task,
			workers: result.workers.map(w => ({ ...w, output: "x".repeat(20_000) })),
			synthesis: result.synthesis,
		});
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(Buffer.byteLength(chunk.content, "utf8")).toBeLessThanOrEqual(MOA_ARCHIVE_CHUNK_BYTES);
		}
	});

	it("chunks cover indices 0..total-1 in order with consistent runId", () => {
		const { chunks } = buildMoaArchiveEntries({
			runId: "moa-ord",
			task: "x",
			workers: [makeWorker({ output: "x".repeat(100_000) })],
		});
		expect(chunks.map(c => c.index)).toEqual(chunks.map((_, i) => i));
		expect(chunks.every(c => c.runId === "moa-ord")).toBe(true);
		expect(chunks.every(c => c.total === chunks.length)).toBe(true);
	});
});

describe("reconstructMoaArchive / listMoaArchiveRuns", () => {
	it("rebuilds full transcript by runId", () => {
		const result = makeResult({ workers: [makeWorker({ name: "w1", output: "x".repeat(100_000) })] });
		const createdAt = "2026-07-12T16:45:30.000Z";
		const { manifest, chunks } = buildMoaArchiveEntries({
			runId: "moa-r-1",
			createdAt,
			task: result.plan.task,
			workers: result.workers,
			synthesis: result.synthesis,
		});
		const entries = [asCustomMessageEntry(manifest, ""), ...chunks.map(c => asCustomMessageEntry(c, c.content))];
		const reconstructed = reconstructMoaArchive(entries, "moa-r-1");
		expect(reconstructed).toBeDefined();
		expect(reconstructed?.manifest).toEqual(manifest);
		const expected = buildMoaArchive({
			runId: "moa-r-1",
			createdAt,
			task: result.plan.task,
			workers: result.workers,
			synthesis: result.synthesis,
		});
		expect(reconstructed?.content).toBe(expected);
	});

	it("rebuilds most recent run when runId is omitted", () => {
		const r1 = buildMoaArchiveEntries({
			runId: "moa-old",
			task: "first",
			workers: [makeWorker({ name: "a", output: "alpha" })],
		});
		const r2 = buildMoaArchiveEntries({
			runId: "moa-new",
			task: "second",
			workers: [makeWorker({ name: "b", output: "beta" })],
		});
		const entries = [
			...r1.chunks.map(c => asCustomMessageEntry(c, c.content)),
			asCustomMessageEntry(r1.manifest, ""),
			asCustomMessageEntry(r2.manifest, ""),
			...r2.chunks.map(c => asCustomMessageEntry(c, c.content)),
		];
		const reconstructed = reconstructMoaArchive(entries);
		expect(reconstructed?.manifest.runId).toBe("moa-new");
	});

	it("returns undefined for an unknown runId", () => {
		const { chunks } = buildMoaArchiveEntries({
			runId: "moa-known",
			task: "x",
			workers: [makeWorker()],
		});
		const entries = chunks.map(c => asCustomMessageEntry(c, c.content));
		expect(reconstructMoaArchive(entries, "moa-other")).toBeUndefined();
	});

	it("returns undefined when chunks are missing for a manifest", () => {
		const { manifest } = buildMoaArchiveEntries({
			runId: "moa-orphan",
			task: "x",
			workers: [makeWorker()],
		});
		expect(reconstructMoaArchive([asCustomMessageEntry(manifest, "")])).toBeUndefined();
	});

	it("ignores malformed archive entries", () => {
		const entries = [
			{
				type: "custom_message",
				customType: "moa-archive",
				details: { schema: "wrong", kind: "manifest" },
				content: [],
			},
			{ type: "message", message: { role: "user", content: [] } },
		];
		expect(reconstructMoaArchive(entries)).toBeUndefined();
		expect(listMoaArchiveRuns(entries)).toEqual([]);
	});

	it("listMoaArchiveRuns returns every manifest in order", () => {
		const r1 = buildMoaArchiveEntries({ runId: "moa-a", task: "x", workers: [makeWorker()] });
		const r2 = buildMoaArchiveEntries({ runId: "moa-b", task: "y", workers: [makeWorker()] });
		const entries = [
			asCustomMessageEntry(r1.manifest, ""),
			...r1.chunks.map(c => asCustomMessageEntry(c, c.content)),
			asCustomMessageEntry(r2.manifest, ""),
			...r2.chunks.map(c => asCustomMessageEntry(c, c.content)),
		];
		const runs = listMoaArchiveRuns(entries);
		expect(runs.map(r => r.runId)).toEqual(["moa-a", "moa-b"]);
	});
});

describe("buildMoaHandoff", () => {
	it("includes runId pointer and bounded worker conclusions", () => {
		const handoff = buildMoaHandoff({
			runId: "moa-x",
			archiveChunks: 2,
			archiveBytes: 60_000,
			workers: [makeWorker({ output: "x".repeat(2_000) })],
			task: "design the panel",
			maxBytes: 1_000,
		});
		expect(handoff).toContain("moa transcript: 1/1 workers completed");
		expect(handoff).toContain("/moa transcript moa-x");
		expect(Buffer.byteLength(handoff, "utf8")).toBeLessThan(4_000);
		expect(handoff).toContain("truncated");
	});

	it("returns headline + pointer only when maxBytes is 0", () => {
		const handoff = buildMoaHandoff({
			runId: "moa-y",
			archiveChunks: 1,
			archiveBytes: 100,
			workers: [makeWorker()],
			task: "x",
			maxBytes: 0,
		});
		expect(handoff).toContain("moa transcript:");
		expect(handoff).toContain("moa-y");
		expect(handoff).not.toContain("Worker conclusions");
	});

	it("places synthesis before workers so the byte cap preserves the merged answer", () => {
		// 3 workers with large outputs, a synthesis with a clear marker, and a
		// tight byte cap that forces truncation. Without the reorder, the
		// synthesis ends up at the tail and gets cut off by truncateUtf8.
		const synthesisMarker = "SYNTHESIS_HEADLINE_xyz_unique";
		const handoff = buildMoaHandoff({
			runId: "moa-z",
			archiveChunks: 1,
			archiveBytes: 100,
			workers: [
				makeWorker({ name: "divergent", output: "d".repeat(2_000) }),
				makeWorker({ name: "grounded", output: "g".repeat(2_000) }),
				makeWorker({ name: "critical", output: "c".repeat(2_000) }),
			],
			synthesis: makeWorker({ name: "synthesis", output: `${synthesisMarker}\n${"s".repeat(500)}` }),
			task: "rank options",
			maxBytes: 1_500,
		});
		const synthesisIdx = handoff.indexOf(synthesisMarker);
		const firstWorkerIdx = handoff.indexOf("### worker 1:");
		expect(synthesisIdx).toBeGreaterThan(0);
		expect(firstWorkerIdx).toBeGreaterThan(0);
		expect(synthesisIdx).toBeLessThan(firstWorkerIdx);
		// And the synthesis marker actually survives the truncation.
		expect(handoff).toContain(synthesisMarker);
	});
});

describe("buildDispatchLogFromResults", () => {
	it("assigns round=1 to every entry", () => {
		const log = buildDispatchLogFromResults([makeWorker({ name: "divergent" }), makeWorker({ name: "grounded" })]);
		expect(log).toHaveLength(2);
		expect(log.every(e => e.round === 1)).toBe(true);
	});

	it("propagates model, qualityScore, qualityDropped", () => {
		const log = buildDispatchLogFromResults([
			makeWorker({ name: "divergent", model: "test/model" }),
			makeWorker({ name: "grounded", qualityScore: 30, qualityDropped: true }),
		]);
		expect(log[0]?.model).toBe("test/model");
		expect(log[1]?.qualityScore).toBe(30);
		expect(log[1]?.qualityDropped).toBe(true);
	});

	it("propagates qualityMeta from worker results", () => {
		const meta = makeQualityMeta({ heuristicScore: 55, source: "heuristic", judged: false });
		const log = buildDispatchLogFromResults([
			makeWorker({ name: "divergent", qualityScore: 55, qualityMeta: meta }),
		]);
		expect(log[0]?.qualityMeta).toEqual(meta);
	});
});

describe("formatDispatchQuality", () => {
	it("returns plain score when no meta", () => {
		expect(formatDispatchQuality({ qualityScore: 72 })).toBe("72");
		expect(formatDispatchQuality({})).toBe("");
	});

	it("returns simple score for heuristic-only meta", () => {
		expect(
			formatDispatchQuality({
				qualityScore: 45,
				qualityMeta: makeQualityMeta({ heuristicScore: 45, judged: false }),
			}),
		).toBe("45");
	});

	it("renders heuristic→judge line when judged", () => {
		expect(
			formatDispatchQuality({
				qualityScore: 72,
				qualityMeta: makeQualityMeta({
					heuristicScore: 45,
					judgeScore: 72,
					source: "judge",
					judged: true,
				}),
			}),
		).toBe("72 (heuristic=45 → judge=72)");
	});
});

describe("buildMoaArchive with dispatchLog", () => {
	it("includes a Dispatch log markdown table when dispatchLog provided", () => {
		const result = makeResult();
		const dispatchLog = buildDispatchLogFromResults(result.workers, {
			startedAt: "2026-07-14T10:00:00.000Z",
		});
		const text = buildMoaArchive({
			runId: "moa-d-1",
			task: result.plan.task,
			workers: result.workers,
			synthesis: result.synthesis,
			dispatchLog,
		});
		expect(text).toContain("## Dispatch log");
		expect(text).toContain("| worker | round |");
		expect(text).toContain("divergent");
		expect(text).toContain("grounded");
	});

	it("renders heuristic→judge quality in dispatch log when meta present", () => {
		const meta = makeQualityMeta({
			heuristicScore: 45,
			judgeScore: 72,
			source: "judge",
			judged: true,
		});
		const dispatchLog = buildDispatchLogFromResults([
			makeWorker({ name: "divergent", qualityScore: 72, qualityMeta: meta }),
		]);
		const text = buildMoaArchive({
			runId: "moa-d-judge",
			task: "t",
			workers: [makeWorker({ name: "divergent" })],
			dispatchLog,
		});
		expect(text).toContain("72 (heuristic=45 → judge=72)");
	});

	it("omits Dispatch log section when dispatchLog is empty or undefined", () => {
		const result = makeResult();
		const textNoLog = buildMoaArchive({
			runId: "moa-d-2",
			task: result.plan.task,
			workers: result.workers,
		});
		expect(textNoLog).not.toContain("## Dispatch log");

		const textEmptyLog = buildMoaArchive({
			runId: "moa-d-3",
			task: result.plan.task,
			workers: result.workers,
			dispatchLog: [],
		});
		expect(textEmptyLog).not.toContain("## Dispatch log");
	});
});

describe("buildMoaArchiveEntries with dispatchLog", () => {
	it("sets manifest.dispatchLog when non-empty", () => {
		const result = makeResult();
		const dispatchLog = buildDispatchLogFromResults(result.workers);
		const { manifest } = buildMoaArchiveEntries({
			runId: "moa-manifest-d-1",
			task: result.plan.task,
			workers: result.workers,
			synthesis: result.synthesis,
			dispatchLog,
		});
		expect(manifest.dispatchLog).toBeDefined();
		expect(manifest.dispatchLog).toHaveLength(3);
	});

	it("omits manifest.dispatchLog when empty (back-compat: old readers see no field)", () => {
		const result = makeResult();
		const { manifest } = buildMoaArchiveEntries({
			runId: "moa-manifest-d-2",
			task: result.plan.task,
			workers: result.workers,
			dispatchLog: [],
		});
		expect(manifest.dispatchLog).toBeUndefined();
	});

	it("back-compat: no dispatchLog argument yields no field on manifest", () => {
		const result = makeResult();
		const { manifest } = buildMoaArchiveEntries({
			runId: "moa-manifest-d-3",
			task: result.plan.task,
			workers: result.workers,
		});
		expect(manifest.dispatchLog).toBeUndefined();
	});
});

describe("buildSummary / buildTraceDetails (deprecated, kept for back-compat)", () => {
	it("buildSummary still produces the legacy format", () => {
		const result = makeResult();
		const summary = buildSummary(result);
		expect(summary).toContain("## MOA Run");
		expect(summary).toContain("### synthesis");
		expect(summary).toContain("divergent");
	});

	it("buildTraceDetails includes runId, archiveChunks, archiveBytes", () => {
		const details = buildTraceDetails(makeResult(), {
			runId: "moa-z",
			archiveChunks: 3,
			archiveBytes: 1024,
		});
		expect(details.runId).toBe("moa-z");
		expect(details.archiveChunks).toBe(3);
		expect(details.archiveBytes).toBe(1024);
		expect(details.workers).toHaveLength(3);
	});

	it("buildTraceDetails surfaces result.timings when set", () => {
		const result = makeResult();
		result.timings = { discovery: 27_600, ask: 9_000, rewrite: 69_700, workers: 141_600, synthesis: 48_700, total: 296_600 };
		const details = buildTraceDetails(result, { runId: "moa-z", archiveChunks: 2, archiveBytes: 80_881 });
		expect(details.timings).toEqual(result.timings);
	});
});
