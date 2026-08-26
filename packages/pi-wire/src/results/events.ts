/**
 * 进度/权限/服务端事件（前端消费的推送形状）。
 */
import type { SessionListEntryDto } from "./agents";
import type { SessionSnapshotDto } from "./session";

/** 进度事件（progress，非权威——仅打字机/delta 提示，跨快照即失效）。 */
export type ProgressEventDto =
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "steer"; text: string }
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

/** 权限请求推送（approval：危险命令审批；clarify：Agent 澄清择一）。 */
export type PermissionRequestDto =
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

/** 服务端事件（连接后收到的推送帧负载）。 */
export type WireServerEventDto =
	| { type: "server_snapshot"; sessions: SessionListEntryDto[] }
	| { type: "session_snapshot"; sessionId: string; snapshot: SessionSnapshotDto }
	| { type: "progress"; sessionId: string; event: ProgressEventDto }
	| PermissionRequestDto;
