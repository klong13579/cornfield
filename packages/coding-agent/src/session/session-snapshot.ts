/**
 * 会话快照 —— 类型已迁往 @oh-my-pi/pi-wire（协议定义层），本文件保留
 * 构建快照的运行时（reducePhase 归约器）。方向：协议定义 → 核心实现。
 */
import type { SessionPhase, SessionSnapshot } from "@oh-my-pi/pi-wire";

export type { SessionPhase, SessionSnapshot };

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
