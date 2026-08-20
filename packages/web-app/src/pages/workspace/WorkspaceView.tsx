import { Folder, Menu, PanelRight, Smartphone } from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { QueueCard } from "../../components/QueueCard";
import { DevicePreview } from "../../layout/DevicePreview";
import { FloatingCardHost } from "../../render/FloatingCardHost";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { ComposerBar } from "./ComposerBar";
import { RightPanel } from "./RightPanel";
import { SessionSidebar } from "./SessionSidebar";
import { Transcript } from "./Transcript";

/**
 * 会话工作台（FR-1）：自定义顶栏 + 转录区 + Composer（右栏已按用户决策移除，对话区占满全宽）。
 * 支持 ?q= 直达（Home Composer 跳转带话），一次性消费：自动发送后从 URL 移除 q 参数。
 */
export function WorkspaceView({ compact = false }: { compact?: boolean }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const [searchParams, setSearchParams] = useSearchParams();
	const initialQuery = (searchParams.get("q") ?? "").trim();

	useEffect(() => {
		if (!initialQuery) return;
		// Home ?q= 直达：输入区为空则先放入种子文本（用户可随时改写）；
		// 等待快照就绪后自动发送（仅当用户未改动输入时），随后消费 URL 参数——
		// 防止刷新/回退重复触发，也防止种子文本在清空输入后反复恢复。
		if (!getUiStore().getSnapshot().draft) getUiStore().setDraft(initialQuery);
		const t = setTimeout(() => {
			const draft = getUiStore().getSnapshot().draft;
			if (draft === initialQuery) {
				store.prompt(initialQuery);
				getUiStore().setDraft("");
			}
			setSearchParams(
				prev => {
					const next = new URLSearchParams(prev);
					next.delete("q");
					return next;
				},
				{ replace: true },
			);
		}, 400);
		return () => clearTimeout(t);
	}, [initialQuery, store, setSearchParams]);

	return (
		<div className="flex h-full min-h-0">
			{!compact && <SessionSidebar />}
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
					<button
						type="button"
						className="cbtn shrink-0 lg:hidden"
						onClick={() => getUiStore().setMobileNav(!ui.mobileNavOpen)}
						aria-label="切换会话栏"
					>
						<Menu size={16} strokeWidth={1.5} />
					</button>
					<span className="flex items-center gap-1.5 text-[12px] text-success">
						<span className={`conn-dot ${view.reconnecting ? "reconnecting" : ""}`} />
						{view.reconnecting
							? `reconnecting${view.connectionId ? ` · ${view.connectionId}` : ""}`
							: "connected"}
					</span>
					<span className="h-[18px] w-px bg-hairline" />
					<button type="button" className="chip">
						<Folder size={13} strokeWidth={1.5} />
						<b>{view.env?.repos ?? "未连接"}</b>
						{view.env ? ` · ${view.env.branch}` : ""}
					</button>
					<span className="flex-1" />
					{!compact && (
						<>
							<button
								type="button"
								className="cbtn hidden shrink-0 lg:inline-flex"
								onClick={() => getUiStore().setPhonePreview(true)}
								title="手机预览"
								aria-label="手机预览"
							>
								<Smartphone size={16} strokeWidth={1.5} />
							</button>
							<button
								type="button"
								className="cbtn hidden shrink-0 lg:inline-flex"
								onClick={() => getUiStore().setRightPanel(!ui.rightPanelOpen)}
								aria-label={ui.rightPanelOpen ? "收起右栏" : "展开右栏"}
								title={ui.rightPanelOpen ? "收起右栏" : "展开右栏"}
							>
								<PanelRight size={16} strokeWidth={1.5} />
							</button>
							<button type="button" className="cbtn" onClick={() => store.compact()}>
								compact
							</button>
							<button type="button" className="cbtn" onClick={() => store.newSession()}>
								新会话
							</button>
						</>
					)}
				</header>

				<Transcript />
				<QueueCard
					count={view.queued}
					onCancel={view.queued > 0 ? () => void store.cancelQueued() : undefined}
					className="mx-auto mb-1 max-w-[800px]"
				/>

				{/* 输入区：单一实例（CSS 自适应桌面/移动），避免模型列表/草稿逻辑双份执行 */}
				{/* 审批/澄清浮层卡：position:relative 锚点，卡从 composer 上方滑入 */}
				<FloatingCardHost />
				<ComposerBar autoFocusDraft={initialQuery} />
			</div>
			{!compact && <RightPanel collapsed={!ui.rightPanelOpen} />}
			{!compact && <DevicePreview />}
		</div>
	);
}
