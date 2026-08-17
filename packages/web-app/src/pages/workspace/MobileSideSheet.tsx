import { LayoutPanelLeft, X } from "lucide-react";
import { useState } from "react";
import { useIsMobile } from "../../lib/use-media-query";
import { SidePanel } from "./SidePanel";

/**
 * 移动端浮层面板（FR-8）：桌面右栏（概览/上下文/正在执行/Todo）在 <lg 变为
 * 底部弹出 sheet；桌面端渲染占位（右栏由 WorkspaceView 直接渲染 SidePanel）。
 * 触控优先：44px 触发按钮 + overlay 点击/Esc 关闭。
 */
export function MobileSideSheet(): React.JSX.Element | null {
	const isMobile = useIsMobile();
	const [open, setOpen] = useState(false);

	if (!isMobile) return null;

	return (
		<>
			<button
				type="button"
				className="link flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-md text-ink-subtle hover:bg-surface-2 hover:text-ink"
				title="会话面板"
				aria-label="打开会话面板"
				onClick={() => setOpen(true)}
			>
				<LayoutPanelLeft size={16} strokeWidth={1.5} />
			</button>

			{open && (
				<button
					type="button"
					className="fixed inset-0 z-40 cursor-default bg-black/40"
					onClick={() => setOpen(false)}
					aria-label="关闭会话面板"
				/>
			)}
			{open && (
				<div
					className="fixed inset-x-0 bottom-0 z-41 flex max-h-[72vh] flex-col overflow-y-auto rounded-t-2xl border-t border-hairline-strong bg-surface shadow-[-8px_0_32px_rgba(0,0,0,0.14)]"
					role="dialog"
					aria-label="会话面板"
				>
					<div className="flex items-center justify-between border-b border-hairline px-4 py-3">
						<span className="h-1 w-10 rounded-full bg-hairline-strong" aria-hidden />
					</div>
					<div className="shrink-0">
						<SidePanel />
					</div>
					<button
						type="button"
						className="m-3 rounded-md border border-hairline py-2.5 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink"
						onClick={() => setOpen(false)}
					>
						<X size={14} strokeWidth={1.5} className="inline" /> 关闭
					</button>
				</div>
			)}
		</>
	);
}
