import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { RouteObject } from "react-router-dom";

/**
 * PanelDef —— 应用导航与路由的**唯一元数据源**。
 *
 * 一个面板 = 侧栏一项 + 一条路由 + 一件外壳（通用顶栏 or 自带顶栏）。这三件事过去
 * 各有一份表（panelRegistry / router 的 PAGE_META / createHashRouter 的 children），
 * 加一个页面要改三处、漏一处不报错只表现错（面包屑落在 Home、子路由命中父面板的顶栏、
 * 侧栏有而路由没有）。现在只有这一份：
 *   - AppSidebar 由 getPanelGroups() 渲染（组标题 + 组内条目，都是这里声明的事实）；
 *   - router.tsx 由 getPanels() 派生路由（path / element / children 同源）；
 *   - AppShell 由路由匹配链上的 handle（panelHandle）解析当前面板，取 title / customTopbar。
 */

/**
 * 侧栏分组 id —— 分组名与顺序见 PANEL_GROUPS（唯一一份）。
 *
 * 这里不再是「primary/bottom」那种与页面无关的布局槽位：分组本身就是导航的一部分，
 * 一个面板属于哪个组是它的导航事实，不是侧栏的排版细节。
 */
export type PanelGroupId = "work" | "agent" | "capability" | "system";

/** 一个侧栏分组：id + 组标题（标题文本就是屏幕上的那行字，也是测试断言的锚点）。 */
export interface PanelGroupDef {
	id: PanelGroupId;
	title: string;
}

/**
 * 侧栏的四个组，**数组顺序即渲染顺序**（对齐 docs/proma-comparison/mock.html 的
 * 「工作 / Agent / 能力 / 系统」四段）。加一个组 = 这里加一项，否则 getPanelGroups() 会抛。
 */
export const PANEL_GROUPS: readonly PanelGroupDef[] = [
	{ id: "work", title: "工作" },
	{ id: "agent", title: "Agent" },
	{ id: "capability", title: "能力" },
	{ id: "system", title: "系统" },
];

export interface PanelDef {
	/** panel 唯一标识 */
	id: string;
	/** 显示标题：侧栏 label、通用顶栏的「当前位置」都用它，不另设 name / breadcrumb */
	title: string;
	/** Lucide 图标组件 */
	icon: LucideIcon;
	/** badge 计数（null 表示不显示） */
	badge?: () => number | null;
	/** 侧栏分组（组顺序见 PANEL_GROUPS） */
	group: PanelGroupId;
	/** 组内排序（1 起） */
	order: number;
	/** 路由路径（用于深链和 history） */
	path: string;
	/** 挂载函数，返回 panel 组件（router 用它建 element —— 面板是路由的所有者） */
	mount: () => ComponentType;
	/**
	 * 面板自带顶栏：true 时 AppShell 不渲染通用顶栏，那一行由面板自己负责。
	 *
	 * 现状只有会话工作台为 true —— 它的顶栏是工作台自己的上下文条与操作区（新会话 /
	 * compact / 右栏 / 手机预览），不是导航，不该出现在别的页面上，也不该被别的页面继承。
	 */
	customTopbar?: boolean;
	/**
	 * 面板自带的路由片段（子工作区），按相对路径解析。
	 * 例：模型控制中心的目录 / Provider / 运行时配置三个子工作区。
	 */
	children?: RouteObject[];
}

/** 全局 panel 注册表 */
export const panelRegistry = new Map<string, PanelDef>();

/** 注册 panel */
export function registerPanel(def: PanelDef): void {
	panelRegistry.set(def.id, def);
}

/** 获取单个 panel 定义 */
export function getPanel(id: string): PanelDef | undefined {
	return panelRegistry.get(id);
}

/** 取面板定义；未注册时抛错（调用方要的是「一定存在的面板」时用它） */
export function requirePanel(id: string): PanelDef {
	const def = panelRegistry.get(id);
	if (!def) throw new Error(`panel 未注册：${id}`);
	return def;
}

/** 分组在侧栏里的次序；未声明的分组返回 -1（调用方负责把它当错）。 */
function groupRank(id: PanelGroupId): number {
	return PANEL_GROUPS.findIndex(group => group.id === id);
}

/** 获取所有已注册 panel（按分组顺序 + 组内 order 排序） */
export function getPanels(): PanelDef[] {
	return Array.from(panelRegistry.values()).sort((a, b) => {
		const rank = groupRank(a.group) - groupRank(b.group);
		return rank !== 0 ? rank : a.order - b.order;
	});
}

/** 一个分组 + 它的条目（已按组内 order 排好）。 */
export interface PanelGroupView extends PanelGroupDef {
	panels: PanelDef[];
}

/**
 * 侧栏渲染要的全部事实：四个组（含空组）与各自的条目。
 *
 * 空组照样返回（AppSidebar 只是不画条目）——「这个组现在没有页面」与「这个组不存在」不是一回事。
 * 反过来，注册了 PANEL_GROUPS 里没有的分组**直接抛**：那种面板会从侧栏悄悄消失，
 * 而侧栏少一项是没人会收到报错的错误。
 */
export function getPanelGroups(): PanelGroupView[] {
	const views: PanelGroupView[] = PANEL_GROUPS.map(group => ({ ...group, panels: [] }));
	for (const panel of getPanels()) {
		const view = views.find(item => item.id === panel.group);
		if (!view) throw new Error(`panel ${panel.id} 的分组未在 PANEL_GROUPS 里声明：${panel.group}`);
		view.panels.push(panel);
	}
	return views;
}

/** 路由 handle：声明这条路由（及其子路由）穿哪个面板的外壳。 */
export interface PanelHandle {
	panel: string;
}

/**
 * 构造路由 handle。
 *
 * 面板 id 不认识就在这里抛 —— 建表期（模块求值）失败，比运行期悄悄少一件外壳好查。
 */
export function panelHandle(id: string): PanelHandle {
	requirePanel(id);
	return { panel: id };
}

/**
 * 从 react-router 的匹配链解析当前面板：**最深的带 handle.panel 的一层**。
 *
 * 深链与刷新走同一条路，不按 pathname 前缀猜：
 *   - `/models/catalog` 的匹配链是 [AppShell, /models, catalog]，只有 /models 带 handle，
 *     于是当前位置落在「模型控制中心」而不是根；
 *   - `/records/abc` 这类参数子路由不在磁盘上挨着 /records 的视图，就在自己的路由上
 *     声明它属于 /records 面板（见 router.tsx 的 EXTRA_ROUTES）。
 *
 * 没人认领的路径（如 `/nope`）返回 undefined：外壳不带标题，内容区由 router.tsx 的
 * 兜底路由渲染「未找到这个位置」。
 */
export function activePanelOf(matches: readonly { handle?: unknown }[]): PanelDef | undefined {
	for (let i = matches.length - 1; i >= 0; i -= 1) {
		const id = panelIdOfHandle(matches[i]?.handle);
		if (id === undefined) continue;
		const def = panelRegistry.get(id);
		if (def) return def;
	}
	return undefined;
}

/** handle 是路由上的 unknown 载荷：取 panel 字段前必须收窄（非对象 / 字段不是 string 都要挡住）。 */
function panelIdOfHandle(handle: unknown): string | undefined {
	if (typeof handle !== "object" || handle === null) return undefined;
	const panel = (handle as { panel?: unknown }).panel;
	return typeof panel === "string" ? panel : undefined;
}
