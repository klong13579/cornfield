import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";

/**
 * Wire 命令面 (multiplex 子集)。
 *
 * 本包仅定义 wire 传输层能看到的 shape：名字 + 参数。不依赖 coding-agent 的 rpc-types
 * （取消 P0/P1 时期的 `Extract<RpcCommand, ...>` 约束）。两边同步保证在 code review
 * 层面：pi-wire 新增命令 -> coding-agent wire-server 实现；coding-agent rpc 新增命令
 * 不自动进入 wire 面（需显式在本文件登记）。
 *
 * ## P3 多 Agent 升级
 *
 * 所有状态相关命令都多一个可选 `sessionId` 参数：
 * - 无 `sessionId`：作用于当前连接的 active session（P1 兼容行为）
 * - 有 `sessionId`：定向注册表里的具体 agent，服务器侧 lazy attach
 *
 * `switch_session` 将 P1 的 `sessionPath` 变为 `sessionId`（agent 注册名）——
 * 与 rpc-types 同名命令语义不同，已在 wire-server 中根据注册表定位。
 *
 * 新增专属命令：`list_agents` —— 返回所有已注册 agent 的元数据列表。
 *
 * ## 情境外命令（已在 requirement.md 约定创除）
 *
 * set_steering_mode / set_follow_up_mode / set_interrupt_mode /
 * set_disabled_toolsets / export_html / bash / abort_bash。gateway-specific，不进多端。
 */

/** todo phase shape（与 coding-agent tools/todo-write 同形，作为 wire 数据面单一事实源）。 */
export interface WireTodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
	notes?: string[];
}

export interface WireTodoPhase {
	name: string;
	tasks: WireTodoItem[];
}

/** host tool 声明（形状与 RpcHostToolDefinition 同构）。 */
export interface WireHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
}

/**
 * Multiplex 命令 — P3 升级后每条命令均可带 `sessionId` 参数定向 agent。
 */
export type MultiplexCommand =
	// Prompting
	| {
			id?: string;
			type: "prompt";
			sessionId?: string;
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "steer"; sessionId?: string; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; sessionId?: string; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort"; sessionId?: string }
	| { id?: string; type: "abort_and_prompt"; sessionId?: string; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; sessionId?: string; parentSession?: string }
	// State
	| { id?: string; type: "get_state"; sessionId?: string }
	| { id?: string; type: "set_todos"; sessionId?: string; phases: WireTodoPhase[] }
	| { id?: string; type: "set_host_tools"; sessionId?: string; tools: WireHostToolDefinition[] }
	// Model
	| { id?: string; type: "set_model"; sessionId?: string; provider: string; modelId: string }
	| { id?: string; type: "cycle_model"; sessionId?: string }
	| { id?: string; type: "get_available_models"; sessionId?: string }
	// Thinking
	| { id?: string; type: "set_thinking_level"; sessionId?: string; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level"; sessionId?: string }
	// Compaction
	| { id?: string; type: "compact"; sessionId?: string; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; sessionId?: string; enabled: boolean }
	// Retry
	| { id?: string; type: "set_auto_retry"; sessionId?: string; enabled: boolean }
	| { id?: string; type: "abort_retry"; sessionId?: string }
	// Session
	| { id?: string; type: "get_session_stats"; sessionId?: string }
	/**
	 * P3: 切换本连接的 active session。入参为 agent 注册名。
	 * 切换后：本连接后续无 sessionId 的命令都默认这个 session；
	 * server 主动 push session_snapshot(sessionId=新)。
	 */
	| { id?: string; type: "switch_session"; sessionId: string }
	| { id?: string; type: "branch"; sessionId?: string; entryId: string }
	| { id?: string; type: "get_branch_messages"; sessionId?: string }
	| { id?: string; type: "get_last_assistant_text"; sessionId?: string }
	| { id?: string; type: "set_session_name"; sessionId?: string; name: string }
	// Messages
	| { id?: string; type: "get_messages"; sessionId?: string };

/** 多端专属命令（rpc-types 没有，wire 层新增）。 */
export type WireExtensionCommand =
	/** 订阅推送（默认已自动订；预留接口支持后续多 session 选订）。 */
	| { id?: string; type: "subscribe"; sessionId?: string }
	| { id?: string; type: "unsubscribe"; sessionId: string }
	/** 获取一个 session 的完整快照（无 sessionId 为 active session）。 */
	| { id?: string; type: "get_snapshot"; sessionId?: string }
	/**
	 * P3 lazy attach: 实例化一个注册表里的 agent 到本进程。
	 * 已 attached 时 idempotent；未注册时 ok:false。
	 */
	| { id?: string; type: "attach"; sessionId: string }
	/** 释放一个已 attached agent 的进程内实例。active session 则 ok:false。 */
	| { id?: string; type: "detach"; sessionId: string }
	/** P3 新增：列出所有已注册 agent 的元数据（不触发 attach）。 */
	| { id?: string; type: "list_agents" }
	/**
	 * P4 新增：历史会话索引（/records 列表页）。扫描 sessions 目录，返回按开始时间
	 * 倒序的会话元数据列表。不实例化任何 session（纯文件索引）。
	 *
	 * - 无 sessionId：扫描全部 agent（default 的全局 sessions 根 + 每个 registry agent 的
	 *   <agentDir>/sessions/）
	 * - 有 sessionId：只扫描该 agent（与其它定向命令同语义）
	 * - limit：返回条数上限（默认 100，最大 500）——按文件 mtime 取最新 N 个再解析
	 */
	| { id?: string; type: "list_sessions"; sessionId?: string; limit?: number }
	/**
	 * 只读列出 agent workspace 目录（Agent 详情页文件系统 tab）。
	 * path 相对 agentDir；省略 = agentDir 根。返回条目（目录在前，名/类型/大小）。
	 * 路径约束：必须解析在 agentDir 内（防任意读）；越界 ok:false + error。
	 */
	| { id?: string; type: "fs_list"; sessionId?: string; path?: string }
	/** 只读读一个 workspace 文件（文本，utf-8；> 128KB 截断到 128KB）。路径约束同上。 */
	| { id?: string; type: "fs_read"; sessionId?: string; path: string }
	/**
	 * 读取本机 gateway 运行状态（~/.omp/gateway-data/gateway.status.json 只读转发，
	 * gateway 定期写盘）。返回 accounts（bridgeRunning/bridgeState/channelHealth）+
	 * scheduler/pid；statusWrittenAt 距今超 30s 视为 stale。gateway 未运行返回 ok:false。
	 */
	| { id?: string; type: "gateway_status" };

export type WireCommand = MultiplexCommand | WireExtensionCommand;

/** 获取具体命令结构的 helper。 */
export type WireCommandOfType<T extends WireCommand["type"]> = Extract<WireCommand, { type: T }>;
