import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { SessionSnapshotDto } from "@cornfield/wire";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * SERVE-1 回归：在 hr 历史会话视图里发消息，页面零反馈（2026-09-01 线上事件）。
 *
 * 复盘：ComposerBar 默认 agent = agents[0] = "default"，与视图焦点（hr）脱节；prompt 投给了
 * default agent；serve 只给连接焦点 agent（hr）推帧，default 的回合帧被服务端过滤；前端又无
 * 乐观回显 → 页面什么都没有，消息实际进了 default 会话并已获得回复（日志可见）。
 *
 * 本测试锁两条修复契约：
 * 1. prompt 本地乐观回显（立即可见；权威快照替换；失败标错 + 错误提示条）
 * 2. switchSession 同步更新 view.activeAgentId（ComposerBar 跟随该值，不再只看 agents[0] 初值）
 */

let lastCreated: FakeWebSocket | undefined;
const createdAdapters: PiClientAdapter[] = [];

class FakeWebSocket implements PiWebSocketLike {
	readyState = 1;
	sent: string[] = [];
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;

	constructor(_url: string) {
		lastCreated = this;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}
}

// FakeWebSocket 是合法的 PiWebSocketCtor（new (url) => PiWebSocketLike）。
const fakeCtor: PiWebSocketCtor = FakeWebSocket;
const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

afterEach(() => {
	for (const adapter of createdAdapters) adapter.disconnect();
	createdAdapters.length = 0;
});

/** 解析已发出的 request 帧（不含 hello/ping）。 */
function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

/** 用当前最新 request 帧的 id 回失败响应。 */
function respondError(error: string): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: false, error }));
}

/** 新建 store + 真 PiClientAdapter（假 WebSocket），完成 hello 握手。 */
async function createConnectedStore(): Promise<{ store: SessionStore; adapter: PiClientAdapter }> {
	lastCreated = undefined;
	const adapter = new PiClientAdapter(config, fakeCtor);
	createdAdapters.push(adapter);
	const store = new SessionStore();
	store.init(adapter);
	const connectPromise = store.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
	return { store, adapter };
}

describe("SERVE-1：prompt 乐观回显", () => {
	it("发送即回显到当前转录，请求帧携带目标 sessionId", async () => {
		const { store } = await createConnectedStore();

		store.prompt("候选人的履历发我看看", "hr");

		const view = store.getSnapshot();
		const echo = view.messages.find(m => m.id.startsWith("echo-"));
		expect(echo).toBeDefined();
		expect(echo?.role).toBe("user");
		expect(echo?.text).toBe("候选人的履历发我看看");
		expect(echo?.done).toBe(false);
		expect(echo?.error).toBeUndefined();

		const req = sentRequests().at(-1);
		expect(req?.command).toMatchObject({ type: "prompt", message: "候选人的履历发我看看", sessionId: "hr" });
	});

	it("目标 agent 的权威快照到达后，回显被真实消息替换", async () => {
		const { store } = await createConnectedStore();
		store.prompt("hello", "hr");
		expect(store.getSnapshot().messages.some(m => m.id.startsWith("echo-"))).toBe(true);

		const snapshot: SessionSnapshotDto = {
			seq: 2,
			phase: "idle",
			retryAttempt: 0,
			isCompacting: false,
			isStreaming: false,
			sessionId: "hr-sess-1",
			sessionName: "hr",
			model: { provider: "narwal-plan", id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
			messages: [
				{ id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
				{ id: "m2", role: "assistant", content: [{ type: "text", text: "reply" }] },
			],
			messageEntryIds: { m1: "e1", m2: "e2" },
			todoPhases: [],
			activeToolNames: [],
			queuedMessageCount: 0,
			autoCompactionEnabled: false,
			autoRetryEnabled: false,
		};
		lastCreated?.receive(
			JSON.stringify({ type: "push", event: { type: "session_snapshot", sessionId: "hr", snapshot } }),
		);

		const view = store.getSnapshot();
		expect(view.messages.some(m => m.id.startsWith("echo-"))).toBe(false);
		expect(view.messages.map(m => m.id)).toEqual(["m1", "m2"]);
		expect(view.messages[0]?.text).toBe("hello");
		expect(view.messages[1]?.text).toBe("reply");
	});

	it("发送失败：命令错误提示条 + 回显消息标错（不悬挂发送中）", async () => {
		const { store } = await createConnectedStore();
		store.prompt("hello", "hr");

		respondError("agent not attached: hr");
		await Bun.sleep(0);

		const view = store.getSnapshot();
		expect(view.commandError).toContain("命令失败");
		const echo = view.messages.find(m => m.id.startsWith("echo-"));
		// WirePiClient 会包装服务端错误文本（如 `Server rejected "prompt": agent not attached: hr`）
		expect(echo?.error).toContain("agent not attached: hr");
		expect(echo?.done).toBe(true);
	});
});

describe("SERVE-1：agent 视图焦点", () => {
	it("switchSession 同步更新 activeAgentId（ComposerBar 跟随契约）", async () => {
		const { store } = await createConnectedStore();
		store.switchSession("hr");

		expect(store.getSnapshot().activeAgentId).toBe("hr");

		const req = sentRequests().at(-1);
		expect(req?.command).toMatchObject({ type: "switch_session", sessionId: "hr" });
	});
});
