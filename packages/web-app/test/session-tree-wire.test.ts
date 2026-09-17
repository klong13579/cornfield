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

/**
 * 回给**指定命令类型**的最后一条请求。
 *
 * 委派 / 带回会插在同一条流里（切会话、同一条命令的两次刷新），「最后一条请求」不等于
 * 「我要回的那一条」—— 拿错了响应，测试验的就不是要验的那条路径。
 */
function respondTo(type: string, result: unknown): void {
	const req = sentRequests()
		.filter(r => r.command.type === type)
		.at(-1);
	if (!req) throw new Error(`没有发过 ${type} 请求`);
	lastCreated?.receive(JSON.stringify({ type: "response", id: req.id, ok: true, result }));
}

function respondErrorTo(type: string, error: string): void {
	const req = sentRequests()
		.filter(r => r.command.type === type)
		.at(-1);
	if (!req) throw new Error(`没有发过 ${type} 请求`);
	lastCreated?.receive(JSON.stringify({ type: "response", id: req.id, ok: false, error }));
}

/** 已发过的请求里有没有这一类命令。 */
function sentTypes(): string[] {
	return sentRequests().map(r => String(r.command.type));
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

/**
 * serve 连接后必推的 agent 注册表（本连接焦点那个标 `active: true`）。
 *
 * 「新会话建在哪个 Agent 上」的判据就是这个焦点读数：注册表还没到就无从确定，不得建（见
 * SessionStore.newSession）。后台真实顺序也是先注册表再可能有点击（hello_ack →
 * broadcastServerSnapshot），所以要用例真的走到新建，就得先把注册表摆上。
 */
function pushAgents(...ids: string[]): void {
	lastCreated?.receive(
		JSON.stringify({
			type: "push",
			event: {
				type: "server_snapshot",
				sessions: ids.map((id, index) => ({ id, active: index === 0, attached: true })),
			},
		}),
	);
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

/**
 * review P2-1：委派失败也是一次**真发生过的写命令**。
 *
 * `SessionTreeManager.delegate` 在子会话起不来 / 没过注册门时，是先把账本节点写成 `failed`
 * 再招错 —— 所以账本才是失败后的真相。不重读，面板就停在上一次读到的那棵树上，而它上面
 * 没有这一行，用户会得出「什么都没发生」的反的结论。
 */
describe("委派失败：失败路径也要重读账本", () => {
	/** 把一次委派的结局收成一句话：resolve 说 "resolved"，reject 给错误文本。 */
	function outcomeOf(pending: Promise<unknown>): Promise<string> {
		return pending.then(
			() => "resolved",
			(err: unknown) => (err instanceof Error ? err.message : String(err)),
		);
	}

	it("失败后照样发 get_session_tree：账本里那一行 failed 看得见，原错误也没被吞掉", async () => {
		const { store } = await createConnectedStore();
		const settled = outcomeOf(store.delegateChild({ objective: "研究编辑器方案" }, "hr"));

		// serve：子会话没起来 / 没过注册门，节点已写成 failed
		respondErrorTo("delegate_child", "delegate_child: child did not pass the registration gate");
		await Bun.sleep(0);

		expect(sentTypes().at(-1)).toBe("get_session_tree");
		respondTo("get_session_tree", {
			sessionId: "sess-root",
			agentId: "hr",
			children: [{ ...CHILD, status: "failed", statusDetail: "启动后没有挂上 broker" }],
		});

		expect(await settled).toContain("registration gate");
		const view = store.getSnapshot();
		expect(view.sessionTree?.children[0]?.status).toBe("failed");
		expect(view.sessionTree?.children[0]?.statusDetail).toBe("启动后没有挂上 broker");
		expect(view.sessionTreeError).toBeUndefined();
		expect(view.sessionTreeLoading).toBe(false);
	});

	it("账本也读不出来：两条错误都在（不拿空树顶替 failed 节点）", async () => {
		const { store } = await createConnectedStore();
		const settled = outcomeOf(store.delegateChild({ objective: "研究编辑器方案" }, "hr"));

		respondErrorTo("delegate_child", "delegate_child: spawn failed");
		await Bun.sleep(0);
		respondErrorTo("get_session_tree", "session tree entry 1: unreadable");

		expect(await settled).toContain("spawn failed");
		const view = store.getSnapshot();
		expect(view.sessionTree).toBeUndefined();
		expect(view.sessionTreeError).toContain("unreadable");
	});
});

/**
 * review P2-2：写命令的回执与它引起的树刷新都属于**提交时那个会话**。
 *
 * 子会话在注册期间用户切了会话 / Agent，旧请求回来时：树不能刷（子会话会挂在错误的 root
 * 下，带回也会打错目标），回执也不能显示（面板的判定同样按 `sessionIdentity()` 对表）。
 */
describe("写命令的回执不落进别的会话", () => {
	it("委派途中换会话：不重读账本，回执也不再属于当前会话", async () => {
		const { store } = await createConnectedStore();
		const submitted = store.sessionIdentity();
		const pending = store.delegateChild({ objective: "研究编辑器方案" }, "hr");

		// 用户在子会话注册期间切走（面板就是拿这个值与提交时的值对表）
		store.switchSession("sw");
		expect(store.sessionIdentity()).not.toBe(submitted);

		// 旧请求这时才回来
		respondTo("delegate_child", { sessionId: "child-1", runId: "run-1", status: "running", agentId: "hr" });
		const child = await pending;

		// 回执本身还是有效的（子会话真起来了），只是不该再显示在这一屏上
		expect(child.sessionId).toBe("child-1");
		expect(sentTypes()).not.toContain("get_session_tree");
		const view = store.getSnapshot();
		expect(view.activeAgentId).toBe("sw");
		expect(view.sessionTree).toBeUndefined();
	});

	it("换会话后，上一个会话的账本响应落不进新视图（读成功与读失败都落不进）", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshSessionTree("hr");

		store.switchSession("sw");

		respondTo("get_session_tree", { sessionId: "sess-root", children: [CHILD] });
		await pending;

		const view = store.getSnapshot();
		expect(view.activeAgentId).toBe("sw");
		expect(view.sessionTree).toBeUndefined();
		expect(view.sessionTreeError).toBeUndefined();
	});

	it("上一个会话的读失败也是上一个会话的判决（不挂在新会话身上）", async () => {
		const { store } = await createConnectedStore();
		const pending = store.refreshSessionTree("hr");

		store.switchSession("sw");

		respondErrorTo("get_session_tree", "session tree entry 3: snapshot version 99 is not readable");
		await pending;

		const view = store.getSnapshot();
		expect(view.activeAgentId).toBe("sw");
		expect(view.sessionTree).toBeUndefined();
		expect(view.sessionTreeError).toBeUndefined();
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
		pushAgents("hr");
		const tree = store.refreshSessionTree("hr");
		respond({ sessionId: "sess-root", children: [CHILD] });
		await tree;
		expect(store.getSnapshot().sessionTree?.children).toHaveLength(1);

		const created = store.newSession();
		// 调用即作废（不等回执）：上一会话的账本不得跟着新会话走到下一屏
		expect(store.getSnapshot().sessionTree).toBeUndefined();
		respondTo("new_session", { cancelled: false });
		expect((await created).kind).toBe("created");
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
