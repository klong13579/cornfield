import { describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { PiClientAdapter } from "../src/state/pi-client-adapter";

/**
 * get_agent_prompt_sources 的适配契约（F5）。
 *
 * 这一层只做两件事，两件都必须是原本的事实：
 *   1. 命令定向到**被问的那个 agent**（sessionId = agentId，不是「当前焦点」）；
 *   2. 逐项 `exists` 原样带出来 —— **一张不裁剪的清单**：缺的文件也在这份清单里，
 *      调用方（Prompts tab）才有得说「该建哪个 / 哪个没了」。裁成「存在的那些」等于
 *      把缺失本身藏起来，那是这份视图唯一的用处。
 *
 * 读不到（未知 agent / 连接断了）必须是抛错，不是空清单：空清单会被渲染成
 * 「这个 agent 没有任何 prompt 源」，与「没读到」是两句相反的话。
 */

let lastSocket: FakeSocket | undefined;

class FakeWebSocket implements PiWebSocketLike {
	readyState = 1;
	sent: string[] = [];
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;

	constructor(_url: string) {
		lastSocket = this;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}
}

const fakeCtor: PiWebSocketCtor = FakeWebSocket;

/** 刚创建的那个假 socket（connect() 里同步产生）。拿不到 = 用例自己的前提坏了，别静默跳过握手。 */
function currentSocket(): FakeWebSocket {
	if (!lastSocket) throw new Error("FakeWebSocket 未被创建：connect() 没走到 new WebSocket");
	return lastSocket;
}

async function connectAdapter(adapter: PiClientAdapter): Promise<void> {
	const connectPromise = adapter.connect();
	const socket = currentSocket();
	socket.onopen?.({});
	socket.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
}

function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastSocket?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

function lastCommand(): Record<string, unknown> {
	const reqs = sentRequests();
	return reqs[reqs.length - 1]!.command;
}

function respondOk(result: unknown): void {
	const reqs = sentRequests();
	currentSocket().receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: true, result }));
}

function respondError(error: unknown): void {
	const reqs = sentRequests();
	currentSocket().receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: false, error }));
}

describe("PiClientAdapter get_agent_prompt_sources", () => {
	it("命令定向被问的 agent，返回整份清单（缺的项留在里面）", async () => {
		lastSocket = undefined;
		const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
		try {
			await connectAdapter(adapter);

			const pending = adapter.getAgentPromptSources("hr");
			// 定向身份是 agentId（不是「当前焦点」）；frame 上的 id 是 pi-client 注入的关联 id，不属于命令内容
			expect(lastCommand()).toMatchObject({ type: "get_agent_prompt_sources", sessionId: "hr" });

			respondOk({
				sources: [
					{ path: "AGENTS.md", title: "硬约束与文件地图", description: "无条件读取。", exists: true },
					{ path: "user.md", title: "项目级人设", description: "本项目覆盖层。", exists: false },
				],
			});

			expect(await pending).toEqual([
				{ path: "AGENTS.md", title: "硬约束与文件地图", description: "无条件读取。", exists: true },
				{ path: "user.md", title: "项目级人设", description: "本项目覆盖层。", exists: false },
			]);
		} finally {
			adapter.disconnect();
		}
	});

	it("未知 agent（ok:false）抛错 —— 不渲染成一份空清单", async () => {
		lastSocket = undefined;
		const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.getAgentPromptSources("no-such-agent");
			respondError("unknown agent: no-such-agent");
			await expect(pending).rejects.toThrow("unknown agent: no-such-agent");
		} finally {
			adapter.disconnect();
		}
	});

	it("答复里没有 sources 数组（ok:true 但形状不对）→ 抛错，不当成空清单", async () => {
		lastSocket = undefined;
		const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.getAgentPromptSources("hr");
			respondOk({});
			await expect(pending).rejects.toThrow(/sources/);
		} finally {
			adapter.disconnect();
		}
	});
});
