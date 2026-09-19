import type { AgentTool, AgentToolResult } from "@cornfield/agent";
import { StringEnum } from "@cornfield/ai";
import { untilAborted } from "@cornfield/utils";
import { type Static, Type } from "@sinclair/typebox";
import {
	type AgentTodoTarget,
	putAgentTodo,
	readAgentTodoBoard,
	removeAgentTodoRecord,
} from "../agent-domain/agent-todo-board";
import { findAgentProfileByDir } from "../agent-domain/profile-registry";
import type { AgentTodo, AgentTodoPriority, AgentTodoStatus } from "../agent-domain/types";
import agentTodoDescription from "../prompts/tools/agent-todo.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

/**
 * 这个 Agent 自己的长期任务板（`<agentDir>/.cornfield/agent-todos.json`）。
 *
 * 与 `todo` 工具的分工是**范围**，不是详略：`todo` 管这一次会话的执行清单，随会话结束消失；
 * 这块板子是跨会话的长期任务 —— Todo 页显示的就是它，用户也会在上面直接改。
 *
 * 读写走 `agent-domain/agent-todo-board`（与 serve 的 wire 命令同一份）：owner、Project 绑定、
 * 生命周期、时间戳全在那一层判，工具这里只负责把「模型说的话」翻成一次调用。
 */

const AGENT_TODO_ACTIONS = ["list", "add", "update", "delete"] as const;
const AGENT_TODO_STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;
const AGENT_TODO_PRIORITIES = ["low", "medium", "high"] as const;

const agentTodoSchema = Type.Object(
	{
		action: StringEnum(AGENT_TODO_ACTIONS, {
			description: "operation to apply to this Agent's task board",
		}),
		id: Type.Optional(
			Type.String({
				description: "task id as it came back from `list` (required for update/delete)",
				examples: ["6f1c4b1e-…"],
			}),
		),
		title: Type.Optional(
			Type.String({ description: "task title, one line (required for add, must stay non-empty)" }),
		),
		status: Type.Optional(
			StringEnum(AGENT_TODO_STATUSES, { description: "new status (completed/cancelled are terminal)" }),
		),
		priority: Type.Optional(
			StringEnum(AGENT_TODO_PRIORITIES, { description: "priority; defaults to medium on add" }),
		),
		dueAt: Type.Optional(
			Type.String({
				description:
					"due date in local wall clock: `YYYY-MM-DD` (that day's end) or `YYYY-MM-DD HH:mm`; empty string clears it",
			}),
		),
		notes: Type.Optional(Type.String({ description: "free-form notes; empty string clears them" })),
		projectId: Type.Optional(
			Type.String({ description: "bind the task to a Project this Agent declares (optional)" }),
		),
	},
	{ description: "Read or update this Agent's long-lived task board" },
);

type AgentTodoParams = Static<typeof agentTodoSchema>;

export interface AgentTodoToolDetails {
	action: (typeof AGENT_TODO_ACTIONS)[number];
	agentId: string;
	/** `list` 的结果；单条写入时为 undefined（`todo` 才是这次写的那条）。 */
	todos?: AgentTodo[];
	/** 这次写入落盘的那一份（存储盖章后的权威版本）。 */
	todo?: AgentTodo;
	/** 这个 Agent 声明的 Project 绑定上限；缺省 = 未约束。 */
	projectIds?: string[];
}

/** `YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`（本地墙钟）。 */
const DUE_AT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

export class AgentTodoTool implements AgentTool<typeof agentTodoSchema, AgentTodoToolDetails> {
	readonly name = "agent_todo";
	readonly label = "AgentTodo";
	readonly loadMode = "discoverable" as const;
	readonly summary = "Reads and updates this Agent's own long-lived task board (the Todo page's board).";
	readonly description = agentTodoDescription;
	readonly parameters = agentTodoSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: AgentTodoParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AgentTodoToolDetails>> {
		return untilAborted(signal, async () => {
			const target = await this.#target();
			if (params.action === "list") {
				const board = await readAgentTodoBoard(target);
				return {
					content: [{ type: "text", text: renderBoard(board.todos) }],
					details: {
						action: "list",
						agentId: target.agentId,
						todos: board.todos,
						...(board.projectIds ? { projectIds: board.projectIds } : {}),
					},
				};
			}

			if (params.action === "add") {
				const title = requireTitle(params.title);
				const id = crypto.randomUUID();
				const todo: AgentTodo = {
					id,
					agentId: target.agentId,
					title,
					status: "open",
					priority: params.priority ?? "medium",
					source: "agent",
					// 建条时 sessionRefs 必须为空：它记的是「哪些 session 推进过」，不是调用方手上的东西。
					sessionRefs: [],
					createdAt: 0,
					updatedAt: 0,
					...(params.notes === undefined || params.notes === "" ? {} : { notes: params.notes }),
					...(params.dueAt === undefined ? {} : dueAtField(params.dueAt)),
					...(params.projectId === undefined ? {} : { projectId: params.projectId }),
				};
				const stored = await putAgentTodo(target, todo);
				return {
					content: [{ type: "text", text: `已记下：${renderLine(stored)}` }],
					details: { action: "add", agentId: target.agentId, todo: stored },
				};
			}

			if (params.action === "delete") {
				const id = requireId(params.id);
				const removed = await removeAgentTodoRecord(target, id);
				if (!removed) throw new ToolError(`板上没有 id 为 "${id}" 的任务（先用 action:"list" 取一次 id）。`);
				return {
					content: [{ type: "text", text: `已删除 ${id}` }],
					details: { action: "delete", agentId: target.agentId },
				};
			}

			const id = requireId(params.id);
			const board = await readAgentTodoBoard(target);
			const previous = board.todos.find(todo => todo.id === id);
			if (!previous) {
				throw new ToolError(`板上没有 id 为 "${id}" 的任务（先用 action:"list" 取一次 id）。`, {
					knownIds: board.todos.map(todo => todo.id),
				});
			}
			const next: AgentTodo = { ...previous };
			if (params.title !== undefined) next.title = requireTitle(params.title);
			if (params.status !== undefined) next.status = params.status;
			if (params.priority !== undefined) next.priority = params.priority;
			if (params.projectId !== undefined) next.projectId = params.projectId;
			if (params.notes !== undefined) {
				if (params.notes === "") delete next.notes;
				else next.notes = params.notes;
			}
			if (params.dueAt !== undefined) {
				if (params.dueAt.trim() === "") delete next.dueAt;
				else Object.assign(next, dueAtField(params.dueAt));
			}
			const stored = await putAgentTodo(target, next);
			return {
				content: [{ type: "text", text: `已更新：${renderLine(stored)}` }],
				details: { action: "update", agentId: target.agentId, todo: stored },
			};
		});
	}

	/**
	 * 这块板子属于哪个 Agent —— 身份（agentId）与家（agentDir）必须成对，缺一个都无法判归属。
	 *
	 * agentId 从注册表按 agentDir 反查，不猜：每一条记录的 `agentId` 是它的 owner，猜错一个
	 * 就是往别人的板子上写。
	 */
	async #target(): Promise<AgentTodoTarget> {
		// `getAgentDir()` 永远有值（缺省就是 default Agent 的家）—— 裸跑 CLI 的会话因此改的是
		// default Agent 的板子，与 Todo 页在 default 上显示的那块是同一块。
		const agentDir = this.session.settings.getAgentDir();
		const owner = await findAgentProfileByDir(agentDir);
		if (!owner) {
			throw new ToolError(
				`没有已注册的 Agent 指向 agentDir "${agentDir}"：任务板属于一个 Agent，记录里的 agentId 是它的归属。` +
					`先注册（cornfield agent init）再用这个工具。`,
			);
		}
		return { agentId: owner.agentId, agentDir: owner.agentDir };
	}
}

function requireTitle(title: string | undefined): string {
	const trimmed = title?.trim() ?? "";
	if (trimmed === "") throw new ToolError("title 不能为空。");
	return trimmed;
}

function requireId(id: string | undefined): string {
	const trimmed = id?.trim() ?? "";
	if (trimmed === "") throw new ToolError(`这个 action 需要 id（先用 action:"list" 取一次）。`);
	return trimmed;
}

/**
 * 截止时间 → 存储字段。
 *
 * 只认本地墙钟的两种写法；`YYYY-MM-DD` 落在**当日结束**（人说的「9 月 30 日截止」是那一天结束，
 * 不是那天零点 —— 与 Todo 页的「延期」同一口径）。日历构造器会**滚**掉不存在的日期
 * （2 月 30 日 → 3 月 2 日），这里报错而不是替她改：静默改成一个用户没设过的截止时间更坏。
 */
function dueAtField(raw: string): { dueAt: number } {
	const text = raw.trim();
	const match = DUE_AT.exec(text);
	if (!match) {
		throw new ToolError(`dueAt 无法解析："${text}"。用 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm"。`);
	}
	const [, year, month, day, hour, minute] = match;
	const y = Number(year);
	const mo = Number(month);
	const d = Number(day);
	const h = hour === undefined ? 23 : Number(hour);
	const mi = minute === undefined ? 59 : Number(minute);
	const at =
		hour === undefined
			? new Date(y, mo - 1, d, 23, 59, 59, 999).getTime()
			: new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
	const rolled = new Date(at);
	if (
		!Number.isFinite(at) ||
		rolled.getFullYear() !== y ||
		rolled.getMonth() !== mo - 1 ||
		rolled.getDate() !== d ||
		rolled.getHours() !== h ||
		rolled.getMinutes() !== mi
	) {
		throw new ToolError(`dueAt 不是真实存在的日期："${text}"。`);
	}
	return { dueAt: at };
}

const STATUS_LABEL: Record<AgentTodoStatus, string> = {
	open: "未开始",
	in_progress: "进行中",
	completed: "已完成",
	cancelled: "已取消",
};

const PRIORITY_LABEL: Record<AgentTodoPriority, string> = { low: "低", medium: "中", high: "高" };

/** 一条任务的一行读法（模型读的那一份）。 */
function renderLine(todo: AgentTodo): string {
	const parts = [
		todo.id,
		`[${STATUS_LABEL[todo.status]}]`,
		`[${PRIORITY_LABEL[todo.priority]}]`,
		todo.projectId === undefined ? "通用" : todo.projectId,
		todo.title,
	];
	if (todo.dueAt !== undefined) parts.push(`截止 ${wallClock(todo.dueAt)}`);
	if (todo.notes !== undefined && todo.notes !== "") parts.push(`备注：${todo.notes.replace(/\n/g, " / ")}`);
	return parts.join(" · ");
}

function renderBoard(todos: readonly AgentTodo[]): string {
	if (todos.length === 0) return "这块板子是空的。";
	const lines = todos.map(renderLine);
	return `${todos.length} 条：\n${lines.join("\n")}`;
}

/** 本地墙钟读数（给模型看的展示值；存储里存的是 Epoch）。 */
function wallClock(at: number): string {
	const d = new Date(at);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
