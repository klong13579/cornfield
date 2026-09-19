import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { AgentMessageDto, SessionSnapshotDto } from "@cornfield/wire";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * 历史会话回放 ↔ 回到实时（侧栏顶上「当前会话」那一行的点击闭环）。
 *
 * 缺陷的形状：点侧栏别的会话 → 视图切进回放；再点顶上「当前会话」→ **没有任何反应**。
 * 表层是那一行的 `onClick` 是 `undefined`，根因是**视图里没有一个「正在回放」的事实**：
 * `sessionId` / `sessionName` 一直是实时那条（顶上那行就是拿它画的），`sessionFile` 两种态下
 * 都非空 —— 没有这个事实，就没有「回到哪」可回。这一组钉四件事：
 *   1. 打开历史会话会留下 `historySessionFile`（回放态可以被说出来）；
 *   2. 实时快照到达把它清空 —— 这是回放态**唯一**的终结者；
 *   3. 不在回放态时 `returnToLiveSession` 一个字节都不发（不给白闪留口子）；
 *   4. 失败要把原因上屏，且**不许假装回到了**（回放态仍在）。
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

/** 已发出的 request 帧（不含 hello/ping）。 */
function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

/** 用最后一条 request 帧的 id 回成功响应。时序（哪一条对应哪一步）由用例自己控。 */
function respondOk(result: unknown = {}): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: true, result }));
}

/** 用最后一条 request 帧的 id 回失败响应。 */
function respondError(error: string): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: false, error }));
}

/** 让在途的 promise 链跑完（一次 `await` 只够一跳，这里给两跳）。 */
async function flush(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

async function createConnectedStore(): Promise<SessionStore> {
	lastCreated = undefined;
	const adapter = new PiClientAdapter(config, fakeCtor);
	createdAdapters.push(adapter);
	const store = new SessionStore();
	store.init(adapter);
	const connectPromise = store.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
	return store;
}

function snapshot(over: Partial<SessionSnapshotDto> = {}): SessionSnapshotDto {
	return {
		seq: 1,
		phase: "idle",
		retryAttempt: 0,
		isCompacting: false,
		isStreaming: false,
		sessionId: "live-uuid",
		sessionName: "实时会话",
		model: { provider: "p", id: "m", name: "m" },
		messages: [{ id: "live-1", role: "user", content: [{ type: "text", text: "实时消息" }] }],
		messageEntryIds: {},
		todoPhases: [],
		activeToolNames: [],
		queuedMessageCount: 0,
		autoCompactionEnabled: false,
		autoRetryEnabled: false,
		...over,
	};
}

function pushSnapshot(snap: SessionSnapshotDto): void {
	lastCreated?.receive(
		JSON.stringify({ type: "push", event: { type: "session_snapshot", sessionId: "hr", snapshot: snap } }),
	);
}

const HISTORY_FILE = "/Users/me/.cornfield/agent/sessions/--x--/by-date/2026-09-15/100000__a1.jsonl";
const HISTORY_MESSAGE = { id: "h-1", role: "user", content: [{ type: "text", text: "历史消息" }] } as AgentMessageDto;

/** 走完「打开历史会话」：switch_session → get_session_messages 两条命令各回一次。 */
async function openHistory(store: SessionStore): Promise<void> {
	const pending = store.openHistorySession({ id: "h1", agent: "hr", sessionFile: HISTORY_FILE });
	await flush();
	respondOk({});
	await flush();
	respondOk({ messages: [HISTORY_MESSAGE] });
	await pending;
}

describe("历史会话回放态", () => {
	it("打开历史会话：视图留下「正在回放哪个文件」", async () => {
		const store = await createConnectedStore();
		pushSnapshot(snapshot());
		expect(store.getSnapshot().historySessionFile).toBeUndefined();

		await openHistory(store);

		const view = store.getSnapshot();
		expect(view.historySessionFile).toBe(HISTORY_FILE);
		expect(view.sessionFile).toBe(HISTORY_FILE);
		expect(view.messages.map(m => m.text)).toEqual(["历史消息"]);
		// 会话 id 不能被这次切换清掉：侧栏顶上那一行是按 `view.sessionId` 画的，
		// 清掉它那一行就消失，「回到实时」的入口也跟着没了。
		expect(view.sessionId).toBe("live-uuid");
	});

	it("实时快照到达 → 回放态结束（它是唯一的终结者）", async () => {
		const store = await createConnectedStore();
		pushSnapshot(snapshot());
		await openHistory(store);
		expect(store.getSnapshot().historySessionFile).toBe(HISTORY_FILE);

		pushSnapshot(
			snapshot({ messages: [{ id: "live-2", role: "assistant", content: [{ type: "text", text: "实时回复" }] }] }),
		);

		const view = store.getSnapshot();
		expect(view.historySessionFile).toBeUndefined();
		expect(view.messages.map(m => m.text)).toEqual(["实时回复"]);
	});
});

describe("returnToLiveSession：回到实时会话", () => {
	it("不在回放态 → 一个字节都不发（点了不应该白闪一次）", async () => {
		const store = await createConnectedStore();
		pushSnapshot(snapshot());
		const before = sentRequests().length;

		await store.returnToLiveSession();

		expect(sentRequests().length).toBe(before);
		expect(store.getSnapshot().historySessionFile).toBeUndefined();
	});

	it("回放中 → 切一次焦点让 serve 推实时快照；快照回来之前视图仍是回放态", async () => {
		const store = await createConnectedStore();
		pushSnapshot(snapshot());
		await openHistory(store);
		const before = sentRequests().length;

		const pending = store.returnToLiveSession();
		await flush();
		respondOk({});
		await flush();
		respondOk({});
		await pending;

		expect(
			sentRequests()
				.slice(before)
				.map(r => r.command.type),
		).toEqual(["attach", "switch_session"]);
		// 只发了命令，还没收到实时快照 —— 此刻不许声称已经回到实时
		expect(store.getSnapshot().historySessionFile).toBe(HISTORY_FILE);

		pushSnapshot(snapshot());
		expect(store.getSnapshot().historySessionFile).toBeUndefined();
		expect(store.getSnapshot().messages.map(m => m.text)).toEqual(["实时消息"]);
	});

	it("失败 → 原因上屏，且不假装回到了（回放态仍在）", async () => {
		const store = await createConnectedStore();
		pushSnapshot(snapshot());
		await openHistory(store);

		const pending = store.returnToLiveSession();
		await flush();
		respondError("agent not attached: hr");
		await pending;

		const view = store.getSnapshot();
		expect(view.historyError).toContain("回到实时会话失败");
		expect(view.historyError).toContain("agent not attached: hr");
		expect(view.historySessionFile).toBe(HISTORY_FILE);
	});
});
