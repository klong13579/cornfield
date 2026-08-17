/**
 * SteerIndicator —— steer 斜体指示条（hermes steer indicator，R5）。
 * 数据源 TBD：SessionView/wire-dto 暂无 steer 事件，仅 client→server "steer" 命令存在。
 * 本组件保持纯展示，text 由未来协议事件或上层注入。
 */

export interface SteerIndicatorProps {
	text: string;
	className?: string;
}

export function SteerIndicator({ text, className = "" }: SteerIndicatorProps): React.JSX.Element | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	return (
		<div className={`flex items-baseline gap-2 py-2 text-[12.5px] italic text-accent opacity-65 ${className}`}>
			<span className="shrink-0 rounded border border-hairline-strong bg-accent-dim px-1.5 py-px text-[10px] font-semibold uppercase not-italic tracking-wide">
				steer
			</span>
			<span>{trimmed}</span>
		</div>
	);
}
