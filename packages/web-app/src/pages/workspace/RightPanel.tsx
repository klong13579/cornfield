import { FolderOpen, Image } from "lucide-react";
import { useState } from "react";
import { useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { FileExplorer } from "./FileExplorer";

/**
 * 工作台右栏（S5，hermes 右栏 Files/Artifacts 双 tab）。
 * - Files：复用 FileExplorer（S5 复用，不重写 fs 目录树），窄栏上下布局
 * - Artifacts：占位（Artifacts 产物面板待接入）
 *
 * 数据源：仅读当前 attached session 的 agentDir（view.sessionId；未挂载时回退首个 agent）。
 */

type TabId = "files" | "artifacts";

const TABS: { id: TabId; label: string }[] = [
	{ id: "files", label: "Files" },
	{ id: "artifacts", label: "Artifacts" },
];

export function RightPanel({ collapsed = false }: { collapsed?: boolean }): React.JSX.Element {
	const view = useSession();
	const ui = useUiState();
	const [tab, setTab] = useState<TabId>("files");
	const agentId = view.sessionId || view.agents[0]?.id;

	return (
		<aside
			className={`fixed inset-y-0 right-0 z-50 flex w-[300px] flex-col border-l border-hairline bg-surface transition-transform duration-200 lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 ${ui.mobileNavOpen ? "translate-x-0" : "translate-x-full"} ${collapsed ? "lg:hidden" : ""}`}
		>
			{/* 双 tab */}
			<div className="flex shrink-0 border-b border-hairline px-3 pt-2">
				{TABS.map(t => (
					<button
						key={t.id}
						type="button"
						className={`flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] font-medium transition-colors ${tab === t.id ? "border-accent text-accent-hover" : "border-transparent text-ink-subtle hover:text-ink"}`}
						onClick={() => setTab(t.id)}
					>
						{t.id === "files" ? (
							<FolderOpen size={13} strokeWidth={1.5} />
						) : (
							<Image size={13} strokeWidth={1.5} />
						)}
						{t.label}
					</button>
				))}
			</div>

			{/* 内容 */}
			<div className="min-h-0 flex-1 overflow-hidden p-3">
				{tab === "files" ? (
					agentId ? (
						<FileExplorer agentId={agentId} variant="narrow" />
					) : (
						<div className="py-10 text-center text-[12px] text-ink-faint">
							{view.connected ? "等待会话挂载…" : "未连接——文件系统不可用"}
						</div>
					)
				) : (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-center">
						<Image size={24} strokeWidth={1.25} className="text-ink-faint" />
						<div className="text-[12px] text-ink-faint">Artifacts 待实现（产物面板占位）</div>
					</div>
				)}
			</div>
		</aside>
	);
}
