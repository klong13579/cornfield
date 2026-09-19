import { NavLink } from "react-router-dom";
import { projectLabelOf } from "../lib/project-read-model";
import { activeAgentOf } from "../state/agent-context";
import type { SessionView } from "../state/session-store";
import { useSession } from "../state/use-session";
import { getPanelGroups, type PanelGroupView } from "./panel-registry";

/**
 * 左侧导航（桌面默认 240px，可拖）—— 由 panel 注册表驱动，按分组分段渲染：
 * 顶部是「我是谁」（logo + 当前 Agent + 工作上下文），下面是四个组（组标题 + 组内条目）。
 *
 * 分组与组内顺序都不是这份组件的事：它们是注册表的元数据（PANEL_GROUPS / group / order），
 * 这个文件只负责把那份事实画出来 —— 加一个面板 = router.tsx 加一项，这里一个字都不用改。
 *
 * 宽度不是这份组件的事：`md:w-[var(--pane-appSidebar-width)]` 取自外壳的分栏容器
 * （`usePaneLayout`），拖拽时也是同一个变量在动。`min-w` 一起给，窄窗口下它才肯让位。
 * `elementRef` 交出去是为了量可见宽度 —— 被容器收紧过的是屏幕上那个尺寸，不是偏好值。
 */
export function AppSidebar({ elementRef }: { elementRef?: React.Ref<HTMLElement> } = {}): React.JSX.Element {
	const view = useSession();

	return (
		<nav
			ref={elementRef}
			aria-label="主导航"
			className="hidden w-[240px] flex-col overflow-y-auto border-r border-hairline bg-surface px-3.5 py-3.5 md:flex md:min-w-[var(--pane-appSidebar-min)] md:w-[var(--pane-appSidebar-width)]"
		>
			<div className="px-2 pb-5 pt-3 text-xl font-extrabold tracking-tight text-ink">cornfield</div>
			<SidebarAgentContext view={view} />
			<SidebarNav groups={getPanelGroups()} />
		</nav>
	);
}

/**
 * 「当前 Agent」块：现在是谁在服务本连接，以及工作的上下文落在哪。**只展示，不切换** ——
 * 切换是 attach + switch_session 一起做的事（store.focusAgent），入口在顶栏的 AgentSwitcher；
 * 在侧栏再放一个切换控件，就会有第二个地方对「屏幕上写着谁」给答案。
 *
 * 名字一行取应用现有的焦点 Agent（agent-context 的解析，与工作台 / 右栏 / 首页同源）。
 * 提示一行说**工作上下文**（下次新会话落在哪），与顶栏的 Project chip 用同一份读模型
 * （project-read-model 的 projectLabelOf），于是「未连接 / 读取中 / 未声明 / 不指定」这些
 * 说法在两处不会各写一套。没有焦点 Agent 时按 mock 的文案说「先选择 Agent」。
 *
 * 独立导出是为了能直接拿一份假视图渲染它 —— 它读的事实都在参数里，没有自己的状态。
 */
export function SidebarAgentContext({ view }: { view: SessionView }): React.JSX.Element {
	const agent = activeAgentOf(view);
	const context = projectLabelOf(view);
	// 「先选择 Agent」只在**连上了、确实还没得选**的时候说：没连接时一个都选不了，
	// 那时候要说的是没连上（与 AgentSwitcher 的四态同一个纪律）。
	const hint = agent !== undefined ? context.label : view.connected ? "先选择 Agent" : "未连接";

	return (
		<div className="mb-3.5 rounded-lg border border-hairline bg-surface-2 px-3.5 py-3">
			<div className="text-3xs uppercase tracking-[0.12em] text-ink-faint">当前 Agent</div>
			<div className="mt-1.5 truncate font-medium text-ink" title={agent?.agentDir ?? agent?.id}>
				{agent?.name ?? "未选择 Agent"}
			</div>
			<div className="mt-0.5 truncate text-2xs text-ink-subtle" title={context.title}>
				{hint}
			</div>
		</div>
	);
}

/**
 * 分组导航：每个组一个 <h2> 组标题 + 一组 NavLink。
 *
 * 组标题用真正的小标题元素（而不是 div）：它是这一段的标题，也是「侧栏有哪几组」这个事实
 * 在渲染层唯一的落点 —— 断言的锚点因此是文本本身，不是某个 class 名。
 */
export function SidebarNav({
	groups,
	onNavigate,
}: {
	groups: PanelGroupView[];
	/** 每条导航链接被点中后（导航已发起）再收尾的动作，例如窄屏抽屉关闭。 */
	onNavigate?: () => void;
}): React.JSX.Element {
	return (
		<>
			{groups.map(group => (
				<section key={group.id} className="mb-3.5">
					<h2 className="mx-2 mb-1.5 text-3xs font-medium uppercase tracking-[0.12em] text-ink-faint">
						{group.title}
					</h2>
					<div className="grid gap-[3px]">
						{group.panels.map(panel => (
							<NavLink
								key={panel.id}
								to={panel.path}
								end={panel.path === "/"}
								title={panel.title}
								aria-label={panel.title}
								className="sidebar-item"
								onClick={onNavigate}
							>
								<panel.icon size={15} strokeWidth={1.5} />
								<span className="truncate">{panel.title}</span>
							</NavLink>
						))}
					</div>
				</section>
			))}
		</>
	);
}
