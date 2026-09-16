import { FolderTree, RefreshCw } from "lucide-react";
import { ProjectList, projectLabelOf } from "../components/ProjectContext";
import type { SessionView } from "../state/session-store";

/**
 * ProjectSwitcher —— 工作台顶栏的「当前会话落在哪个 Project」上下文控件（唯一实现）。
 *
 * 它能做什么，老实说清楚：wire 面只有 `list_projects`（读）与 serve 算出来的会话归属，
 * **没有切 Project 的命令**（切 Project 需要 serve 侧改动，不在本票范围）。
 * 所以这里是「看当前归属 + 看已声明的清单 + 重读」，不摆一个点了没反应的切换动作 ——
 * 假动作比没有更坏，用户会以为自己切过去了。
 *
 * 展开态用原生 <details>：深链、刷新、键盘可达都不需要额外状态，也不会在刷新后丢失。
 * 三个「没有」（读不到 / 未声明 / 未归属）由 projectLabelOf + ProjectList 一处判定。
 */
export function ProjectSwitcher({
	view,
	onRefresh,
}: {
	view: SessionView;
	/** 重读 registry（含当前会话归属）；缺省时不显示刷新钮。 */
	onRefresh?: () => void;
}): React.JSX.Element {
	const { label, title } = projectLabelOf(view);

	return (
		<details className="relative shrink-0">
			<summary className="chip whitespace-nowrap" title={title}>
				<FolderTree size={13} strokeWidth={1.5} />
				<b>{label}</b>
			</summary>
			<div className="absolute right-0 z-menu mt-1 w-[380px] rounded-[12px] border border-hairline-strong bg-surface p-3 shadow-xl">
				<div className="mb-2 flex items-center gap-2">
					<span className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">项目</span>
					<span className="flex-1" />
					{onRefresh && (
						<button
							type="button"
							className="cbtn"
							onClick={onRefresh}
							aria-label="重新读取项目列表"
							title="重新读取项目列表"
						>
							<RefreshCw size={13} strokeWidth={1.5} />
						</button>
					)}
				</div>
				<ProjectList view={view} />
			</div>
		</details>
	);
}
