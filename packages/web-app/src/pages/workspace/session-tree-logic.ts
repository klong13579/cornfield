import type { ChildSessionNodeDto, ChildSessionStatusDto } from "../../lib/pi-client-api";

/**
 * 会话树面板的显示逻辑（与渲染分离，便于按仓库既有 *-logic 惯例单测）。
 *
 * 这里有三件真有判断的事：
 *   1. **什么时候允许点「带回结果」** —— 它必须严格等于 serve 侧
 *      `bring_back_child_result` 会成功的条件（有结果指针、且还没带回）；放宽一格，用户
 *      就会点到一个必然失败（或重复注入）的按钮。
 *   2. **什么时候允许提交一次委派** —— serve 会拒掉空 objective，但那条规则在这里就能
 *      说清；留给一次往返，用户拿到的只是一个晚到的错误。
 *   3. **委派失败后能说什么** —— 子会话到底有没有起来，客户端无从知道，所以这句提示只能
 *      指向刚重读过的账本。
 */

export const STATUS_LABEL: Record<ChildSessionStatusDto, string> = {
	running: "运行中",
	waiting_user: "等待你",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

export const STATUS_BADGE: Record<ChildSessionStatusDto, string> = {
	running: "badge run",
	waiting_user: "badge run",
	completed: "badge done",
	failed: "badge fail",
	cancelled: "badge",
};

export interface ResultState {
	label: string;
	/** 只有它为真时「带回结果」可用。 */
	canBringBack: boolean;
}

/** 结果状态：没有结果 / 结果就绪待带回 / 已带回（终态，不再可操作）。 */
export function resultStateOf(child: Pick<ChildSessionNodeDto, "resultRef" | "resultBroughtBackAt">): ResultState {
	if (!child.resultRef) return { label: "无结果", canBringBack: false };
	if (child.resultBroughtBackAt === undefined) return { label: "结果待带回", canBringBack: true };
	return { label: "已带回", canBringBack: false };
}

/** 相对时间（分钟粒度；跨天回落到日期）。 */
export function shortTime(epochMs: number, now: number = Date.now()): string {
	const minutes = Math.floor((now - epochMs) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return new Date(epochMs).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export interface DelegateSubmitState {
	canSubmit: boolean;
	/** 为什么现在不能提交（空串 = 可以提交）。 */
	hint: string;
}

/**
 * 委派表单能不能提交。
 *
 * 两条与 serve 严格对齐的规则：objective 去空白后非空（serve 拒掉空 objective），
 * 以及一次一个（委派是起一个真进程，并发点两次不是一个用户想要的效果）。
 */
export function delegateSubmitState(input: { objective: string; busy: boolean }): DelegateSubmitState {
	if (input.busy) return { canSubmit: false, hint: "委派中…" };
	if (input.objective.trim() === "") return { canSubmit: false, hint: "写清这次委派要完成什么" };
	return { canSubmit: true, hint: "" };
}

/**
 * 委派失败后，这一行还能说什么。
 *
 * 客户端**不知道**子会话有没有起来：serve 在子进程起不来 / 没过注册门时会把账本节点写成
 * `failed` 再报错，断线时子进程甚至可能已经起来了。所以这句话只能说「以刚重读过的账本为
 * 准」，绝不能说「树上不会多一行」—— 那是客户端无从知道的事。
 *
 * 账本本身也没读到（`ledgerError` 非空）时更不能给结论：这条委派成没成，此刻无从判断。
 */
export function delegateFailureNote(ledgerError: string | undefined): string {
	if (ledgerError !== undefined) return "账本也没读到：这次委派成没成，暂时无从判断。";
	return "已重读账本：这次委派成没成，以树上的记录为准。";
}

/**
 * 委派目标 Agent 的可选项（注册表原样，当前 Agent 排在第一个）。
 *
 * 不去重、不合并同名项：注册表的 id 就是 serve 认的 key，前端自作主张地归并会造出一个
 * serve 根本不认识的选项。当前 Agent 排第一只是默认选择顺序，不是身份合并。
 */
export function delegateAgentOptions(
	agents: readonly { id: string; name: string }[],
	activeAgentId: string | undefined,
): Array<{ id: string; name: string }> {
	const options = agents.map(agent => ({ id: agent.id, name: agent.name }));
	if (!activeAgentId) return options;
	const current = options.findIndex(agent => agent.id === activeAgentId);
	if (current <= 0) return options;
	const [first] = options.splice(current, 1);
	if (first) options.unshift(first);
	return options;
}
