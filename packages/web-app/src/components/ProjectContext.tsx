import { RefreshCw } from "lucide-react";
import type { ProjectRecordDto } from "../lib/pi-client-api";
import {
	attributionTextOf,
	projectRegistryState,
	sessionAttributionOf,
	workingProjectOf,
} from "../lib/project-read-model";
import type { SessionView } from "../state/session-store";

/**
 * Project 上下文的读数与清单（T8 / T28）—— 客户端级 Project registry
 * （`~/.cornfield/agent/projects.json`，WP4）的真实读数。
 *
 * 「关于 Project 我们知道什么」的判据只有一份，在 `lib/project-read-model`；本模块只把那些
 * 状态画成人能读的句子与清单。三件不同的事在任何地方都不许折叠成一件：
 *   - **读不到**（未连接 / 存储损坏）：不知道，不显示「未声明」；
 *   - **未声明**：读到了空列表，是明确的事实；
 *   - **未归属 / 不指定**：同一个形状的两种事实 —— 「这个会话没有归属」（serve 说的）与
 *     「我还没选工作上下文」（本地选择），前者在 `ProjectAttributionNote` 里，后者是 chip 本身。
 *
 * 两个外壳共用同一份判据与同一份清单：
 *   - `ProjectSection`（首页的区块，带标题与刷新钮）；
 *   - `ProjectSwitcher`（工作台顶栏的工作上下文选择器，见 layout/ProjectSwitcher.tsx）。
 */

/**
 * 当前**会话**的归属读数 —— 与 chip 上那个「工作上下文」是两件事，所以单独一行说。
 *
 * 来源一并说出来（会话记下的 / 按目录算出的）：两者的可信度不同，用户要据此判断这个归属
 * 靠不靠得住。不知道就说不知道，不拿「未归属」顶。
 */
export function ProjectAttributionNote({ view }: { view: SessionView }): React.JSX.Element {
	const text = attributionTextOf(sessionAttributionOf(view));
	return (
		<div className="mb-2 border-b border-hairline pb-2 text-[11.5px] text-ink-subtle">
			<div className="flex items-baseline gap-1.5">
				<span className="shrink-0 text-ink-faint">当前会话</span>
				<span className="min-w-0 flex-1 truncate text-ink-muted" title={text.title}>
					{text.label}
				</span>
			</div>
			<div className="mt-0.5 text-[11px] text-ink-faint">{text.detail}</div>
		</div>
	);
}

/** 一个已声明 Project 的一行（名称 + 当前/工作标记 + 默认 Agent + root）。 */
function ProjectRow({
	project,
	current,
	working,
}: {
	project: ProjectRecordDto;
	current: boolean;
	working: boolean;
}): React.JSX.Element {
	return (
		<div className="flex items-baseline gap-2 border-b border-hairline px-1 py-1.5 last:border-b-0">
			<span className="shrink-0 text-[12.5px] text-ink">{project.name}</span>
			{working && (
				<span className="badge done shrink-0" title="工作上下文：下一个新会话落在这个 Project 的根上">
					工作
				</span>
			)}
			{current && (
				<span className="badge shrink-0" title="当前会话记录的归属（serve 的读数）">
					当前会话
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
 * 这里是只读读数：清单行不是可点的（选择在 ProjectSwitcher 的选择器里）。
 */
export function ProjectList({ view }: { view: SessionView }): React.JSX.Element {
	const registry = projectRegistryState(view);
	const working = workingProjectOf(view);
	// 判不出工作上下文时（还没读到 / 没选）不打标记：一个打到别处的标记比没有标记更坏。
	const workingId = working.kind === "set" ? working.projectId : undefined;

	if (registry.kind === "disconnected") {
		return <p className="text-[12.5px] text-ink-faint">未连接——Project registry 不可用</p>;
	}

	if (registry.kind === "error") {
		return (
			<div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
				Project 读取失败：{registry.message}
				<span className="mt-0.5 block text-[11px] text-ink-subtle">
					读不到和「没声明过」不是一回事，这里不显示空态。
				</span>
			</div>
		);
	}

	if (registry.kind === "unread") {
		return <p className="text-[12.5px] text-ink-faint">读取中…</p>;
	}

	if (registry.kind === "empty") {
		return (
			<p className="text-[12.5px] text-ink-faint">
				未声明任何 Project。声明文件：
				<span className="font-mono text-[11px]">~/.cornfield/agent/projects.json</span>
			</p>
		);
	}

	return (
		<div className="rounded-lg border border-hairline bg-surface-2 px-2 py-1">
			{registry.projects.map(project => (
				<ProjectRow
					key={project.projectId}
					project={project}
					current={project.projectId === view.currentProjectId}
					working={project.projectId === workingId}
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
