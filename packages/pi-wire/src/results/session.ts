/**
 * session 相关结果形状 —— 快照/消息/进度事件（serve 端权威数据面）。
 * SessionSnapshot 权威类型见 packages/pi-wire/src/snapshot.ts；
 * 这里的 Dto 形状是前端消费契约（映射/投影层）。
 */

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

/** 会话权威快照（前端形状；context 为可选扩展，真机数据可接 get_session_stats）。 */
export interface SessionSnapshotDto {
	seq: number;
	sessionId: string;
	sessionName?: string;
	sessionFile?: string;
	model?: ModelDto;
	thinkingLevel?: string;
	messages: MessageDto[];
	/** messageId → session entryId（消息级 undo/fork/retry 定位）。 */
	messageEntryIds: Record<string, string>;
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
	/** 上下文水位（快照 context 提供）。 */
	context?: { usedTokens: number; totalTokens: number; lastCompaction?: number | null };
}