import { useLocation, useOutlet } from "react-router-dom";
import { findPanelByPath } from "./panel-registry";

/**
 * PanelHost — AppShell 的 panel 渲染宿主。
 *
 * - 顶层 panel 路径（如 `/workspace`、`/agents`）→ 从 panelRegistry 精确匹配并渲染 mount() 组件。
 * - 带参子路由（如 `/records/:id`）→ 回退到 react-router 的 Outlet，由 route config 渲染子页面。
 */
export function PanelHost(): React.JSX.Element {
	const { pathname } = useLocation();
	const outlet = useOutlet();

	const panel = findPanelByPath(pathname);
	if (!panel) {
		return <>{outlet ?? <NotFound pathname={pathname} />}</>;
	}

	const PanelComponent = panel.mount();
	return <PanelComponent />;
}

function NotFound({ pathname }: { pathname: string }): React.JSX.Element {
	return (
		<div className="flex h-full items-center justify-center">
			<div className="text-center text-[13px] text-ink-faint">未找到 panel：{pathname}</div>
		</div>
	);
}
