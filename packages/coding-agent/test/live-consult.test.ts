/**
 * LiveConsultBridge tests — fake session via the sessionFactory seam,
 * implementing the full ConsultSession interface (no partial mocks).
 */
import { describe, expect, test } from "bun:test";
import { type ConsultEvent, type ConsultSession, LiveConsultBridge } from "../src/live/consult-bridge";

class FakeConsultSession implements ConsultSession {
	sent: string[] = [];
	listeners: Array<(event: ConsultEvent) => void> = [];
	toolsSet: string[][] = [];
	failNextSend: Error | undefined;
	aborted = 0;
	streaming = false;

	async sendUserMessage(text: string): Promise<void> {
		if (this.failNextSend) {
			const err = this.failNextSend;
			this.failNextSend = undefined;
			throw err;
		}
		this.sent.push(text);
	}

	subscribe(listener: (event: ConsultEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i >= 0) this.listeners.splice(i, 1);
		};
	}

	abort(): Promise<void> {
		this.aborted += 1;
		return Promise.resolve();
	}

	get isStreaming(): boolean {
		return this.streaming;
	}


	agent = {
		state: { tools: [{ name: "read" }, { name: "bash" }] },
		setTools: (tools: unknown[]): void => {
			this.toolsSet.push((tools as Array<{ name: string }>).map(t => t.name));
		},
	};

	emit(event: ConsultEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

function assistantMessages(text: string): unknown {
	return [
		{ role: "user", content: "task" },
		{ role: "assistant", content: [{ type: "text", text }] },
	];
}

describe("LiveConsultBridge", () => {
	test("consult sends task and resolves with the assistant text on agent_end", async () => {
		const session = new FakeConsultSession();
		const bridge = new LiveConsultBridge({ sessionFactory: async () => session });
		const pending = bridge.consult("查一下 TODO 有几条");
		await Bun.sleep(10);
		expect(session.sent).toEqual(["查一下 TODO 有几条"]);
		session.emit({ type: "agent_end", messages: assistantMessages("TODO 里有 3 条待办。") });
		expect(await pending).toBe("TODO 里有 3 条待办。");
	});

	test("session is created once and reused", async () => {
		const session = new FakeConsultSession();
		let created = 0;
		const bridge = new LiveConsultBridge({
			sessionFactory: async () => {
				created++;
				return session;
			},
		});
		const first = bridge.consult("任务一");
		await Bun.sleep(10);
		session.emit({ type: "agent_end", messages: assistantMessages("一") });
		await first;
		const second = bridge.consult("任务二");
		await Bun.sleep(10);
		session.emit({ type: "agent_end", messages: assistantMessages("二") });
		await second;
		expect(created).toBe(1);
		expect(session.sent).toEqual(["任务一", "任务二"]);
	});

	test("tool activity lines are forwarded", async () => {
		const session = new FakeConsultSession();
		const activity: string[] = [];
		const bridge = new LiveConsultBridge({
			sessionFactory: async () => session,
			onActivity: line => activity.push(line),
		});
		const pending = bridge.consult("读 TODO.md");
		await Bun.sleep(10);
		session.emit({ type: "tool_execution_start", toolName: "read", args: { path: "TODO.md" } });
		session.emit({ type: "tool_execution_start", toolName: "search", args: { pattern: "待办" } });
		session.emit({ type: "agent_end", messages: assistantMessages("3 条。") });
		await pending;
		expect(activity).toEqual(["read: TODO.md", "search: 待办"]);
	});

	test("timeout resolves with a spoken-friendly message", async () => {
		const session = new FakeConsultSession();
		const bridge = new LiveConsultBridge({ sessionFactory: async () => session, timeoutMs: 50 });
		const result = await bridge.consult("永远不会结束的任务");
		expect(result).toContain("超时");
	});

	test("timed-out task finishing late fires onBackgroundResult (design §5)", async () => {
		const session = new FakeConsultSession();
		const background: Array<{ task: string; text: string }> = [];
		const bridge = new LiveConsultBridge({
			sessionFactory: async () => session,
			timeoutMs: 30,
			onBackgroundResult: (task, text) => background.push({ task, text }),
		});

		const result = await bridge.consult("很慢的任务");
		expect(result).toContain("超时");

		// The task finishes after the timeout — the late result must still surface.
		session.emit({ type: "agent_end", messages: assistantMessages("迟到的结果。") });
		expect(background).toEqual([{ task: "很慢的任务", text: "迟到的结果。" }]);
	});

	test("send failure resolves with an error message, not a throw", async () => {
		const session = new FakeConsultSession();
		session.failNextSend = new Error("model overloaded");
		const bridge = new LiveConsultBridge({ sessionFactory: async () => session });
		const result = await bridge.consult("任务");
		expect(result).toContain("model overloaded");
	});

	test("assistant text extraction handles string content and missing text", async () => {
		const session = new FakeConsultSession();
		const bridge = new LiveConsultBridge({ sessionFactory: async () => session });
		const pending = bridge.consult("任务");
		await Bun.sleep(10);
		session.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: "纯文本回答" }],
		});
		expect(await pending).toBe("纯文本回答");

		const pending2 = bridge.consult("任务2");
		await Bun.sleep(10);
		session.emit({ type: "agent_end", messages: [{ role: "assistant", content: [] }] });
		expect(await pending2).toContain("没有产生可播报的结果");
	});

	// ------------------------------------------------------------- cancel ---

	test("abortCurrent cancels the in-flight consult and suppresses the result", async () => {
		const session = new FakeConsultSession();
		const bridge = new LiveConsultBridge({ sessionFactory: async () => session });
		expect(bridge.busy).toBe(false);
		expect(bridge.abortCurrent()).toBe(false); // nothing running

		const pending = bridge.consult("查天气");
		await Bun.sleep(10);
		expect(bridge.busy).toBe(true);

		expect(bridge.abortCurrent()).toBe(true);
		expect(session.aborted).toBe(1);

		// The aborted agent_end resolves with the cancellation closure — the
		// real result (arriving late or not) can never be spoken.
		session.emit({ type: "agent_end", messages: assistantMessages("迟到的结果") });
		expect(await pending).toContain("已被用户取消");
		expect(bridge.busy).toBe(false);
	});

	test("cancel after timeout delivers the closure to the background path", async () => {
		const session = new FakeConsultSession();
		const background: Array<{ task: string; text: string }> = [];
		const bridge = new LiveConsultBridge({
			sessionFactory: async () => session,
			timeoutMs: 30,
			onBackgroundResult: (task, text) => background.push({ task, text }),
		});

		const result = await bridge.consult("很慢的查询");
		expect(result).toContain("超时");

		expect(bridge.abortCurrent()).toBe(true);
		session.emit({ type: "agent_end", messages: assistantMessages("迟到的结果") });
		expect(background.length).toBe(1);
		expect(background[0]!.text).toContain("已被用户取消");
		expect(background[0]!.text).not.toContain("迟到的结果");
	});

	test("activity tracks the in-flight consult for status reports", async () => {
		const session = new FakeConsultSession();
		const bridge = new LiveConsultBridge({ sessionFactory: async () => session });
		const pending = bridge.consult("读文件");
		await Bun.sleep(10);
		session.emit({ type: "tool_execution_start", toolName: "read", args: { path: "TODO.md" } });
		expect(bridge.activity).toBe("read: TODO.md");
		session.emit({ type: "agent_end", messages: assistantMessages("完成") });
		await pending;
		expect(bridge.activity).toBeUndefined();
	});

	test("cancel state survives a later consult's send failure (per-invocation)", async () => {
		const session = new FakeConsultSession();
		const bridge = new LiveConsultBridge({ sessionFactory: async () => session });
		const first = bridge.consult("查询一");
		await Bun.sleep(10);
		expect(bridge.abortCurrent()).toBe(true);

		// A second consult attempt fails at send — must not clobber the first
		// invocation's cancelled state (the 23:53 live-acceptance regression).
		session.failNextSend = new Error("busy");
		const second = await bridge.consult("查询二");
		expect(second).toContain("任务发送失败");

		// The first consult's late agent_end still resolves as cancelled.
		session.emit({ type: "agent_end", messages: assistantMessages("迟到的结果") });
		expect(await first).toContain("已被用户取消");
	});

	test("busy session is replaced with a fresh one instead of erroring", async () => {
		const oldSession = new FakeConsultSession();
		oldSession.streaming = true; // a cancelled turn still draining
		const freshSession = new FakeConsultSession();
		let created = 0;
		const bridge = new LiveConsultBridge({
			sessionFactory: async () => {
				created += 1;
				return created === 1 ? oldSession : freshSession;
			},
		});

		const pending = bridge.consult("新查询");
		await Bun.sleep(10);
		expect(created).toBe(2);
		expect(oldSession.sent).toEqual([]);
		expect(freshSession.sent).toEqual(["新查询"]);

		freshSession.emit({ type: "agent_end", messages: assistantMessages("结果") });
		expect(await pending).toBe("结果");
	});
});
