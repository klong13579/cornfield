import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * PanelDef — M1 注册表接口（主线已定义，W1 消费）。
 * 每个 panel 注册进 panelRegistry（Map<id, PanelDef>），PanelHost 按 rail 选中渲染。
 */
export interface PanelDef {
	/** panel 唯一标识 */
	id: string;
	/** 显示标题 */
	title: string;
	/** Lucide 图标组件 */
	icon: LucideIcon;
	/** badge 计数（null 表示不显示） */
	badge?: () => number | null;
	/** 导航分组：primary（主功能）或 bottom（底部） */
	group: "primary" | "bottom";
	/** 同组内排序（1 起） */
	order: number;
	/** 路由路径（用于深链和 history） */
	path: string;
	/** 挂载函数，返回 panel 组件 */
	mount: () => ComponentType;
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

/** 获取所有已注册 panel（按 group + order 排序） */
export function getPanels(): PanelDef[] {
	return Array.from(panelRegistry.values()).sort((a, b) => {
		if (a.group !== b.group) {
			return a.group === "primary" ? -1 : 1;
		}
		return a.order - b.order;
	});
}

/** 根据路径精确查找对应的 panel（不向前缀匹配；子路由由 PanelHost 回退到 Outlet） */
export function findPanelByPath(path: string): PanelDef | undefined {
	return Array.from(panelRegistry.values()).find(p => p.path === path);
}
