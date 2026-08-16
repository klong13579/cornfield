import type { RpcCommand } from "../modes/rpc/rpc-types";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionSnapshot } from "../session/session-snapshot";

/**
 * 多端协议（wire protocol）类型 —— P1 `omp serve` 的面。
 *
 * 与 gateway 的 rpc-types 关系：
 * - 命令面从 rpc-types 复用「通用会话控制」子集，用 `Extract` 类型级筛选，
 *   不产生运行时耦合，且协议面明确排除 gateway 包袱命令。
 * - 排除（gateway/IM 专属，不进多端协议）：set_steering_mode、
 *   set_follow_up_mode、set_interrupt_mode、set_disabled_toolsets、export_html。
 * - 新增多端专属命令：subscribe / unsubscribe / get_snapshot / attach / detach。
 *
 * 帧模型：
 * - 传输：WebSocket 文本帧 = 一个 JSON 对象（天然帧边界）；二进制帧预留给
 *   CBOR 后路（未来可选）。
 * - 握手：客户端首帧必须为 hello（携带版本 + token，token 也可在 URL query
 *   传入）；服务端回 hello_ack(connectionId) 或 hello_error。握手完成前拒绝
 *   一切 request。
 * - 请求/响应按 id 关联；推送（push）为服务端主动事件，无 id。
 *
 * 权威 vs 进度：session_snapshot 是权威（可重建 UI）；progress 是 UI 提示
 * （打字机/delta），不得归约为权威状态。
 */
export const MULTIDEVICE_PROTOCOL_VERSION = 1;

// ── 客户端 → 服务端 ──

/** rpc-types 中允许进入多端协议的通用会话控制命令（25 条）。 */
export type MultiplexCommand = Extract<
	RpcCommand,
	| { type: "prompt" }
	| { type: "steer" }
	| { type: "follow_up" }
	| { type: "abort" }
	| { type: "abort_and_prompt" }
	| { type: "new_session" }
	| { type: "get_state" }
	| { type: "set_todos" }
	| { type: "set_host_tools" }
	| { type: "set_model" }
	| { type: "cycle_model" }
	| { type: "get_available_models" }
	| { type: "set_thinking_level" }
	| { type: "cycle_thinking_level" }
	| { type: "compact" }
	| { type: "set_auto_compaction" }
	| { type: "set_auto_retry" }
	| { type: "abort_retry" }
	| { type: "get_session_stats" }
	| { type: "switch_session" }
	| { type: "branch" }
	| { type: "get_branch_messages" }
	| { type: "get_last_assistant_text" }
	| { type: "set_session_name" }
	| { type: "get_messages" }
>;

/** 多端专属命令（rpc-types 没有，wire 层新增）。 */
export type WireExtensionCommand =
	| { id?: string; type: "subscribe"; sessionId?: string }
	| { id?: string; type: "unsubscribe"; sessionId: string }
	| { id?: string; type: "get_snapshot"; sessionId: string }
	| { id?: string; type: "attach"; sessionId: string }
	| { id?: string; type: "detach"; sessionId: string };

export type WireCommand = MultiplexCommand | WireExtensionCommand;

export type ClientFrame =
	| { type: "hello"; version: number; token: string }
	| { type: "request"; id: string; command: WireCommand };

// ── 服务端 → 客户端 ──

export interface SessionListEntry {
	id: string;
	name?: string;
	sessionFile?: string;
	active: boolean;
}

export type WireServerEvent =
	/** 会话列表快照（多会话支持后用于初始列表；P1 单会话恒为 1 项）。 */
	| { type: "server_snapshot"; sessions: SessionListEntry[] }
	/** 权威会话快照 —— 可据此完整重建 UI。 */
	| { type: "session_snapshot"; sessionId: string; snapshot: SessionSnapshot }
	/** 进度事件（打字机/delta）—— 非权威，不得归约为状态。 */
	| { type: "progress"; sessionId: string; event: AgentSessionEvent };

export type ServerFrame =
	| { type: "hello_ack"; connectionId: string; protocolVersion: number }
	| { type: "hello_error"; error: string }
	| { type: "response"; id: string; ok: true; result?: unknown }
	| { type: "response"; id: string; ok: false; error: string }
	| { type: "push"; event: WireServerEvent };
