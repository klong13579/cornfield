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

/**
 * `create_agent` 的入参 —— 与 `cornfield agent init` 的 `InitArgs` 同一组字段。
 *
 * 建一个 agentDir 只有一条实现（`cli/agent-cli.ts` 的 `runAgentInit`），wire 面不另造一套语义：
 *   - `dir` 是**路径**语义：已存在的目录当父目录、其下建 `<name>/`；不存在的路径按原样用。
 *   - `mission` 是**文件路径**（不是文本）：那个文件的内容成为新 agentDir 的 `mission.md`。
 *   - `template` 今天只认 `"default"`，其它值由服务端拒绝（原文回给客户端）。
 */
export interface AgentCreateInput {
	name: string;
	dir?: string;
	mission?: string;
	template?: string;
}

/**
 * `create_agent` 的答复（`InitResult` 的 wire 投影，形状锁在 coding-agent 侧的类型断言上）。
 *
 * `created` 是这份读数里的分水岭：`true` = 这次真的新建了一个 agentDir；`false` = **同名目录本来
 * 就在**，这次只把缺的骨架文件补齐（`agent init` 的增量语义，不是错误、不是失败）。两种结果都写进
 * registry，所以两种之后 `list_agents` 都看得见它。
 */
export interface AgentCreateDto {
	name: string;
	/** 真实落成的 agentDir 绝对路径（`--dir` 给的是父目录时，这里是拼上 `<name>` 之后的那一个）。 */
	agentDir: string;
	created: boolean;
	/** 这次新写的骨架文件数；`created:false` 时是 0（没有新建，也就没有「写了几份」这回事）。 */
	filesWritten: number;
	/** 声明在 agentDir 上的附加读写根（`init --root`；这次没声明就不出现）。 */
	attachedRoots?: string[];
}
