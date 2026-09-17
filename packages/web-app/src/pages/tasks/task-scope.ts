/**
 * 定时任务工作台的 scope 判定（T10C）—— 纯函数，可单测。
 *
 * 工作台要按 **Agent / Project / Session** 三个 scope 展示调度定义，而「一行属于谁」不能靠
 * 渲染层的感觉决定：
 *
 *   Agent scope   网关从行里持久化的绑定解析出来的 `agentId`（registered 时才有）；身份没解析出来
 *                 的行**不得**归到当前选中的 Agent 名下 —— 那是替另一个 Agent 认领工作
 *   Project scope Agent 声明绑定的 Project（`workspace.json` projectRoot 命中 Project registry）；
 *                 没声明就是「未声明绑定（不受约束）」，不是「无项目」
 *   Session scope 一次执行落到的 OMP 会话（`CronLogEntryDto.agentSessionPath`）与投递目标会话
 *                 （`delivery.toConversationId`）—— 都是从执行记录/调度定义里读出来的事实
 *
 * 三个容易写错的地方，本模块显式区分：
 *   1. `unbound`（没绑定）与 `unregistered`（有 home 但认不出是谁）是两件事，展示与处置都不同；
 *   2. 过期（`once` 且到点已过）是行的属性，不由展示层推断成「已禁用」；
 *   3. 「重复执行」看 repeatCount/repeatCompleted 与 runCount，不是看 runCount > 1。
 */

import type { CronLogEntryDto, TaskRowDto } from "@cornfield/wire";

/** 归属桶：注册身份 / 身份未解析（有 home，认不出是哪个 Agent）/ 未绑定。 */
export type TaskScopeBucket = "agent" | "unresolved" | "unbound";

/** 当前焦点 Agent 的事实（来自 list_agents 的注册表，前端不自己拼身份）。 */
export interface FocusAgentScope {
	/** 注册 id；无焦点 Agent（未连接/未注册）时缺省。 */
	agentId?: string;
	/** Agent 的 home（用于认领「身份未解析但目录相同」的旧行）。 */
	agentDir?: string;
}

/** 一行任务在渲染前算好的判定结果。 */
export interface TaskView {
	task: TaskRowDto;
	bucket: TaskScopeBucket;
	/** 该行是否属于当前焦点 Agent 的 scope。 */
	inFocusScope: boolean;
	/** 一次性调度且到点已过：不会再触发（行本身仍如实显示 enabled/status）。 */
	expired: boolean;
	/** 绑定的说明文本（给行上那个 badge 用）。 */
	bindingLabel: string;
	/** 有值 = 这行跑不起来（未绑定 / Agent home 不在），值是人话原因。 */
	blockedReason?: string;
}

/** 归属桶 → 分组标题（未解析/未绑定各自成组，不得并入任何 Agent）。 */
export const BUCKET_LABELS: Record<TaskScopeBucket, string> = {
	agent: "已绑定 Agent",
	unresolved: "身份未解析",
	unbound: "未绑定 Agent",
};

function bucketOf(task: TaskRowDto): TaskScopeBucket {
	if (task.agentId) return "agent";
	return task.agentResolution === "unbound" ? "unbound" : "unresolved";
}

/** 一行是否属于焦点 Agent：身份匹配（权威）或 home 相同（旧行的路径事实）。 */
export function isTaskInAgentScope(task: TaskRowDto, scope: FocusAgentScope): boolean {
	if (scope.agentId && task.agentId) return task.agentId === scope.agentId;
	// 身份没解析出来的旧行：只有「执行 home 就是这个 Agent 的家」才算它的人。
	if (scope.agentDir && task.agentDir) return normalizePath(task.agentDir) === normalizePath(scope.agentDir);
	return false;
}

/** 过期：`once` 调度的触发点已过（cron/interval 不存在过期）。 */
export function isExpiredTask(task: TaskRowDto, now = Date.now()): boolean {
	if (task.scheduleType !== "once") return false;
	return typeof task.nextRunAt === "number" && task.nextRunAt > 0 && task.nextRunAt < now;
}

/** 绑定的展示文本：身份 + 目录（未解析时明说身份未知，不拿目录冒充名字）。 */
export function taskBindingLabel(task: TaskRowDto): string {
	const identity =
		task.agentId !== undefined
			? (task.agentDisplayName ?? task.agentId)
			: task.agentResolution === "unbound"
				? "未绑定 Agent"
				: "身份未解析";
	const dir = task.agentDir ? ` · ${task.agentDir}` : "";
	return `${identity}${dir}`;
}

/** 为什么这行跑不起来（undefined = 没有已知阻塞）。 */
export function taskBlockedReason(task: TaskRowDto): string | undefined {
	if (task.agentResolution === "unbound") {
		return task.agentError ?? "没有绑定 Agent：调度不会执行。";
	}
	if (task.agentEnabled === false) {
		return task.agentError ?? "绑定的 Agent 的 agentDir 不存在：调度不会执行。";
	}
	return undefined;
}

/** 把一行 + 焦点 scope 算成渲染视图。 */
export function toTaskView(task: TaskRowDto, scope: FocusAgentScope, now = Date.now()): TaskView {
	const view: TaskView = {
		task,
		bucket: bucketOf(task),
		inFocusScope: isTaskInAgentScope(task, scope),
		expired: isExpiredTask(task, now),
		bindingLabel: taskBindingLabel(task),
	};
	const blocked = taskBlockedReason(task);
	if (blocked) view.blockedReason = blocked;
	return view;
}

/** 一组同 scope 的行（组内保持 serve 顺序）。 */
export interface TaskGroup {
	/** 组键：`agent:<agentId>` / `unresolved:<agentDir|→` / `unbound`。 */
	key: string;
	label: string;
	bucket: TaskScopeBucket;
	agentId?: string;
	/** Agent 声明的 Project 绑定（缺省 = 未声明，不是「没有项目」）。 */
	projectIds?: string[];
	/** 该组里有多少行跑不起来（未解析/未绑定/Agent home 不在）。 */
	blockedCount: number;
	rows: TaskView[];
}

/** 按 Agent 分组：已解析的按 agentId 合组，未解析的按 home 合组，未绑定的合一组。 */
export function groupTasks(tasks: TaskRowDto[], scope: FocusAgentScope, now = Date.now()): TaskGroup[] {
	const views = tasks.map(task => toTaskView(task, scope, now));
	const groups = new Map<string, TaskGroup>();
	for (const view of views) {
		const task = view.task;
		const key =
			view.bucket === "agent"
				? `agent:${task.agentId}`
				: view.bucket === "unresolved"
					? `unresolved:${normalizePath(task.agentDir ?? "")}`
					: "unbound";
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				label: groupLabel(task, view.bucket),
				bucket: view.bucket,
				blockedCount: 0,
				rows: [],
			};
			if (task.agentId !== undefined) group.agentId = task.agentId;
			if (task.projectIds !== undefined) group.projectIds = task.projectIds;
			groups.set(key, group);
		}
		if (view.blockedReason) group.blockedCount++;
		group.rows.push(view);
	}
	return [...groups.values()];
}

function groupLabel(task: TaskRowDto, bucket: TaskScopeBucket): string {
	if (bucket === "agent") return task.agentDisplayName ?? task.agentId ?? "（未命名 Agent）";
	if (bucket === "unbound") return BUCKET_LABELS.unbound;
	return `${BUCKET_LABELS.unresolved}（${task.agentDir ?? "无目录"}）`;
}

/** 重复执行的进度：已完成/总数 + 是否已跑完（总数缺省 = 不限次）。 */
export function taskRunProgress(task: TaskRowDto): {
	completed: number;
	total?: number;
	exhausted: boolean;
	text: string;
} {
	const completed = task.repeatCompleted ?? task.runCount ?? 0;
	const total = typeof task.repeatCount === "number" && task.repeatCount > 0 ? task.repeatCount : undefined;
	const exhausted = total !== undefined && completed >= total;
	return {
		completed,
		...(total !== undefined ? { total } : {}),
		exhausted,
		text: total !== undefined ? `已执行 ${completed}/${total} 次` : `已执行 ${completed} 次`,
	};
}

/** 一行的最近一次执行（按执行记录时间取最新；没有记录 = undefined）。 */
export function latestLogOf(logs: readonly CronLogEntryDto[], taskId: string): CronLogEntryDto | undefined {
	let latest: CronLogEntryDto | undefined;
	for (const log of logs) {
		if (log.taskId !== taskId) continue;
		if (!latest || log.ts > latest.ts) latest = log;
	}
	return latest;
}

/** 路径归一（比较用）：反斜杠统一、去掉重复与尾随分隔符。 */
function normalizePath(value: string): string {
	const unified = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	return unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
}
