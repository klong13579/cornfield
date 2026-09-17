import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { AgentInfoDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentDetailView } from "../src/pages/agents/AgentDetailView";
import { AgentsView } from "../src/pages/agents/AgentsView";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import type { SessionView } from "../src/state/session-store";
import * as sessionStoreModule from "../src/state/session-store";
import * as useSessionModule from "../src/state/use-session";

/**
 * 票 10 的「删无数据源渲染」回归：cronCount / lastAction 在 agents 页只剩删渲染（不留占位），
 * 有数据源的 skillsCount 保留；同时锁票 06 已合入的 `role` 字段被适配层消费成 `workspace`，
 * 旧字段名（`role`）不残留在 DTO 上。
 */

// ── 最小 DOM 垫片（react-router-dom 求值时读 window/history）──
const noop = (): void => {};
(globalThis as { document?: unknown }).document = { defaultView: globalThis };
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { history?: unknown }).history = {
	state: { idx: 0 },
	length: 1,
	scrollRestoration: "manual",
	pushState: noop,
	replaceState: noop,
	go: noop,
	back: noop,
	forward: noop,
};
(globalThis as { location?: unknown }).location = {
	hash: "",
	pathname: "/",
	search: "",
	origin: "http://localhost",
	href: "http://localhost/",
	assign: noop,
	replace: noop,
	reload: noop,
};

const { MemoryRouter } = await import("react-router-dom");

let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			fetchAgents: () => Promise.reject(new Error("静态渲染不应拉 agent 列表")),
			gatewayStatus: () => Promise.reject(new Error("静态渲染不应拉 gateway 状态")),
			focusAgent: () => {},
			getHostTools: () => [],
		}) as unknown as ReturnType<typeof sessionStoreModule.useSessionStore>,
);

afterAll(() => {
	useSessionSpy.mockRestore();
	useSessionStoreSpy.mockRestore();
});

function viewOf(patch: Partial<SessionView>): SessionView {
	currentView = {
		connected: true,
		reconnecting: false,
		wsUrl: "ws://127.0.0.1:1/ws",
		protocolVersion: 1,
		phase: "idle",
		model: null,
		thinkingLevel: null,
		sessionId: "",
		attachmentAddress: "default",
		messages: [],
		messageEntryIds: {},
		isStreaming: false,
		activeToolNames: [],
		queued: 0,
		todo: [],
		flags: { autoCompaction: false, autoRetry: false },
		agents: [],
		env: null,
		historyLoading: false,
		sessionTreeLoading: false,
		agentTodosPending: false,
		gitChangesPending: false,
		projectsPending: false,
		...patch,
	};
	return currentView;
}

// 即便 DTO 仍带着这些死字段（pi-wire 声明在 scope 之外），渲染层也必须无视它们。
const AGENT_WITH_STALE_FIELDS: AgentInfoDto = {
	id: "hr",
	name: "HR 助手",
	face: "H",
	workspace: "HR",
	kind: "worker",
	status: "idle",
	model: "deepseek-v4-flash",
	skillsCount: 5,
	cronCount: 3,
	lastAction: "昨天 23:00",
};

describe("agents 页删除无数据源渲染（票 10）", () => {
	it("列表卡片不再渲染 cronCount/lastAction，保留 skillsCount", () => {
		viewOf({ agents: [AGENT_WITH_STALE_FIELDS] });
		const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AgentsView)));
		expect(html).toContain("5 技能");
		expect(html).not.toContain("定时任务");
		expect(html).not.toContain("最近活跃");
		expect(html).not.toContain("昨天 23:00");
	});

	it("详情头部不再渲染 lastAction（两处都删，不留占位）", () => {
		viewOf({ agents: [AGENT_WITH_STALE_FIELDS] });
		const html = renderToStaticMarkup(createElement(AgentDetailView, { agentId: "hr", onClose: () => {} }));
		expect(html).not.toContain("最近活跃");
		expect(html).not.toContain("昨天 23:00");
	});
});

// ── 票 06 字段消费（role → workspace，旧字段名不残留）──
let lastCreated: FakeWebSocket | undefined;

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

async function connectAdapter(adapter: PiClientAdapter): Promise<void> {
	const connectPromise = adapter.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
}

describe("list_agents 消费 role 字段（票 06）", () => {
	it("wire role → DTO workspace；role 旧字段名不残留在结果上", async () => {
		lastCreated = undefined;
		const adapter = new PiClientAdapter(config, fakeCtor);
		try {
			await connectAdapter(adapter);
			const pending = adapter.listAgents();
			// 用最后一条 request 帧的 id 回 ok 响应（list_agents 是当前唯一在飞请求）。
			const req = lastCreated?.sent
				.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
				.filter((f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id);
			const id = req?.at(-1)?.id;
			lastCreated?.receive(
				JSON.stringify({
					type: "response",
					id,
					ok: true,
					result: {
						agents: [{ id: "hr", name: "HR 助手", active: true, attached: true, role: "HR", skillCount: 5 }],
					},
				}),
			);
			const result = await pending;
			expect(result).toHaveLength(1);
			expect(result[0]?.workspace).toBe("HR");
			expect(result[0]?.status).toBe("online");
			expect(result[0]?.skillsCount).toBe(5);
			expect("role" in (result[0] ?? {})).toBe(false);
		} finally {
			adapter.disconnect();
		}
	});
});
