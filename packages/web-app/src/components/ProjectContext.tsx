import { RefreshCw } from "lucide-react";
import type { ProjectRecordDto } from "../lib/pi-client-api";
import type { SessionView } from "../state/session-store";

/**
 * Project 上下文（T8）—— 客户端级 Project registry（`~/.cornfield/agent/projects.json`，WP4）
 * 的真实读数。
 *
 * 三个状态必须分开显示，它们不是一回事：
 *   - **读不到**（存储损坏）：serve 回 ok:false，这里显示错误，不显示「未声明」；
 *   - **未声明**：读到了空列表，是明确的事实；
 *   - **未归属**：声明了 Project，但当前会话不在任何一个是（归属由 serve 按域里的 root
 *     匹配规则算，前端不自己猜）。
 *
 * 本模块只做「读模型 → 文案/清单」这一件事，两处外壳共用同一份判据与同一份清单：
 *   - `ProjectSection`（首页的区块，带标题与刷新钮）；
 *   - `ProjectSwitcher`（工作台顶栏的上下文控件，见 layout/ProjectSwitcher.tsx）。
 */

/** 上下文条/控件上的短标签 + 悬停说明。 */
export function projectLabelOf(view: SessionView): { label: string; title: string } {
	if (view.projectsError) {
		return { label: "读取失败", title: `Project registry 读不出来：${view.projectsError}` };
	}
	// 归属还没算出来（切会话后的窗口期 / 还没读过）：不能拿「未归属」代替一个尚未计算的结果。
	if (view.projectsPending || view.projects === undefined) {
		return { label: "…", title: "Project 归属读取中" };
	}
	const current = view.currentProjectId
		? view.projects.find(project => project.projectId === view.currentProjectId)
		: undefined;
	if (current) return { label: current.name, title: `${current.name} · ${current.root}` };
	if (view.projects.length === 0) {
		return { label: "未声明", title: "还没有声明任何 Project（~/.cornfield/agent/projects.json）" };
	}
	return {
		label: "未归属",
		title: `已声明 ${view.projects.length} 个 Project，当前会话不在其中任何一个里`,
	};
}

/** 一个已声明 Project 的一行（名称 + 当前标记 + 默认 Agent + root）。 */
function ProjectRow({ project, current }: { project: ProjectRecordDto; current: boolean }): React.JSX.Element {
	return (
		<div className="flex items-baseline gap-2 border-b border-hairline px-1 py-1.5 last:border-b-0">
			<span className="shrink-0 text-[12.5px] text-ink">{project.name}</span>
			{current && (
				<span className="badge done shrink-0" title="当前会话所在的 Project">
					当前
				</span>
			)}
			{project.defaultAgentId && (
				<span className="badge shrink-0" title="该 Project 的默认 Agent（§10 解析链第 2 级）">
					{project.defaultAgentId}
				</span>
			)}
			<span
				className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-ink-faint"
				title={project.root}
			>
				{project.root}
			</span>
		</div>
	);
}

/**
 * 已声明 Project 的清单块（列表 / 空态 / 读取中 / 错误态 / 未连接）—— 两块外壳共用。
 * 这里是只读读数：清单行不是可点的（见 ProjectSwitcher 的说明）。
 */
export function ProjectList({ view }: { view: SessionView }): React.JSX.Element {
	if (!view.connected) {
		return <p className="text-[12.5px] text-ink-faint">未连接——Project registry 不可用</p>;
	}

	if (view.projectsError) {
		return (
			<div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
				Project 读取失败：{view.projectsError}
				<span className="mt-0.5 block text-[11px] text-ink-subtle">
					读不到和「没声明过」不是一回事，这里不显示空态。
				</span>
			</div>
		);
	}

	if (view.projects === undefined) {
		return <p className="text-[12.5px] text-ink-faint">读取中…</p>;
	}

	if (view.projects.length === 0) {
		return (
			<p className="text-[12.5px] text-ink-faint">
				未声明任何 Project。声明文件：
				<span className="font-mono text-[11px]">~/.cornfield/agent/projects.json</span>
			</p>
		);
	}

	return (
		<div className="rounded-lg border border-hairline bg-surface-2 px-2 py-1">
			{view.projects.map(project => (
				<ProjectRow
					key={project.projectId}
					project={project}
					current={project.projectId === view.currentProjectId}
				/>
			))}
		</div>
	);
}

/**
 * 已声明 Project 的区块（首页用）：标题 + 刷新钮 + 清单。
 * `onRefresh` 缺省时不显示刷新钮（调用方没有重读入口时不要给一个点了没反应的按钮）。
 */
export function ProjectSection({ view, onRefresh }: { view: SessionView; onRefresh?: () => void }): React.JSX.Element {
	return (
		<section className="w-full rounded-xl border border-hairline bg-surface p-4">
			<div className="mb-2 flex items-center gap-2">
				<span className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">项目</span>
				<span className="flex-1" />
				{onRefresh && (
					<button
						type="button"
						className="cbtn"
						onClick={onRefresh}
						aria-label="刷新项目列表"
						title="刷新项目列表"
					>
						<RefreshCw size={13} strokeWidth={1.5} />
					</button>
				)}
			</div>
			<ProjectList view={view} />
		</section>
	);
}
