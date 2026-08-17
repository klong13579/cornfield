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
import { AgentDetailView } from "./pages/agents/AgentDetailView";
import { AgentsView } from "./pages/agents/AgentsView";
import { HomeView } from "./pages/home/HomeView";
import { ModelsView } from "./pages/models/ModelsView";
import { PlaybackView } from "./pages/records/PlaybackView";
import { RecordsView } from "./pages/records/RecordsView";
import { SettingsView } from "./pages/settings/SettingsView";
import { TodoView } from "./pages/todo/TodoView";
import { VoiceView } from "./pages/voice/VoiceView";
import { WorkspaceView } from "./pages/workspace/WorkspaceView";

/**
 * 页面 meta 注册表（页面名/路由/导航分组/覆盖协议）—— 侧栏与面包屑均由此驱动。
 * 加页面 = 数组加一项（侧栏与面包屑均由此驱动）。
 */
export interface PageMeta {
	id: string;
	path: string;
	name: string;
	/** 顶栏面包屑末级文案。 */
	breadcrumb: string;
	group: "primary" | "bottom";
	/** primary 导航位次（1 起）。 */
	order: number;
	icon: LucideIcon;
	/** 覆盖协议（requirements 修订的 wire 命令面），作页面角标展示。 */
	protocol: string[];
	/** 页面自带顶栏（workspace 有 conn/项目/操作区，不套通用顶栏）。 */
	customTopbar?: boolean;
}

export const PAGE_META: PageMeta[] = [
	{
		id: "home",
		path: "/",
		name: "Home",
		breadcrumb: "Home",
		group: "primary",
		order: 1,
		icon: House,
		protocol: ["get_state（环境摘要）", "subscribe（活跃 agent 状态）"],
	},
	{
		id: "workspace",
		path: "/workspace",
		name: "会话工作台",
		breadcrumb: "会话工作台",
		group: "primary",
		order: 2,
		icon: MessagesSquare,
		protocol: [
			"prompt, steer, follow_up, abort, abort_and_prompt, get_snapshot, set_model, set_thinking_level, compact, set_todos, subscribe",
			"session_snapshot, progress",
		],
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
		protocol: ["get_state, get_available_models, switch_session", "server_snapshot"],
	},
	{
		id: "records",
		path: "/records",
		name: "会话记录",
		breadcrumb: "会话记录",
		group: "primary",
		order: 4,
		icon: Clock,
		protocol: ["get_messages, get_session_stats, get_branch_messages"],
	},
	{
		id: "voice",
		path: "/voice",
		name: "语音",
		breadcrumb: "语音",
		group: "primary",
		order: 5,
		icon: Mic,
		protocol: ["prompt（语音转文字后发送）", "session_snapshot"],
	},
	{
		id: "todo",
		path: "/todo",
		name: "Todo 面板",
		breadcrumb: "Todo 面板",
		group: "primary",
		order: 6,
		icon: ListChecks,
		protocol: ["set_todos, get_state", "session_snapshot"],
	},
	{
		id: "models",
		path: "/models",
		name: "模型市场",
		breadcrumb: "模型市场",
		group: "primary",
		order: 7,
		icon: Cpu,
		protocol: ["get_available_models, set_model, cycle_model, set_thinking_level", "session_snapshot"],
	},
	{
		id: "settings",
		path: "/settings",
		name: "设置",
		breadcrumb: "设置",
		group: "bottom",
		order: 1,
		icon: SlidersHorizontal,
		protocol: ["hello, set_auto_compaction, set_auto_retry", "subscribe"],
	},
];

export function findPageMeta(pathname: string): PageMeta | undefined {
	// 精确匹配优先，其次前缀（agent-detail 等子路由用父 meta）
	return PAGE_META.find(p => p.path === pathname) ?? PAGE_META.find(p => pathname.startsWith(p.path));
}

export const router = createBrowserRouter([
	{
		element: <AppShell />,
		children: [
			{ path: "/", element: <HomeView /> },
			{ path: "/workspace", element: <WorkspaceView /> },
			{ path: "/agents", element: <AgentsView /> },
			{ path: "/agents/:id", element: <AgentDetailView /> },
			{ path: "/records", element: <RecordsView /> },
			{ path: "/records/:id", element: <PlaybackView /> },
			{ path: "/voice", element: <VoiceView /> },
			{ path: "/todo", element: <TodoView /> },
			{ path: "/models", element: <ModelsView /> },
			{ path: "/settings", element: <SettingsView /> },
			// P5 移动端裁剪：走 workspace 同代码 + responsive breakpoint（DevicePreview iframe 用）
			{ path: "/m", element: <WorkspaceView compact /> },
		],
	},
]);
