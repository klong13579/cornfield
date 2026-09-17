import type { EnvironmentSummaryDto } from "@cornfield/wire";

/**
 * 首页「真实性」纯函数（T4）—— 把首页不再向用户说谎的那几处判据从组件里抽出来，供单测钉住。
 *
 * 只放「输入 → 显示/发送判据」的无副作用计算，不含任何 React / DOM 依赖：
 * - 输入法组合态判据：Enter 在组合态是「选词确认」，不是「提交」。
 * - 环境摘要行：空字段（非 git 分支为空）不出现，serve 报不出的定时任务数不硬编成 0。
 * - 占位文案：没有焦点 Agent 时不给一个不存在的名字。
 */

/** Enter 是否应触发发送。组合态（isComposing）下的 Enter 是 IME 选词，不算提交。 */
export function shouldSubmitOnEnter(key: string, isComposing: boolean): boolean {
	return key === "Enter" && !isComposing;
}

/**
 * 环境摘要行：只拼确实拿到的字段，空字段跳过，pendingCronCount 为 0/未知时不说「0 定时任务」。
 *
 * wire serve 不返回 pendingCronCount（那是 gateway 面的数据源），适配层把它缺省成 0 ——
 * 直接「0 定时任务待执行」等于替 serve 编一个它不知道的读数。这里只在确有 >0 时提这一句。
 */
export function envSummaryText(env: EnvironmentSummaryDto): string {
	const parts: string[] = [];
	if (env.repos) parts.push(env.repos);
	if (env.branch) parts.push(env.branch);
	parts.push(`${env.activeAgentCount} agent 运行中`);
	if (env.pendingCronCount > 0) parts.push(`${env.pendingCronCount} 定时任务待执行`);
	return parts.join(" · ");
}

/** 输入框占位文案：有焦点 Agent 用其名，否则用通用文案（不写死不存在的 Agent 名）。 */
export function composerPlaceholder(agentName: string | undefined): string {
	return agentName ? `给 ${agentName} 发一条指令…` : "发一条指令…";
}

/** Agent 区块标题 —— 卡片展示的是「已注册 Agent」，不是（也没有数据支撑的）「最近活跃」。 */
export const AGENT_SECTION_TITLE = "Agent";
