import { Outlet, useMatches } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { MobileNav } from "./MobileNav";
import { activePanelOf } from "./panel-registry";

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
 */
export function AppShell(): React.JSX.Element {
	const panel = activePanelOf(useMatches());

	return (
		<div className="flex h-full">
			<a href="#main" className="skip-link">
				跳到主要内容
			</a>
			<AppSidebar />
			<MobileNav />
			<div className="flex min-w-0 flex-1 flex-col">
				{!panel?.customTopbar && <AppTopbar panel={panel} />}
				<main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
