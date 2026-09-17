import type { AgentInfoDto } from "@cornfield/wire";
import type { GatewayStatusDto } from "../../lib/pi-client-api";

/**
 * Agent 卡片与详情头部共用的「状态结论」。
 *
 * 这里只有一套判定：gateway 账号停用（`enabled:false` / 不在运行账号表）优先覆盖 serve
 * 快照的 `status` 投影，其余按 serve 的 online/busy/idle/stopped 翻译成同一个词。列表卡片
 * 与详情头部各自只调这一处，两处就不会再出现「列表说已停用、详情说空闲」的分叉。
 */

/** 展示层状态键（`unmounted` = serve 未挂载；`disabled` = gateway 账号停用）。 */
export type AgentDisplayStatus = "online" | "busy" | "idle" | "unmounted" | "disabled";

export interface AgentStatusDisplay {
	/** 筛选桶键（与 {@link AgentDisplayStatus} 一一对应）。 */
	key: AgentDisplayStatus;
	/** 屏上写的词（列表卡片、详情头部、筛选桶共用同一套词）。 */
	label: string;
	/** 状态点 tailwind 配色（红=停用，绿=焦点，黄脉动=执行中，灰=空闲/未挂载）。 */
	dotClass: string;
}

/**
 * 账号是否已停用：gateway 运行中 + 绑定了钉钉 + accountId 不在 gateway 账号表 = 停用。
 * 未绑定钉钉的本地 agent（default）不算停用；gateway 未运行 / 状态陈旧时按不拦截。
 */
export function isAccountStopped(agent: AgentInfoDto, gwStatus: GatewayStatusDto | null): boolean {
	if (!gwStatus || gwStatus.stale) return false;
	if (!agent.dingtalk) return false;
	return !gwStatus.accounts.some(a => a.accountId === agent.id);
}

/**
 * 一个 agent 在屏幕上的状态结论（词 + 点色）。列表与详情共用这一份，保证同一 agent 两处同词。
 */
export function agentStatusDisplay(agent: AgentInfoDto, gwStatus: GatewayStatusDto | null): AgentStatusDisplay {
	if (isAccountStopped(agent, gwStatus)) {
		return { key: "disabled", label: "已停用", dotClass: "bg-danger" };
	}
	switch (agent.status) {
		case "online":
			return { key: "online", label: "运行中", dotClass: "bg-success" };
		case "busy":
			return { key: "busy", label: "执行中", dotClass: "bg-warning animate-pulse" };
		case "idle":
			return { key: "idle", label: "空闲", dotClass: "bg-ink-faint" };
		case "stopped":
			return { key: "unmounted", label: "未挂载", dotClass: "bg-ink-faint" };
		default:
			// serve 快照的 status 是完整联合，此分支只兜运行时异常数据；按「未挂载」处理，不造新词。
			return { key: "unmounted", label: "未挂载", dotClass: "bg-ink-faint" };
	}
}
