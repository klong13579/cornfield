import { X } from "lucide-react";
import { useEffect } from "react";
import { getUiStore, useUiState } from "../state/ui-store";

/**
 * 手机预览面板 —— 375 尺寸设备框内嵌 iframe（加载 /m 移动裁剪路由 / workspace 响应式）。
 * 触发按钮由 WorkspaceView 顶栏渲染（避免 fixed 悬浮层遮挡顶栏操作）。
 * P5 阶段再完善为独立 mobile route 联调；当前/移动端裁剪已随 workspace 响应式断点生效。
 */
export function DevicePreview(): React.JSX.Element {
	const ui = useUiState();

	useEffect(() => {
		if (!ui.phonePreviewOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") getUiStore().setPhonePreview(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [ui.phonePreviewOpen]);

	return (
		<>
			{ui.phonePreviewOpen && (
				<button
					type="button"
					className="fixed inset-0 z-30 cursor-default bg-ink/50"
					onClick={() => getUiStore().setPhonePreview(false)}
					aria-label="关闭预览"
				/>
			)}
			{ui.phonePreviewOpen && (
				<div className="fixed top-0 right-0 z-31 flex h-screen w-[420px] flex-col border-l border-hairline-strong bg-surface shadow-[-16px_0_48px_rgba(24,24,27,0.08)]">
					<div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
						<span className="font-mono text-xs text-ink-subtle">移动端预览 · 375×812</span>
						<button
							type="button"
							className="ml-auto rounded-md p-1 px-2 text-lg text-ink-subtle hover:bg-surface-2 hover:text-ink"
							onClick={() => getUiStore().setPhonePreview(false)}
							aria-label="关闭预览"
						>
							<X size={16} strokeWidth={1.5} />
						</button>
					</div>
					<div className="flex flex-1 items-center justify-center overflow-hidden p-6">
						<div className="flex h-full max-h-[812px] w-[375px] flex-col overflow-hidden rounded-[40px] border border-hairline-strong bg-canvas shadow-[0_24px_64px_rgba(24,24,27,0.12)]">
							<div className="flex h-11 shrink-0 items-center justify-between px-6 text-xs font-semibold text-ink">
								<span>9:41</span>
								<span>omp</span>
								<span>●●●</span>
							</div>
							<div className="min-h-0 flex-1">
								<iframe src="/m" title="移动端预览" className="h-full w-full border-none" />
							</div>
							<div className="flex h-5 shrink-0 items-center justify-center">
								<span className="h-1 w-[120px] rounded-full bg-hairline-strong" />
							</div>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
