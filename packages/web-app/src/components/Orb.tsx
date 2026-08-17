import type { OrbState as TOrbState } from "thinking-orbs";
import { ThinkingOrb } from "thinking-orbs";

/**
 * ThinkingOrb —— FR-12 实装（npm `thinking-orbs` 0.3.1，canvas 2D，MIT）。
 *
 * 状态映射（docs/mock/README.md 9.1 节）：
 *   idle → breathing（Home 问候区）· streaming → composing（工作台流式名称行）
 *   工具执行 → solving（工具卡头部）· listening → listening（Voice/Jarvis）
 *   connecting → connecting（连接态）· planning → shaping（Jarvis 转写完成态）
 *   agent 运行中 → working（Agent 卡片）
 *
 * size 归一：thinking-orbs 只提供 64/20 两个预设（各自独立调参，非缩放），
 * <=32 归 20（行内），>32 归 64（头像/hero 级）。
 * theme="light"：V6 亮色主题，渲染深墨点在透明画布上。
 */

export type OrbState = TOrbState;

export interface OrbProps {
	state?: OrbState;
	size?: number;
	className?: string;
	/** thinking-orbs 内置调色，固定 light（V6 亮色）；不需要外部染色。 */
	color?: string;
	/** 冻结动画（如页面隐藏）。 */
	paused?: boolean;
	/** 动画速度倍率。 */
	speed?: number;
}

const ORB_PRESET = (size: number): 20 | 64 => (size <= 32 ? 20 : 64);

export function Orb({
	state = "breathing",
	size = 20,
	className = "",
	paused = false,
	speed = 1,
}: OrbProps): React.JSX.Element {
	return (
		<ThinkingOrb
			state={state}
			size={ORB_PRESET(size)}
			theme="light"
			paused={paused}
			speed={speed}
			className={className}
			aria-label={`orb: ${state}`}
		/>
	);
}
