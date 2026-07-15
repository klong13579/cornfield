import { describe, expect, it, vi } from "bun:test";
import { applyWorkerQuality } from "../src/quality/apply";
import { createSpawnJudgeFn, parseJudgeResponse } from "../src/quality/judge";
import type { MoaQualitySettings } from "../src/quality/types";
import { DEFAULT_OUTPUT_SCHEMA, type MoaWorkerResult } from "../src/types";
import { parseWorkerOutputBySchema } from "../src/worker-parser";

function makeResult(overrides: Partial<MoaWorkerResult> = {}): MoaWorkerResult {
	return {
		name: overrides.name ?? "divergent",
		role: overrides.role ?? "Generate options",
		ok: overrides.ok ?? true,
		output: overrides.output ?? "",
		stderr: overrides.stderr ?? "",
		exitCode: overrides.exitCode ?? 0,
		model: overrides.model,
	};
}

const GOOD_OUTPUT = `## plan
${"x".repeat(500)}
## open_questions
- question: a | context: b | suggested_default: c | type: freeform
## assumptions
- claim: y | basis: z`;

const LOW_SCORE_OUTPUT = `## plan
Short plan with 请确认 here.

## open_questions
- q1
- q2
- q3
- q4
- q5
- q6`;

const CONTRACT_FAIL_OUTPUT = "## open_questions\n- x";

const GRAY_ZONE_OUTPUT = `## plan
${"x".repeat(120)}

## open_questions
- question: a | context: b | suggested_default: c | type: freeform
- question: d | context: e | suggested_default: f | type: freeform
- question: g | context: h | suggested_default: i | type: freeform
- question: j | context: k | suggested_default: l | type: freeform
- question: m | context: n | suggested_default: o | type: freeform
- question: p | context: q | suggested_default: r | type: freeform`;

const JUDGE_ENABLED_QUALITY: MoaQualitySettings = {
	judge: {
		enabled: true,
		mode: "hybrid",
		model: "narwal-plan/minimax-m3",
		grayMargin: 10,
		timeoutMs: 60_000,
		onError: "keep_heuristic",
	},
};

describe("parseJudgeResponse", () => {
	it("parses valid JSON with score", () => {
		const result = parseJudgeResponse(
			JSON.stringify({ score: 72, pass: true, rationale: "ok", role_fit: "high", issues: [] }),
		);
		expect(result.score).toBe(72);
		expect(result.rationale).toBe("ok");
	});

	it("throws on invalid JSON", () => {
		expect(() => parseJudgeResponse("not json")).toThrow();
	});

	it("parses fenced ```json blocks", () => {
		const result = parseJudgeResponse('```json\n{"score": 88, "rationale": "good"}\n```');
		expect(result.score).toBe(88);
		expect(result.rationale).toBe("good");
	});

	it("returns out-of-range score without clamping", () => {
		const result = parseJudgeResponse(JSON.stringify({ score: 150 }));
		expect(result.score).toBe(150);
	});
});

describe("createSpawnJudgeFn", () => {
	it("calls spawn with tools:none and parses stdout JSON score", async () => {
		const spawn = vi.fn(async () => ({
			ok: true,
			output: JSON.stringify({ score: 77, pass: true, rationale: "acceptable" }),
			stderr: "",
			exitCode: 0,
			aborted: false,
			timedOut: false,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			durationMs: 1,
		}));
		const judgeFn = createSpawnJudgeFn({
			cwd: "/tmp/judge-test",
			model: "test/judge-model",
			timeoutMs: 5000,
			spawn,
		});
		const result = makeResult({ output: LOW_SCORE_OUTPUT });
		const parsed = parseWorkerOutputBySchema(LOW_SCORE_OUTPUT, DEFAULT_OUTPUT_SCHEMA);

		const out = await judgeFn({
			result,
			parsed,
			schema: DEFAULT_OUTPUT_SCHEMA,
			heuristicScore: 25,
			roleKey: "divergent",
			task: "score this worker",
		});

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/judge-test",
				model: "test/judge-model",
				tools: "none",
				task: "Score the worker output. Reply with JSON only.",
				timeoutMs: 5000,
			}),
		);
		expect(spawn.mock.calls[0]![0].systemPrompt).toContain("score this worker");
		expect(out.score).toBe(77);
		expect(out.rationale).toBe("acceptable");
	});
});

describe("applyWorkerQuality", () => {
	it("judge disabled: sets v2 meta from heuristic, does not call judgeFn", async () => {
		const result = makeResult({ output: GOOD_OUTPUT });
		const fixedNow = new Date("2026-07-15T10:00:00.000Z");
		const judgeFn = vi.fn(async () => ({ score: 99 }));

		const out = await applyWorkerQuality(result, DEFAULT_OUTPUT_SCHEMA, {
			now: () => fixedNow,
			judgeFn,
		});

		expect(judgeFn).not.toHaveBeenCalled();
		expect(out.parsed?.plan).toContain("x".repeat(100));
		expect(out.qualityScore).toBe(100);
		expect(out.qualityDropped).toBe(false);
		expect(out.parsedAt).toBe("2026-07-15T10:00:00.000Z");
		expect(out.qualityMeta).toEqual({
			version: 2,
			heuristicScore: 100,
			source: "heuristic",
			roleKey: "divergent",
			contractHardFail: false,
			judged: false,
			breakdown: out.qualityMeta?.breakdown,
		});
	});

	it("drops worker when heuristic score < minScore", async () => {
		const result = makeResult({ output: LOW_SCORE_OUTPUT });
		const out = await applyWorkerQuality(result, DEFAULT_OUTPUT_SCHEMA, { minScore: 40 });

		expect(out.qualityScore).toBeLessThan(40);
		expect(out.qualityDropped).toBe(true);
		expect(out.qualityMeta?.contractHardFail).toBe(false);
		expect(out.qualityMeta?.source).toBe("heuristic");
	});

	it("judge overrides willDrop heuristic: mock score 80 rescues worker", async () => {
		const result = makeResult({ output: LOW_SCORE_OUTPUT });
		const judgeFn = vi.fn(async () => ({ score: 80 }));

		const out = await applyWorkerQuality(result, DEFAULT_OUTPUT_SCHEMA, {
			minScore: 40,
			quality: JUDGE_ENABLED_QUALITY,
			judgeFn,
		});

		expect(judgeFn).toHaveBeenCalledTimes(1);
		expect(out.qualityScore).toBe(80);
		expect(out.qualityDropped).toBe(false);
		expect(out.qualityMeta?.source).toBe("judge");
		expect(out.qualityMeta?.judged).toBe(true);
		expect(out.qualityMeta?.judgeScore).toBe(80);
		expect(out.qualityMeta?.heuristicScore).toBeLessThan(40);
	});

	it("judge gray-zone drop: mock score 10 drops worker", async () => {
		const result = makeResult({ output: GRAY_ZONE_OUTPUT });
		const judgeFn = vi.fn(async () => ({ score: 10 }));

		const out = await applyWorkerQuality(result, DEFAULT_OUTPUT_SCHEMA, {
			minScore: 40,
			quality: JUDGE_ENABLED_QUALITY,
			judgeFn,
		});

		expect(judgeFn).toHaveBeenCalledTimes(1);
		expect(out.qualityScore).toBe(10);
		expect(out.qualityDropped).toBe(true);
		expect(out.qualityMeta?.source).toBe("judge");
		expect(out.qualityMeta?.judged).toBe(true);
	});

	it("judge throw keeps heuristic score and sets judgeError", async () => {
		const result = makeResult({ output: LOW_SCORE_OUTPUT });
		const judgeFn = vi.fn(async () => {
			throw new Error("judge timeout");
		});

		const out = await applyWorkerQuality(result, DEFAULT_OUTPUT_SCHEMA, {
			minScore: 40,
			quality: JUDGE_ENABLED_QUALITY,
			judgeFn,
		});

		expect(judgeFn).toHaveBeenCalledTimes(1);
		expect(out.qualityMeta?.source).toBe("heuristic");
		expect(out.qualityMeta?.judged).toBe(false);
		expect(out.qualityMeta?.judgeError).toBe("judge timeout");
		expect(out.qualityScore).toBe(out.qualityMeta?.heuristicScore);
		expect(out.qualityDropped).toBe(true);
	});

	it("contractHardFail never calls judgeFn even when judge enabled", async () => {
		const result = makeResult({ output: CONTRACT_FAIL_OUTPUT });
		const judgeFn = vi.fn(async () => ({ score: 99 }));

		const out = await applyWorkerQuality(result, DEFAULT_OUTPUT_SCHEMA, {
			quality: JUDGE_ENABLED_QUALITY,
			judgeFn,
		});

		expect(judgeFn).not.toHaveBeenCalled();
		expect(out.qualityMeta?.contractHardFail).toBe(true);
		expect(out.qualityMeta?.judged).toBe(false);
		expect(out.qualityDropped).toBe(true);
	});

	it("does not mutate the input result", async () => {
		const result = makeResult({ output: GOOD_OUTPUT });
		const before = { ...result };
		await applyWorkerQuality(result, DEFAULT_OUTPUT_SCHEMA);
		expect(result).toEqual(before);
	});
});
