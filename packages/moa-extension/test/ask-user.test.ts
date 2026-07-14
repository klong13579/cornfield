import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { askMissingInputs } from "../src/ask-user";
import { parseDiscoveryOutput, type TaskContextObject } from "../src/tco";

function makeNoopUI() {
	return {
		select: vi.fn(async () => undefined as string | undefined),
		input: vi.fn(async () => undefined as string | undefined),
		notify: vi.fn(),
	};
}

function makeTco(
	missing: Array<{ key: string; type?: string; required?: boolean; options?: string[]; defaultValue?: unknown }>,
): TaskContextObject {
	return parseDiscoveryOutput(
		JSON.stringify({
			task_understanding: "test",
			known_inputs: [],
			missing_inputs: missing.map(m => ({
				key: m.key,
				question: `ask ${m.key}`,
				type: m.type ?? "text",
				required: m.required ?? true,
				options: m.options,
				defaultValue: m.defaultValue,
			})),
		}),
	).tco;
}

describe("askMissingInputs", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("records all as non_interactive_fallback when hasUI=false", async () => {
		const tco = makeTco([{ key: "a" }, { key: "b" }]);
		const ui = makeNoopUI();
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: false });
		expect(result.asked).toBe(0);
		expect(result.assumed).toBe(2);
		expect(tco.assumptions.every(a => a.reason === "non_interactive_fallback")).toBe(true);
		expect(ui.input).not.toHaveBeenCalled();
	});

	it("records all as non_interactive_fallback when askEnabled=false", async () => {
		const tco = makeTco([{ key: "a" }]);
		const ui = makeNoopUI();
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true }, { enabled: false });
		expect(result.asked).toBe(0);
		expect(result.assumed).toBe(1);
		expect(tco.assumptions[0]?.reason).toBe("non_interactive_fallback");
	});

	it("records user_skipped on empty answer", async () => {
		const tco = makeTco([{ key: "positions" }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce(undefined);
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.asked).toBe(1);
		expect(result.assumed).toBe(1);
		expect(tco.assumptions[0]?.reason).toBe("user_skipped_required"); // required=true
	});

	it("records user_skipped (not required) on empty answer when required=false", async () => {
		const tco = makeTco([{ key: "budget", required: false }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce(undefined);
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.assumed).toBe(1);
		expect(tco.assumptions[0]?.reason).toBe("user_skipped");
	});

	it("appends answered list input to known_inputs split on commas", async () => {
		const tco = makeTco([{ key: "positions", type: "list" }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce("感知算法, 嵌入式");
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.answered).toBe(1);
		expect(tco.known_inputs).toHaveLength(1);
		expect(tco.known_inputs[0]?.key).toBe("positions");
		expect(tco.known_inputs[0]?.value).toEqual(["感知算法", "嵌入式"]);
		expect(tco.known_inputs[0]?.source).toBe("user");
	});

	it("parses number type", async () => {
		const tco = makeTco([{ key: "budget", type: "number" }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce("400");
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.answered).toBe(1);
		expect(tco.known_inputs[0]?.value).toBe(400);
	});

	it("parses confirm type (yes/no)", async () => {
		const tco = makeTco([{ key: "urgent", type: "confirm" }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce("y");
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.answered).toBe(1);
		expect(tco.known_inputs[0]?.value).toBe(true);
	});

	it("parses confirm type (no)", async () => {
		const tco = makeTco([{ key: "urgent", type: "confirm" }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce("n");
		const _result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(tco.known_inputs[0]?.value).toBe(false);
	});

	it("uses ui.select for select type", async () => {
		const tco = makeTco([{ key: "stage", type: "select", options: ["A", "B", "C"] }]);
		const ui = makeNoopUI();
		ui.select.mockResolvedValueOnce("A");
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.answered).toBe(1);
		expect(tco.known_inputs[0]?.value).toBe("A");
		expect(ui.select).toHaveBeenCalled();
		expect(ui.input).not.toHaveBeenCalled();
	});

	it("treats select without options as skipped", async () => {
		const tco = makeTco([{ key: "stage", type: "select", options: [] }]);
		const ui = makeNoopUI();
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.assumed).toBe(1);
	});

	it("treats invalid number as skipped", async () => {
		const tco = makeTco([{ key: "budget", type: "number" }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce("not a number");
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.assumed).toBe(1);
	});

	it("asks no questions when missing_inputs is empty", async () => {
		const tco = makeTco([]);
		const ui = makeNoopUI();
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(result.asked).toBe(0);
		expect(result.answered).toBe(0);
		expect(ui.input).not.toHaveBeenCalled();
	});

	it("records timeout as user_skipped", async () => {
		const tco = makeTco([{ key: "x" }]);
		const ui = makeNoopUI();
		// input never resolves → timeout
		ui.input.mockImplementation(() => new Promise(() => {}));
		const promise = askMissingInputs(tco, { ui: ui as never, hasUI: true }, { timeoutMs: 50 });
		// Advance fake timers past the 50ms timeout, then drain microtasks
		vi.advanceTimersByTime(60);
		await Promise.resolve();
		await Promise.resolve();
		const result = await promise;
		expect(result.timedOut).toBe(1);
		expect(tco.assumptions[0]?.reason).toBe("user_skipped_required");
	});

	// -----------------------------------------------------------------
	// defaultValue fallback (PR1 — see docs/moa-multi-round-design.md §2)
	// -----------------------------------------------------------------

	it("uses defaultValue in non-interactive fallback (list type)", async () => {
		const tco = makeTco([{ key: "positions", type: "list", defaultValue: ["感知算法", "嵌入式"] }]);
		const ui = makeNoopUI();
		const result = await askMissingInputs(tco, { ui: ui as never, hasUI: false });
		expect(result.assumed).toBe(1);
		expect(tco.assumptions[0]?.value).toEqual(["感知算法", "嵌入式"]);
	});

	it("uses defaultValue in non-interactive fallback (text type)", async () => {
		const tco = makeTco([{ key: "deadline", type: "text", required: false, defaultValue: "4 weeks" }]);
		const ui = makeNoopUI();
		await askMissingInputs(tco, { ui: ui as never, hasUI: false });
		expect(tco.assumptions[0]?.value).toBe("4 weeks");
	});

	it("uses defaultValue when user skips a question", async () => {
		const tco = makeTco([{ key: "positions", type: "list", defaultValue: ["A", "B"] }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce(undefined);
		await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(tco.assumptions[0]?.value).toEqual(["A", "B"]);
		expect(tco.assumptions[0]?.reason).toBe("user_skipped_required");
	});

	it("uses defaultValue on confirm type", async () => {
		const tco = makeTco([{ key: "urgent", type: "confirm", required: false, defaultValue: true }]);
		const ui = makeNoopUI();
		ui.input.mockResolvedValueOnce(undefined);
		await askMissingInputs(tco, { ui: ui as never, hasUI: true });
		expect(tco.assumptions[0]?.value).toBe(true);
	});

	it("falls back to type-default when defaultValue is undefined (regression)", async () => {
		const tco = makeTco([{ key: "positions", type: "list" }]); // no defaultValue
		const ui = makeNoopUI();
		await askMissingInputs(tco, { ui: ui as never, hasUI: false });
		expect(tco.assumptions[0]?.value).toEqual([]);
	});
});

// ============================================================================
// askQuestionsList — per-round ask (PR2)
// ============================================================================

import { type AskQuestionsListItem, askQuestionsList } from "../src/ask-user";

function makeItem(key: string, question: string, sourceWorkers: string[] = ["divergent"]): AskQuestionsListItem {
	return { key, question, type: "freeform", sourceWorkers };
}

function makeListUI(answers: Array<string | undefined>) {
	const calls: string[] = [];
	return {
		calls,
		select: vi.fn(async (msg: string) => {
			calls.push(msg);
			return answers.shift();
		}),
		input: vi.fn(async (msg: string) => {
			calls.push(msg);
			return answers.shift();
		}),
		notify: vi.fn(),
	};
}

describe("askQuestionsList", () => {
	it("answers, skips, and stops the loop on STOP", async () => {
		const ui = makeListUI(["answer to first", "", "STOP"]);
		const items: AskQuestionsListItem[] = [
			makeItem("divergent.0", "first?"),
			makeItem("divergent.1", "second?"),
			makeItem("divergent.2", "third?"),
		];
		const result = await askQuestionsList(items, { ui: ui as never, hasUI: true });
		expect(result.stopped).toBe(true);
		expect(result.answered.map(a => a.key)).toEqual(["divergent.0"]);
		expect(result.skipped.map(s => s.key)).toEqual(["divergent.1", "divergent.2"]);
		expect(result.skipped[1]?.reason).toBe("user_stopped");
	});

	it("non-interactive fallback returns all skipped, no stop", async () => {
		const ui = makeListUI([]);
		const items = [makeItem("a", "x"), makeItem("b", "y")];
		const result = await askQuestionsList(items, { ui: ui as never, hasUI: false });
		expect(result.stopped).toBe(false);
		expect(result.answered).toHaveLength(0);
		expect(result.skipped.every(s => s.reason === "non_interactive_fallback")).toBe(true);
	});

	it("asks select when type=choice", async () => {
		const ui = makeListUI(["choice A", ""]);
		const items: AskQuestionsListItem[] = [
			{ key: "x", question: "pick one", type: "choice", options: ["choice A", "choice B"], sourceWorkers: ["w"] },
		];
		const result = await askQuestionsList(items, { ui: ui as never, hasUI: true });
		expect(result.answered[0]?.answer).toBe("choice A");
		expect(ui.input).not.toHaveBeenCalled();
	});

	it("empty items returns zero counts and no stop", async () => {
		const ui = makeListUI([]);
		const result = await askQuestionsList([], { ui: ui as never, hasUI: true });
		expect(result.answered).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
		expect(result.stopped).toBe(false);
	});
});
