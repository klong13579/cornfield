/**
 * agent 列表结果形状（server_snapshot / list_agents / attach 等）。
/** agent 列表结果形状（server_snapshot / list_agents / attach 等）。 */

export type AgentKind = "coding" | "worker";
export type AgentStatus = "online" | "busy" | "idle" | "stopped";

/** 域声明（B1，D8/D10）：agent 所属域 + 是否域 agent（lead）。 */
export interface DomainRef {
	id: string;
	name: string;
	/** 该 agent 是否为域 agent（域的大脑，域内协作发起者）。 */
	lead?: boolean;
}

/** 域详情（list_domains 响应项）：域 + 域内 agent。 */
export interface DomainDto {
	id: string;
	name: string;
	/** 域 agent（lead 标记）的 agent id，未指定则为空。 */
	leadAgentId?: string;
	agents: AgentInfoDto[];
}

/** list_domains 响应。 */
export interface ListDomainsResult {
	domains: DomainDto[];
}

/** domain_report 响应（B2，CEO 工作台战报卡）。 */
export interface DomainReportResult {
	domainId: string;
	/** 域战报文本（域 agent 的 context/summary.md 产出）。未生成时为 undefined。 */
	report?: string;
	/** 战报文件 mtime（ISO）。 */
	updatedAt?: string;
}

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
	/** 运行阶段（attached 时有值）。 */
	phase?: "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";
	/** agentDir 绝对路径。 */
	agentDir?: string;
	dingtalkBound?: boolean;
	/** 所属域声明（B1）。 */
	domain?: DomainRef;
}

export interface SessionListEntryDto {
	id: string;
	name?: string;
	sessionFile?: string;
	active: boolean;
}
