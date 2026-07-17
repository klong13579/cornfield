import { describe, expect, it, vi } from "bun:test";
import { createWorkerStreamSink } from "../src/stream-ui";
import { applyWorkerStreamEvent, type WorkerStreamState } from "../src/subprocess";

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

describe("createWorkerStreamSink (once-right P5)", () => {
	it("groups partials by worker name and paints a setWidget preview", () => {
		const setWidget = vi.fn();
		const sink = createWorkerStreamSink({ setWidget } as never, { throttleMs: 0, previewChars: 80 });
		sink.onPartial({ name: "divergent", text: "route A then B" });
		sink.onPartial({ name: "grounded", text: "cost check" });
		expect(setWidget).toHaveBeenCalled();
		const last = setWidget.mock.calls.at(-1);
		expect(last?.[0]).toBe("moa-workers");
		const lines = last?.[1] as string[];
		expect(lines.some(l => l.includes("divergent") && l.includes("route A"))).toBe(true);
		expect(lines.some(l => l.includes("grounded") && l.includes("cost check"))).toBe(true);
	});

	it("markStatus appends OK/BLOCKED without clearing other workers", () => {
		const setWidget = vi.fn();
		const sink = createWorkerStreamSink({ setWidget } as never, { throttleMs: 0 });
		sink.onPartial({ name: "divergent", text: "plan…" });
		sink.markStatus("divergent", "blocked");
		const lines = setWidget.mock.calls.at(-1)?.[1] as string[];
		expect(lines.some(l => /divergent.*BLOCKED/i.test(l))).toBe(true);
	});

	it("clear removes the widget", () => {
		const setWidget = vi.fn();
		const sink = createWorkerStreamSink({ setWidget } as never, { throttleMs: 0 });
		sink.onPartial({ name: "critical", text: "risks" });
		sink.clear();
		expect(setWidget).toHaveBeenCalledWith("moa-workers", undefined);
	});
});
