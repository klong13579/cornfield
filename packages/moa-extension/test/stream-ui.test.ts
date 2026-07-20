import { describe, expect, it, vi } from "bun:test";
import {
	buildWorkerStreamLines,
	createWorkerStreamSink,
	previewMultilineTail,
	type WorkerStreamTheme,
} from "../src/stream-ui";
import { applyWorkerStreamEvent, type WorkerStreamState } from "../src/subprocess";

const plainTheme: WorkerStreamTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: text => text,
	spinnerFrames: ["⠋", "⠙", "⠹"],
};

describe("applyWorkerStreamEvent (once-right P5)", () => {
	it("accumulates text_delta from message_update and calls onPartial with cumulative text", () => {
		const partials: string[] = [];
		const state: WorkerStreamState = { text: "" };
		applyWorkerStreamEvent(
			{
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello" }],
				},
				assistantMessageEvent: { type: "text_delta", delta: "Hello" },
			},
			state,
			t => partials.push(t),
		);
		applyWorkerStreamEvent(
			{
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello world" }],
				},
				assistantMessageEvent: { type: "text_delta", delta: " world" },
			},
			state,
			t => partials.push(t),
		);
		expect(partials).toEqual(["Hello", "Hello world"]);
		expect(state.text).toBe("Hello world");
	});

	it("updates from message_end assistant text", () => {
		const partials: string[] = [];
		const state: WorkerStreamState = { text: "" };
		applyWorkerStreamEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "final plan body" }],
				},
			},
			state,
			t => partials.push(t),
		);
		expect(partials).toEqual(["final plan body"]);
	});

	it("ignores non-streaming / non-assistant events", () => {
		const onPartial = vi.fn();
		const state: WorkerStreamState = { text: "" };
		applyWorkerStreamEvent({ type: "tool_execution_start" }, state, onPartial);
		applyWorkerStreamEvent(
			{
				type: "message_update",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			},
			state,
			onPartial,
		);
		expect(onPartial).not.toHaveBeenCalled();
		expect(state.text).toBe("");
	});
});

describe("previewMultilineTail", () => {
	it("returns the last N lines without flattening", () => {
		const text = ["## plan", "line1", "line2", "line3", "line4"].join("\n");
		expect(previewMultilineTail(text, 3, 500)).toEqual(["line2", "line3", "line4"]);
	});

	it("caps total characters while keeping line breaks", () => {
		const text = "aaaa\nbbbb\ncccc\ndddd";
		const lines = previewMultilineTail(text, 10, 12);
		expect(lines.join("\n").length).toBeLessThanOrEqual(12);
		expect(lines.some(l => l.includes("\n"))).toBe(false);
	});
});

describe("buildWorkerStreamLines", () => {
	it("renders multi-line blocks with status labels", () => {
		const lines = buildWorkerStreamLines(
			[
				{ name: "divergent", text: "## plan\nroute A\nroute B\nroute C", status: "streaming" },
				{ name: "grounded", text: "cost check", status: "ok" },
			],
			plainTheme,
			{ previewLines: 4, previewChars: 200, spinnerFrame: 0 },
		);
		const joined = lines.join("\n");
		expect(joined).toContain("MOA workers");
		expect(joined).toMatch(/divergent.*streaming/i);
		expect(joined).toContain("route B");
		expect(joined).toContain("route C");
		expect(joined).toMatch(/grounded.*OK/i);
		expect(joined).toContain("⠋"); // spinner for streaming
	});

	it("uses FAILED label for failed slots", () => {
		const lines = buildWorkerStreamLines(
			[{ name: "critical", text: "boom", status: "failed" }],
			plainTheme,
			{ previewLines: 2, previewChars: 80, spinnerFrame: 0 },
		);
		expect(lines.join("\n")).toMatch(/critical.*FAILED/i);
	});
});

describe("createWorkerStreamSink (once-right P5)", () => {
	function paintLines(setWidget: ReturnType<typeof vi.fn>): string {
		const content = setWidget.mock.calls.at(-1)?.[1];
		if (typeof content === "function") {
			const comp = content({}, plainTheme) as { render: (w: number) => string[] };
			return comp.render(120).join("\n");
		}
		if (Array.isArray(content)) return content.join("\n");
		return "";
	}

	it("groups partials by worker name and paints a themed multi-line widget", () => {
		const setWidget = vi.fn();
		const sink = createWorkerStreamSink({ setWidget } as never, {
			throttleMs: 0,
			previewChars: 200,
			previewLines: 4,
		});
		sink.onPartial({ name: "divergent", text: "## plan\nroute A\nroute B" });
		sink.onPartial({ name: "grounded", text: "cost check" });
		expect(setWidget).toHaveBeenCalled();
		expect(setWidget.mock.calls.at(-1)?.[0]).toBe("moa-workers");
		const painted = paintLines(setWidget);
		expect(painted).toContain("divergent");
		expect(painted).toContain("route A");
		expect(painted).toContain("route B");
		expect(painted).toContain("grounded");
		expect(painted).toContain("cost check");
	});

	it("markStatus appends OK/BLOCKED without clearing other workers", () => {
		const setWidget = vi.fn();
		const sink = createWorkerStreamSink({ setWidget } as never, { throttleMs: 0 });
		sink.onPartial({ name: "divergent", text: "plan…" });
		sink.markStatus("divergent", "blocked");
		expect(paintLines(setWidget)).toMatch(/divergent.*BLOCKED/i);
	});

	it("clear removes the widget", () => {
		const setWidget = vi.fn();
		const sink = createWorkerStreamSink({ setWidget } as never, { throttleMs: 0 });
		sink.onPartial({ name: "critical", text: "risks" });
		sink.clear();
		expect(setWidget).toHaveBeenCalledWith("moa-workers", undefined);
	});
});
