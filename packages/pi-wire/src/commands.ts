import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";

/**
 * Wire 命令面 (multiplex 子集)。
 *
 * 本包 仅定义 wire 传输层能看到的 shape：名字 + 参数。不依赖 coding-agent 的 rpc-types
 * (取消 P0/P1 时期的 `Extract<RpcCommand, ...>` 约束)。两边同步保证在 code review
 * 层面：pi-wire 新增命令 -> coding-agent wire-server 实现；coding-agent rpc 新增命令
 * 不自动进入 wire 面（需显式在本文件登记）。
 *
 * P1 已补齐的命令以 rpc-mode.ts 同名语义为准（参数名/类型一致，方便
 * gateway/tui/serve 共享客户端代码机会）。
 *
 * 情境外命令（已在 requirement.md 约定创除）：set_steering_mode /
 * set_follow_up_mode / set_interrupt_mode / set_disabled_toolsets / export_html /
 * bash / abort_bash。gateway-specific，不进多端。
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
 * Multiplex 命令 — 25 条，与 P1 wire-types 一致（只不再通过 Extract 依赖 rpc-types）。
 */
export type MultiplexCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }
	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_todos"; phases: WireTodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: WireHostToolDefinition[] }
	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	// Messages
	| { id?: string; type: "get_messages" };

/** 多端专属命令（rpc-types 没有，wire 层新增）。 */
export type WireExtensionCommand =
	| { id?: string; type: "subscribe"; sessionId?: string }
	| { id?: string; type: "unsubscribe"; sessionId: string }
	| { id?: string; type: "get_snapshot"; sessionId: string }
	| { id?: string; type: "attach"; sessionId: string }
	| { id?: string; type: "detach"; sessionId: string };

export type WireCommand = MultiplexCommand | WireExtensionCommand;

/** 获取具体命令结构的 helper。 */
export type WireCommandOfType<T extends WireCommand["type"]> = Extract<WireCommand, { type: T }>;
