import type { SessionTreeDto } from "@cornfield/wire";
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

/**
 * 进程状态（UX §8 的「进程健康」这一维）。
 *
 * 它与另外两维不是一回事，谁都不能顶替谁：
 *   - **任务状态**（`STATUS_LABEL`）= 这次委派走到哪一步，账本记的；
 *   - **结果状态**（`resultStateOf`）= 产出有没有就绪、有没有带回；
 *   - **进程状态** = 有没有一个进程正在服务它。
 *
 * 客户端**观察不到子会话的进程**，只能在账本确实给出的事实范围内说话，所以每一档的依据都写在
 * `detail` 里；说不出来的就是「未知」，绝不拿一个好看的值顶替：
 *
 *   healthy  只属于**当前焦点会话自己** —— 它刚应答了这条 `get_session_tree`，进程活着是有凭据的。
 *   stopped  `completed` / `cancelled`：这次运行已经结束。
 *   failed   `failed`：委派以失败收场，原因看 `statusDetail` 原文。**不叫 crashed** —— 父会话判的
 *            `failed` 与「进程崩溃」不是一回事（起不来、没过注册门都会写成 failed）。
 *   starting 只在手上确有「刚发出、还没有报 pid 的那次委派」时用；账本里倒推不出这一档。
 *   未知     其余非终态。账本这时只说「上次见到它时它在跑」：`lastPid` 是「最后见到」而不是存活
 *            探针，而 `get_session_tree` 读账本时**不跑 reconcile**（`manager.records()` 只与
 *            supervisor 对齐），父会话重启后陈旧条目会一直说 running —— 拿它推 healthy 就是编。
 */
export type ProcessState = "starting" | "healthy" | "stopped" | "failed" | "unknown";

export const PROCESS_LABEL: Record<ProcessState, string> = {
	starting: "启动中",
	healthy: "健康",
	stopped: "已停止",
	failed: "失败",
	unknown: "未知",
};

export interface ProcessReading {
	state: ProcessState;
	/** 屏上那一格的字。 */
	label: string;
	/** 这一档所依据的事实；`unknown` 必须在这里说清缺什么。 */
	detail: string;
}

function processReading(state: ProcessState, detail: string): ProcessReading {
	return { state, label: PROCESS_LABEL[state], detail };
}

/** 这次运行是否已经结束（WP1 §6：终态不可重开）。 */
function isSettledStatus(status: ChildSessionStatusDto): boolean {
	return status === "completed" || status === "cancelled" || status === "failed";
}

/**
 * 一条子会话的进程状态。
 *
 * `starting` 要两个事实同时成立：这次委派是**手上刚发出的那一档**（`startingChildId`），且账本还
 * 没有为它记下 pid、也还没说它结束。两条都满足才是「还在启动」；只有前者就是拿一个陈旧的本地
 * 回执替账本发言，所以账本一给出 pid 这一档就自然退场。
 */
export function childProcessStateOf(
	child: Pick<ChildSessionNodeDto, "sessionId" | "status" | "lastPid">,
	opts: { startingChildId?: string } = {},
): ProcessReading {
	if (
		opts.startingChildId !== undefined &&
		opts.startingChildId === child.sessionId &&
		child.lastPid === undefined &&
		!isSettledStatus(child.status)
	) {
		return processReading("starting", "委派已发出，还没有进程报 pid");
	}
	switch (child.status) {
		case "completed":
		case "cancelled":
			return processReading("stopped", `运行已结束（${child.status}）`);
		case "failed":
			return processReading("failed", "委派以失败收场（原因见状态说明）");
		case "running":
		case "waiting_user":
			return processReading("unknown", unreviewedProcessNote(child.lastPid));
		default:
			// 线上来的 JSON 不受类型约束：词表外的状态不许被归进任何一档。
			return processReading("unknown", `账本给了词表外的状态 ${String(child.status)}`);
	}
}

/** 账本没复核时说得清的那句话：它记着的 pid 是「报过到」，不是「此刻还活着」。 */
function unreviewedProcessNote(lastPid: number | undefined): string {
	if (lastPid === undefined) return "账本未复核，且没有 pid：此刻无从判断进程在不在";
	return `账本未复核：最后见到的 pid ${lastPid} 只说明它报过到，不等于此刻还活着`;
}

/**
 * 当前焦点会话自己的进程状态 —— 它是这条 `get_session_tree` 的应答方。
 *
 * 输入就是账本本身：读到了 = 它刚应答了这条命令（进程活着有凭据）；没读到 = 还没答。
 * 「未连接」「账本读取失败」由面板自己的守卫分支说（SessionTree.tsx），不在这里重复一遍：
 * 那两种情况下根本没有根卡片，写一条永远到不了屏上的读数就是把分支堆给下一个读者。
 *
 * `healthy` 只属于焦点会话自己，不许拿去装饰账本里的子会话。
 */
export function focusProcessState(sessionTree: SessionTreeDto | undefined): ProcessReading {
	if (sessionTree === undefined) return processReading("unknown", "还没读到账本：本会话进程是否活着无从判断");
	return processReading("healthy", "本会话进程刚应答了这条账本读取");
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
