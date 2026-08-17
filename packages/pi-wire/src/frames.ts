import type { WireCommand } from "./commands";

/** 多端协议版本 — hello 握手时双向校验。 */
export const MULTIDEVICE_PROTOCOL_VERSION = 1;

// ── 客户端 → 服务端 ──

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

/**
 * 服务端主动推送事件。
 *
 * 泛型参数化 snapshot / event：
 * - `TSnapshot` = SessionSnapshot 具体类型（coding-agent 侧传入 SessionSnapshot，fe 侧可定义
 *   自己的 view-model，也可先用 `unknown` 弦后再收紧）。
 * - `TEvent` = AgentSessionEvent 具体类型。
 *
 * pi-wire 本身不依赖 coding-agent 内部结构；双方在数据层面以 JSON 为契约。
 */
export type WireServerEvent<TSnapshot = unknown, TEvent = unknown> =
	/** 会话列表快照（多会话支持后用于初始列表；P1 单会话恒为 1 项）。 */
	| { type: "server_snapshot"; sessions: SessionListEntry[] }
	/** 权威会话快照 — 可据此完整重建 UI。 */
	| { type: "session_snapshot"; sessionId: string; snapshot: TSnapshot }
	/** 进度事件（打字机/delta） — 非权威，不得归约为状态。 */
	| { type: "progress"; sessionId: string; event: TEvent };

export type ServerFrame<TSnapshot = unknown, TEvent = unknown> =
	| { type: "hello_ack"; connectionId: string; protocolVersion: number }
	| { type: "hello_error"; error: string }
	| { type: "response"; id: string; ok: true; result?: unknown }
	| { type: "response"; id: string; ok: false; error: string }
	| { type: "push"; event: WireServerEvent<TSnapshot, TEvent> };

/** helper: 判断一个帧是否 push 帧。 */
export function isPushFrame<TSnapshot, TEvent>(
	frame: ServerFrame<TSnapshot, TEvent>,
): frame is Extract<ServerFrame<TSnapshot, TEvent>, { type: "push" }> {
	return frame.type === "push";
}

/** helper: 判断一个帧是否 response 帧。 */
export function isResponseFrame<TSnapshot, TEvent>(
	frame: ServerFrame<TSnapshot, TEvent>,
): frame is Extract<ServerFrame<TSnapshot, TEvent>, { type: "response" }> {
	return frame.type === "response";
}
