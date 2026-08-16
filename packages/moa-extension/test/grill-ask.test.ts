import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type GrillQuestion, parseGrillQuestion, runGrillAsk } from "../src/grill-ask";
import { parseDiscoveryOutput } from "../src/tco";

function makeNoopUI() {
	return {
		select: vi.fn(async () => undefined as string | undefined),
		input: vi.fn(async () => undefined as string | undefined),
		notify: vi.fn(),
	};
}

function makeTco(missing: Array<{ key: string; question: string }>) {
	return parseDiscoveryOutput(
		JSON.stringify({
			task_understanding: "对比 hermes 与 workbuddy",
			known_inputs: [],
			missing_inputs: missing.map(m => ({
				key: m.key,
				question: m.question,
				type: "text",
				required: true,
			})),
		}),
	).tco;
}

describe("parseGrillQuestion", () => {
	it("parses done and open questions", () => {
		expect(parseGrillQuestion('{"done":true,"rationale":"ok"}')).toEqual({ done: true, rationale: "ok" });
		const q = parseGrillQuestion(
			'{"done":false,"key":"dims","question":"关心哪些维度？","options":["A","B"],"recommended":["A"]}',
		);
		expect(q.done).toBe(false);
		expect(q.key).toBe("dims");
		expect(q.recommended).toEqual(["A"]);
	});

	it("treats invalid JSON as done", () => {
		expect(parseGrillQuestion("not json").done).toBe(true);
	});
});

describe("runGrillAsk", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("skips UI when hasUI=false and assumes seed missing", async () => {
		const tco = makeTco([{ key: "dims", question: "对比维度？" }]);
		const ui = makeNoopUI();
		const result = await runGrillAsk(
			tco,
			{ ui: ui as never, hasUI: false },
			{
				nextQuestion: async () => ({ done: true }),
			},
		);
		expect(result.asked).toBe(0);
		expect(result.assumed).toBe(1);
		expect(ui.input).not.toHaveBeenCalled();
		expect(tco.missing_inputs).toHaveLength(1);
	});

	it("asks one question at a time and records answers", async () => {
		const tco = makeTco([{ key: "dims", question: "对比维度？" }]);
		const ui = makeNoopUI();
		ui.select.mockResolvedValueOnce("架构定位");
		ui.select.mockResolvedValueOnce("技术读者");

		const queue: GrillQuestion[] = [
			{
				done: false,
				key: "dims",
				question: "对比最关心哪些维度？",
				options: ["架构定位", "能力边界", "全部"],
				recommended: ["架构定位"],
			},
			{
				done: false,
				key: "audience",
				question: "主要读者是谁？",
				options: ["技术读者", "产品读者"],
				recommended: ["技术读者"],
			},
			{ done: true },
		];
		let i = 0;
		const result = await runGrillAsk(
			tco,
			{ ui: ui as never, hasUI: true },
			{
				maxQuestions: 5,
				nextQuestion: async () => queue[i++]!,
			},
		);
		expect(result.asked).toBe(2);
		expect(result.answered).toBe(2);
		expect(result.turns.map(t => t.key)).toEqual(["dims", "audience"]);
		expect(tco.known_inputs.map(k => k.key)).toEqual(["dims", "audience"]);
	});

	it("stops on user skip", async () => {
		const tco = makeTco([]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce(undefined);
		const result = await runGrillAsk(
			tco,
			{ ui: ui as never, hasUI: true },
			{
				nextQuestion: async () => ({
					done: false,
					key: "depth",
					question: "要多深？",
					recommended: ["概览"],
				}),
			},
		);
		expect(result.asked).toBe(1);
		expect(result.assumed).toBe(1);
		expect(tco.assumptions[0]?.reason).toBe("user_skipped");
	});

	it("respects maxQuestions", async () => {
		const tco = makeTco([]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValue("ok");
		const result = await runGrillAsk(
			tco,
			{ ui: ui as never, hasUI: true },
			{
				maxQuestions: 2,
				nextQuestion: async ctx => ({
					done: false,
					key: `q${ctx.questionIndex}`,
					question: `Q${ctx.questionIndex}?`,
				}),
			},
		);
		expect(result.asked).toBe(2);
		expect(result.answered).toBe(2);
	});
});
