/**
 * @oh-my-pi/pi-wire — 多端 wire 协议类型包。
 *
 * 职责边界：
 * - 只定义类型（帧/命令/事件/协议版本），不召时包含任何行为（零运行时依赖 coding-agent）。
 * - 向下依赖 pi-agent-core (ThinkingLevel) 和 pi-ai (ImageContent)，不向上依赖 coding-agent。
 * - 与 coding-agent 的 rpc-types 不再直接组合 (取消 P1 的 Extract 约束)；命令面需扉齐仅靠人工同步
 *   和 code review（两边不共享后叁不会引入循环/跨 workspace 奇奇怪怪的添写）。
 *
 * P0/P1 兼容：旧名字 (MULTIDEVICE_PROTOCOL_VERSION / MultiplexCommand / WireCommand /
 * WireExtensionCommand / ClientFrame / ServerFrame / WireServerEvent / SessionListEntry) 全部保留。
 */
export * from "./commands";
export * from "./frames";
export * from "./results";
export * from "./snapshot";
