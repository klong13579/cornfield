/**
 * ThinkingOrb —— thinking-orbs 动效的 CSS 占位实现（FR-12）。
 *
 * mock 状态映射：streaming→composing / 工具执行→solving / 待命→breathing /
 * 连接中→connecting。当前以等距点阵脉冲近似；
 * TODO: 后续接 npm `thinking-orbs`（FR-12，canvas 2D 引擎，9 状态，
 * IntersectionObserver 离屏暂停 + DPR cap 2），替换本组件。
 */

export type OrbState = "breathing" | "composing" | "working" | "solving" | "connecting" | "listening" | "shaping";

const ORB_DURATION_MS: Record<OrbState, number> = {
	breathing: 2600,
	composing: 1500,
	working: 1300,
	solving: 800,
	connecting: 1100,
	listening: 1700,
	shaping: 1900,
};

export interface OrbProps {
	state?: OrbState;
	size?: number;
	className?: string;
	/** 不染色时用 currentColor（跟随文字色）。 */
	color?: string;
}

export function Orb({
	state = "breathing",
	size = 20,
	className = "",
	color = "currentColor",
}: OrbProps): React.JSX.Element {
	const n = 10;
	const duration = ORB_DURATION_MS[state];
	const radius = size / 2.6;
	const dot = Math.max(2, size / 9);

	return (
		<span
			className={`relative inline-flex shrink-0 ${className}`}
			style={{ width: size, height: size, ["--orb-dur" as string]: `${duration}ms` }}
			role="img"
			aria-label={`orb: ${state}`}
		>
			{Array.from({ length: n }, (_, i) => {
				const angle = (i / n) * Math.PI * 2;
				const left = size / 2 + Math.cos(angle) * radius - dot / 2;
				const top = size / 2 + Math.sin(angle) * radius - dot / 2;
				return (
					<span
						key={i}
						className="orb-dot"
						style={{
							position: "absolute",
							left,
							top,
							width: dot,
							height: dot,
							color,
							background: color,
							animationDelay: `${(i * duration) / n}ms`,
						}}
					/>
				);
			})}
		</span>
	);
}
