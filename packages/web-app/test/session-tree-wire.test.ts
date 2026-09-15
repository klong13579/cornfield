import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { AgentInfoDto } from "@cornfield/wire";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * T8：Session Tree（委派账本 + 结果带回）与 Agent 隔离的客户端契约。
 *
 * 用真 SessionStore + 真 PiClientAdapter + 假 WebSocket：验的是「帧怎么出去、状态怎么落」，
 * 不是 serve 的账本逻辑（那在 coding-agent/test/server/session-tree-wire.test.ts）。
 *
 * 两条被钉住的不变量：
 *   1. 读不到 ≠ 没有子会话（失败必须显示错误，不能渲染空树）
 *   2. 换 Agent 后，上一个 Agent 的转录与子树都不留在屏幕上
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

const fakeCtor: PiWebSocketCtor = FakeWebSocket;
const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

afterEach(() => {
	for (const adapter of createdAdapters) adapter.disconnect();
	createdAdapters.length = 0;
});

function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

/** 用当前最新 request 帧的 id 回一个响应（result 为 serve 的 response.result）。 */
function respond(result: unknown): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: true, result }));
}

function respondError(error: string): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: false, error }));
}

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

const CHILD = {
	sessionId: "child-1",
	parentSessionId: "sess-root",
	rootSessionId: "sess-root",
	depth: 1,
	agentId: "hr",
	status: "completed",
	delegationRole: "research",
	objective: "研究编辑器方案",
	resultRef: "/tmp/result.md",
	createdAt: 1_000,
	updatedAt: 2_000,
} as const;

describe("Session Tree 读取", () => {
	it("get_session_tree 定向当前 Agent，结果落进 view.sessionTree", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshSessionTree("hr");

		const request = sentRequests().at(-1);
		expect(request?.command).toMatchObject({ type: "get_session_tree", sessionId: "hr" });
		expect(store.getSnapshot().sessionTreeLoading).toBe(true);

		respond({ sessionId: "sess-root", agentId: "hr", agentName: "HR", children: [CHILD] });
		await pending;

		const view = store.getSnapshot();
		expect(view.sessionTreeLoading).toBe(false);
		expect(view.sessionTreeError).toBeUndefined();
		expect(view.sessionTree?.children).toHaveLength(1);
		expect(view.sessionTree?.children[0]?.objective).toBe("研究编辑器方案");
	});

	it("明确空账本 = children: []，不是错误", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshSessionTree("hr");
		respond({ sessionId: "sess-root", children: [] });
		await pending;

		expect(store.getSnapshot().sessionTree?.children).toEqual([]);
		expect(store.getSnapshot().sessionTreeError).toBeUndefined();
	});

	it("读取失败显示错误，且不伪装成空树", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshSessionTree("hr");
		respondError("session tree entry 3: snapshot version 99 is not readable");
		await pending;

		const view = store.getSnapshot();
		expect(view.sessionTreeError).toContain("version 99");
		expect(view.sessionTree).toBeUndefined();
		expect(view.sessionTreeLoading).toBe(false);
	});
});

describe("结果带回", () => {
	it("bring_back_child_result 后刷新账本，并返回 serve 的原始结果", async () => {
		const { store } = await createConnectedStore();
		const pending = store.bringBackChild("child-1", "hr");

		const request = sentRequests().at(-1);
		expect(request?.command).toMatchObject({
			type: "bring_back_child_result",
			childSessionId: "child-1",
			sessionId: "hr",
		});
		respond({
			childSessionId: "child-1",
			resultRef: "/tmp/result.md",
			content: "# 结论",
			firstTime: true,
			broughtBackAt: 42,
			injected: true,
		});

		// 带回成功后自动重读账本（面板要立刻显示「已带回」）
		await Bun.sleep(0);
		expect(sentRequests().at(-1)?.command).toMatchObject({ type: "get_session_tree" });
		respond({
			sessionId: "sess-root",
			children: [{ ...CHILD, resultBroughtBackAt: 42 }],
		});

		const result = await pending;
		expect(result.firstTime).toBe(true);
		expect(result.injected).toBe(true);
		expect(result.content).toBe("# 结论");
		expect(store.getSnapshot().sessionTree?.children[0]?.resultBroughtBackAt).toBe(42);
	});

	it("重复带回不报错，但 firstTime=false 告诉调用方不要再注入", async () => {
		const { store } = await createConnectedStore();
		const pending = store.bringBackChild("child-1", "hr");
		respond({
			childSessionId: "child-1",
			resultRef: "/tmp/result.md",
			content: "# 结论",
			firstTime: false,
			broughtBackAt: 42,
			injected: false,
		});
		await Bun.sleep(0);
		respond({ sessionId: "sess-root", children: [] });

		const result = await pending;
		expect(result.firstTime).toBe(false);
		expect(result.injected).toBe(false);
	});
});

describe("Agent 隔离（不同 Agent 不混入主流）", () => {
	it("切到另一个 Agent：清空转录与子树，等新快照再填回", async () => {
		const { store } = await createConnectedStore();

		// 先落到 hr：权威快照 + 一棵子树
		lastCreated?.receive(
			JSON.stringify({
				type: "push",
				event: {
					type: "session_snapshot",
					sessionId: "hr",
					snapshot: {
						seq: 1,
						phase: "idle",
						retryAttempt: 0,
						isCompacting: false,
						isStreaming: false,
						sessionId: "hr",
						sessionName: "hr 会话",
						messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "hr 的产出" }] }],
						messageEntryIds: {},
						todoPhases: [],
						activeToolNames: [],
						queuedMessageCount: 0,
						autoCompactionEnabled: false,
						autoRetryEnabled: false,
					},
				},
			}),
		);
		const tree = store.refreshSessionTree("hr");
		respond({ sessionId: "sess-root", children: [CHILD] });
		await tree;
		expect(store.getSnapshot().messages).toHaveLength(1);

		// 切到 sw
		store.switchSession("sw");
		const view = store.getSnapshot();
		expect(view.activeAgentId).toBe("sw");
		expect(view.messages).toEqual([]);
		expect(view.sessionTree).toBeUndefined();
		expect(view.sessionName).toBeUndefined();
	});

	it("同一 Agent 上的重复切换不动转录", async () => {
		const { store } = await createConnectedStore();
		lastCreated?.receive(
			JSON.stringify({
				type: "push",
				event: {
					type: "session_snapshot",
					sessionId: "hr",
					snapshot: {
						seq: 1,
						phase: "idle",
						retryAttempt: 0,
						isCompacting: false,
						isStreaming: false,
						sessionId: "hr",
						messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "keep me" }] }],
						messageEntryIds: {},
						todoPhases: [],
						activeToolNames: [],
						queuedMessageCount: 0,
						autoCompactionEnabled: false,
						autoRetryEnabled: false,
					},
				},
			}),
		);

		store.switchSession("hr");
		expect(store.getSnapshot().messages.map(m => m.text)).toEqual(["keep me"]);
	});

	it("新会话清掉上一会话的子树", async () => {
		const { store } = await createConnectedStore();
		const tree = store.refreshSessionTree("hr");
		respond({ sessionId: "sess-root", children: [CHILD] });
		await tree;
		expect(store.getSnapshot().sessionTree?.children).toHaveLength(1);

		store.newSession();
		expect(store.getSnapshot().sessionTree).toBeUndefined();
	});
});

describe("重连后的焦点恢复", () => {
	it("hello_ack 后用 switch_session 恢复焦点（attach 不会切焦点，会把别的 Agent 的流引进来）", async () => {
		const { store } = await createConnectedStore();

		// 服务端推来 hr 的快照 → 适配器记住当前 sessionId = "hr"
		lastCreated?.receive(
			JSON.stringify({
				type: "push",
				event: {
					type: "session_snapshot",
					sessionId: "hr",
					snapshot: {
						seq: 1,
						phase: "idle",
						retryAttempt: 0,
						isCompacting: false,
						isStreaming: false,
						sessionId: "hr",
						messages: [],
						messageEntryIds: {},
						todoPhases: [],
						activeToolNames: [],
						queuedMessageCount: 0,
						autoCompactionEnabled: false,
						autoRetryEnabled: false,
					},
				},
			}),
		);
		void store;

		// 重连：同一套 hello 握手重来一次（serve 侧是一条新连接，焦点回到 default）
		lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c2", protocolVersion: 1 }));
		await Bun.sleep(0);

		const resync = sentRequests().filter(r => r.command.type === "switch_session" || r.command.type === "attach");
		expect(resync.at(-1)?.command).toMatchObject({ type: "switch_session", sessionId: "hr" });
	});
});

describe("list_agents 结果形状", () => {
	it("读 { agents } 而不是把整个响应当数组（否则每次都静默回落缓存）", async () => {
		const { adapter } = await createConnectedStore();
		const agents: AgentInfoDto[] = [
			{ id: "hr", name: "HR Agent", face: "HR", workspace: "hr", kind: "worker", status: "online" },
		];
		const pending = adapter.listAgents();
		respond({ agents: [{ id: "hr", name: "HR Agent", active: false, attached: true }] });
		const result = await pending;

		expect(result.map(a => a.id)).toEqual(["hr"]);
		expect(agents).toBeDefined();
	});
});
