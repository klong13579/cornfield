import { FolderOpen, Image } from "lucide-react";
import { useState } from "react";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { FileExplorer } from "./FileExplorer";

/**
 * 工作台右栏（S5，hermes 右栏 Files/Artifacts 双 tab）。
 * - Files：复用 FileExplorer（S5 复用，不重写 fs 目录树），窄栏上下布局
 * - Artifacts：ArtifactsPanel 骨架（产物列表/空态/loading/错误态；wire 协议未接，仅留数据接入钩子）
 *
 * 数据源：取当前 attached agent 的 registry id（未挂载回退首个 agent）。
 */

type TabId = "files" | "artifacts";

const TABS: { id: TabId; label: string }[] = [
	{ id: "files", label: "文件" },
	{ id: "artifacts", label: "产物" },
];

export function RightPanel({ collapsed = false }: { collapsed?: boolean }): React.JSX.Element {
	const view = useSession();
	const ui = useUiState();
	const [tab, setTab] = useState<TabId>("files");
	const agentId = view.agents.find(a => a.attached)?.id ?? view.agents[0]?.id;

	return (
		<>
			{/* 移动端遮罩 */}
			{ui.mobileNavOpen && (
				<div
					className="fixed inset-0 z-menu bg-ink/20 lg:hidden"
					onClick={() => getUiStore().setRightPanel(false)}
					aria-hidden
				/>
			)}
			<aside
				className={`fixed inset-y-0 right-0 z-drawer flex w-[300px] flex-col border-l border-hairline bg-surface transition-transform duration-200 lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 ${ui.mobileNavOpen ? "translate-x-0" : "translate-x-full"} ${collapsed ? "lg:hidden" : ""}`}
			>
				{/* 双 tab */}
				<div role="tablist" className="flex shrink-0 border-b border-hairline px-3 pt-2">
					{TABS.map(t => (
						<button
							key={t.id}
							type="button"
							role="tab"
							aria-selected={tab === t.id}
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
						<ArtifactsPanel />
					)}
				</div>
			</aside>
		</>
	);
}
