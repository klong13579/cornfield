import { Hourglass, X } from "lucide-react";

/**
 * QueueCard —— 排队消息卡（hermes queue card，R5）。
 * 数据源：SessionView.queued（排队数量）。每条排队消息的文本与取消命令当前协议尚未提供，
 * 故 text/onCancel 均可选：仅当 onCancel 提供时才渲染 ✕，避免渲染无实义的可点按钮。
 */

export interface QueueCardProps {
	count: number;
	/** 排队中正在等待的提示文本（协议未提供时省略）。 */
	text?: string;
	/** 取消排队回调（wire 命令未就绪前不传入，按钮不渲染）。 */
	onCancel?: () => void;
	className?: string;
}

export function QueueCard({ count, text, onCancel, className = "" }: QueueCardProps): React.JSX.Element | null {
	if (count <= 0) return null;
	return (
		<div
			className={`flex items-center gap-2 rounded-[10px] border border-dashed border-hairline-strong px-3.5 py-2 text-[12px] text-ink-muted ${className}`}
		>
			<Hourglass size={13} strokeWidth={1.5} className="shrink-0 text-ink-subtle" />
			<span className="min-w-0">
				排队中 · <b className="font-medium text-accent">{count} 条</b>
				{text ? `：${text}` : ""}
			</span>
			{onCancel && (
				<button
					type="button"
					className="ml-auto flex shrink-0 items-center justify-center rounded p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
					onClick={onCancel}
					aria-label="取消排队"
				>
					<X size={12} strokeWidth={1.5} />
				</button>
			)}
		</div>
	);
}
