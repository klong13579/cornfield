/**
 * VoiceGate tests — the tiered confirmation gate (P1 design §5).
 * Fake channel + fake runner implementing the real addInternalExtension /
 * emitToolCall contract (no partial mocks).
 */
import { describe, expect, test } from "bun:test";
import type { Extension, ToolCallEvent, ToolCallEventResult } from "../src/extensibility/extensions/types";
import { VoiceGate } from "../src/live/voice-gate";

class FakeChannel {
	notes: string[] = [];
	available = true;
	speak(text: string): boolean {
		if (!this.available) return false;
		this.notes.push(text);
		return true;
	}
}

class FakeRunner {
	extensions: Extension[] = [];
	addInternalExtension(extension: Extension): () => void {
		this.extensions.push(extension);
		return () => {
			const index = this.extensions.indexOf(extension);
			if (index !== -1) this.extensions.splice(index, 1);
		};
	}
	/** Mirrors ExtensionRunner.emitToolCall: first block wins. */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		let result: ToolCallEventResult | undefined;
		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("tool_call") ?? []) {
				const handlerResult = (await handler(event, undefined)) as ToolCallEventResult | undefined;
				if (handlerResult) {
					result = handlerResult;
					if (result.block) return result;
				}
			}
		}
		return result;
	}
}

function toolCall(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
	return { type: "tool_call", toolName, toolCallId: "t1", input };
}

function makeGate(
	channel = new FakeChannel(),
	confirmTimeoutMs = 1_000,
): { gate: VoiceGate; runner: FakeRunner; channel: FakeChannel } {
	const gate = new VoiceGate({ channel, confirmTimeoutMs });
	const runner = new FakeRunner();
	gate.arm(runner);
	return { gate, runner, channel };
}

describe("VoiceGate", () => {
	test("does not intervene outside a voice task (typed turns stay ungated)", async () => {
		const { gate, runner } = makeGate();
		expect(await runner.emitToolCall(toolCall("edit", { path: "a" }))).toBeUndefined();
		gate.beginTask();
		gate.endTask();
		expect(await runner.emitToolCall(toolCall("edit", { path: "a" }))).toBeUndefined();
	});

	test("green tools execute without confirmation during a task", async () => {
		const { gate, runner, channel } = makeGate();
		gate.beginTask();
		expect(await runner.emitToolCall(toolCall("read", { path: "a" }))).toBeUndefined();
		expect(channel.notes).toEqual([]);
	});

	test("yellow tool asks once; confirm executes; sticky covers repeats", async () => {
		const { gate, runner, channel } = makeGate();
		gate.beginTask();

		const first = runner.emitToolCall(toolCall("edit", { path: "src/foo.ts" }));
		await Bun.sleep(10);
		expect(gate.confirmationPending).toBe(true);
		expect(channel.notes.length).toBe(1);
		expect(channel.notes[0]).toContain("src/foo.ts");

		gate.resolveDecision("confirm");
		expect(await first).toBeUndefined();

		// Sticky within the task: no second question for the same tool.
		expect(await runner.emitToolCall(toolCall("edit", { path: "src/bar.ts" }))).toBeUndefined();
		expect(channel.notes.length).toBe(1);
	});

	test("sticky does not cover a different yellow tool", async () => {
		const { gate, runner, channel } = makeGate();
		gate.beginTask();

		const first = runner.emitToolCall(toolCall("edit", { path: "a" }));
		await Bun.sleep(10);
		gate.resolveDecision("confirm");
		await first;

		const second = runner.emitToolCall(toolCall("write", { path: "b" }));
		await Bun.sleep(10);
		expect(gate.confirmationPending).toBe(true);
		expect(channel.notes.length).toBe(2);
		gate.resolveDecision("confirm");
		expect(await second).toBeUndefined();
	});

	test("red tool asks every time — never sticky", async () => {
		const { gate, runner, channel } = makeGate();
		gate.beginTask();

		const first = runner.emitToolCall(toolCall("bash", { command: "rm -rf dist" }));
		await Bun.sleep(10);
		gate.resolveDecision("confirm");
		await first;

		const second = runner.emitToolCall(toolCall("bash", { command: "rm -rf dist" }));
		await Bun.sleep(10);
		expect(gate.confirmationPending).toBe(true);
		expect(channel.notes.filter(note => note.includes("需要用户确认")).length).toBe(2);
		gate.resolveDecision("confirm");
		expect(await second).toBeUndefined();
	});

	test("cancel blocks with an agent-readable reason and a closure note", async () => {
		const { gate, runner, channel } = makeGate();
		gate.beginTask();

		const pending = runner.emitToolCall(toolCall("write", { path: "a.md" }));
		await Bun.sleep(10);
		gate.resolveDecision("cancel");
		const result = await pending;
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("取消");
		expect(result?.reason).toContain("写入 a.md");
		expect(channel.notes.some(note => note.includes("取消了该操作"))).toBe(true);
	});

	test("timeout blocks — never defaults to execute", async () => {
		const { gate, runner } = makeGate(new FakeChannel(), 20);
		gate.beginTask();
		const result = await runner.emitToolCall(toolCall("edit", { path: "a" }));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("取消");
	});

	test("unclear asks again once, then gives up (two-strike rule)", async () => {
		const { gate, runner, channel } = makeGate();
		gate.beginTask();

		const pending = runner.emitToolCall(toolCall("edit", { path: "a" }));
		await Bun.sleep(10);
		gate.resolveDecision("unclear");
		await Bun.sleep(10);
		expect(channel.notes.filter(note => note.includes("再次询问")).length).toBe(1);

		gate.resolveDecision("unclear");
		const result = await pending;
		expect(result?.block).toBe(true);
		expect(channel.notes.some(note => note.includes("放弃执行"))).toBe(true);
	});

	test("unclear then confirm still executes", async () => {
		const { gate, runner } = makeGate();
		gate.beginTask();
		const pending = runner.emitToolCall(toolCall("edit", { path: "a" }));
		await Bun.sleep(10);
		gate.resolveDecision("unclear");
		await Bun.sleep(10);
		gate.resolveDecision("confirm");
		expect(await pending).toBeUndefined();
	});

	test("disarm settles a pending confirmation as cancel and unregisters", async () => {
		const { gate, runner } = makeGate();
		gate.beginTask();
		const pending = runner.emitToolCall(toolCall("edit", { path: "a" }));
		await Bun.sleep(10);
		gate.disarm();
		const result = await pending;
		expect(result?.block).toBe(true);
		expect(runner.extensions.length).toBe(0);
		expect(gate.armed).toBe(false);
	});

	test("channel unavailable fails safe as cancel", async () => {
		const channel = new FakeChannel();
		channel.available = false;
		const { gate, runner } = makeGate(channel);
		gate.beginTask();
		const result = await runner.emitToolCall(toolCall("edit", { path: "a" }));
		expect(result?.block).toBe(true);
	});

	test("parallel tool calls serialize confirmations — one question at a time", async () => {
		const { gate, runner, channel } = makeGate();
		gate.beginTask();

		const first = runner.emitToolCall(toolCall("edit", { path: "a" }));
		const second = runner.emitToolCall(toolCall("write", { path: "b" }));
		await Bun.sleep(10);
		expect(channel.notes.length).toBe(1); // the second waits its turn

		gate.resolveDecision("confirm");
		await Bun.sleep(10);
		expect(channel.notes.length).toBe(2); // write is not sticky-covered by edit

		gate.resolveDecision("confirm");
		expect(await first).toBeUndefined();
		expect(await second).toBeUndefined();
	});

	test("endTask during a pending confirmation settles it as cancel (stop mid-confirm)", async () => {
		const { gate, runner } = makeGate();
		gate.beginTask();
		const pending = runner.emitToolCall(toolCall("edit", { path: "a" }));
		await Bun.sleep(10);
		expect(gate.confirmationPending).toBe(true);

		// The task was aborted (user said stop) — the pending question must
		// settle as cancel and the tool must be blocked, never left hanging.
		gate.endTask();
		const result = await pending;
		expect(result?.block).toBe(true);
		expect(gate.confirmationPending).toBe(false);
	});
});
