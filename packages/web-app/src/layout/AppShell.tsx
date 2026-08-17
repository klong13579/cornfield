import { Outlet, useLocation } from "react-router-dom";
import { findPageMeta } from "../router";
import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { DevicePreview } from "./DevicePreview";

/**
 * 应用壳：56px 图标侧栏 + 顶栏 + 页面出口 + 手机预览。
 * workspace 自带顶栏（conn/项目/操作），meta.customTopbar 时跳过通用顶栏。
 */
export function AppShell(): React.JSX.Element {
	const { pathname } = useLocation();
	const meta = findPageMeta(pathname);

	return (
		<div className="flex h-full">
			<AppSidebar />
			<div className="flex min-w-0 flex-1 flex-col">
				{!meta?.customTopbar && <AppTopbar meta={meta} />}
				<main className="min-h-0 flex-1 overflow-y-auto">
					<Outlet />
				</main>
			</div>
			<DevicePreview />
		</div>
	);
}
