import { FolderOpen, GitBranch, Image } from "lucide-react";
import { useState } from "react";
import { activeAgentIdOf } from "../../state/agent-context";
import { getFileWorkflow } from "../../state/file-workflow-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { ChangesPanel, fileOpenTargetOf } from "./ChangesPanel";
import { FileExplorer } from "./FileExplorer";

/**
 * 工作台右栏（hermes 右栏 Files/Artifacts/Changes 三 tab）。
 * - Files：复用 FileExplorer（S5 复用，不重写 fs 目录树），窄栏上下布局
 * - Artifacts：产物列表（list_artifacts 真数据）
 * - Changes：工作区改动清单（git_changes 真数据），按读取它的会话分组
 *
 * Terminal 是一个明确的**不做**：右栏不做终端。这里也没有留一个空 tab 占位。
 *
 * 数据源：Files 与 Changes 的**本会话组**都按**会话身份**（`view.attachmentAddress`，即焦点附件的
 * 地址）指路 —— 绑了 Project 的会话只有它能指认得动自己的工作根；Artifacts 同样按会话身份取
 * （它还要按 `sessionFile` 隔离到本会话）。`agentId`（当前 attached agent 的 registry id）只用于
 * 归属/展示。
 */

type TabId = "files" | "artifacts" | "changes";

const TABS: { id: TabId; label: string; icon: typeof FolderOpen }[] = [
	{ id: "files", label: "文件", icon: FolderOpen },
	{ id: "artifacts", label: "产物", icon: Image },
	{ id: "changes", label: "改动", icon: GitBranch },
];

export function RightPanel({
	collapsed = false,
	elementRef,
}: {
	collapsed?: boolean;
	/** 交出去给分栏容器量可见宽度（拖拽起点用屏幕上那个值，不是偏好值）。 */
	elementRef?: React.Ref<HTMLElement>;
}): React.JSX.Element {
	const view = useSession();
	const ui = useUiState();
	const [tab, setTab] = useState<TabId>("files");
	// 跟随本连接当前焦点 agent（与左栏会话树同一处解析，避免两栏读不同 Agent）—— 只用于归属/展示。
	const agentId = activeAgentIdOf(view);
	// 文件面的 wire 身份是**会话身份**（附件地址）：绑了 Project 的会话只有它能指认出自己的根。
	const attachmentAddress = view.attachmentAddress;

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
				ref={elementRef}
				className={`fixed inset-y-0 right-0 z-drawer flex w-[300px] flex-col border-l border-hairline bg-surface transition-transform duration-200 lg:static lg:z-auto lg:w-[var(--pane-rightPanel-width)] lg:min-w-[var(--pane-rightPanel-min)] lg:translate-x-0 ${ui.mobileNavOpen ? "translate-x-0" : "translate-x-full"} ${collapsed ? "lg:hidden" : ""}`}
			>
				{/* 三 tab */}
				<div role="tablist" className="flex shrink-0 border-b border-hairline px-3 pt-2">
					{TABS.map(t => {
						const Icon = t.icon;
						return (
							<button
								key={t.id}
								type="button"
								role="tab"
								aria-selected={tab === t.id}
								className={`flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] font-medium transition-colors ${tab === t.id ? "border-accent text-accent-hover" : "border-transparent text-ink-subtle hover:text-ink"}`}
								onClick={() => setTab(t.id)}
							>
								<Icon size={13} strokeWidth={1.5} />
								{t.label}
							</button>
						);
					})}
				</div>

				{/* 内容 */}
				<div className="min-h-0 flex-1 overflow-hidden p-3">
					{tab === "files" &&
						(attachmentAddress !== "" && agentId ? (
							<FileExplorer attachmentAddress={attachmentAddress} agentId={agentId} variant="narrow" />
						) : (
							<div className="py-10 text-center text-[12px] text-ink-faint">
								{view.connected ? "等待会话挂载…" : "未连接——文件系统不可用"}
							</div>
						))}
					{tab === "artifacts" && (
						<ArtifactsPanel
							attachmentAddress={attachmentAddress}
							sessionFile={view.sessionFile}
							connected={view.connected}
						/>
					)}
					{tab === "changes" && (
						<ChangesPanel
							onOpenFile={(group, path) => {
								// 打开的是**那条改动所属会话**的文件（不是当前焦点会话的）；打开用的身份就是那份
								// 清单读的时候用的身份（fileOpenTargetOf 一个口子给出两个身份，见它的注释）；
								// 编辑/保存的窗口在文件 tab 里，所以打开后切过去 —— 否则点了没反应。
								getFileWorkflow().requestOpen(fileOpenTargetOf(group, path));
								setTab("files");
							}}
						/>
					)}
				</div>
			</aside>
		</>
	);
}
