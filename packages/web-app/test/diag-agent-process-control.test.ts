import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * agent 进程操作入口（detach / 启停能力边界 —— 票 09）的契约测试。
 *
 * 钉住的判据（服务端能力已探明）：
 * - `attach` / `detach` 命令 serve 侧已存在（wire-server.ts / commands.ts）；启停（start/stop）不存在。
 * - detach 释放的是**空闲**实例：忙态（phase 在 streaming/executing_tool/compacting/retrying）有会话
 *   在跑，store 必须在发命令之前拦截 —— 不能偷偷拆掉别人正在跑的会话。
 * - 失败（未知 agent / 占用 / default）把 serve 原文原样回传，UI 只负责展示。
 *
 * 假 serve 复现 wire 的 request/response 与 server_snapshot 推送，断言只看 serve 侧事实
 * （发没发 `detach` 帧、`list_agents` 是否被重新拉起、出错原文是什么），不认客户端本地读数。
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

	/** 注册表里已有的 agent。 */
	readonly known = new Set(["default", "hr"]);
	/** 已 attach 的会话（boot 时 default 与 hr 都已预挂载）。 */
	readonly attached = new Set(["default", "hr"]);
	/** 连接焦点（serve 的 conn.activeAgentId）。 */
	activeAgent = "default";
	/** 设了值之后，`detach` 命令一律回这个错误（复现占用/未知等失败路径）。 */
	detachFailure: string | null = null;

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
				if (sessionId === undefined || !this.known.has(sessionId)) {
					return this.#fail(id, `unknown agent: ${sessionId}`);
				}
				this.attached.add(sessionId);
				this.activeAgent = sessionId;
				return this.#ok(id, { sessionId });
			}
			case "list_agents": {
				return this.#ok(id, {
					agents: [...this.known].map(agentId => ({
						id: agentId,
						active: agentId === this.activeAgent,
						attached: this.attached.has(agentId),
					})),
				});
			}
			case "detach": {
				if (this.detachFailure) return this.#fail(id, this.detachFailure);
				if (sessionId === "default") return this.#fail(id, "cannot detach default agent");
				if (sessionId === undefined || !this.known.has(sessionId)) {
					return this.#fail(id, `unknown agent: ${sessionId}`);
				}
				this.attached.delete(sessionId);
				return this.#ok(id, {});
			}
			default:
				return this.#ok(id, {});
		}
	}

	/** 推一份 serve 的 agent 列表（server_snapshot；phase 可选，用于构造忙态）。 */
	pushAgents(sessions: Array<{ id: string; active?: boolean; attached?: boolean; phase?: string }>): void {
		this.receive(
			JSON.stringify({
				type: "push",
				event: {
					type: "server_snapshot",
					sessions: sessions.map((s, index) => ({
						id: s.id,
						active: s.active ?? index === 0,
						attached: s.attached ?? this.attached.has(s.id),
						...(s.phase ? { phase: s.phase } : {}),
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
}

interface ServeCommand {
	type?: string;
	sessionId?: string;
}

/** 与 detach 链路相关的请求帧命令类型（能力探明 + 命令面事实）。 */
function relevantFrames(serve: FakeServe): string[] {
	const interesting = new Set(["detach", "list_agents", "attach", "switch_session"]);
	return serve.sent
		.map(line => JSON.parse(line) as { type?: string; command?: { type?: string } })
		.filter(f => f.type === "request" && interesting.has(String(f.command?.type)))
		.map(f => String(f.command?.type));
}

/** 每条 `detach` 请求帧上带的 sessionId（命令到底打给谁）。 */
function detachTargets(serve: FakeServe): Array<string | undefined> {
	return serve.sent
		.map(line => JSON.parse(line) as { type?: string; command?: ServeCommand })
		.filter(f => f.type === "request" && f.command?.type === "detach")
		.map(f => f.command?.sessionId);
}

const fakeCtor: PiWebSocketCtor = FakeServe;
const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

afterEach(() => {
	for (const adapter of createdAdapters) adapter.disconnect();
	createdAdapters.length = 0;
	lastCreated = undefined;
});

/** 连接就绪的 store + 假 serve（注册表已推：default 是焦点、hr 已预挂载空闲）。 */
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

describe("detach 一个空闲 agent：发命令、成功后刷新列表", () => {
	it("空闲 hr 被 detach：detach 帧带 sessionId，随后重拉 list_agents，serve 侧 attached 移除", async () => {
		const { store, serve } = await createConnectedStore();

		const outcome = await store.detachAgent("hr");

		expect(outcome).toEqual({ ok: true });
		// 命令面事实：detach 打给 hr，且成功之后重新拉了列表（与 createAgent 同一条「写状态归 store」纪律）
		expect(detachTargets(serve)).toEqual(["hr"]);
		expect(relevantFrames(serve)).toEqual(["detach", "list_agents"]);
		// serve 侧事实：hr 的进程内实例被释放
		expect(serve.attached.has("hr")).toBe(false);
		// 客户端报的列表已经刷成 serve 现状（hr attached:false → 未挂载）
		const hr = store.getSnapshot().agents.find(a => a.id === "hr");
		expect(hr?.attached).toBe(false);
		expect(hr?.status).toBe("stopped");
	});

	it("default 不能 detach：serve 拒绝，原文透出，不发第二次重试", async () => {
		const { store, serve } = await createConnectedStore();

		const outcome = await store.detachAgent("default");

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error).toBe("cannot detach default agent");
		// 只发了一帧 detach（失败不重试），而且打给的是 default
		expect(detachTargets(serve)).toEqual(["default"]);
		expect(relevantFrames(serve)).toEqual(["detach"]);
		// serve 侧没把它拆掉
		expect(serve.attached.has("default")).toBe(true);
	});
});

describe("detach 忙态 agent：store 在发命令之前拦截", () => {
	it("phase=streaming 的 hr 被 detach：返回 busy:true，一个 detach 帧都不发", async () => {
		const { store, serve } = await createConnectedStore();
		// 构造忙态：hr 有一会话在跑（流式）。
		serve.pushAgents([
			{ id: "default", active: true },
			{ id: "hr", phase: "streaming" },
		]);

		const outcome = await store.detachAgent("hr");

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.busy).toBe(true);
			expect(outcome.error).toBe("agent is busy: hr");
		}
		// 命令面事实：忙态拦截发生在发命令之前 —— 一个 detach 字节都没发出去
		expect(detachTargets(serve)).toEqual([]);
		expect(relevantFrames(serve)).toEqual([]);
		// serve 侧会话原样保留
		expect(serve.attached.has("hr")).toBe(true);
	});
});

describe("detach 失败路径：serve 原文可见、不吞", () => {
	it("被其它连接聚焦（active）：serve 拒绝，原文透出", async () => {
		const { store, serve } = await createConnectedStore();
		serve.detachFailure = "agent is active on a connection: hr (switch_session first)";

		const outcome = await store.detachAgent("hr");

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.busy).toBeUndefined();
			expect(outcome.error).toContain("agent is active on a connection: hr");
		}
		expect(detachTargets(serve)).toEqual(["hr"]);
		// 失败后不重拉列表（没有 list_agents）
		expect(relevantFrames(serve)).toEqual(["detach"]);
		expect(serve.attached.has("hr")).toBe(true);
	});

	it("unknown agent：serve 原文透出", async () => {
		const { store, serve } = await createConnectedStore();
		serve.detachFailure = "unknown agent: ghost";

		const outcome = await store.detachAgent("ghost");

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error).toBe("unknown agent: ghost");
		expect(detachTargets(serve)).toEqual(["ghost"]);
	});
});
