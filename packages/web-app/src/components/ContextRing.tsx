/**
 * ContextRing —— token 用量圆环（hermes composer context ring，R5）。
 *
 * 数据源：SessionView.context（session-store 已用 ratioPercent 归一 0~100 并 clamp）。
 * 消费侧（W1 S4 composer）负责把 context 映射为 props；本组件保持纯展示，不引 session-store。
 *
 * - 圆环 viewBox 30×30、半径 11、线宽 3；背景轨道 + 前景弧（dashoffset 反比于用量）
 * - 中心整百分比（mono 8px）
 * - 弧色分档：<70% accent（墨色）、70~89% warning、>=90% danger
 */

export interface ContextRingProps {
	/** 0~100 的用量百分比（超界会被 clamp；NaN 视作 0）。 */
	percent: number;
	size?: number;
	usedTokens?: number;
	totalTokens?: number;
	className?: string;
}

const VIEW = 30;
const RADIUS = 11;
const STROKE = 3;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ≈ 69.115

function clampPercent(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(100, Math.max(0, n));
}

function arcColor(percent: number): string {
	if (percent >= 90) return "var(--color-danger)";
	if (percent >= 70) return "var(--color-warning)";
	return "var(--color-accent)";
}

export function ContextRing({
	percent,
	size = 30,
	usedTokens,
	totalTokens,
	className = "",
}: ContextRingProps): React.JSX.Element {
	const pct = Math.round(clampPercent(percent));
	const dashOffset = CIRCUMFERENCE * (1 - pct / 100);
	const title =
		usedTokens !== undefined && totalTokens !== undefined
			? `上下文 ${pct}%（${usedTokens.toLocaleString()} / ${totalTokens.toLocaleString()} tokens）`
			: `上下文 ${pct}%`;

	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${VIEW} ${VIEW}`}
			role="img"
			aria-label={title}
			className={className}
		>
			<title>{title}</title>
			<circle
				cx={VIEW / 2}
				cy={VIEW / 2}
				r={RADIUS}
				fill="none"
				stroke="var(--color-hairline)"
				strokeWidth={STROKE}
			/>
			<g transform={`rotate(-90 ${VIEW / 2} ${VIEW / 2})`}>
				<circle
					cx={VIEW / 2}
					cy={VIEW / 2}
					r={RADIUS}
					fill="none"
					stroke={arcColor(pct)}
					strokeWidth={STROKE}
					strokeLinecap="round"
					strokeDasharray={CIRCUMFERENCE.toFixed(3)}
					strokeDashoffset={dashOffset.toFixed(3)}
				/>
			</g>
			<text
				x={VIEW / 2}
				y={VIEW / 2}
				textAnchor="middle"
				dominantBaseline="central"
				fontSize={8}
				fontWeight={600}
				fill="var(--color-ink-muted)"
				fontFamily="var(--font-mono)"
			>
				{pct}%
			</text>
		</svg>
	);
}
