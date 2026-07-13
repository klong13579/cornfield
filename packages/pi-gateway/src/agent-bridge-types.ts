/**
 * Shared types for the agent bridge pipeline.
 *
 * Extracted to its own module so `PromptQueue` can import `ForwardStreamHandlers`
 * without depending on `AgentBridge` (which would create a circular import).
 */

export interface ForwardStreamHandlers {
	onTextDelta?: (delta: string, cumulative: string) => void;
	onThinkingDelta?: (delta: string) => void;
	onToolCall?: (call: { id: string; name: string; args: unknown }) => void;
	onToolResult?: (result: { id: string; name: string; isError: boolean; contentText: string }) => void;
	onAssistantMessageEnd?: () => void;
	onAgentEnd?: () => void;
	onLongTask?: (event: { toolCallId: string; toolName: string; elapsedMs: number; threshold: boolean; toolCallArgs?: unknown }) => void;
}
