import { FolderTree, RefreshCw } from "lucide-react";
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
 */

/** 上下文条用的短标签 + 悬停说明。 */
export function projectLabelOf(view: SessionView): { label: string; title: string } {
	if (view.projectsError) {
		return { label: "读取失败", title: `Project registry 读不出来：${view.projectsError}` };
	}
	if (view.projects === undefined) {
		return { label: "…", title: "Project registry 读取中" };
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

/** 上下文条里的一格（与 Agent / 工作区 / 会话同排）。 */
export function ProjectCell({ view }: { view: SessionView }): React.JSX.Element {
	const { label, title } = projectLabelOf(view);
	return (
		<span className="chip" title={title}>
			<FolderTree size={13} strokeWidth={1.5} />
			<b>{label}</b>
		</span>
	);
}

/** 一个已声明 Project 的一行（名称 + 默认 Agent + root）。 */
function ProjectRow({ project }: { project: ProjectRecordDto }): React.JSX.Element {
	return (
		<div className="flex items-baseline gap-2 border-b border-hairline px-1 py-1.5 last:border-b-0">
			<span className="shrink-0 text-[12.5px] text-ink">{project.name}</span>
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
 * 已声明 Project 的列表块（列表 / 空态 / 错误态）。
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

			{!view.connected && <p className="text-[12.5px] text-ink-faint">未连接——Project registry 不可用</p>}

			{view.connected && view.projectsError && (
				<div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
					Project 读取失败：{view.projectsError}
					<span className="mt-0.5 block text-[11px] text-ink-subtle">
						读不到和「没声明过」不是一回事，这里不显示空态。
					</span>
				</div>
			)}

			{view.connected && !view.projectsError && view.projects === undefined && (
				<p className="text-[12.5px] text-ink-faint">读取中…</p>
			)}

			{view.connected && !view.projectsError && view.projects?.length === 0 && (
				<p className="text-[12.5px] text-ink-faint">
					未声明任何 Project。声明文件：
					<span className="font-mono text-[11px]">~/.cornfield/agent/projects.json</span>
				</p>
			)}

			{view.connected && !view.projectsError && view.projects && view.projects.length > 0 && (
				<div className="rounded-lg border border-hairline bg-surface-2 px-2 py-1">
					{view.projects.map(project => (
						<ProjectRow key={project.projectId} project={project} />
					))}
				</div>
			)}
		</section>
	);
}
