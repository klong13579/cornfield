import { NavLink } from "react-router-dom";
import { PAGE_META } from "../router";

/** 56px 图标侧栏 —— 由 PAGE_META 驱动（加页面 = meta 数组加一项）。 */
export function AppSidebar(): React.JSX.Element {
	const primary = PAGE_META.filter(p => p.group === "primary").sort((a, b) => a.order - b.order);
	const bottom = PAGE_META.filter(p => p.group === "bottom").sort((a, b) => a.order - b.order);

	return (
		<nav className="hidden w-[60px] shrink-0 flex-col items-center gap-1 border-r border-hairline bg-surface py-3.5 md:flex">
			{primary.map(p => (
				<NavLink
					key={p.id}
					to={p.path}
					end={p.path === "/"}
					title={p.name}
					aria-label={p.name}
					className="nav-item"
				>
					<p.icon size={18} strokeWidth={1.5} />
				</NavLink>
			))}
			<div className="flex-1" />
			{bottom.map(p => (
				<NavLink key={p.id} to={p.path} title={p.name} aria-label={p.name} className="nav-item">
					<p.icon size={18} strokeWidth={1.5} />
				</NavLink>
			))}
		</nav>
	);
}
