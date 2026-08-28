/**
 * agent 列表结果形状（server_snapshot / list_agents / attach 等）。
 */

import type { DingtalkAgentConfigDto } from "../frames";

export type AgentKind = "coding" | "worker";
export type AgentStatus = "online" | "busy" | "idle" | "stopped";

export interface AgentInfoDto {
	id: string;
	name: string;
	face: string;
	workspace: string;
	kind: AgentKind;
	status: AgentStatus;
	lastAction?: string;
	model?: string;
	skillsCount?: number;
	cronCount?: number;
	/** 已 lazy attach 到本进程（注册表 attached）。 */
	attached?: boolean;
	/** 本连接焦点 agent（真；多连接时可能为其它连接的焦点）。 */
	active?: boolean;
	/** 运行阶段（attached 时有值）。 */
	phase?: "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";
	/** agentDir 绝对路径。 */
	agentDir?: string;
	/** 钉钉机器人配置（gateway.json channels.dingtalk.accounts；未绑定/未配置时省略）。 */
	dingtalk?: DingtalkAgentConfigDto;
}

export interface SessionListEntryDto {
	id: string;
	name?: string;
	sessionFile?: string;
	active: boolean;
}
