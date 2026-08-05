/**
 * LiveTaskRouter tests — main-session routing (P1 design §4): busy semantics,
 * fail-closed gate check, plan-mode refusal, lifecycle, summary clipping.
 */
import { describe, expect, test } from "bun:test";
import type { Extension } from "../src/extensibility/extensions/types";
import { LiveTaskRouter, type TaskRouterEvent, type TaskRouterSession } from "../src/live/task-router";
import { VoiceGate } from "../src/live/voice-gate";

class FakeTaskSession implements TaskRouterSession {
	sent: string[] = [];
	sentOptions: Array<{ deliverAs?: "steer" | "followUp" } | undefined> = [];
	listeners: Array<(event: TaskRouterEvent) => void> = [];
	streaming = false;
	aborted = 0;
	failNextSend: Error | undefined;

	async sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> {
		if (this.failNextSend) {
			const err = this.failNextSend;
			this.failNextSend = undefined;
			throw err;
		}
		this.sent.push(text);
		this.sentOptions.push(options);
	}

	subscribe(listener: (event: TaskRouterEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	abort(): Promise<void> {
		this.aborted += 1;
		return Promise.resolve();
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	emit(event: TaskRouterEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

function armedGate(): VoiceGate {
	const gate = new VoiceGate({ channel: { speak: () => true } });
	gate.arm({
		addInternalExtension: (_extension: Extension) => () => {},
	});
	return gate;
}

function assistantMessages(text: string): unknown {
	return [
		{ role: "user", content: "task" },
		{ role: "assistant", content: [{ type: "text", text }] },
	];
}

describe("LiveTaskRouter", () => {
	test("injects the task and resolves with the agent_end summary", async () => {
		const session = new FakeTaskSession();
		const gate = armedGate();
		const activity: string[] = [];
		const router = new LiveTaskRouter({ session, gate, onActivity: line => activity.push(line) });

		const pending = router.dispatch("把 TODO.md 第一条标完成");
		await Bun.sleep(10);
		expect(session.sent).toEqual(["把 TODO.md 第一条标完成"]);
		expect(gate.inFlight).toBe(true);

		session.emit({ type: "tool_execution_start", toolName: "edit", args: { path: "TODO.md" } });
		session.emit({ type: "agent_end", messages: assistantMessages("改完了，两处，测试通过。") });
		expect(await pending).toBe("改完了，两处，测试通过。");
		expect(gate.inFlight).toBe(false);
		expect(activity).toEqual(["edit: TODO.md"]);
	});

	test("summaries are clipped to protect the realtime context", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate(), summaryMaxChars: 20 });
		const pending = router.dispatch("任务");
		await Bun.sleep(10);
		session.emit({ type: "agent_end", messages: assistantMessages("很长的结果".repeat(50)) });
		const summary = await pending;
		expect(summary.length).toBeLessThanOrEqual(21);
		expect(summary.endsWith("…")).toBe(true);
	});

	test("busy session (any origin) is refused before injection", async () => {
		const session = new FakeTaskSession();
		session.streaming = true;
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		const result = await router.dispatch("任务");
		expect(result).toContain("还在执行中");
		expect(session.sent).toEqual([]);
	});

	test("plan mode session refuses the task path", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate(), isPlanMode: () => true });
		expect(await router.dispatch("任务")).toContain("plan mode");
		expect(session.sent).toEqual([]);
	});

	test("fail-closed: unarmed gate refuses the task path", async () => {
		const session = new FakeTaskSession();
		const gate = new VoiceGate({ channel: { speak: () => true } }); // never armed
		const router = new LiveTaskRouter({ session, gate });
		expect(await router.dispatch("任务")).toContain("确认门不可用");
		expect(session.sent).toEqual([]);
	});

	test("send failure resolves with an error text and closes the gate scope", async () => {
		const session = new FakeTaskSession();
		session.failNextSend = new Error("boom");
		const gate = armedGate();
		const router = new LiveTaskRouter({ session, gate });
		const result = await router.dispatch("任务");
		expect(result).toContain("任务发送失败");
		expect(gate.inFlight).toBe(false);
	});

	test("agent_end without assistant text still resolves speakably", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		const pending = router.dispatch("任务");
		await Bun.sleep(10);
		session.emit({ type: "agent_end", messages: [] });
		expect(await pending).toContain("没有产生可播报的结果");
	});

	test("dispatch after dispose reports the exited mode", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		router.dispose();
		expect(await router.dispatch("任务")).toContain("已退出");
		expect(session.sent).toEqual([]);
	});

	// ---------------------------------------------------------------- P1b ---

	test("status reports: idle, thinking, and current tool activity", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		expect(router.status()).toContain("没有在跑");

		const pending = router.dispatch("任务");
		await Bun.sleep(10);
		expect(router.status()).toContain("还在思考");

		session.emit({ type: "tool_execution_start", toolName: "bash", args: { command: "bun test" } });
		expect(router.status()).toContain("bun test");

		session.emit({ type: "agent_end", messages: assistantMessages("完成") });
		await pending;
		expect(router.status()).toContain("没有在跑");
	});

	test("steer injects with deliverAs steer while a task runs", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		const pending = router.dispatch("任务");
		await Bun.sleep(10);

		expect(await router.steer("先看 src/foo.ts")).toContain("已把补充指示");
		expect(session.sent).toEqual(["任务", "先看 src/foo.ts"]);
		expect(session.sentOptions[1]).toEqual({ deliverAs: "steer" });

		session.emit({ type: "agent_end", messages: assistantMessages("完成") });
		await pending;
	});

	test("steer without a running task declines friendly", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		expect(await router.steer("先看 X")).toContain("没有在跑");
		expect(session.sent).toEqual([]);
	});

	test("steer send failure reports the error", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		const pending = router.dispatch("任务");
		await Bun.sleep(10);
		session.failNextSend = new Error("boom");
		expect(await router.steer("指示")).toContain("没能送达");
		session.emit({ type: "agent_end", messages: assistantMessages("完成") });
		await pending;
	});

	test("cancel aborts the session and confirms", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		const pending = router.dispatch("任务");
		await Bun.sleep(10);

		expect(await router.cancel()).toContain("已停止");
		expect(session.aborted).toBe(1);

		session.emit({ type: "agent_end", messages: [] });
		await pending;
	});

	test("cancel without a running task declines", async () => {
		const session = new FakeTaskSession();
		const router = new LiveTaskRouter({ session, gate: armedGate() });
		expect(await router.cancel()).toContain("没有在跑");
		expect(session.aborted).toBe(0);
	});
});
