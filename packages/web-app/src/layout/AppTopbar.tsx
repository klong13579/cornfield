import type { PageMeta } from "../router";

/** 通用顶栏：面包屑 + 右侧页级操作区（workspace 走 customTopbar 自带顶栏）。 */
export function AppTopbar({ meta }: { meta?: PageMeta }): React.JSX.Element {
	return (
		<header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-surface px-5">
			<div className="text-[13px] text-ink-subtle">
				CornField 多端前端 <span className="text-ink">{meta?.name ?? ""}</span>
			</div>
		</header>
	);
}
