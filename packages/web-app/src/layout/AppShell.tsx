import { Outlet, useMatches } from "react-router-dom";
import type { PaneId } from "../lib/pane-resize";
import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { MobileNav } from "./MobileNav";
import { PaneDivider } from "./PaneDivider";
import { activePanelOf } from "./panel-registry";
import { usePaneLayout } from "./use-pane-layout";

/** 外壳里可拖的栏。模块级常量：分栏集合是外壳的形状，不是每次渲染算出来的东西。 */
const SHELL_PANES: readonly PaneId[] = ["appSidebar"];

/**
 * 应用壳：侧栏 + 顶栏 + 内容出口。
 *
 * 当前面板从**路由匹配链**解析（activePanelOf 取最深一层带 handle.panel 的路由），
 * 不按 pathname 前缀猜：深链、刷新、参数子路由走同一条路，也就不会出现
 * 「/records/abc 落在 Home」「/models/catalog 换了另一件顶栏」这类猜错的壳。
 * 自带顶栏的面板（customTopbar）由它自己渲染那一行。
 *
 * 内容区直接是 router 的 Outlet —— 面板就是路由，路由表由注册表派生（router.tsx），
 * 所以这里不再需要「按路径找组件」的中间层。
 *
 * 主导航这一栏可拖（`usePaneLayout`）：容器给出宽度变量，导航栏自己取用，中间夹一条分隔条。
 * 内容列保持 `min-w-0` 不设下限 —— 窗口不够时先紧内容，这也是改之前的行为。
 */
export function AppShell(): React.JSX.Element {
	const panel = activePanelOf(useMatches());
	const layout = usePaneLayout(SHELL_PANES);

	return (
		<div className="flex h-full" ref={layout.containerRef} style={layout.containerStyle}>
			<a href="#main" className="skip-link">
				跳到主要内容
			</a>
			<AppSidebar elementRef={layout.paneRef("appSidebar")} />
			{/* md 以下导航栏是隐藏的（不是分栏），分隔条跟着一起藏 */}
			<PaneDivider axis="vertical" edge="before" target={layout.target("appSidebar")} className="hidden md:block" />
			<MobileNav />
			<div className="flex min-w-0 flex-1 flex-col" ref={layout.contentRef}>
				{!panel?.customTopbar && <AppTopbar panel={panel} />}
				<main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
