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
	| { id?: string; type: "fork_from"; sessionId?: string; entryId: string }
	| { id?: string; type: "undo_exchange"; sessionId?: string; entryId: string }
	| { id?: string; type: "retry_from"; sessionId?: string; entryId: string; message?: string; images?: ImageContent[] }
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
	| { id?: string; type: "gateway_status" }
	/**
	 * W3 D1：只读拉取本地用量统计（@oh-my-pi/omp-stats 聚合，DashboardStats）。
	 * 与 `omp stats --json` 同源：调用前内部增量同步会话文件，返回整体/按模型/按目录/
	 * 时间序列聚合。不依赖任何 attached session（不定向）。
	 *
	 * W3 D2 扩展：可选 `period`（1d/7d/30d/90d/all）——对 overall/byModel/byFolder
	 * 做时间窗口聚合（默认省略 = all 全量）；时间序列仍是固定窗口（24h/14d/90d）。
	 * 响应附带 priceCatalog（美元 /1M tokens，取自 models.json）供模型成本表展示单价。
	 */
	| { id?: string; type: "get_stats"; period?: "1d" | "7d" | "30d" | "90d" | "all" }
	/**
	 * W3 D3：只读拉取记忆投影（三分区：memory/user/project）。
	 * - memory：self-evolution 记忆库（vector_embeddings 分区，按 importance 排序）
	 * - user：~/.omp/user.md 内容（身份画像；缺失 → null）
	 * - project：当前项目记忆目录的 MEMORY.md / memory_summary.md / raw_memories.md
	 *   （canonical evolution 目录优先，旧版扁平目录 agentDir/memories 回落）
	 * 不依赖任何 attached session（不定向，锚定 serve 进程 cwd 的 default agent）。
	 * 文件内容 > 128KB 截断并标记 truncated；取不到的区返回 null，UI 渲染空态。
	 */
	| { id?: string; type: "get_memory" }
	/**
	 * W3 D5：只读列出目标 agent 已加载技能（session.skills 同源——discovery 已按 settings
	 * 过滤，「已启用集」语义）。返回 name/description/source/level（user|project|native）/provider。
	 * 不实现启停写入：B3 技能管理协议落地前的只读前置。
	 * - 无 sessionId：当前连接 active session；有 sessionId：定向该 agent（lazy attach）
	 */
	| { id?: string; type: "get_skills"; sessionId?: string }
	/**
	 * 协议批 B-2：取消最近一条排队消息（steer/followUp 队列，LIFO）。
	 * 空队列返回 { cancelled:false }；成功返回 { cancelled:true, text }（被取消的文本）。
	 */
	| { id?: string; type: "cancel_queued"; sessionId?: string }
	/**
	 * 协议批 B-3：TUI slash 命令表（BUILTIN_SLASH_COMMAND registry 同源）。
	 * 返回 { commands: [{ name（含前导 /）, description }] }——W1 SlashPalette 真源。
	 * 不定向（registry 级只读）。
	 */
	| { id?: string; type: "list_commands" }
	/**
	 * P2-W3-1（B6 只读代理）：拉取 gateway cron 任务表。
	 * 数据源 jobs.json 直读（~/.omp/gateway-data/scheduler/jobs.json），不依赖 gateway 进程，
	 * 不 import gateway 运行时。返回 { tasks: TaskRowDto 形状 }（字段对齐 jobs.json 任务）。
	 */
	| { id?: string; type: "get_cron_tasks" }
	/**
	 * P2-W3-1（B6 只读代理）：拉取 cron 执行日志（~/.omp/gateway-data/scheduler/logs/by-task/ 直读）。
	 * - taskId 可选：缺省 = 全部任务；
	 * - days 回溯天数（默认 3，钳 1-30）；limit 返回条数（默认 50，钳 1-200）
	 * 返回 { logs: [{ taskId, id, ts, status, exitCode, durationMs, output(截断), stderr(截断) }] }。
	 */
	| { id?: string; type: "get_cron_logs"; taskId?: string; days?: number; limit?: number }
	/**
	 * 壳内验证：注入一个 mock 审批/澄清请求（permission_request push），
	 * 模拟危险命令审批，不接 agent-core。命令 response 会等到 respond 到达再回。
	 */
	| { id?: string; type: "inject_permission"; kind?: "approval" | "clarify" }
	/**
	 * 用户裁决回传：requestId 对应 permission_request；choice 白名单（approval: deny|once|session|always），
	 * clarify 为所选 option 文本。脏值 serve 侧回 error。
	 */
	| { id?: string; type: "permission_respond"; requestId: string; choice: string };

export type WireCommand = MultiplexCommand | WireExtensionCommand;

/** 获取具体命令结构的 helper。 */
export type WireCommandOfType<T extends WireCommand["type"]> = Extract<WireCommand, { type: T }>;
