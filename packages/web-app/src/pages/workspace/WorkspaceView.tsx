import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSessionStore } from "../../state/session-store";
import { getUiStore } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { ComposerBar } from "./ComposerBar";
import { Transcript } from "./Transcript";

/**
 * 会话工作台（FR-1）：自定义顶栏 + 转录区 + Composer（右栏已按用户决策移除，对话区占满全宽）。
 * 支持 ?q= 直达（Home Composer 跳转带话）。
 */
export function WorkspaceView({ compact = false }: { compact?: boolean }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const [searchParams] = useSearchParams();
	const initialQuery = searchParams.get("q") ?? "";
	const [draftSeed] = useState(initialQuery);

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
						<b>{view.env?.repos ?? "未连接"}</b>
						{view.env ? ` · ${view.env.branch}` : ""}
					</button>
					<span className="flex-1" />
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
		</div>
	);
}
