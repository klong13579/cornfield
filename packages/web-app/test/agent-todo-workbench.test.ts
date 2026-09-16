import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import {
	AGENT_TODO_TRANSITIONS,
	agentTodoStatusActions,
	isAgentTodoTransitionAllowed,
	isTerminalAgentTodoStatus,
} from "@cornfield/wire";
import type { AgentTodoDto, ProjectRecordDto } from "../src/lib/pi-client-api";
import type { AgentTodoEditDraft, AgentTodoEditPatch } from "../src/pages/todo/agent-todo-logic";
import {
	ALL_TODOS,
	applyTodoPatch,
	bindableProjects,
	bindingLabelOf,
	canDefer,
	countsOf,
	DEFER_PRESETS,
	deferDueAt,
	deferredPatch,
	dueBadgeOf,
	dueLabel,
	dueStateOf,
	editDraftOf,
	filterAgentTodos,
	filterOptionsOf,
	formatDueInput,
	humanizeDuration,
	PRIORITY_LABELS,
	PRIORITY_VALUES,
	parseDueInput,
	patchOfDraft,
	projectRegistryOf,
	sameFilter,
	serveVerdictOf,
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

/** 取一条已知有效的补丁（草稿不合法就直接失败，带出问题文案）。 */
function okPatch(base: AgentTodoDto, overrides: Partial<AgentTodoEditDraft> = {}): AgentTodoEditPatch {
	const checked = patchOfDraft({ ...editDraftOf(base), ...overrides });
	if (checked.kind !== "ok") throw new Error(`draft should be valid: ${checked.problem}`);
	return checked.patch;
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
		expect(isTerminalAgentTodoStatus("completed")).toBe(true);
		expect(isTerminalAgentTodoStatus("cancelled")).toBe(true);
		expect(isTerminalAgentTodoStatus("in_progress")).toBe(false);
	});

	it("可绑的 Project 以 Agent 的声明为上限；无声明 = 未约束（不是「一个都不能绑」）", () => {
		expect(bindableProjects(LOADED, undefined).map(p => p.projectId)).toEqual(["cornfield", "dtc"]);
		expect(bindableProjects(LOADED, ["dtc"]).map(p => p.projectId)).toEqual(["dtc"]);
		expect(bindableProjects(LOADED, [])).toEqual([]);
	});
});

it("工作台只声明 Agent Todo，Project 仅作为筛选，不渲染 Session Todo 区块", () => {
	const source = readFileSync(new URL("../src/pages/todo/TodoView.tsx", import.meta.url), "utf8");
	expect(source).toContain("<AgentTodoBoard />");
	expect(source).toContain("Project 筛选");
	expect(source).not.toContain("<SessionTodos />");
	expect(source).not.toContain('scope="Session"');
});

describe("agent todo 编辑与延期", () => {
	it("终态只有自己一条出路：completed / cancelled 不可重开（§37）", () => {
		expect(AGENT_TODO_TRANSITIONS.completed).toEqual(["completed"]);
		expect(AGENT_TODO_TRANSITIONS.cancelled).toEqual(["cancelled"]);
		// 界面上要渲染的按钮集合：终态是空 —— 不是「按钮被置灰」，是根本没有按钮可点
		expect(agentTodoStatusActions("completed")).toEqual([]);
		expect(agentTodoStatusActions("cancelled")).toEqual([]);
		expect(agentTodoStatusActions("open")).toEqual(["in_progress", "completed", "cancelled"]);
		expect(agentTodoStatusActions("in_progress")).toEqual(["open", "completed", "cancelled"]);

		expect(isAgentTodoTransitionAllowed("open", "completed")).toBe(true);
		expect(isAgentTodoTransitionAllowed("in_progress", "cancelled")).toBe(true);
		expect(isAgentTodoTransitionAllowed("completed", "open")).toBe(false);
		expect(isAgentTodoTransitionAllowed("completed", "in_progress")).toBe(false);
		expect(isAgentTodoTransitionAllowed("cancelled", "open")).toBe(false);
	});

	/**
	 * 两侧同一份词表：工作台一次点击能到达的新状态，恰好是词表里的合法转移去掉无操作。
	 *
	 * 多一个 = 界面给出一个必然被 serve 拒的按钮（响的，可接受）；少一个 = 用户做不了本来合法的
	 * 事且没有任何错误（静默的能力消失）。所以两侧不能各有一份词表：这里逐状态钉住集合相等，
	 * 并顺手钉住工作台自己没有藏一张表（第二份定义就是漂移的入口）。
	 */
	it("工作台渲染的动作集合与词表同源：勾选框 + 按钮 = 合法转移去掉无操作", () => {
		const statuses = Object.keys(AGENT_TODO_TRANSITIONS) as (keyof typeof AGENT_TODO_TRANSITIONS)[];
		for (const status of statuses) {
			// TodoView 的组合：「完成」由勾选框承担，状态按钮组渲染其余合法转移。
			const buttons = agentTodoStatusActions(status).filter(target => target !== "completed");
			for (const button of buttons) expect(isAgentTodoTransitionAllowed(status, button)).toBe(true);
			// 勾选框能到达的**新**状态：合法且「还不是完成」（已完成的板子上它是勾上的，再点是无操作）。
			const checkboxReaches = status !== "completed" && isAgentTodoTransitionAllowed(status, "completed");
			const reachable = [...new Set([...buttons, ...(checkboxReaches ? ["completed"] : [])])].sort();
			expect(reachable).toEqual(AGENT_TODO_TRANSITIONS[status].filter(target => target !== status).sort());
		}

		// 工作台的两处源码里没有第二张表 —— 再长一份就该红在这里，而不是等用户发现少了按钮。
		const transitionRow = /open\s*:\s*\[\s*"open"\s*,\s*"in_progress"/;
		for (const file of ["../src/pages/todo/TodoView.tsx", "../src/pages/todo/agent-todo-logic.ts"]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(transitionRow.test(source)).toBe(false);
		}
	});

	it("编辑只动可写字段；清空 = 省略键，不是写空串 / 0", () => {
		const todo = makeTodo({
			id: "t1",
			projectId: "cornfield",
			notes: "旧备注",
			dueAt: new Date(2026, 8, 20, 23, 59).getTime(),
			reminders: [{ at: 1_700_000_100_000 }],
			status: "in_progress",
			createdAt: 5,
			updatedAt: 7,
			sessionRefs: ["s-1"],
		});

		expect(editDraftOf(todo)).toEqual({
			title: todo.title,
			notes: "旧备注",
			priority: "medium",
			dueText: "2026-09-20T23:59",
		});

		const patch = okPatch(todo, { title: "  改过的标题  ", notes: "新备注", priority: "high" });
		expect(patch.title).toBe("改过的标题");
		expect(patch.notes).toBe("新备注");

		const next = applyTodoPatch(todo, patch);
		// 存储与 serve 拥有的事实原样送回（改它们只会换来一次拒绝，或者把别人的板子当成自己的写）
		expect(next).toMatchObject({
			id: "t1",
			agentId: "default",
			projectId: "cornfield",
			status: "in_progress",
			source: "user",
			sessionRefs: ["s-1"],
			createdAt: 5,
			updatedAt: 7,
			title: "改过的标题",
			priority: "high",
			notes: "新备注",
		});
		// 提醒跟着走：一次改标题不该静默清掉它
		expect(next.reminders).toEqual([{ at: 1_700_000_100_000 }]);

		// 清空：键不出现，而不是 notes:"" / dueAt:0
		const cleared = applyTodoPatch(todo, { title: "x", priority: "low", notes: undefined, dueAt: undefined });
		expect("notes" in cleared).toBe(false);
		expect("dueAt" in cleared).toBe(false);
		// 备注留空 = 没有备注
		expect(patchOfDraft({ title: "x", notes: "", priority: "low", dueText: "" })).toEqual({
			kind: "ok",
			patch: { title: "x", priority: "low" },
		});
		// 空标题在本地就拦住（serve 也会拒，但没必要让它跑一趟）
		expect(patchOfDraft({ title: "   ", notes: "", priority: "low", dueText: "" })).toEqual({
			kind: "invalid",
			problem: "标题不能为空",
		});
	});

	it("截止时间输入分三态：空串是清空，「还没敲完」不是", () => {
		expect(parseDueInput("")).toEqual({ kind: "cleared" });
		expect(parseDueInput("   ")).toEqual({ kind: "cleared" });
		expect(parseDueInput("2026-09-1")).toEqual({ kind: "invalid", raw: "2026-09-1" });
		// 日历构造器会把 2 月 30 日 / 25 点「滚」成别的时刻：滚过的值不是用户写的日期
		expect(parseDueInput("2026-02-30T10:00").kind).toBe("invalid");
		expect(parseDueInput("2026-13-01T10:00").kind).toBe("invalid");
		expect(parseDueInput("2026-09-20T25:00").kind).toBe("invalid");

		expect(parseDueInput("2026-09-20T23:59")).toEqual({
			kind: "due",
			at: new Date(2026, 8, 20, 23, 59, 0, 0).getTime(),
		});
		// 解析不出的时间不播成「清空」：那等于替用户决定不要截止时间了
		expect(patchOfDraft({ title: "x", notes: "", priority: "low", dueText: "2026-09-1" })).toEqual({
			kind: "invalid",
			problem: "截止时间无法解析：2026-09-1",
		});

		// 输入框原文 ↔ Epoch 往返（本地墙钟，秒以下截断）
		expect(formatDueInput(new Date(2026, 8, 20, 23, 59).getTime())).toBe("2026-09-20T23:59");
		expect(formatDueInput(undefined)).toBe("");
		const withSeconds = new Date(2026, 8, 20, 23, 59, 30, 500).getTime();
		const back = parseDueInput(formatDueInput(withSeconds));
		expect(back.kind).toBe("due");
		if (back.kind === "due") {
			expect(back.at).toBeLessThanOrEqual(withSeconds);
			expect(withSeconds - back.at).toBeLessThan(60_000);
		}
	});

	it("延期以现在为基准落到当日结束，且只改 dueAt", () => {
		const now = new Date(2026, 4, 12, 4, 30, 0, 0).getTime();

		// 「明天」= 次日结束，而不是 now + 24h 的同一钟点
		expect(deferDueAt(now, 1)).toBe(new Date(2026, 4, 14, 0, 0, 0, 0).getTime() - 1);
		expect(deferDueAt(now, 3)).toBe(new Date(2026, 4, 16, 0, 0, 0, 0).getTime() - 1);
		expect(deferDueAt(now, 7)).toBe(new Date(2026, 4, 20, 0, 0, 0, 0).getTime() - 1);
		expect(DEFER_PRESETS.map(preset => preset.days)).toEqual([1, 3, 7]);
		// 按日历天走，不按毫秒加：夏令时那两天只有 23 / 25 小时，毫秒加法在切换日附近
		// 会落到前一天的夜里，把「明天」算成「今天」—— 结果必须落在本地日历的第 days 天之后那天
		for (const day of [7, 8, 31]) {
			for (const hour of [0, 1, 2, 23]) {
				const at = new Date(2026, 2, day, hour, 30, 0, 0).getTime();
				for (const days of [1, 7]) {
					const source = new Date(at);
					const targetDay = new Date(source.getFullYear(), source.getMonth(), source.getDate() + days);
					expect(new Date(deferDueAt(at, days)).toDateString()).toBe(targetDay.toDateString());
					expect(deferDueAt(at, days)).toBeGreaterThan(at);
				}
			}
		}

		// 已过期的任务延期一次必须真的落到将来：基准是现在，不是旧的 dueAt
		const overdue = makeTodo({ id: "t2", dueAt: now - 10 * 86_400_000 });
		const postponed = applyTodoPatch(overdue, deferredPatch(overdue, now, 1));
		expect(postponed.dueAt).toBe(deferDueAt(now, 1));
		expect(postponed.dueAt ?? 0).toBeGreaterThan(now);

		// 延期不是编辑：其余字段照抄**已存盘**的那份
		const todo = makeTodo({ id: "t1", notes: "备注", projectId: "cornfield", status: "in_progress" });
		const patch = deferredPatch(todo, now, 3);
		expect(patch).toMatchObject({ title: todo.title, priority: todo.priority, notes: "备注" });
		expect(applyTodoPatch(todo, patch)).toMatchObject({ id: "t1", status: "in_progress", projectId: "cornfield" });

		// 终态没有「以后再做」
		expect(canDefer(makeTodo({ status: "completed" }))).toBe(false);
		expect(canDefer(makeTodo({ status: "cancelled" }))).toBe(false);
		expect(canDefer(makeTodo({ status: "open" }))).toBe(true);
		expect(canDefer(makeTodo({ status: "in_progress" }))).toBe(true);
	});

	it("过期 ≠ 取消 ≠ 完成：三条判断各自独立", () => {
		const now = new Date(2026, 4, 12, 12, 0).getTime();
		const past = now - 3 * 86_400_000;

		const overdueOpen = makeTodo({ id: "a", status: "open", dueAt: past });
		const overdueCancelled = makeTodo({ id: "b", status: "cancelled", dueAt: past });
		const overdueCompleted = makeTodo({ id: "c", status: "completed", dueAt: past });
		const futureOpen = makeTodo({ id: "d", status: "open", dueAt: now + 86_400_000 });
		const undated = makeTodo({ id: "e", status: "open" });

		// 事实层：只看 dueAt
		expect(dueStateOf(overdueOpen, now)).toEqual({ kind: "overdue", byMs: 3 * 86_400_000 });
		expect(dueStateOf(futureOpen, now)).toEqual({ kind: "upcoming", inMs: 86_400_000 });
		expect(dueStateOf(undated, now)).toEqual({ kind: "none" });
		// 边界：时刻刚到不算过期
		expect(dueStateOf(makeTodo({ dueAt: now }), now)).toEqual({ kind: "upcoming", inMs: 0 });

		// 状态层：过期不是状态 —— 它进的是未完成桶，不是终态桶
		expect(isTerminalAgentTodoStatus(overdueOpen.status)).toBe(false);
		expect(countsOf([overdueOpen, overdueCancelled, overdueCompleted])).toEqual({
			total: 3,
			open: 1,
			completed: 1,
			cancelled: 1,
		});
		// 一条过期的任务该能被完成，也不会因为过期而被顶到终态后面
		expect(isAgentTodoTransitionAllowed(overdueOpen.status, "completed")).toBe(true);
		expect(sortAgentTodos([overdueCancelled, overdueOpen]).map(t => t.id)).toEqual(["a", "b"]);

		// 判断层：「已过期」只给未完成的
		expect(dueBadgeOf(overdueOpen, now)?.label).toBe("已过期 3 天");
		expect(dueBadgeOf(overdueCancelled, now)).toBeUndefined();
		expect(dueBadgeOf(overdueCompleted, now)).toBeUndefined();
		expect(dueBadgeOf(futureOpen, now)).toBeUndefined();
		expect(dueBadgeOf(undated, now)).toBeUndefined();
		// 截止时间本身对终态照实显示（被压掉的只是告警）
		expect(dueLabel(overdueCancelled)).toBe(`截止 ${formatDueInput(past).replace("T", " ")}`);
		expect(dueLabel(undated)).toBeUndefined();

		expect(humanizeDuration(3 * 86_400_000)).toBe("3 天");
		expect(humanizeDuration(5 * 3_600_000)).toBe("5 小时");
		expect(humanizeDuration(90_000)).toBe("1 分钟");
		// 不足一分钟不说「0 分钟」：那不是一个时长
		expect(humanizeDuration(30_000)).toBe("不到 1 分钟");
		expect(dueBadgeOf(makeTodo({ dueAt: now - 30_000 }), now)?.label).toBe("已过期 不到 1 分钟");
		// 优先级枚举的两处声明不能漂：顺序表与文案表必须同集合
		expect(PRIORITY_VALUES).toEqual(["low", "medium", "high"]);
		expect([...PRIORITY_VALUES].sort()).toEqual(Object.keys(PRIORITY_LABELS).sort());
	});

	it("写失败的 serve 判决原样取出，不翻译成「保存失败」", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), {
			agentId: "default",
			todos: [makeTodo({ status: "completed", updatedAt: 20 })],
		});
		await load;

		// serve 按**已存盘的**状态判：重开终态必须被拒，判决原样带回来
		const reopen = store.saveAgentTodo(makeTodo({ status: "open", updatedAt: 20 }));
		respondErrorTo(
			lastRequestId("set_agent_todo"),
			"todo.status-transition: illegal AgentTodo transition completed → open",
		);
		const verdict = await reopen.then(
			() => null,
			(err: unknown) => serveVerdictOf(err),
		);
		expect(verdict?.message).toBe("todo.status-transition: illegal AgentTodo transition completed → open");
		// 板子不动：失败不能被显示成成功
		expect(store.getSnapshot().agentTodos?.[0]?.status).toBe("completed");
		expect(store.getSnapshot().agentTodos?.[0]?.updatedAt).toBe(20);

		// 非 serve 的失败（断线 / 超时）没有判决，就说它自己的话
		expect(serveVerdictOf(new Error("boom"))).toEqual({ message: "boom" });
		expect(serveVerdictOf("plain")).toEqual({ message: "plain" });
	});
});

it("编辑面：状态按钮由转移表推导，延期档位来自 DEFER_PRESETS，写失败显示 serve 原话", () => {
	const source = readFileSync(new URL("../src/pages/todo/TodoView.tsx", import.meta.url), "utf8");
	// 终态渲染不出状态按钮，是因为 agentTodoStatusActions 返回空 —— 不是手写的 if
	// （两个函数都来自 @cornfield/wire 的唯一词表，前端没有第二份）
	// 组合本身也钉住：一旦谁把某个合法目标从按钮里滤掉，这里立刻红，不会变成静默的能力消失。
	expect(source).toContain('agentTodoStatusActions(todo.status).filter(target => target !== "completed")');
	expect(source).toContain('disabled={busy || !isAgentTodoTransitionAllowed(todo.status, "completed")}');
	expect(source).toContain("DEFER_PRESETS.map");
	expect(source).toContain("serveVerdictOf(err)");
	expect(source).toContain("applyTodoPatch(todo, patch)");
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

	it("编辑写入：补丁字段上联，用 serve 返回的那份替换板上那条", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), {
			agentId: "default",
			todos: [makeTodo({ createdAt: 10, updatedAt: 10, notes: "旧备注" })],
		});
		await load;

		const todo = store.getSnapshot().agentTodos?.[0];
		if (!todo) throw new Error("board should have the todo");
		const patch = okPatch(todo, { title: "新标题", notes: "", priority: "high", dueText: "" });
		const saved = store.saveAgentTodo(applyTodoPatch(todo, patch));

		const write = commandsOf("set_agent_todo").at(-1) as { todo: Record<string, unknown> };
		expect(write.todo).toMatchObject({
			id: "todo-1",
			agentId: "default",
			title: "新标题",
			priority: "high",
			status: "open",
		});
		// 清空是省略键，不是 notes:"" —— serve 以「字段不在」为准
		expect("notes" in write.todo).toBe(false);
		expect("dueAt" in write.todo).toBe(false);

		respondTo(lastRequestId("set_agent_todo"), {
			todo: makeTodo({ title: "新标题", priority: "high", createdAt: 10, updatedAt: 99 }),
		});
		await saved;

		// 用 serve 返回的那份替换（时间戳由存储盖章，客户端发出去那份不算数）
		expect(store.getSnapshot().agentTodos?.[0]).toMatchObject({
			title: "新标题",
			priority: "high",
			createdAt: 10,
			updatedAt: 99,
		});
		expect(store.getSnapshot().agentTodos?.[0]?.notes).toBeUndefined();
	});

	it("切 Agent 后，上一个 Agent 上的写入结果不落进新 Agent 的板子", async () => {
		const store = await createConnectedStore();
		const load = store.refreshAgentTodos();
		respondTo(lastRequestId("list_agent_todos"), { agentId: "default", todos: [makeTodo()] });
		await load;

		// 在 default 的板子上发起一次编辑，然后在它回来之前把焦点切到 hr
		const write = store.saveAgentTodo(makeTodo({ title: "编辑中的标题" }));
		const writeId = lastRequestId("set_agent_todo");
		store.switchSession("hr");
		pushSnapshot("hr", "/sessions/hr.jsonl");
		const reloadId = lastRequestId("list_agent_todos");

		// 迟到的那份属于 default：不许落进 hr 的板子，只许触发一次重读
		respondTo(writeId, { todo: makeTodo({ title: "编辑中的标题", agentId: "default" }) });
		await write;
		await Bun.sleep(0);
		expect(store.getSnapshot().agentTodos).toBeUndefined();

		const refetchId = lastRequestId("list_agent_todos");
		expect(refetchId).not.toBe(reloadId);
		respondTo(refetchId, { agentId: "hr", todos: [makeTodo({ id: "hr-1", agentId: "hr" })] });
		await Bun.sleep(0);
		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["hr-1"]);

		// 切 Agent 时那次重读迟到回来也不许覆盖（它属于上一代）
		respondTo(reloadId, { agentId: "default", todos: [makeTodo()] });
		await Bun.sleep(0);
		expect(store.getSnapshot().agentTodos?.map(t => t.id)).toEqual(["hr-1"]);
		expect(store.getSnapshot().agentTodos?.every(t => t.agentId === "hr")).toBe(true);
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
