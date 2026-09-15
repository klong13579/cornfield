import type { PanelDef } from "./panel-registry";

/** 通用顶栏：当前位置（面板标题）+ 右侧页级操作区（自带顶栏的面板不走这里）。 */
export function AppTopbar({ panel }: { panel?: PanelDef }): React.JSX.Element {
	return (
		<header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-surface px-5">
			<div className="text-[13px] text-ink-subtle">
				CornField 多端前端 <span className="text-ink">{panel?.title ?? ""}</span>
			</div>
		</header>
	);
}
