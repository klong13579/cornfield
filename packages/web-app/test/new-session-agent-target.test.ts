import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { activeAgentIdOf } from "../src/state/agent-context";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * 「新建会话建在哪个 Agent 上」的契约（顶栏表单、侧栏直建钮共用同一条路径）。
 *
 * 要钉住的那次竞态：serve 逐帧并发处理命令（wire-server.ts `void core.handleCommand(...)`），
 * `switch_session` 在改 `ctx.activeAgentId` 之前要 `await registry.attach`；而 `new_session`
 * 不带 `sessionId` 时按**处理那一刻**的 `ctx.activeAgentId` 定目标。于是「先切 Agent、紧接着新建」
 * 的两帧可能倒过来：新会话建在**旧** Agent 上，而客户端已经在显示新焦点。
 *
 * 下面的假 serve 复现那一刻（`switch_session` 的焦点要等一个 tick 才改），并像真 serve 一样
 * 按 `command.sessionId ?? activeAgent` 决定新会话落在谁身上、再推一份带**落地 Agent** 的
 * `session_snapshot`。断言只认 serve 侧的事实（`createdOn` / 推来的快照），不认客户端本地读数。
 */

let lastCreated: FakeServe | undefined;
const createdAdapters: PiClientAdapter[] = [];

class FakeServe implements PiWebSocketLike {
	readyState = 1;
	readonly sent: string[] = [];
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;

	/** 注册表里已有的 agent（serve 的 meta）。 */
	readonly known = new Set(["default", "hr"]);
	/** 已 attach 的会话（boot 时 default 已 attach）。 */
	readonly attached = new Set(["default"]);
	/** 连接焦点（serve 的 conn.activeAgentId）。 */
	activeAgent = "default";
	/** 每条 new_session 到达时的「那一刻的连接焦点 + 命令带的目标」。 */
	readonly arrivals: Array<{ activeAgent: string; sessionId: string | undefined }> = [];
	/** 真正建了会话的 Agent（serve 侧事实）。 */
	readonly createdOn: string[] = [];
	/** 推出去的 session_snapshot 帧上的 Agent（serve 对「本连接焦点是谁」的权威说法）。 */
	readonly pushedAgents: string[] = [];
	#seq = 0;

	constructor(_url: string) {
		lastCreated = this;
	}

	send(data: string): void {
		this.sent.push(data);
		const frame = JSON.parse(data) as { type?: string; id?: string; command?: ServeCommand };
		if (frame.type !== "request" || !frame.id || !frame.command) return;
		this.#handle(frame.id, frame.command);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}

	#handle(id: string, command: ServeCommand): void {
		const sessionId = command.sessionId;
		switch (command.type) {
			case "attach": {
				if (sessionId === undefined || !this.known.has(sessionId)) {
					return this.#fail(id, `unknown agent: ${sessionId}`);
				}
				this.attached.add(sessionId);
				return this.#ok(id, { sessionId, sessionFile: `/sessions/${sessionId}.jsonl` });
			}
			case "switch_session": {
				// serve：先 `await registry.attach` 再 `ctx.setActiveAgentId` —— 焦点不是这帧一进来就变的
				if (sessionId === undefined || !this.known.has(sessionId)) {
					return this.#fail(id, `unknown agent: ${sessionId}`);
				}
				const target = sessionId;
				setTimeout(() => {
					this.attached.add(target);
					this.activeAgent = target;
					this.#push(target, `/sessions/${target}.jsonl`);
					this.#ok(id, { sessionId: target });
				}, 1);
				return;
			}
			case "new_session": {
				this.arrivals.push({ activeAgent: this.activeAgent, sessionId });
				// serve：没带 sessionId 就按这一刻的焦点定目标（这正是会建错的那条路）
				const landing = sessionId ?? this.activeAgent;
				if (!this.attached.has(landing)) {
					return this.#fail(id, `agent not attached: ${landing} (send attach first)`);
				}
				this.createdOn.push(landing);
				this.#ok(id, { cancelled: false });
				this.#push(landing, `/sessions/${landing}-${++this.#seq}.jsonl`);
				return;
			}
			default:
				return this.#ok(id, {});
		}
	}

	/** serve 的 agent 列表推送（本连接焦点标 active）。 */
	pushAgents(sessions: Array<{ id: string; active?: boolean }>): void {
		this.receive(
			JSON.stringify({
				type: "push",
				event: {
					type: "server_snapshot",
					sessions: sessions.map((s, index) => ({
						id: s.id,
						active: s.active ?? index === 0,
						attached: this.attached.has(s.id),
					})),
				},
			}),
		);
	}

	#ok(id: string, result: unknown): void {
		this.receive(JSON.stringify({ type: "response", id, ok: true, result }));
	}

	#fail(id: string, error: string): void {
		this.receive(JSON.stringify({ type: "response", id, ok: false, error }));
	}

	/** 推一份权威快照：帧上的 `sessionId` 是**落地 Agent**（serve 的约定），快照里的是会话自己的 id。 */
	#push(agentId: string, sessionFile: string): void {
		this.pushedAgents.push(agentId);
		this.receive(
			JSON.stringify({
				type: "push",
				event: {
					type: "session_snapshot",
					sessionId: agentId,
					snapshot: {
						seq: 1,
						phase: "idle",
						retryAttempt: 0,
						isCompacting: false,
						isStreaming: false,
						sessionId: `${agentId}-sess`,
						sessionFile,
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
	}
}

interface ServeCommand {
	type?: string;
	sessionId?: string;
}

const fakeCtor: PiWebSocketCtor = FakeServe;
const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

afterEach(() => {
	for (const adapter of createdAdapters) adapter.disconnect();
	createdAdapters.length = 0;
	lastCreated = undefined;
});

/** 连接就绪的 store + 假 serve（注册表已推：default 是本连接焦点 —— 与真 serve 的连接顺序一致）。 */
async function createConnectedStore(): Promise<{ store: SessionStore; serve: FakeServe }> {
	lastCreated = undefined;
	const adapter = new PiClientAdapter(config, fakeCtor);
	createdAdapters.push(adapter);
	const store = new SessionStore();
	store.init(adapter);
	const connectPromise = store.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
	const serve = lastCreated;
	if (!serve) throw new Error("没有建立假 serve 连接");
	serve.pushAgents([{ id: "default", active: true }, { id: "hr" }]);
	return { store, serve };
}

/** 与「新建会话」相关的请求帧类型（其余是注册表/归属那几路读命令，不属于本条契约）。 */
function creationFrames(serve: FakeServe): string[] {
	const interesting = new Set(["attach", "switch_session", "new_session"]);
	return serve.sent
		.map(line => JSON.parse(line) as { type?: string; command?: { type?: string } })
		.filter(f => f.type === "request" && interesting.has(String(f.command?.type)))
		.map(f => String(f.command?.type));
}

describe("新建会话选另一个 Agent：先等 serve 确认，再带显式目标建", () => {
	it("换 Agent 新建：new_session 到达时连接焦点已是目标，且命令带显式目标", async () => {
		const { store, serve } = await createConnectedStore();
		expect(store.getSnapshot().activeAgentId).toBeUndefined();

		const outcome = await store.newSession({ agentId: "hr" });

		expect(outcome).toEqual({ kind: "created", notApplied: [] });
		// serve 侧事实：新会话**真的建在 hr 上**，而不是按客户端显示的那个焦点碰运气
		expect(serve.createdOn).toEqual(["hr"]);
		// 竞态判据：new_session 到达那一刻，连接焦点已经切到 hr（切换是被 await 过的），
		// 且命令自己带了 sessionId —— 就算焦点旧了也跑不到别的 Agent 上
		expect(serve.arrivals).toEqual([{ activeAgent: "hr", sessionId: "hr" }]);
		expect(creationFrames(serve)).toEqual(["attach", "switch_session", "new_session"]);

		// 客户端报的 Agent 与 serve 推来的快照（就是那个新会话）属于同一个 Agent
		const view = store.getSnapshot();
		expect(serve.pushedAgents.at(-1)).toBe("hr");
		expect(view.activeAgentId).toBe(serve.pushedAgents.at(-1));
		expect(view.sessionFile).toBe("/sessions/hr-1.jsonl");
	});

	it("目标 Agent 不存在：把 serve 的原文给出来、一个会话都不建、焦点读数退回", async () => {
		const { store, serve } = await createConnectedStore();

		const outcome = await store.newSession({ agentId: "ghost" });

		expect(outcome.kind).toBe("not-created");
		expect(outcome.kind === "not-created" ? outcome.error : "").toContain("unknown agent: ghost");
		// 没建：new_session 一个字节都没发出去
		expect(creationFrames(serve)).toEqual(["attach"]);
		expect(serve.createdOn).toEqual([]);
		// 用户看得见 serve 的原文（唯一可见的错误面）
		expect(store.getSnapshot().commandError).toContain("unknown agent: ghost");
		// 焦点读数没有停在失败目标上：屏幕上报的仍是**真的**那个 Agent（注册表说 default）
		expect(store.getSnapshot().activeAgentId).toBeUndefined();
		expect(activeAgentIdOf(store.getSnapshot())).toBe("default");
	});

	it("默认路径（当前焦点 Agent）：不多切一次，但命令照样带显式目标", async () => {
		const { store, serve } = await createConnectedStore();

		const outcome = await store.newSession();

		expect(outcome).toEqual({ kind: "created", notApplied: [] });
		expect(serve.createdOn).toEqual(["default"]);
		expect(serve.arrivals).toEqual([{ activeAgent: "default", sessionId: "default" }]);
		// 焦点已经是它：不再 attach / switch（默认路径的表现与以前一致）
		expect(creationFrames(serve)).toEqual(["new_session"]);
		expect(store.getSnapshot().activeAgentId).toBeUndefined();
		expect(store.getSnapshot().sessionFile).toBe("/sessions/default-1.jsonl");
	});

	it("两次快速提交：第二次被挡下，只建出一个会话", async () => {
		const { store, serve } = await createConnectedStore();

		const first = store.newSession({ agentId: "hr" });
		const second = store.newSession({ agentId: "hr" });

		const duplicate = await second;
		expect(duplicate.kind).toBe("not-created");
		expect(duplicate.kind === "not-created" ? duplicate.error : "").toContain("重复提交");
		expect(await first).toEqual({ kind: "created", notApplied: [] });
		expect(serve.createdOn).toEqual(["hr"]);
		expect(creationFrames(serve).filter(t => t === "new_session")).toHaveLength(1);
	});

	it("焦点读不出来（注册表还没到）：明说无从确定，不发命令", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter(config, fakeCtor);
		createdAdapters.push(adapter);
		const store = new SessionStore();
		store.init(adapter);
		const connectPromise = store.connect();
		lastCreated?.onopen?.({});
		lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
		await connectPromise;
		const serve = lastCreated;
		if (!serve) throw new Error("没有建立假 serve 连接");

		const outcome = await store.newSession();

		expect(outcome.kind).toBe("not-created");
		expect(outcome.kind === "not-created" ? outcome.error : "").toContain("无从确定");
		expect(creationFrames(serve)).toEqual([]);
		expect(serve.createdOn).toEqual([]);
	});
});
