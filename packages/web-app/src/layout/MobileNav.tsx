import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionView } from "../state/session-store";
import { useSession } from "../state/use-session";
import { SidebarAgentContext, SidebarNav } from "./AppSidebar";
import { getPanelGroups } from "./panel-registry";

/**
 * 窄屏主导航 —— 桌面侧栏（240px）在 <md 断点下 `display:none`，这一件是它在窄屏的入口：
 * 右上角一个固定汉堡钮，点开一个从左侧滑出的抽屉，里面画的是**同一份**导航
 * （SidebarAgentContext + SidebarNav，都来自注册表 getPanelGroups()），不是另抄一张面板表。
 *
 * 与工作台会话抽屉（SessionSidebar，<lg 从左侧滑出）刻意分开：
 *   - 入口位不同（本件右上角，会话抽屉的 Menu 在工作台顶栏左上角），不互相遮挡；
 *   - 状态独立（本件自持 useState，不复用 ui.mobileNavOpen——那是会话抽屉的开关）；
 *   - 层级独立（入口钮 z-modal、遮罩 z-drawer、抽屉 z-modal，都在会话抽屉的 aside z-50 / 遮罩 z-menu(60) / 右栏 z-drawer(70) 之上；入口钮再高一层保证会话抽屉展开、右栏滑入时也不被盖住）。
 *
 * 键盘：入口是原生 <button>（Tab 到、Enter/Space 开），抽屉里的导航链接也是原生 <a>，
 * Escape 关闭；未连接态入口照样可用（抽屉里的「当前 Agent」会如实说「未连接」）。
 */

/**
 * 受控、无 hook 的面板：入口钮 + （展开时）遮罩 + 抽屉。状态由壳持有，单测直接调用即可。
 */
export function MobileNavPanel({
	view,
	open,
	onToggle,
	onClose,
}: {
	view: SessionView;
	open: boolean;
	onToggle: () => void;
	onClose: () => void;
}): React.JSX.Element {
	return (
		<>
			<button
				type="button"
				className="fixed top-0 right-0 z-modal flex h-12 w-12 items-center justify-center border-b border-l border-hairline bg-surface text-ink transition-colors hover:bg-surface-2 md:hidden"
				onClick={onToggle}
				aria-label="打开主导航"
				aria-expanded={open}
				aria-controls="mobile-nav"
				title="打开主导航"
			>
				<Menu size={18} strokeWidth={1.5} />
			</button>
			{open && (
				<>
					<div aria-hidden className="fixed inset-0 z-drawer bg-ink/30 md:hidden" onClick={onClose} />
					<nav
						id="mobile-nav"
						aria-label="主导航"
						className="fixed inset-y-0 left-0 z-modal flex w-[280px] flex-col overflow-y-auto border-r border-hairline bg-surface px-3.5 py-3.5 md:hidden"
					>
						<div className="flex items-center justify-between px-2 pb-5 pt-3">
							<span className="text-xl font-extrabold tracking-tight text-ink">cornfield</span>
							<button
								type="button"
								className="icon-btn"
								onClick={onClose}
								aria-label="关闭主导航"
								title="关闭主导航"
							>
								<X size={16} strokeWidth={1.5} />
							</button>
						</div>
						<SidebarAgentContext view={view} />
						<SidebarNav groups={getPanelGroups()} onNavigate={onClose} />
					</nav>
				</>
			)}
		</>
	);
}

/** 状态壳：持开合态 + Escape 关闭，并把会话视图接给无 hook 的面板。 */
export function MobileNav(): React.JSX.Element {
	const view = useSession();
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	return <MobileNavPanel view={view} open={open} onToggle={() => setOpen(o => !o)} onClose={() => setOpen(false)} />;
}
