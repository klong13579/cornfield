import { PiServerError } from "@cornfield/client";
import type { AgentTodoDto, AgentTodoPriorityDto, AgentTodoStatusDto, ProjectRecordDto } from "../../lib/pi-client-api";

/**
 * Agent Todo 工作台的投影逻辑（纯函数，无 DOM）。
 *
 * 这一层做四件事，且都必须可被单独验证：
 *   - **scope 隔离**：工作台只展示 Agent-owned Todo，Project 仅按 projectId 筛选同一组记录。
 *     会话 todo 留在聊天运行时；项目 TODO.md 不属于这个工作台的数据源。
 *   - **Project 筛选**：绑定了哪个 Project 就落在哪个桶里；**没绑定**是「通用任务」，
 *     与「绑定了一个查不到的 Project」是两回事（后者要显式说出来，不能悄悄藏掉）。
 *   - **展示顺序**：先未完成、再已完成、最后取消；同组按 updatedAt 倒序。
 *   - **编辑 / 延期**：把表单原文翻成一条只含可写字段的补丁，并把「过期」这类判断与
 *     `status` 分开算（过期不是一种状态，取消和完成也不是「更严重的过期」）。
 *
 * 所有涉及 Project 的判断都走 {@link ProjectRegistryView}，因为**「读不出来」不是
 * 「没有」**：registry 挂掉时把一个有效的绑定渲染成「这个 Project 没了」，就是在替一个
 * 我们并不知道的结论发言（T8 的 `projectLabelOf` 定的是同一条规矩）。
 */

/** 筛选桶：全部 / 未绑定（通用任务）/ 某一个 Project。 */
export type AgentTodoFilter = { kind: "all" } | { kind: "unbound" } | { kind: "project"; projectId: string };

export const ALL_TODOS: AgentTodoFilter = { kind: "all" };
export const UNBOUND_TODOS: AgentTodoFilter = { kind: "unbound" };

/**
 * Project registry 在前端看到的**三态**。
 *
 * `projects === undefined` 与 `projectsError` 都不是「没有 Project」：前者是还没读到，
 * 后者是读坏了。把这两者当空列表用，就是让用户的绑定凭空变成「无效」。
 */
export type ProjectRegistryView =
	| { state: "unreadable"; error: string }
	| { state: "pending" }
	| { state: "loaded"; projects: readonly ProjectRecordDto[] };

export function projectRegistryOf(view: {
	projects?: readonly ProjectRecordDto[];
	projectsError?: string;
}): ProjectRegistryView {
	if (view.projectsError) return { state: "unreadable", error: view.projectsError };
	if (view.projects === undefined) return { state: "pending" };
	return { state: "loaded", projects: view.projects };
}

/** 终态：完成了或取消了，都不会再回到进行中（§37 生命周期）。 */
export function isTerminal(status: AgentTodoStatusDto): boolean {
	return status === "completed" || status === "cancelled";
}

export function matchesAgentTodoFilter(todo: AgentTodoDto, filter: AgentTodoFilter): boolean {
	switch (filter.kind) {
		case "all":
			return true;
		case "unbound":
			return todo.projectId === undefined;
		case "project":
			return todo.projectId === filter.projectId;
	}
}

export function filterAgentTodos(todos: readonly AgentTodoDto[], filter: AgentTodoFilter): AgentTodoDto[] {
	return todos.filter(todo => matchesAgentTodoFilter(todo, filter));
}

export interface AgentTodoCounts {
	total: number;
	/** 未完成（open + in_progress）。 */
	open: number;
	completed: number;
	cancelled: number;
}

export function countsOf(todos: readonly AgentTodoDto[]): AgentTodoCounts {
	return {
		total: todos.length,
		open: todos.filter(todo => !isTerminal(todo.status)).length,
		completed: todos.filter(todo => todo.status === "completed").length,
		cancelled: todos.filter(todo => todo.status === "cancelled").length,
	};
}

/** 展示权重：未完成在前，取消的最后。 */
const STATUS_ORDER: Record<AgentTodoStatusDto, number> = {
	in_progress: 0,
	open: 1,
	completed: 2,
	cancelled: 3,
};

/** 稳定排序：同权重按 updatedAt 倒序（刚动过的在上），再按 id 兜底保证确定性。 */
export function sortAgentTodos(todos: readonly AgentTodoDto[]): AgentTodoDto[] {
	return [...todos].sort((a, b) => {
		const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
		if (byStatus !== 0) return byStatus;
		if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
		return a.id.localeCompare(b.id);
	});
}

export interface BindingLabel {
	label: string;
	/** 有值 = 一条**我们有权说出口**的警告。判断不了的时候不给警告。 */
	warning?: string;
	title: string;
}

/**
 * 一条 Todo 的绑定标签。
 *
 * 四种情况分得很开：未绑定 / 绑定有效 / registry 里查不到 / **registry 读不出来**。
 * 最后一种不给警告 —— 我们不知道那个 Project 还在不在，说「没了」就是瞎猜；但绑定 ID 要
 * 照原样显示，否则用户会以为这条任务没绑过。
 */
export function bindingLabelOf(todo: AgentTodoDto, registry: ProjectRegistryView): BindingLabel {
	return projectBindingLabel(todo.projectId, registry);
}

export function projectBindingLabel(projectId: string | undefined, registry: ProjectRegistryView): BindingLabel {
	if (projectId === undefined) {
		return { label: "通用", title: "未绑定 Project —— 这个 Agent 的通用任务" };
	}
	switch (registry.state) {
		case "unreadable":
			return {
				label: projectId,
				title: `Project registry 读不出来（${registry.error}），无法判断这个绑定是否还有效`,
			};
		case "pending":
			return { label: projectId, title: "Project registry 读取中" };
		case "loaded": {
			const project = registry.projects.find(candidate => candidate.projectId === projectId);
			if (!project) {
				return {
					label: projectId,
					warning: `绑定的 Project "${projectId}" 已经不在 Project registry 里了`,
					title: "Project 已被删除或改名",
				};
			}
			return { label: project.name, title: `${project.name} · ${project.root}` };
		}
	}
}

/**
 * 能绑的 Project：Agent 声明过的绑定是上限（缺省 = 未约束）。
 *
 * registry 还没读到 / 读不出来时返回空 —— 拿不到清单就不假装「没有可绑的 Project」，
 * 由调用方把这个状态说出来（见 {@link ProjectRegistryView}）。
 */
export function bindableProjects(
	registry: ProjectRegistryView,
	declaredProjectIds: readonly string[] | undefined,
): ProjectRecordDto[] {
	if (registry.state !== "loaded") return [];
	if (declaredProjectIds === undefined) return [...registry.projects];
	return registry.projects.filter(project => declaredProjectIds.includes(project.projectId));
}

export interface FilterOption {
	filter: AgentTodoFilter;
	label: string;
	count: number;
	warning?: string;
}

/**
 * 筛选桶的选项：全部 / 未绑定 / 板上**实际出现过**的每个 Project。
 *
 * 用「出现过的」而不是 registry 全量：筛选器里有 8 个桶、7 个点进去是空的，用户就得先
 * 逐个点一遍才知道任务在哪。板上没有的 Project 不需要出现在这里（要新建时走选择器）。
 * 查不到的 projectId 也要给一个桶，否则那些任务会被筛没了。
 */
export function filterOptionsOf(registry: ProjectRegistryView, todos: readonly AgentTodoDto[]): FilterOption[] {
	const options: FilterOption[] = [{ filter: ALL_TODOS, label: "全部", count: todos.length }];
	const unbound = todos.filter(todo => todo.projectId === undefined).length;
	if (unbound > 0) options.push({ filter: UNBOUND_TODOS, label: "通用", count: unbound });

	const seen = new Map<string, number>();
	for (const todo of todos) {
		if (todo.projectId === undefined) continue;
		seen.set(todo.projectId, (seen.get(todo.projectId) ?? 0) + 1);
	}
	for (const [projectId, count] of seen) {
		const label = projectBindingLabel(projectId, registry);
		options.push({
			filter: { kind: "project", projectId },
			// 名字只在「确实查到了」时用 —— 「查不到」和「查不了」都只能显示 id
			label: registry.state === "loaded" && !label.warning ? label.label : projectId,
			count,
			...(label.warning ? { warning: label.warning } : {}),
		});
	}
	return options;
}

/** 两个筛选桶是不是同一个（React 列表 key / 选中判定用）。 */
export function sameFilter(a: AgentTodoFilter, b: AgentTodoFilter): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "project" && b.kind === "project") return a.projectId === b.projectId;
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 编辑与延期（T16）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 生命周期表 —— 镜像 `agent-domain/relations.ts` 的 `AGENT_TODO_TRANSITIONS`。
 *
 * 服务端按**已存盘的**状态判，客户端说什么都不算数，所以这张表在前端不是为了「再判一次」
 * 写权限，而是为了**不给用户一个必然失败的选择**：终态只有自己一条出路，所以终态行上
 * 不渲染任何状态控件 —— 能点、但永远被 serve 拒绝的按钮，是把服务端的规则伪装成「界面卡了」。
 *
 * 两处不一致时以服务端为准（它才是唯一会拒绝写入的一方）；这里跟着改。
 */
const TRANSITIONS: Record<AgentTodoStatusDto, readonly AgentTodoStatusDto[]> = {
	open: ["open", "in_progress", "completed", "cancelled"],
	in_progress: ["open", "in_progress", "completed", "cancelled"],
	completed: ["completed"],
	cancelled: ["cancelled"],
};

/** 从 `status` 出发合法的目标（含「转到自己」这条无操作转移）。 */
export function allowedTransitionsOf(status: AgentTodoStatusDto): readonly AgentTodoStatusDto[] {
	return TRANSITIONS[status];
}

/** 这次转移合不合法 —— 合法不等于「界面该给按钮」，见 {@link statusActionsOf}。 */
export function canTransition(from: AgentTodoStatusDto, to: AgentTodoStatusDto): boolean {
	return TRANSITIONS[from].includes(to);
}

/** 界面上值得渲染成按钮的转移：去掉无操作的那条。终态返回空。 */
export function statusActionsOf(status: AgentTodoStatusDto): readonly AgentTodoStatusDto[] {
	return TRANSITIONS[status].filter(target => target !== status);
}

export const PRIORITY_LABELS: Record<AgentTodoPriorityDto, string> = {
	low: "低",
	medium: "中",
	high: "高",
};

/** 优先级枚举的展示顺序（下拉框用；不要靠对象 key 顺序）。 */
export const PRIORITY_VALUES: readonly AgentTodoPriorityDto[] = ["low", "medium", "high"];

/**
 * 编辑表单里的那一份。
 *
 * `dueText` 留**输入框原文**（`datetime-local` 的 `YYYY-MM-DDTHH:mm`，本地墙钟），不是 Epoch：
 * 敲到一半的 `2026-09-1` 也是一个必须原样回显的值，先解析成数字再渲染回去会把它吃掉。
 * 空串 = 没有截止时间。
 */
export interface AgentTodoEditDraft {
	title: string;
	notes: string;
	priority: AgentTodoPriorityDto;
	dueText: string;
}

/**
 * 一条 Todo 的**可写**字段补丁。
 *
 * 缺省字段 = 清空（见 {@link applyTodoPatch}）—— 所以这里没有 `undefined` 与「不改」的区别，
 * 「不改」由调用方不写这个键来表达。
 */
export interface AgentTodoEditPatch {
	title: string;
	priority: AgentTodoPriorityDto;
	notes?: string;
	dueAt?: number;
}

/** 从板上的一条记录生成初始草稿（四个可写字段，其余不碰）。 */
export function editDraftOf(todo: AgentTodoDto): AgentTodoEditDraft {
	return {
		title: todo.title,
		notes: todo.notes ?? "",
		priority: todo.priority,
		dueText: formatDueInput(todo.dueAt),
	};
}

export type DraftCheck = { kind: "invalid"; problem: string } | { kind: "ok"; patch: AgentTodoEditPatch };

/**
 * 表单 → 补丁。
 *
 * 只拦**本地就能判定**的错（空标题、解析不出的时间），其余一律交给 serve：owner 不对、
 * Project 没声明过、状态非法都只有它能判，客户端替它下结论就是编一条自己并不知道的判决。
 *
 * 标题去首尾空白（与服务端 `title.trim() === ""` 的判据一致），备注与时间**不加工**：
 * 备注是多行文本，去空白是改用户写的东西。
 */
export function patchOfDraft(draft: AgentTodoEditDraft): DraftCheck {
	const title = draft.title.trim();
	if (title === "") return { kind: "invalid", problem: "标题不能为空" };
	const due = parseDueInput(draft.dueText);
	if (due.kind === "invalid") return { kind: "invalid", problem: `截止时间无法解析：${due.raw}` };
	return {
		kind: "ok",
		patch: {
			title,
			priority: draft.priority,
			...(draft.notes === "" ? {} : { notes: draft.notes }),
			...(due.kind === "due" ? { dueAt: due.at } : {}),
		},
	};
}

/**
 * 把补丁贴到一条 Todo 上。
 *
 * 只动补丁点名的字段。`id` / `agentId` / `projectId` / `status` / `source` / `sessionRefs` /
 * `createdAt` / `updatedAt` / `reminders` 一律原样送回：前一组由 serve 判归属、后一组由存储
 * 盖章（`createdAt` 保存、`updatedAt` 每次写入重盖），改它们只会换来一次拒绝 —— 或者更糟，
 * 把别的 Agent 的板子当成自己的写。`reminders` 必须跟着走，否则一次改标题会静默清掉提醒。
 *
 * 清空 = **省略字段**，不是写空串 / 0：存储层以「字段不在」表示没有备注、没有截止，送
 * `notes: ""` 会真的存下一条空备注，送 `dueAt: 0` 会把截止时间钉在 1970。
 */
export function applyTodoPatch(todo: AgentTodoDto, patch: AgentTodoEditPatch): AgentTodoDto {
	const next: AgentTodoDto = { ...todo, title: patch.title, priority: patch.priority };
	if (patch.notes === undefined) delete next.notes;
	else next.notes = patch.notes;
	if (patch.dueAt === undefined) delete next.dueAt;
	else next.dueAt = patch.dueAt;
	return next;
}

// ── 延期 ──

/** 延期档位。 */
export interface DeferPreset {
	key: string;
	label: string;
	days: number;
}

/**
 * 延期档位。
 *
 * 基准是**现在**，不是原来的 `dueAt`：给一条已经过期的任务按「3 天后」延期，应当落到从
 * 此刻起的三天后。从旧日期起算会给出一个仍然过期的结果 —— 用户按了「延期」却什么都没变。
 * 反面也要说清楚：这是一组**日期**（从今天数），不是增量。一条原本 30 天后到期的任务按
 * 「明天」会变成明天到期 —— 用户选的是一个具体日子，不是「往后挪一点」。
 */
export const DEFER_PRESETS: readonly DeferPreset[] = [
	{ key: "in-1-day", label: "明天", days: 1 },
	{ key: "in-3-days", label: "3 天后", days: 3 },
	{ key: "in-1-week", label: "一周后", days: 7 },
];

/**
 * 延期到 `days` 天后的当日结束。
 *
 * 按**日历天**走（`getDate() + days`），不按毫秒加：夏令时那两天只有 23 / 25 小时，
 * `now + days × 86_400_000` 在切换日附近会落到前一天的夜里，把「明天」算成「今天」。
 * 取当日结束而不是「此刻 + N 天」也是同一个理由：截止日期是人按天说的，「3 天后」
 * 落在三天后的 14:32 只是个时钟读数。
 */
export function deferDueAt(now: number, days: number): number {
	const d = new Date(now);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days + 1).getTime() - 1;
}

/**
 * 只改 `dueAt` 的一次写入。
 *
 * 其余字段**照抄已存盘的那份**，不是界面草稿：延期不是编辑，不该顺手把别的改动一起提交。
 */
export function deferredPatch(todo: AgentTodoDto, now: number, days: number): AgentTodoEditPatch {
	return {
		title: todo.title,
		priority: todo.priority,
		...(todo.notes === undefined ? {} : { notes: todo.notes }),
		dueAt: deferDueAt(now, days),
	};
}

/** 延期只对未完成的 Todo 有意义：终态没有被「以后再算」的余地。 */
export function canDefer(todo: AgentTodoDto): boolean {
	return !isTerminal(todo.status);
}

// ── 截止时间输入（datetime-local，本地墙钟） ──

/** 输入框原文的三种可能：明确的清空 / 还没敲完 / 一个时刻。 */
export type DueInputParse = { kind: "cleared" } | { kind: "invalid"; raw: string } | { kind: "due"; at: number };

const DUE_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 解析 `datetime-local` 的原文。
 *
 * 三态而不是「取个近似值」：空串是**明确的清空**，解析不出是**用户还没敲完**，把后者当成
 * 清空，就是替用户决定「那这个截止时间就不要了」。
 *
 * 用本地日历字段构造，不用 `Date.parse`：`datetime-local` 给的是墙钟时间，没有时区。
 * `Date.parse("2026-09-20T23:59")` 按本地解释、末尾加 `Z` 又要按 UTC 解释 —— 同一串得到两个答案。
 */
export function parseDueInput(raw: string): DueInputParse {
	const text = raw.trim();
	if (text === "") return { kind: "cleared" };
	const m = DUE_INPUT_RE.exec(text);
	if (!m) return { kind: "invalid", raw: text };
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = m[6] === undefined ? 0 : Number(m[6]);
	const at = new Date(year, month - 1, day, hour, minute, second, 0).getTime();
	// 2 月 30 日、25 点这类会被日历构造器**滚**成别的时刻的值不是用户写的那个日期，
	// 报错而不是替她改：悄悄改成 3 月 2 日，用户看到的是一个自己没设过的截止时间。
	const rolled = new Date(at);
	if (
		!Number.isFinite(at) ||
		rolled.getFullYear() !== year ||
		rolled.getMonth() !== month - 1 ||
		rolled.getDate() !== day ||
		rolled.getHours() !== hour ||
		rolled.getMinutes() !== minute
	) {
		return { kind: "invalid", raw: text };
	}
	return { kind: "due", at };
}

/** Epoch → `datetime-local` 输入框的值（本地墙钟，秒以下截断）。 */
export function formatDueInput(at: number | undefined): string {
	if (at === undefined || !Number.isFinite(at)) return "";
	return wallClock(at, "T");
}

/** `YYYY-MM-DD<sep>HH:mm`（本地墙钟），输入框与展示文案共用一套补零。 */
function wallClock(at: number, separator: string): string {
	const d = new Date(at);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${separator}${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 过期：与 status 正交的一条事实 ──

/** 截止时间相对 `now` 的位置。 */
export type DueState = { kind: "none" } | { kind: "overdue"; byMs: number } | { kind: "upcoming"; inMs: number };

/**
 * 截止时间过去了没有。
 *
 * 这是一条**只关于 `dueAt` 的事实**，与 `status` 无关：过期不是一种状态，取消和完成也不是
 * 「更严重的过期」。三条判断各自独立 —— 一条过期的任务仍然是未完成的（该出现在未完成桶，
 * 该被算进 `counts.open`），一条取消的任务即使 `dueAt` 已过也不因此变成「过期」。
 * 把两者搅在一起，用户就会看到「已过期」把一条取消的任务顶到待办前面。
 *
 * 边界：`dueAt === now` 不算过期（它的时刻刚到，还没过去）。
 */
export function dueStateOf(todo: AgentTodoDto, now: number): DueState {
	if (todo.dueAt === undefined) return { kind: "none" };
	return now > todo.dueAt ? { kind: "overdue", byMs: now - todo.dueAt } : { kind: "upcoming", inMs: todo.dueAt - now };
}

/** 截止时间本身（事实，终态也照实显示）。没有截止时间返回 undefined。 */
export function dueLabel(todo: AgentTodoDto): string | undefined {
	if (todo.dueAt === undefined) return undefined;
	return `截止 ${wallClock(todo.dueAt, " ")}`;
}

export interface DueBadge {
	label: string;
	tone: "danger";
	title: string;
}

/**
 * 「已过期」这枚**判断**（不是事实）—— 只在未完成的 Todo 上给。
 *
 * 终态不再有过期概念：一条已完成的任务不会因为时间过去而变成另一种状态，一条取消的任务
 * 也不欠谁一个交付。事实层（{@link dueLabel}）对终态照常显示截止时间，被压掉的只是告警。
 */
export function dueBadgeOf(todo: AgentTodoDto, now: number): DueBadge | undefined {
	if (isTerminal(todo.status)) return undefined;
	const due = dueStateOf(todo, now);
	if (due.kind !== "overdue") return undefined;
	const howLong = humanizeDuration(due.byMs);
	return { label: `已过期 ${howLong}`, tone: "danger", title: `截止时间已经过去 ${howLong}` };
}

/** 时长的粗略人话（分钟 / 小时 / 天）。不足一分钟不说「0 分钟」：那不是一个时长。 */
export function humanizeDuration(ms: number): string {
	const minutes = Math.floor(Math.max(ms, 0) / 60_000);
	if (minutes < 1) return "不到 1 分钟";
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时`;
	return `${Math.floor(hours / 24)} 天`;
}

// ── 写失败的 serve 判决 ──

export interface ServeVerdict {
	/** serve 给的原文（如 `todo.status-transition: illegal AgentTodo transition completed → open`）。 */
	message: string;
	/** 结构化错误码（协议批 B-4 的 `{ code, message }` 形状才有）。 */
	code?: string;
}

/**
 * 从一次写入失败里取出 **serve 的原话**。
 *
 * `PiServerError.message` 是 `Server rejected "set_agent_todo": <serve 的话>` —— 前缀是客户端
 * 加的，界面要显示的是后面那半句。其余错误（断线 / 超时）没有「判决」，就说它自己的话。
 *
 * 不在这里做「翻译成友好文案」：serve 拒它的理由（owner 不对、Project 没声明过、状态非法）
 * 是用户唯一能据以修的东西，改写成一句「保存失败」就把它丢了。
 */
export function serveVerdictOf(err: unknown): ServeVerdict {
	if (err instanceof PiServerError) {
		return typeof err.serverError === "string"
			? { message: err.serverError }
			: { message: err.serverError.message, code: err.serverError.code };
	}
	if (err instanceof Error) return { message: err.message };
	return { message: String(err) };
}
