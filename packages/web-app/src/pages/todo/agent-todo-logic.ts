import type { AgentTodoDto, AgentTodoStatusDto, ProjectRecordDto } from "../../lib/pi-client-api";

/**
 * Agent Todo 工作台的投影逻辑（纯函数，无 DOM）。
 *
 * 这一层只做三件事，且都必须可被单独验证：
 *   - **scope 隔离**：Agent Todo 板上的记录只按它自己的字段投影（owner / projectId），
 *     不去看会话 todo，也不去读 Project 的 TODO.md —— 三种东西的 owner 不同，混在一起
 *     看就是让用户以为它们是一回事（§9 / §37）。
 *   - **Project 筛选**：绑定了哪个 Project 就落在哪个桶里；**没绑定**是「通用任务」，
 *     与「绑定了一个查不到的 Project」是两回事（后者要显式说出来，不能悄悄藏掉）。
 *   - **展示顺序**：先未完成、再已完成、最后取消；同组按 updatedAt 倒序。
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
