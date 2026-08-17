import {
	Bot,
	Clock,
	Cpu,
	House,
	ListChecks,
	type LucideIcon,
	MessagesSquare,
	Mic,
	SlidersHorizontal,
} from "lucide-react";
import { createBrowserRouter } from "react-router-dom";
import { AppShell } from "./layout/AppShell";
import { registerPanel } from "./layout/panel-registry";
import { AgentsView } from "./pages/agents/AgentsView";
import { HomeView } from "./pages/home/HomeView";
import { ModelsView } from "./pages/models/ModelsView";
import { PlaybackView } from "./pages/records/PlaybackView";
import { RecordsView } from "./pages/records/RecordsView";
import { SettingsView } from "./pages/settings/SettingsView";
import { TodoView } from "./pages/todo/TodoView";
import { VoiceView } from "./pages/voice/VoiceView";
import { WorkspaceView } from "./pages/workspace/WorkspaceView";

// ── Panel 注册 ────────────────────────────────────────────────────────
// 每个 panel 注册进全局注册表；AppSidebar 从注册表渲染导航，
// 路由定义也从注册表生成（保持单源真理）。

/** 注册所有 panel */
function registerAllPanels(): void {
	registerPanel({
		id: "home",
		title: "Home",
		icon: House,
		group: "primary",
		order: 1,
		path: "/",
		mount: () => HomeView,
	});

	registerPanel({
		id: "workspace",
		title: "会话工作台",
		icon: MessagesSquare,
		group: "primary",
		order: 2,
		path: "/workspace",
		mount: () => WorkspaceView,
	});

	registerPanel({
		id: "agents",
		title: "Agent 管理",
		icon: Bot,
		group: "primary",
		order: 3,
		path: "/agents",
		mount: () => AgentsView,
	});

	registerPanel({
		id: "records",
		title: "会话记录",
		icon: Clock,
		group: "primary",
		order: 4,
		path: "/records",
		mount: () => RecordsView,
	});

	registerPanel({
		id: "voice",
		title: "语音",
		icon: Mic,
		group: "primary",
		order: 5,
		path: "/voice",
		mount: () => VoiceView,
	});

	registerPanel({
		id: "todo",
		title: "Todo 面板",
		icon: ListChecks,
		group: "primary",
		order: 6,
		path: "/todo",
		mount: () => TodoView,
	});

	registerPanel({
		id: "models",
		title: "模型市场",
		icon: Cpu,
		group: "primary",
		order: 7,
		path: "/models",
		mount: () => ModelsView,
	});

	registerPanel({
		id: "settings",
		title: "设置",
		icon: SlidersHorizontal,
		group: "bottom",
		order: 1,
		path: "/settings",
		mount: () => SettingsView,
	});
}

registerAllPanels();

// ── 兼容导出：PageMeta / PAGE_META / findPageMeta ─────────────────────
// 下游组件（AppTopbar 等）仍依赖这些符号，保持兼容直到迁移完成。

/** @deprecated 使用 panel-registry.ts 中的 PanelDef / getPanels */
export interface PageMeta {
	id: string;
	path: string;
	name: string;
	breadcrumb: string;
	group: "primary" | "bottom";
	order: number;
	icon: LucideIcon;
	protocol: string[];
	customTopbar?: boolean;
}

/** @deprecated 使用 getPanels() */
export const PAGE_META: PageMeta[] = [
	{
		id: "home",
		path: "/",
		name: "Home",
		breadcrumb: "Home",
		group: "primary",
		order: 1,
		icon: House,
		protocol: ["get_state", "subscribe"],
	},
	{
		id: "workspace",
		path: "/workspace",
		name: "会话工作台",
		breadcrumb: "会话工作台",
		group: "primary",
		order: 2,
		icon: MessagesSquare,
		protocol: ["prompt", "subscribe"],
		customTopbar: true,
	},
	{
		id: "agents",
		path: "/agents",
		name: "Agent 管理",
		breadcrumb: "Agent 管理",
		group: "primary",
		order: 3,
		icon: Bot,
		protocol: ["get_state", "server_snapshot"],
	},
	{
		id: "records",
		path: "/records",
		name: "会话记录",
		breadcrumb: "会话记录",
		group: "primary",
		order: 4,
		icon: Clock,
		protocol: ["get_messages"],
	},
	{
		id: "voice",
		path: "/voice",
		name: "语音",
		breadcrumb: "语音",
		group: "primary",
		order: 5,
		icon: Mic,
		protocol: ["prompt"],
	},
	{
		id: "todo",
		path: "/todo",
		name: "Todo 面板",
		breadcrumb: "Todo 面板",
		group: "primary",
		order: 6,
		icon: ListChecks,
		protocol: ["set_todos"],
	},
	{
		id: "models",
		path: "/models",
		name: "模型市场",
		breadcrumb: "模型市场",
		group: "primary",
		order: 7,
		icon: Cpu,
		protocol: ["get_available_models"],
	},
	{
		id: "settings",
		path: "/settings",
		name: "设置",
		breadcrumb: "设置",
		group: "bottom",
		order: 1,
		icon: SlidersHorizontal,
		protocol: ["hello", "subscribe"],
	},
];

/** @deprecated 使用 findPanelByPath */
export function findPageMeta(pathname: string): PageMeta | undefined {
	return PAGE_META.find(p => p.path === pathname) ?? PAGE_META.find(p => pathname.startsWith(p.path));
}

// ── 路由导出 ──────────────────────────────────────────────────────────

export const router = createBrowserRouter([
	{
		element: <AppShell />,
		children: [
			{ path: "/", element: <HomeView /> },
			{ path: "/workspace", element: <WorkspaceView /> },
			{ path: "/agents", element: <AgentsView /> },
			{ path: "/records", element: <RecordsView /> },
			{ path: "/records/:id", element: <PlaybackView /> },
			{ path: "/voice", element: <VoiceView /> },
			{ path: "/todo", element: <TodoView /> },
			{ path: "/models", element: <ModelsView /> },
			{ path: "/settings", element: <SettingsView /> },
			// P5 移动端裁剪
			{ path: "/m", element: <WorkspaceView compact /> },
		],
	},
]);
