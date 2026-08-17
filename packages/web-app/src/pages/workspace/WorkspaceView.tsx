import { Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { ComposerBar } from "./ComposerBar";
import { MobileSideSheet } from "./MobileSideSheet";
import { SidePanel } from "./SidePanel";
import { Transcript } from "./Transcript";

/**
 * 会话工作台（FR-1）：自定义顶栏 + 转录区 + Composer + 拖拽分隔条 + 右栏。
 * 支持 ?q= 直达（Home Composer 跳转带话）。
 */
export function WorkspaceView({ compact = false }: { compact?: boolean }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const [searchParams] = useSearchParams();
	const initialQuery = searchParams.get("q") ?? "";
	const [draftSeed] = useState(initialQuery);
	const splitterRef = useRef<HTMLHRElement>(null);

	const onSplitterPointerDown = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		splitterRef.current?.setPointerCapture(e.pointerId);
		const onMove = (ev: PointerEvent) => {
			getUiStore().setSidebarWidth(window.innerWidth - ev.clientX);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, []);

	useEffect(() => {
		if (!initialQuery) return;
		// Home ?q= 直达：等待快照就绪后自动发送
		const t = setTimeout(() => {
			if (initialQuery.trim()) store.prompt(initialQuery);
			getUiStore().setDraft("");
		}, 400);
		return () => clearTimeout(t);
	}, [initialQuery, store]);

	return (
		<div className="flex h-full min-h-0">
			<div className="flex min-w-0 flex-1 flex-col">
				{view.commandError && (
					<div className="flex items-center gap-2 border-b border-danger/40 bg-danger/5 px-4 py-1.5 text-[12px] text-danger">
						<span className="flex-1 truncate">{view.commandError}</span>
						<button type="button" className="link" onClick={() => store.clearCommandError()}>
							清除
						</button>
					</div>
				)}
				<header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-surface px-4.5">
					<span className="flex items-center gap-1.5 text-[12px] text-success">
						<span className={`conn-dot ${view.reconnecting ? "reconnecting" : ""}`} />
						{view.reconnecting
							? `reconnecting${view.connectionId ? ` · ${view.connectionId}` : ""}`
							: "connected"}
					</span>
					<span className="h-[18px] w-px bg-hairline" />
					<button type="button" className="chip">
						<Folder size={13} strokeWidth={1.5} />
						<b>{view.env?.repos ?? "oh-my-pi"}</b> · {view.env?.branch ?? "main"}
					</button>
					<span className="flex-1" />
					<MobileSideSheet />
					{!compact && (
						<>
							<button type="button" className="link" onClick={() => store.compact()}>
								compact
							</button>
							<button type="button" className="link" onClick={() => store.newSession()}>
								新会话
							</button>
						</>
					)}
				</header>

				<Transcript />

				<div className="hidden md:block">
					<ComposerBar autoFocusDraft={draftSeed} />
				</div>
				{/* 移动端（/m 预览）：输入区同样可用 */}
				<div className="md:hidden">
					<ComposerBar autoFocusDraft={draftSeed} />
				</div>
			</div>

			{/* 拖拽分隔条（clamp 240-520，双击复位 300，localStorage 持久化） */}
			{!compact && (
				<hr
					ref={splitterRef}
					aria-orientation="vertical"
					aria-valuenow={ui.sidebarWidth}
					aria-valuemin={240}
					aria-valuemax={520}
					tabIndex={0}
					title="拖拽调整面板宽度（←/→ 微调，双击复位）"
					className="my-0 hidden w-[5px] shrink-0 cursor-col-resize bg-transparent transition-colors duration-150 outline-none hover:bg-accent-dim focus-visible:bg-accent-dim lg:block"
					onPointerDown={onSplitterPointerDown}
					onDoubleClick={() => getUiStore().resetSidebarWidth()}
					onKeyDown={e => {
						if (e.key === "ArrowLeft") getUiStore().setSidebarWidth(ui.sidebarWidth - 20);
						if (e.key === "ArrowRight") getUiStore().setSidebarWidth(ui.sidebarWidth + 20);
					}}
				/>
			)}

			{/* 右栏：桌面端固定宽度；移动端隐藏（P5 浮层） */}
			{!compact && (
				<div className="hidden min-h-0 lg:block" style={{ width: ui.sidebarWidth, minWidth: 240, maxWidth: 520 }}>
					<SidePanel />
				</div>
			)}
		</div>
	);
}
