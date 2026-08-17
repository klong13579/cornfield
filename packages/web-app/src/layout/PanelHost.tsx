import { useLocation } from "react-router-dom";
import { findPanelByPath } from "./panel-registry";

/**
 * PanelHost — 根据当前路由渲染对应的 panel。
 * 从 panelRegistry 中查找匹配当前路径的 panel，渲染其 mount() 返回的组件。
 * 无匹配时渲染空状态。
 */
export function PanelHost(): React.JSX.Element {
	const { pathname } = useLocation();

	const panel = findPanelByPath(pathname);
	if (!panel) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-center text-[13px] text-ink-faint">未找到 panel：{pathname}</div>
			</div>
		);
	}

	const PanelComponent = panel.mount();
	return <PanelComponent />;
}