import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { AgentInfoDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTodoDto } from "../src/lib/pi-client-api";
import { boardAgentIdOf, boardAgentNameOf } from "../src/pages/todo/agent-todo-logic";
import { TodoView } from "../src/pages/todo/TodoView";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import * as sessionStoreModule from "../src/state/session-store";
import { SessionStore, type SessionView } from "../src/state/session-store";
import * as useSessionModule from "../src/state/use-session";

/**
 * T2：Todo 板子归属与行内操作。
 *
 * 盯三件事：
 *   - 板子归属可显式 pin（setTodoBoardAgent），且不切连接焦点；保存/删除都按 pin 定向。
 *   - pin 后，全局切焦点不打断在看的板子。
 *   - 板子标题/占位用 Agent 名（boardAgentNameOf），默认与全站焦点解析同源（activeAgentIdOf）。
 */

// ── store 端（FakeWebSocket，与 agent-todo-workbench 同一套）────────────────

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

function commandsOf(type: string): Array<Record<string, unknown>> {
	return sentRequests()
		.map(r => r.command)
		.filter(c => c.type === type);
}

function lastRequestId(type: string): string {
	const frames = sentRequests().filter(r => r.command.type === type);
	const last = frames.at(-1);
	if (!last) throw new Error(`no ${type} request was sent`);
	return last.id;
}

function respondTo(id: string, result: unknown): void {
	lastCreated?.receive(JSON.stringify({ type: "response", id, ok: true, result }));
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

function makeTodo(overrides: Partial<AgentTodoDto> = {}): AgentTodoDto {
	return {
		id: "todo-1",
		agentId: "default",
		title: "把转正答辩排期定了",
		status: "open",
		priority: "medium",
		source: "user",
		sessionRefs: [],
		createdAt: 10,
		updatedAt: 10,
		...overrides,
	};
}

describe("todo board ownership (store)", () => {
	it("setTodoBoardAgent 只把板子切到目标 Agent，不切连接焦点", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [makeTodo()] });
		await load;
		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["todo-1"]);

		store.setTodoBoardAgent("hr");
		// 切板不改变连接焦点
		expect(store.getSnapshot().activeAgentId).toBeUndefined();
		// 同步作废：重读回来之前是「还不知道」，不是上一个 Agent 的任务
		expect(store.getSnapshot().agentTodos).toBeUndefined();
		expect(store.getSnapshot().todoBoardAgentId).toBe("hr");
		// 只为目标 Agent 重读
		expect(commandsOf("list_agent_todos").at(-1)).toMatchObject({ sessionId: "hr" });

		respondTo(lastRequestId("list_agent_todos"), {
			agentId: "hr",
			todos: [makeTodo({ id: "hr-1", agentId: "hr" })],
		});
		await Bun.sleep(0);
		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["hr-1"]);
		expect(store.getSnapshot().agentTodos?.every(t => t.agentId === "hr")).toBe(true);
	});

	it("保存/删除按板子 Agent 定向，而不是连接焦点", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [] });
		await load;

		store.setTodoBoardAgent("hr");
		respondTo(lastRequestId("list_agent_todos"), { agentId: "hr", todos: [] });
		await Bun.sleep(0);

		const saved = store.saveAgentTodo(makeTodo({ agentId: "hr" }));
		expect(commandsOf("set_agent_todo").at(-1)).toMatchObject({
			todo: { agentId: "hr" },
			sessionId: "hr",
		});
		respondTo(lastRequestId("set_agent_todo"), { todo: makeTodo({ agentId: "hr" }) });
		await saved;

		const removed = store.deleteAgentTodo("todo-1");
		expect(commandsOf("delete_agent_todo").at(-1)).toMatchObject({
			todoId: "todo-1",
			sessionId: "hr",
		});
		respondTo(lastRequestId("delete_agent_todo"), { deleted: true });
		expect(await removed).toBe(true);
	});

	it("显式 pin 后，切连接焦点不打断在看的板子", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [makeTodo()] });
		await load;

		store.setTodoBoardAgent("hr");
		respondTo(lastRequestId("list_agent_todos"), {
			agentId: "hr",
			todos: [makeTodo({ id: "hr-1", agentId: "hr" })],
		});
		await Bun.sleep(0);
		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["hr-1"]);

		// 全局切焦点（AgentSwitcher 走这条）不该作废 pin 住的板子
		store.switchSession("coding");
		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["hr-1"]);
		expect(store.getSnapshot().todoBoardAgentId).toBe("hr");
	});

	it("setTodoBoardAgent(undefined) 回到跟随焦点", async () => {
		const store = await createConnectedStore();
		store.setTodoBoardAgent("hr");
		expect(store.getSnapshot().todoBoardAgentId).toBe("hr");

		store.setTodoBoardAgent(undefined);
		expect(store.getSnapshot().todoBoardAgentId).toBeUndefined();
		// 回到跟随焦点后，与当前连接焦点同 source
		expect(commandsOf("list_agent_todos").at(-1)).toMatchObject({});
	});
});

// ── 纯函数：板子归属与全站焦点解析同源 ────────────────────────────────────

const HR_AGENT: AgentInfoDto = {
	id: "hr",
	name: "HR 助手",
	face: "H",
	workspace: "hr",
	kind: "worker",
	status: "idle",
	agentDir: "/Users/me/.cornfield/agents/hr",
	active: true,
};

const CODING_AGENT: AgentInfoDto = {
	id: "coding",
	name: "编码助手",
	face: "C",
	workspace: "coding",
	kind: "coding",
	status: "idle",
	agentDir: "/Users/me/.cornfield/agents/coding",
};

describe("boardAgentIdOf / boardAgentNameOf", () => {
	it("无 pin 时与全站焦点解析同源（回落 active 标志），标题用 Agent 名", () => {
		const source = { todoBoardAgentId: undefined, activeAgentId: undefined, agents: [CODING_AGENT, HR_AGENT] };
		// activeAgentId 缺省 → agents.find(active) → hr
		expect(boardAgentIdOf(source)).toBe("hr");
		expect(boardAgentNameOf(source)).toBe("HR 助手");
	});

	it("pin 优先于焦点", () => {
		const source = { todoBoardAgentId: "coding", activeAgentId: "hr", agents: [CODING_AGENT, HR_AGENT] };
		expect(boardAgentIdOf(source)).toBe("coding");
		expect(boardAgentNameOf(source)).toBe("编码助手");
	});

	it("没有 Agent 时只落回 default", () => {
		expect(boardAgentNameOf({ todoBoardAgentId: undefined, activeAgentId: undefined, agents: [] })).toBe("default");
	});
});

// ── 渲染（react-dom/server，静态渲染不跑 effect）────────────────────────────

let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			refreshAgentTodos: () => Promise.reject(new Error("静态渲染不应请求板子")),
			saveAgentTodo: () => Promise.reject(new Error("静态渲染不应写板子")),
			deleteAgentTodo: () => Promise.reject(new Error("静态渲染不应删板子")),
			setTodoBoardAgent: () => undefined,
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
		sessionId: "s-1",
		attachmentAddress: "hr",
		messages: [],
		messageEntryIds: {},
		isStreaming: false,
		activeToolNames: [],
		queued: 0,
		todo: [],
		flags: { autoCompaction: false, autoRetry: false },
		agents: [CODING_AGENT, HR_AGENT],
		env: null,
		historyLoading: false,
		sessionTreeLoading: false,
		projectsPending: false,
		agentTodosPending: false,
		gitChangesPending: false,
		...patch,
	};
	return currentView;
}

function render(patch: Partial<SessionView>): string {
	viewOf(patch);
	return renderToStaticMarkup(createElement(TodoView));
}

describe("TodoView 渲染：板子标题用 Agent 名，行内操作无 hover 可见", () => {
	it("标题显示 Agent 名（不是裸 id），无 activeAgentId 时回落 active 标志", () => {
		const html = render({ activeAgentId: undefined, agents: [CODING_AGENT, HR_AGENT] });
		expect(html).toContain("HR 助手");
		expect(html).not.toContain('owner <b class="font-medium text-ink-muted">hr</b>');
	});

	it("空标题时「添加」有可见说明", () => {
		const html = render({ agentTodos: [], agents: [HR_AGENT], activeAgentId: "hr" });
		expect(html).toContain("标题为空不能添加");
	});

	it("行内操作容器带无 hover 可见类（窄屏/粗指针不再藏在 hover 后）", () => {
		const html = render({
			agentTodos: [
				{
					id: "t-open",
					agentId: "hr",
					title: "定转正答辩",
					status: "open",
					priority: "medium",
					source: "user",
					sessionRefs: [],
					createdAt: 1,
					updatedAt: 1,
				},
			],
			agents: [HR_AGENT],
			activeAgentId: "hr",
		});
		expect(html).toContain("max-sm:opacity-100");
		expect(html).toContain("编辑");
		expect(html).toContain("删除");
	});
});
