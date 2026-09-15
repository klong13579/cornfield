import { afterEach, describe, expect, it } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { AgentTodoDto, ProjectRecordDto } from "../src/lib/pi-client-api";
import {
	ALL_TODOS,
	bindableProjects,
	bindingLabelOf,
	countsOf,
	filterAgentTodos,
	filterOptionsOf,
	isTerminal,
	projectRegistryOf,
	sameFilter,
	sortAgentTodos,
	UNBOUND_TODOS,
} from "../src/pages/todo/agent-todo-logic";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * T10A：Agent Todo 工作台的前端契约。
 *
 * 这条链路的风险都在「一件事被显示成另一件事」上，所以每条测试盯的都是区分：
 *   - 「还没读出来」/「读到了但板子是空的」/「读不出来」是三种状态，不能互相顶替；
 *   - 板子属于一个 Agent：切 Agent 后上一个 Agent 的迟到响应不得落进新视图；
 *   - 会话 todo 是另一个 scope：它既不出现在 Agent 板上，也不会被 Agent 板的写操作碰到。
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

/** 已发出的某类命令（用于断言「没有发出」这种否命题）。 */
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

function respondErrorTo(id: string, error: string): void {
	lastCreated?.receive(JSON.stringify({ type: "response", id, ok: false, error }));
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

/** 推一份权威快照（切 Agent / 开新会话后 serve 必推一份）。 */
function pushSnapshot(agentId: string, sessionFile: string): void {
	lastCreated?.receive(
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
					sessionId: agentId,
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

const PROJECTS: ProjectRecordDto[] = [
	{ projectId: "cornfield", root: "/Users/me/cornfield", name: "CornField" },
	{ projectId: "dtc", root: "/Users/me/dtc", name: "米克原子 DTC" },
];

/** registry 读到的那一态 —— 绝大多数用例都拿它当输入。 */
const LOADED = projectRegistryOf({ projects: PROJECTS });

describe("agent todo workbench logic", () => {
	it("筛选桶分得清「通用」与「绑了一个查不到的 Project」", () => {
		const todos = [
			makeTodo({ id: "a" }),
			makeTodo({ id: "b", projectId: "cornfield" }),
			makeTodo({ id: "c", projectId: "ghost" }),
		];

		expect(filterAgentTodos(todos, ALL_TODOS).map(t => t.id)).toEqual(["a", "b", "c"]);
		expect(filterAgentTodos(todos, UNBOUND_TODOS).map(t => t.id)).toEqual(["a"]);
		expect(filterAgentTodos(todos, { kind: "project", projectId: "ghost" }).map(t => t.id)).toEqual(["c"]);

		expect(bindingLabelOf(todos[0]!, LOADED)).toMatchObject({ label: "通用" });
		expect(bindingLabelOf(todos[0]!, LOADED).warning).toBeUndefined();
		// 查不到的绑定必须说出来，不能悄悄归进「通用」
		expect(bindingLabelOf(todos[2]!, LOADED).label).toBe("ghost");
		expect(bindingLabelOf(todos[2]!, LOADED).warning).toContain("不在 Project registry");
		expect(bindingLabelOf(todos[1]!, LOADED)).toMatchObject({ label: "CornField" });
		expect(bindingLabelOf(todos[1]!, LOADED).warning).toBeUndefined();
	});

	it("registry 读不出来时不断言绑定失效 —— 「查不了」不是「没有了」", () => {
		const todo = makeTodo({ projectId: "cornfield" });

		const unreadable = bindingLabelOf(todo, projectRegistryOf({ projectsError: "not valid JSON" }));
		expect(unreadable.label).toBe("cornfield");
		expect(unreadable.warning).toBeUndefined();
		expect(unreadable.title).toContain("not valid JSON");

		const pending = bindingLabelOf(todo, projectRegistryOf({}));
		expect(pending.label).toBe("cornfield");
		expect(pending.warning).toBeUndefined();
		expect(pending.title).toContain("读取中");

		// 没读到 / 读不了时选择器给不出候选，但也不假装「一个都绑不了」
		expect(bindableProjects(projectRegistryOf({}), undefined)).toEqual([]);
		expect(bindableProjects(projectRegistryOf({ projectsError: "boom" }), undefined)).toEqual([]);
	});

	it("筛选器只给板上出现过的 Project 开桶，未声明的也留一个", () => {
		const todos = [
			makeTodo({ id: "a" }),
			makeTodo({ id: "b", projectId: "dtc" }),
			makeTodo({ id: "c", projectId: "ghost" }),
		];
		const options = filterOptionsOf(LOADED, todos);

		expect(options.map(o => o.label)).toEqual(["全部", "通用", "米克原子 DTC", "ghost"]);
		expect(options.map(o => o.count)).toEqual([3, 1, 1, 1]);
		// cornfield 板上一条都没有 —— 不为它开一个点了必然空着的桶
		expect(options.some(o => sameFilter(o.filter, { kind: "project", projectId: "cornfield" }))).toBe(false);
		expect(options.find(o => o.label === "ghost")?.warning).toContain("不在 Project registry");
	});

	it("未完成在前、取消在最后，同组按最近动过的排前面", () => {
		const todos = [
			makeTodo({ id: "done", status: "completed", updatedAt: 50 }),
			makeTodo({ id: "open-old", status: "open", updatedAt: 10 }),
			makeTodo({ id: "cancelled", status: "cancelled", updatedAt: 90 }),
			makeTodo({ id: "doing", status: "in_progress", updatedAt: 5 }),
			makeTodo({ id: "open-new", status: "open", updatedAt: 30 }),
		];
		expect(sortAgentTodos(todos).map(t => t.id)).toEqual(["doing", "open-new", "open-old", "done", "cancelled"]);
	});

	it("计数把终态与未完成分开", () => {
		const counts = countsOf([
			makeTodo({ id: "a", status: "open" }),
			makeTodo({ id: "b", status: "in_progress" }),
			makeTodo({ id: "c", status: "completed" }),
			makeTodo({ id: "d", status: "cancelled" }),
		]);
		expect(counts).toEqual({ total: 4, open: 2, completed: 1, cancelled: 1 });
		expect(isTerminal("completed")).toBe(true);
		expect(isTerminal("cancelled")).toBe(true);
		expect(isTerminal("in_progress")).toBe(false);
	});

	it("可绑的 Project 以 Agent 的声明为上限；无声明 = 未约束（不是「一个都不能绑」）", () => {
		expect(bindableProjects(LOADED, undefined).map(p => p.projectId)).toEqual(["cornfield", "dtc"]);
		expect(bindableProjects(LOADED, ["dtc"]).map(p => p.projectId)).toEqual(["dtc"]);
		expect(bindableProjects(LOADED, [])).toEqual([]);
	});
});

describe("store agent todos", () => {
	it("list_agent_todos 的结果落进 view（板子 + Agent 声明的绑定）", async () => {
		const store = await createConnectedStore();
		const pending = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), {
			agentId: "default",
			projectIds: ["cornfield"],
			todos: [makeTodo()],
		});
		await pending;

		const view = store.getSnapshot();
		expect(view.agentTodos?.map(t => t.id)).toEqual(["todo-1"]);
		expect(view.agentTodoProjectIds).toEqual(["cornfield"]);
		expect(view.agentTodosPending).toBe(false);
		expect(view.agentTodosError).toBeUndefined();
	});

	it("读出来是空板与还没读出来不是一件事", async () => {
		const store = await createConnectedStore();
		const pending = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [] });
		await pending;

		expect(store.getSnapshot().agentTodos).toEqual([]);
		expect(store.getSnapshot().agentTodosPending).toBe(false);
	});

	it("读不出来是错误态，不退化成空板", async () => {
		const store = await createConnectedStore();
		const pending = store.refreshAgentTodos();
		respondErrorTo(lastRequestId("list_agent_todos"), "Agent Todo store at /x is not valid JSON");
		await pending;

		const view = store.getSnapshot();
		expect(view.agentTodos).toBeUndefined();
		expect(view.agentTodosError).toContain("not valid JSON");
		expect(view.agentTodosPending).toBe(false);
	});

	it("切 Agent：板子立即作废，并只为新 Agent 重读；上一个 Agent 的迟到响应整份丢弃", async () => {
		const store = await createConnectedStore();
		const first = store.refreshAgentTodos();
		const staleId = lastRequestId("list_agent_todos");

		store.switchSession("hr");
		// 切换是同步作废：重读回来之前界面必须是「还不知道」，而不是上一个 Agent 的任务
		expect(store.getSnapshot().agentTodos).toBeUndefined();
		expect(store.getSnapshot().agentTodosPending).toBe(true);

		pushSnapshot("hr", "/sessions/hr.jsonl");
		const reloadId = lastRequestId("list_agent_todos");
		expect(reloadId).not.toBe(staleId);
		expect(commandsOf("list_agent_todos").at(-1)).toMatchObject({ sessionId: "hr" });

		// 迟到的旧响应（属于 default）：落后于当前代际，不许落地
		respondTo(staleId, { agentId: "default", todos: [makeTodo()] });
		await expect(first).resolves.toBeUndefined();
		expect(store.getSnapshot().agentTodos).toBeUndefined();

		respondTo(reloadId, { agentId: "hr", todos: [makeTodo({ id: "hr-1", agentId: "hr" })] });
		await Bun.sleep(0);

		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["hr-1"]);
		expect(store.getSnapshot().agentTodos?.every(t => t.agentId === "hr")).toBe(true);
	});

	it("保存：带上焦点 Agent 的 owner，并用 serve 返回的记录（时间戳由存储盖章）替换板上那条", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [makeTodo({ createdAt: 10 })] });
		await load;

		const saved = store.saveAgentTodo(makeTodo({ title: "改过的标题", createdAt: 0, updatedAt: 0 }));
		const write = commandsOf("set_agent_todo").at(-1) as { todo: AgentTodoDto };
		expect(write.todo).toMatchObject({ agentId: "default", title: "改过的标题" });

		respondTo(lastRequestId("set_agent_todo"), {
			todo: makeTodo({ title: "改过的标题", createdAt: 10, updatedAt: 99 }),
		});
		await saved;

		expect(store.getSnapshot().agentTodos?.[0]).toMatchObject({ title: "改过的标题", updatedAt: 99 });
	});

	it("保存失败原样抛出，板子不动 —— 失败不能被显示成成功", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [makeTodo()] });
		await load;

		const saved = store.saveAgentTodo(makeTodo({ projectId: "ghost" }));
		respondErrorTo(lastRequestId("set_agent_todo"), 'todo.project-missing: projectId "ghost" is not a known Project');

		await expect(saved).rejects.toThrow(/todo\.project-missing/);
		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["todo-1"]);
		expect(store.getSnapshot().agentTodosError).toBeUndefined();
	});

	it("删除只在服务端确认删除后就地去掉；deleted:false 时板子不动", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [makeTodo()] });
		await load;

		const removed = store.deleteAgentTodo("todo-1");
		expect(commandsOf("delete_agent_todo").at(-1)).toMatchObject({ todoId: "todo-1" });
		respondTo(lastRequestId("delete_agent_todo"), { deleted: false });
		expect(await removed).toBe(false);
		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["todo-1"]);

		const removedAgain = store.deleteAgentTodo("todo-1");
		respondTo(lastRequestId("delete_agent_todo"), { deleted: true });
		expect(await removedAgain).toBe(true);
		expect(store.getSnapshot().agentTodos).toEqual([]);
	});
});

describe("session todo boundary", () => {
	it("会话任务的改动只走 set_todos，不碰 Agent 板，也不发 Agent Todo 命令", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [makeTodo()] });
		await load;

		const before = store.getSnapshot().agentTodos;
		const beforeCommands = commandsOf("set_agent_todo").length + commandsOf("delete_agent_todo").length;

		store.setTodos([
			{
				name: "阶段一",
				tasks: [{ content: "会话里的临时活", status: "pending" }],
			},
		]);

		expect(commandsOf("set_todos").length).toBe(1);
		expect(commandsOf("set_agent_todo").length + commandsOf("delete_agent_todo").length).toBe(beforeCommands);
		// 会话 todo 进的是 view.todo（会话快照那份），Agent 板一个字节都没变
		expect(store.getSnapshot().agentTodos).toEqual(before);
	});
});
