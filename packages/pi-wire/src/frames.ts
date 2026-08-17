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
}

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

export type WireServerEvent<TSnapshot = unknown, TEvent = unknown> =
	| { type: "server_snapshot"; sessions: SessionListEntry[] }
	| { type: "session_snapshot"; sessionId: string; snapshot: TSnapshot }
	| { type: "progress"; sessionId: string; event: TEvent }
	| HostToolCallPush
	| HostToolCancelPush
	| HostToolsChangedPush;

export type ServerFrame<TSnapshot = unknown, TEvent = unknown> =
	| { type: "hello_ack"; connectionId: string; protocolVersion: number }
	| { type: "hello_error"; error: string }
	| { type: "response"; id: string; ok: true; result?: unknown }
	| { type: "response"; id: string; ok: false; error: string }
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
