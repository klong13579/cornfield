import type { AgentMessage } from "@cornfield/agent";
import type { WireCommand, WireHostToolDefinition } from "./commands";

/**
 * 多端协议版本 — hello 握手时双向校验。
 *
 * 历史：
 *   v1 (P0/P1/P2)：基本 hello/request/response/push (server_snapshot/session_snapshot/progress)
 *   v1 (P3, 向后兼容)：新增 ping/pong + host_tool_* + 富化 SessionListEntry
 *
 * 向后兼容原则：新增帧为可选——旧客户端忽略未知 push 帧仍可工作。
 * 升级到 v2 仅当存在不兼容变更时。
 */
export const MULTIDEVICE_PROTOCOL_VERSION = 1;

// ── 客户端 → 服务端 ──

/**
 * host_tool_result — 客户端完成一个 host tool 执行后反回。
 * `id` 对应 push 帧 host_tool_call 里的 `id`（call直接寻址）。
 * `result.content` 遵循 AgentToolResult 约定（至少含 {type:"text", text} 项）。
 */
export interface HostToolResultFrame {
	type: "host_tool_result";
	id: string;
	result: { content: Array<{ type: string; [k: string]: unknown }> };
	isError?: boolean;
}

/**
 * host_tool_update — 客户端中途发回部分结果（流式工具）。
 * `partialResult` 同上。
 */
export interface HostToolUpdateFrame {
	type: "host_tool_update";
	id: string;
	partialResult: { content: Array<{ type: string; [k: string]: unknown }> };
}

export type ClientFrame =
	| { type: "hello"; version: number; token: string }
	| { type: "request"; id: string; command: WireCommand }
	/** 心跳：client 主动 ping，server 回 pong。 */
	| { type: "ping"; ts?: number }
	| HostToolResultFrame
	| HostToolUpdateFrame;

// ── 服务端 → 客户端 ──

/** 钉钉机器人绑定配置（gateway.json → channels.dingtalk.accounts，按 accountId 匹配 agent id）。 */
export interface DingtalkAgentConfigDto {
	/** 机器人启用状态（gateway 实际挂载）。 */
	enabled: boolean;
	/** 机器人显示名（如 "M-HR"）。 */
	robotName?: string;
	/** 钉钉应用 appKey（非 secret，可识别机器人）。 */
	appKey?: string;
	/** 机器人 code（常见与 appKey 同值）。 */
	robotCode?: string;
	/** 卡片渲染隐藏思考块（账号级偏好）。 */
	hideThinkingBlock?: boolean;
}

/**
 * 多 Agent 列表项。P3 升级：从纯 id/name 扩至含 role/model/skills/state。
 *
 * 兼容：旧字段（id/name/sessionFile/active）保留；新字段均可选，P1/P2 客户端不受影响。
 */
export interface SessionListEntry {
	/** Agent 唯一 id（注册表名，如 "default" / "hr" / "ops"）。 */
	id: string;
	/** 显示名（优先取 workspace.json displayName，否则 id）。 */
	name?: string;
	/** 当前 session JSONL 路径（已 attach 时有值；未 attach 时为 undefined）。 */
	sessionFile?: string;
	/**
	 * 与当前连接的焦点相关：true = 本连接默认推送的 session。
	 * P1 兼容：单 session 时恒 true。P3 多 agent 时，同一时刷只一个 active。
	 */
	active: boolean;
	// ── P3 新增（均可选，旧客户端忽略）──
	/** Agent 角色/工作区定位（workspace.json role）。 */
	role?: string;
	/** Agent 当前模型存图（provider/id）——仅 attached 时有值。 */
	model?: { provider: string; id: string; name?: string };
	/** 可用技能数（workspace.json skills.length，非真实加载）。 */
	skillCount?: number;
	/** 当前运行阶段（依赖 SessionStore）——仅 attached 时有值。 */
	phase?: "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";
	/** 已 attach 本进程（lazy 建 session 已完成）。 */
	attached: boolean;
	/** agentDir 绝对路径（来自注册表）。 */
	agentDir?: string;
	/** 钉钉机器人配置（gateway.json channels.dingtalk.accounts；未绑定/未配置时省略）。 */
	dingtalk?: DingtalkAgentConfigDto;
}

/**
 * P4 环境摘要（`get_state` 响应的 `env` 字段，B1）。
 *
 * serve wire 面恒提供 repos/branch/activeAgentCount；`pendingCronCount` 仅 gateway 面
 * 有数据源，wire 面恒省略（字段可选，客户端按缺省处理）。
 */
export interface WireEnvironmentSummary {
	/** 工作区仓库名（serve 进程 cwd 目录名）。 */
	repos: string;
	/** 当前 git 分支；非 git 仓库 / 分离头时为 null。 */
	branch: string | null;
	/** 已 attach 的 agent 数（serve 进程内活跃实例）。 */
	activeAgentCount: number;
	/** 待执行 cron 任务数——仅 gateway 面提供，wire 面不返回此字段。 */
	pendingCronCount?: number;
}

/**
 * 历史会话索引项（P4 `list_sessions` 命令的返回元素）。
 *
 * 由 sessions 目录的 JSONL 文件头（前 4KB：session header + 初始 model_change）
 * 和尾（末 256KB：最后 timestamp + 最后 assistant stopReason）解析而来，
 * 不整读大文件。messageCount 为流式字节扫描计数（type:"message" 出现次数），
 * 含 user/assistant/toolResult 全部消息条目。
 *
 * status 推断（最后一个 assistant 消息的 stopReason）：
 * - completed：stop/endTurn/length（正常收尾，含长度截断）
 * - aborted：aborted（用户中断）
 * - error：error（模型/工具报错收尾）
 * - incomplete：toolUse（以工具调用收尾——进程被杀/未回填）或无任何 assistant 消息
 * - unknown：尾部解析不出 stopReason（文件头存在但尾部損坏）
 */
export type WireSessionStatus = "completed" | "aborted" | "error" | "incomplete" | "unknown";

/** 会话来源：cli = 本地 CLI 交互会话（default agent）；agent = gateway/registry agent 会话。 */
export type WireSessionSource = "cli" | "agent";

export interface WireSessionIndexEntry {
	/** 会话 id（JSONL 头 session.id）。 */
	sessionId: string;
	/** 所属 agent 注册名（"default" / registry key）。 */
	agentId: string;
	/** 所属 agent 显示名。 */
	agentName: string;
	/** 会话来源（session-index 按源根判定；SessionSidebar 双源 tab 按此区分）。 */
	source: WireSessionSource;
	/** 会话标题（header.title；无则 undefined）。 */
	title?: string;
	/** 会话打开时的工作目录（header.cwd；cli 会话为 `omp` 启动目录，agent 会话为该 agent 的 agentDir）。 */
	cwd?: string;
	/** 开始时间（header.timestamp，ISO）。 */
	startTime: string;
	/** 结束时间（最后一条 entry 的 timestamp，ISO；仅头部时 = startTime）。 */
	endTime?: string;
	/** message 条目数（含 user/assistant/toolResult）。 */
	messageCount: number;
	/** 全部 entry 行数（含 model_change/custom 等非消息条目）。 */
	entryCount: number;
	/** 会话内最后使用的模型（"provider/modelId"；取头尾中最后一次 model_change）。 */
	model?: string;
	/** 结束状态推断（见 WireSessionStatus）。 */
	status: WireSessionStatus;
	/** JSONL 文件绝对路径。 */
	sessionFile: string;
	/** 文件字节大小（列表页展示参考）。 */
	fileSizeBytes: number;
}

/**
 * 关于导出原样 JSONL（任务 B 结论）：
 * `get_messages` 返回的 AgentMessage[] 与 JSONL message 条目的 payload 完全一致
 * （同一对象序列化），且每条自带 timestamp/ms + role + content + stopReason——回放
 * 时间线所需字段齐全。差异仅在信封（type/id/parentId/ISO timestamp）与非消息条目
 * （model_change/compaction/custom…），对 /records 回放无影响。若未来需要字节级
 * 原样导出，应加静态文件服务而不是新 wire 命令（web-app 是本地应用）。
 */

/**
 * Wire 层消息 DTO：`get_messages` / `get_session_messages` 响应的 `messages` 数组元素型。
 * 直接复刻 pi-agent-core 的 AgentMessage（消息联合）——JSONL message 条目的 `message`
 * 字段反序列化后即此型，回放时间线所需 timestamp/role/content/stopReason 齐全（见上方任务 B 结论）。
 */
export type AgentMessageDto = AgentMessage;

/**
 * host_tool_call — 服务端需要客户端执行一个客户端注册的 tool。
 * 客户端回应 host_tool_result / host_tool_update (上)。
 * `sessionId` 将 call 定位到具体 Agent（多 Agent 时客户端需要分派处理）。
 */
export interface HostToolCallPush {
	type: "host_tool_call";
	id: string;
	sessionId: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/**
 * host_tool_cancel — 服务端取消一个已发出的 host_tool_call（逗号 signal.abort()）。
 * `targetId` 为要取消的 host_tool_call 的 `id`。
 */
export interface HostToolCancelPush {
	type: "host_tool_cancel";
	id: string;
	sessionId: string;
	targetId: string;
}

/**
 * P3 host_tool 升级：server 已登记的 tool 定义 — 让客户端可以自检。
 * 仅作为提示，不是权威（权威在 session.setHostTools() 后的下一次 get_state）。
 */
export interface HostToolsChangedPush {
	type: "host_tools_changed";
	sessionId: string;
	tools: WireHostToolDefinition[];
}

/**
 * permission_request —— 需要用户裁决的审批/澄清请求（壳内验证 mode：由 serve 模拟注入触发，
 * 将来 agent-core canUseTool 接上后同帧复用）。推给发起连接 + 全部在线连接（任一端可批）。
 *
 * approval：危险命令审批；clarify：Agent 澄清择一。`requestId` 供 permission_respond 回指。
 */
export type PermissionRequestPush =
	| {
			type: "permission_request";
			requestId: string;
			kind: "approval";
			command: string;
			description: string;
			patternKeys: string[];
	  }
	| {
			type: "permission_request";
			requestId: string;
			kind: "clarify";
			question: string;
			options: string[];
	  };

export type WireServerEvent<TSnapshot = unknown, TEvent = unknown> =
	| { type: "server_snapshot"; sessions: SessionListEntry[] }
	| { type: "session_snapshot"; sessionId: string; snapshot: TSnapshot }
	| { type: "progress"; sessionId: string; event: TEvent }
	| HostToolCallPush
	| HostToolCancelPush
	| HostToolsChangedPush
	| PermissionRequestPush;

/**
 * 协议批 B-4：wire response 错误码枚举（hermes 分类学 12 码）。
 * 向后兼容：error 字段仍接受 string（旧调用方/旧 serve），新调用方优先结构化错误。
 */
export type WireErrorCode =
	| "rate_limit"
	| "quota_exhausted"
	| "compression_exhausted"
	| "model_not_found"
	| "interrupted"
	| "silent_failure"
	| "tool_limit_reached"
	| "not_implemented"
	| "unauthorized"
	| "timeout"
	| "cancelled"
	| "internal";

/** 结构化错误载荷（ok:false 时 error 的半形）。 */
export interface WireErrorPayload {
	code: WireErrorCode;
	message: string;
}

export type ServerFrame<TSnapshot = unknown, TEvent = unknown> =
	| { type: "hello_ack"; connectionId: string; protocolVersion: number }
	| { type: "hello_error"; error: string }
	| { type: "response"; id: string; ok: true; result?: unknown }
	| { type: "response"; id: string; ok: false; error: string | WireErrorPayload }
	| { type: "push"; event: WireServerEvent<TSnapshot, TEvent> }
	/** 心跳：server 回 client ping。ts 回回客户端的 ts（方便 RTT 估算）。 */
	| { type: "pong"; ts?: number };

/** helper: 判断一个帧是否 push 帧。 */
export function isPushFrame<TSnapshot, TEvent>(
	frame: ServerFrame<TSnapshot, TEvent>,
): frame is Extract<ServerFrame<TSnapshot, TEvent>, { type: "push" }> {
	return frame.type === "push";
}

/** helper: 判断一个帧是否 response 帧。 */
export function isResponseFrame<TSnapshot, TEvent>(
	frame: ServerFrame<TSnapshot, TEvent>,
): frame is Extract<ServerFrame<TSnapshot, TEvent>, { type: "response" }> {
	return frame.type === "response";
}
