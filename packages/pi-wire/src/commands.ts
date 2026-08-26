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
 * ## 情境外命令（P2 纳入）
 *
 * set_steering_mode / set_follow_up_mode / set_interrupt_mode /
 * set_disabled_toolsets / export_html / bash / abort_bash 原为 gateway-specific
 * 不进多端（P1 前决策）；P2 gateway 切 wire-stdio 后 AgentBridge 需要它们，
 * 已正式登记进 MultiplexCommand。
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

/** 行锚点（与 hashline 编辑模式的行引用同构：行号 + 2 字母 hash）。 */
export interface WireLineAnchor {
	line: number;
	hash: string;
	contentHint?: string;
}

/** replace 模式编辑条目（与 coding-agent edit 工具 replace 模式 schema 同构）。 */
export interface WireReplaceEditEntry {
	old_text: string;
	new_text: string;
	all?: boolean;
}

/** patch 模式编辑条目（与 coding-agent edit 工具 patch 模式 schema 同构）。 */
export interface WirePatchEditEntry {
	op?: "create" | "delete" | "update";
	rename?: string;
	diff?: string;
}

/** hashline 模式编辑条目（loc/content，与 coding-agent edit 工具 hashline 模式 schema 同构）。 */
export interface WireHashlineEditEntry {
	loc?: "append" | "prepend" | { append: string } | { prepend: string } | { range: { pos: string; end: string } };
	content?: string[] | null;
}

/** fs_edit 的编辑条目联合（载荷按 mode 区分）。 */
export type WireEditEntry = WireReplaceEditEntry | WirePatchEditEntry | WireHashlineEditEntry;

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
	// P3：用户消息/自定义消息（不经 LLM 转发的直接入队）
	| { id?: string; type: "send_user_message"; sessionId?: string; message: string }
	| {
			id?: string;
			type: "send_custom_message";
			sessionId?: string;
			customType: string;
			content: string | Array<{ type: "text"; text: string } | ImageContent>;
			display?: boolean;
	  }
	// State
	| { id?: string; type: "get_state"; sessionId?: string }
	| { id?: string; type: "set_todos"; sessionId?: string; phases: WireTodoPhase[] }
	| { id?: string; type: "set_host_tools"; sessionId?: string; tools: WireHostToolDefinition[] }
	// P3：TUI 工具开关（set_active_tools）与注册表刷新
	| { id?: string; type: "set_active_tools"; sessionId?: string; toolNames: string[] }
	// Model
	| { id?: string; type: "set_model"; sessionId?: string; provider: string; modelId: string }
	| { id?: string; type: "set_model_temporary"; sessionId?: string; provider: string; modelId: string; thinkingLevel?: ThinkingLevel }
	| { id?: string; type: "cycle_model"; sessionId?: string }
	| { id?: string; type: "get_available_models"; sessionId?: string }
	| { id?: string; type: "get_available_thinking_levels"; sessionId?: string }
	| { id?: string; type: "cycle_role_models"; sessionId?: string; roleOrder: string[] }
	// Thinking
	| { id?: string; type: "set_thinking_level"; sessionId?: string; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level"; sessionId?: string }
	// P3：plan mode 状态与上下文
	| { id?: string; type: "set_plan_mode"; sessionId?: string; enabled: boolean; planFilePath?: string }
	| { id?: string; type: "send_plan_mode_context"; sessionId?: string }
	| { id?: string; type: "set_plan_reference"; sessionId?: string; path: string; markSent: boolean }
	| { id?: string; type: "set_slash_commands"; sessionId?: string; commands: Array<{ name: string; description: string; content: string; source?: string }> }
	// Compaction
	| { id?: string; type: "compact"; sessionId?: string; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; sessionId?: string; enabled: boolean }
	| { id?: string; type: "abort_compaction"; sessionId?: string }
	| { id?: string; type: "abort_branch_summary"; sessionId?: string }
	| { id?: string; type: "run_idle_compaction"; sessionId?: string }
	// Retry
	| { id?: string; type: "set_auto_retry"; sessionId?: string; enabled: boolean }
	| { id?: string; type: "abort_retry"; sessionId?: string }
	// P3：会话控制
	| { id?: string; type: "reload"; sessionId?: string }
	| { id?: string; type: "handoff"; sessionId?: string; customInstructions?: string }
	| { id?: string; type: "run_ephemeral_turn"; sessionId?: string; message: string }
	// Bash/Python（P2 加 bash/abort_bash；P3 补 python 对）
	| { id?: string; type: "execute_python"; sessionId?: string; code: string }
	| { id?: string; type: "abort_python"; sessionId?: string }
	// Queue modes（P2：bridge 专有命令纳入 wire 面）
	| { id?: string; type: "set_steering_mode"; sessionId?: string; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; sessionId?: string; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; sessionId?: string; mode: "immediate" | "wait" }
	// Bash（P2：bridge 专有命令纳入 wire 面）
	| { id?: string; type: "bash"; sessionId?: string; command: string }
	| { id?: string; type: "abort_bash"; sessionId?: string }
	// Tool control（P2：bridge 专有命令纳入 wire 面）
	| { id?: string; type: "set_disabled_toolsets"; sessionId?: string; toolsets: string[] }
main
	// Session
	| { id?: string; type: "get_session_stats"; sessionId?: string }
	| { id?: string; type: "export_html"; sessionId?: string; outputPath?: string }
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
	| { id?: string; type: "get_messages"; sessionId?: string }
	// P3：TUI 渲染/导出查询
	| { id?: string; type: "get_tool"; sessionId?: string; toolName: string }
	| { id?: string; type: "get_async_job_snapshot"; sessionId?: string; recentLimit?: number }
	| { id?: string; type: "format_session_as_text"; sessionId?: string }
	| { id?: string; type: "get_display_context"; sessionId?: string }
	| { id?: string; type: "resolve_role_model"; sessionId?: string; role: string };

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
	 * 读一个会话 JSONL 文件（`list_sessions` 返回的 sessionFile 绝对路径），逐行解析并
	 * 提取 message 条目（跳过空行/非 message 条目）。返回 { messages: AgentMessageDto[] }，
	 * 与 `get_messages`（读当前 attached session 内存）同型。不实例化 session，不定向 agent。
	 */
	| { id?: string; type: "get_session_messages"; sessionFile: string }
	/**
	 * 只读列出 agent workspace 目录（Agent 详情页文件系统 tab）。
	 * path 相对 agentDir；省略 = agentDir 根。返回条目（目录在前，名/类型/大小）。
	 * 路径约束：必须解析在 agentDir 内（防任意读）；越界 ok:false + error。
	 */
	| { id?: string; type: "fs_list"; sessionId?: string; path?: string }
	/** 只读读一个 workspace 文件（文本，utf-8；> 128KB 截断到 128KB）。路径约束同上。 */
	| { id?: string; type: "fs_read"; sessionId?: string; path: string }
	/**
	 * R-IMG-SERVE：只读读一个 workspace 图片文件（二进制）→ dataUrl。
	 * 上限 2MB（超出截断并标记 truncated）；MIME 按扩展名（png/jpg/gif/webp/svg/bmp/ico/avif，
	 * 未知回 octet-stream）。路径约束与 fs_read 同。FileExplorer 预览数据源。
	 */
	| { id?: string; type: "fs_read_image"; sessionId?: string; path: string }
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
	 * W3 D5 + P2-W3-3：只读列出已加载技能 + 已停用名单。
	 * skills = session.skills（discovery 按 settings 过滤后的「已启用」集）：name/description/
	 * source/level（user|project|native）/provider。
	 * disabled = settings.skills.ignoredSkills 名单 + 技能目录 SKILL.md 元数据（name/description?）
	 * ——回切入口数据源（SkillsView「显示已停用」）。
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
	 * P2-W3-3（B3 技能写协议）：启停一个技能。
	 * serve 写 settings（~/.omp/agent/config.yml 的 skills.ignoredSkills 列表），随后
	 * 重发现 + 会话热重载，get_skills 立即反映。
	 * - name：技能名（非空、不含路径分隔符）
	 * - enabled：true 启用（从 ignoredSkills 移除）/ false 停用（追加）
	 */
	| { id?: string; type: "set_skill_enabled"; sessionId?: string; name: string; enabled: boolean }
	/**
	 * W3 模型禁用写协议：停用/恢复一个 provider 或单个模型（模型市场页 disable 开关）。
	 * - provider 必填；modelId 缺省 = 整 provider 停用/恢复（写入 settings.disabledProviders）
	 * - modelId 提供 = 精确模型停用/恢复（写入 settings.disabledModels，pattern 为
	 *   `provider/modelId`，如 `narwal-plan/deepseek-v4-flash`）
	 * 两者都持久化到 ~/.omp/agent/config.yml；get_available_models 立即反映（available
	 * 列表按 disabledProviders + disabledModels 过滤），响应返回值带两份名单供前端恢复入口。
	 */
	| {
			id?: string;
			type: "set_model_disabled";
			sessionId?: string;
			provider: string;
			modelId?: string;
			disabled: boolean;
	  }
	/**
	 * 壳内验证：注入一个 mock 审批/澄清请求（permission_request push），
	 * 模拟危险命令审批，不接 agent-core。命令 response 会等到 respond 到达再回。
	 */
	| { id?: string; type: "inject_permission"; kind?: "approval" | "clarify" }
	/**
	 * 用户裁决回传：requestId 对应 permission_request；choice 白名单（approval: deny|once|session|always），
	 * clarify 为所选 option 文本。脏值 serve 侧回 error。
	 */
	| { id?: string; type: "permission_respond"; requestId: string; choice: string }
	/**
	 * 听记（VOICE-D：/voice 听记 tab）：上传一段浏览器录制的 16kHz 单声道 PCM WAV（base64），
	 * 走 TUI /record 同源转写管线（本地 whisper 或 record.model API，超长自动分块），
	 * 结果落 ~/.omp/listen/YYYY-MM-DD-<desc>.json（与 /record 同目录同格式）。
	 * - audio：PCM WAV base64（前端 encodeWav 产出，与 TUI 本地录音同标）
	 * - desc：可选，文件名描述（缺省按时间自动命名）
	 * 响应 { ok:true, text, path, model }；输入非法/转写失败 { ok:false, error }。
	 */
	| { id?: string; type: "record_transcribe"; audio: string; desc?: string }
	/**
	 * 听记历史（/listen 前端化）：列出 ~/.omp/listen/ 全部录音 json（文件名倒序），
	 * 返回元数据 + 转写全文（前端本地搜索/预览零延迟）。
	 * 响应 { ok:true, recordings: [{ name, path, recordedAt, size, text }] }；目录缺失 → { ok:true, recordings: [] }。
	 */
	| { id?: string; type: "listen_list" }
	/**
	 * P0 收口：serve 端 skill hub —— 列出可安装的远程技能（marketplace 源；source 缺省走默认市场）。
	 */
	| { id?: string; type: "list_remote_skills"; source?: string }
	/** P0 收口：serve 端 skill hub —— 安装一个远程技能。 */
	| { id?: string; type: "install_remote_skill"; source: string; name: string }
	/** P0 收口：列出已配置的 MCP 服务器（~/.omp/agent/mcp.json）。 */
	| { id?: string; type: "get_mcp_servers" }
	/** P0 收口：新建/更新一个 MCP 服务器配置。 */
	| { id?: string; type: "set_mcp_server"; name: string; command?: string; args?: string[]; enabled?: boolean }
	/** P0 收口：删除一个 MCP 服务器配置。 */
	| { id?: string; type: "remove_mcp_server"; name: string }
	/** P0 收口：测试一个 MCP 服务器连通性（stdio）。 */
	| { id?: string; type: "test_mcp_server"; name: string }
	/**
	 * fs 写命令面（票 01）：整段写一个 workspace 文件（UTF-8）。
	 * 路径约束与 fs_read 同（必须解析在 agentDir 内，越界 ok:false）；写后走 LSP
	 * writethrough（didChange 同步 + notifySaved），格式化/诊断状态不丢。
	 */
	| { id?: string; type: "fs_write"; sessionId?: string; path: string; content: string }
	/**
	 * 精确编辑（透传既有 edit 工具多模 schema）。mode 缺省 = settings `edit.mode`；
	 * mode ∈ replace/patch/hashline 用 `edits`，atom 用 `input`。写后同 fs_write 走 LSP writethrough。
	 */
	| {
			id?: string;
			type: "fs_edit";
			sessionId?: string;
			path: string;
			mode?: "replace" | "patch" | "hashline" | "atom";
			edits?: WireEditEntry[];
			input?: string;
	  }
	/**
	 * 前后内容统一 diff（供前端 diff 视图）。path+content：agentDir 内文件 vs 待写 content；
	 * before+after：纯文本 diff（不落地）。
	 */
	| {
			id?: string;
			type: "fs_diff";
			sessionId?: string;
			path?: string;
			content?: string;
			before?: string;
			after?: string;
	  }
	/** git 最小集（票 02）：当前分支 + staged/unstaged/untracked 列表。 */
	| { id?: string; type: "git_status"; sessionId?: string }
	/** working tree vs HEAD（或 staged）diff。 */
	| { id?: string; type: "git_diff"; sessionId?: string; cached?: boolean; path?: string }
	/** 最近 n 条 commit（hash/author/message）。 */
	| { id?: string; type: "git_log"; sessionId?: string; count?: number }
	/** 单 commit 详情。 */
	| { id?: string; type: "git_show"; sessionId?: string; revision: string }
	/** 分支列表（local + remote + current）。 */
	| { id?: string; type: "git_branches"; sessionId?: string }
	/** 配置读写（票 03）：读 ~/.omp/agent/config.yml 的域。 */
	| { id?: string; type: "get_config"; key?: string }
	/** 写指定域并持久化（同一份 config.yml，与 set_skill_enabled/set_model_disabled 不双写）。 */
	| { id?: string; type: "set_config"; key: string; value: unknown };
export type WireCommand = MultiplexCommand | WireExtensionCommand;

/** 获取具体命令结构的 helper。 */
export type WireCommandOfType<T extends WireCommand["type"]> = Extract<WireCommand, { type: T }>;
