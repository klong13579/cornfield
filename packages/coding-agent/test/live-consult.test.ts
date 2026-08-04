/**
 * LiveConsultBridge tests — fake session via the sessionFactory seam,
 * implementing the full ConsultSession interface (no partial mocks).
 */
import { describe, expect, test } from "bun:test";
import { LiveConsultBridge, type ConsultEvent, type ConsultSession } from "../src/live/consult-bridge";

class FakeConsultSession implements ConsultSession {
	sent: string[] = [];
	listeners: Array<(event: ConsultEvent) => void> = [];
	toolsSet: string[][] = [];
	failNextSend: Error | undefined;

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
		const bridge = new LiveConsultBridge({ sessionFactory: async () => session, onActivity: line => activity.push(line) });
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
});
