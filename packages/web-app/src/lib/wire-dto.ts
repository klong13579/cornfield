/**
 * 前端协议 DTO —— 适配层契约。
 *
 * 镜像 `packages/coding-agent/src/server/wire-types.ts`（帧模型）与
 * `packages/coding-agent/src/session/session-snapshot.ts`（权威快照字段）的语义：
 * - 权威快照（session_snapshot）：可据此完整重建 UI，行为 `进度不得归约为状态`。
 * - 进度事件（progress）：仅打字机/delta 提示，跨快照即失效。
 *
 * 当 `@oh-my-pi/pi-wire` 抽包完成后，本文件只做 pi-wire 类型 → 前端 DTO 的映射，
 * 不改动上层组件的消费形态。
 */

// ── 快照 ──

/** 会话运行阶段（镜像 SessionPhase，枚举化 UI 提示，非权威门控）。 */
export type SessionPhaseDto = "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";

export type TodoStatusDto = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItemDto {
	content: string;
	status: TodoStatusDto;
	notes?: string[];
}

export interface TodoPhaseDto {
	name: string;
	tasks: TodoItemDto[];
}

export interface ModelDto {
	id: string;
	provider?: string;
	name?: string;
}

/** 消息内容块（镜像 AgentMessage content 的 thinking/text/toolCall/toolResult）。 */
export type MessageContentDto =
	| { type: "thinking"; thinking: string }
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown>; intent?: string }
	| { type: "toolResult"; toolCallId?: string; isError?: boolean; content?: { type: "text"; text: string }[] };

export interface MessageDto {
	id: string;
	role: "user" | "assistant" | "developer" | "toolResult";
	model?: string;
	content: MessageContentDto[];
	/** 助手出错（空 content + errorMessage），UI 渲染 ✗ Error 而不展示为空回复。 */
	errorMessage?: string;
	/** 独立 toolResult 消息：关联的 toolCall id（serve 快照/jsonl 顶层字段）。 */
	toolCallId?: string;
	/** 独立 toolResult 消息：该工具调用是否报错。 */
	isError?: boolean;
}

/** 会话权威快照（对应 SessionSnapshot；context 为可选扩展，真机数据可接 get_session_stats）。 */
export interface SessionSnapshotDto {
	seq: number;
	sessionId: string;
	sessionName?: string;
	sessionFile?: string;
	model?: ModelDto;
	thinkingLevel?: string;
	messages: MessageDto[];
	todoPhases: TodoPhaseDto[];
	activeToolNames: string[];
	queuedMessageCount: number;
	phase: SessionPhaseDto;
	retryAttempt: number;
	isCompacting: boolean;
	isStreaming: boolean;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	scopedModels?: { model: ModelDto; thinkingLevel?: string }[];
	/** 上下文水位（mock 提供；真机接入后走 get_session_stats）。 */
	context?: { usedTokens: number; totalTokens: number; lastCompaction?: number | null };
}

// ── server_snapshot（多 Agent 后的列表）──

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
	/** 运行阶段（attached 时有值）。 */
	phase?: "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";
	/** agentDir 绝对路径。 */
	agentDir?: string;
	dingtalkBound?: boolean;
}

export interface SessionListEntryDto {
	id: string;
	name?: string;
	sessionFile?: string;
	active: boolean;
}

// ── 进度事件（progress，非权威）──

export type ProgressEventDto =
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "message_update"; assistantEvent: { type: "text_delta"; contentIndex: number; delta: string } }
	| { type: "message_update"; assistantEvent: { type: "thinking_delta"; contentIndex: number; delta: string } }
	| { type: "message_update"; assistantEvent: { type: "toolcall_delta"; contentIndex: number; delta: string } }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_end"; contentIndex: number }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			name: string;
			arguments?: Record<string, unknown>;
			intent?: string;
			startedAt: number;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			isError: boolean;
			resultText?: string;
			durationMs?: number;
	  }
	| { type: "auto_compaction_start"; reason: string; action: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "todo_reminder" }
	| { type: "todo_auto_clear" };

// ── 帧 ──

export type WireServerEventDto =
	| { type: "server_snapshot"; sessions: SessionListEntryDto[] }
	| { type: "session_snapshot"; sessionId: string; snapshot: SessionSnapshotDto }
	| { type: "progress"; sessionId: string; event: ProgressEventDto };

export interface ConnectionInfoDto {
	connected: boolean;
	reconnecting?: boolean;
	reconnectAttempts?: number;
	connectionId?: string;
	wsUrl: string;
	protocolVersion: number;
}

// ── 模型市场 ──

export interface ModelInfoDto {
	id: string;
	provider: string;
	/** 模型显示名（真实 Model.name）。 */
	name?: string;
	/** 展示用上下文窗口（如 “200K”“1M”）。 */
	contextWindow?: string;
	/** 原始上下文窗口 token 数（排序用）。 */
	contextWindowTokens?: number;
	/** 价格展示（真实 cost 输入价格，$/M tokens）。 */
	price?: string;
	description?: string;
	supportsThinking: boolean;
}

/** 图片附件（对应 pi-ai ImageContent：prompt.images 通道，base64 内联）。 */
export interface ImageContentDto {
	type: "image";
	data: string; // base64 编码图片数据
	mimeType: string; // 如 image/png
}

/** host tool 声明（对应 WireHostToolDefinition；set_host_tools 入参）。 */
export interface HostToolDefinitionDto {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
}

/** 连接后返回（hello_ack 内容 + 环境摘要，Home 用）。 */
export interface EnvironmentSummaryDto {
	repos: string;
	branch: string;
	activeAgentCount: number;
	pendingCronCount: number;
}
