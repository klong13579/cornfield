import { NavLink } from "react-router-dom";
import { getPanels } from "./panel-registry";

/** 56px 图标侧栏 —— 由 panel 注册表驱动（加 panel = 注册表加一项）。 */
export function AppSidebar(): React.JSX.Element {
	const panels = getPanels();
	const primary = panels.filter(p => p.group === "primary");
	const bottom = panels.filter(p => p.group === "bottom");

	return (
		<nav className="hidden w-[60px] shrink-0 flex-col items-center gap-1 border-r border-hairline bg-surface py-3.5 md:flex">
			{primary.map(p => (
				<NavLink
					key={p.id}
					to={p.path}
					end={p.path === "/"}
					title={p.title}
					aria-label={p.title}
					className="nav-item"
				>
					<p.icon size={18} strokeWidth={1.5} />
				</NavLink>
			))}
			<div className="flex-1" />
			{bottom.map(p => (
				<NavLink key={p.id} to={p.path} title={p.title} aria-label={p.title} className="nav-item">
					<p.icon size={18} strokeWidth={1.5} />
				</NavLink>
			))}
		</nav>
	);
}
