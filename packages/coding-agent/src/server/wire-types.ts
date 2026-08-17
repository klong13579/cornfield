/**
 * 多端协议类型—— coding-agent 侧 shim，代行到 `@oh-my-pi/pi-wire`。
 *
 * P2 抽包以后，帧类型/命令面/协议版本的权威定义在 pi-wire，消除对 coding-agent 自己
 * (rpc-types) 的环形依赖。本文件只负责：
 *   1. 重新导出 pi-wire 的平坐名字，保持 P0/P1 时期已有 import 不断；
 *   2. 将 pi-wire 的泛型 `ServerFrame<TSnapshot, TEvent>` / `WireServerEvent<...>` 局部特化
 *      为 coding-agent 实际在用的具体类型（SessionSnapshot / AgentSessionEvent）。
 *
 * 变更命令面时 — 在 pi-wire/src/commands.ts 里改；wire-server 实现同步在本包 wire-server.ts。
 */
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionSnapshot } from "../session/session-snapshot";

export type {
	ClientFrame,
	MultiplexCommand,
	SessionListEntry,
	WireCommand,
	WireCommandOfType,
	WireExtensionCommand,
	WireHostToolDefinition,
	WireTodoItem,
	WireTodoPhase,
} from "@oh-my-pi/pi-wire";
// 重新导出不需要特化的部分。
export {
	isPushFrame,
	isResponseFrame,
	MULTIDEVICE_PROTOCOL_VERSION,
} from "@oh-my-pi/pi-wire";

// 将泛型帧特化为 coding-agent 内部具体类型（方便 wire-server 直接使用）。
import type { ServerFrame as GenericServerFrame, WireServerEvent as GenericWireServerEvent } from "@oh-my-pi/pi-wire";

export type WireServerEvent = GenericWireServerEvent<SessionSnapshot, AgentSessionEvent>;
export type ServerFrame = GenericServerFrame<SessionSnapshot, AgentSessionEvent>;
