import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { TodoPhase } from "../tools/todo-write";

/**
 * 会话运行时阶段（枚举化，绝不暴露底层 handle）。
 *
 * 这是「运行状态」的 UI 提示，不是权威门控：reducer 从事件流推断，
 * 只保证单调、收敛，不保证与底层实现的逐拍一致。客户端不得据此做
 * 正确性决策，只能用于渲染进度指示。
 */
export type SessionPhase = "idle" | "streaming" | "compacting" | "retrying" | "executing_tool";

/**
 * 会话权威快照 —— 多端 UI 重建的最小充分状态。
 *
 * 分层原则（评审确认）：
 * - 权威字段：消息历史、模型选择、todo、会话身份 —— 低序列化难度，纯数据
 * - 运行时字段：phase/retryAttempt —— 枚举化、计数化，只表达「在干什么」，
 *   绝不携带 AbortController / Promise / Timer 等不可序列化 handle
 *
 * message 历史直接取自 AgentSession（它本身就是权威源），不做增量复制；
 * 本快照只负责派生字段的归约。断线重连的客户端先取全量 snapshot 重建，
 * 再订阅增量事件。
 */
export interface SessionSnapshot {
	/** 单调递增，每次事件归约 +1 */
	seq: number;
	// ── 身份 ──
	sessionId: string;
	sessionName?: string;
	sessionFile?: string;
	// ── 模型 ──
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	// ── 消息（UI 重建的基础）──
	messages: AgentMessage[];
	/** messageId → session entryId 映射（供消息级 undo/fork 定位 entry）。 */
	messageEntryIds: Record<string, string>;
	// ── 业务 ──
	todoPhases: TodoPhase[];
	activeToolNames: string[];
	// ── 队列（只暴露计数）──
	queuedMessageCount: number;
	// ── 运行状态（枚举化）──
	phase: SessionPhase;
	retryAttempt: number;
	isCompacting: boolean;
	isStreaming: boolean;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
}

/** 快照归约的纯函数辅助（测试用）：事件 → 阶段迁移。 */
export function reducePhase(current: SessionPhase, eventType: string): SessionPhase {
	switch (eventType) {
		case "message_update":
			return "streaming";
		case "tool_execution_start":
			return "executing_tool";
		case "auto_compaction_start":
			return "compacting";
		case "auto_retry_start":
			return "retrying";
		// 「活动」事件以持续事件为准：任何流式输出/执行都会重新置活动态；
		// 结束类事件保守归约到 idle，避免长期误报 activity。
		case "message_end":
		case "tool_execution_end":
		case "auto_compaction_end":
		case "auto_retry_end":
		case "agent_end":
		case "turn_end":
		case "agent_start":
		case "turn_start":
			return "idle";
		default:
			return current;
	}
}
