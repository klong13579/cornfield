import {
	BarChart3,
	Bot,
	Brain,
	CalendarClock,
	Clock,
	Cpu,
	House,
	Lightbulb,
	ListChecks,
	MessagesSquare,
	Mic,
	SlidersHorizontal,
} from "lucide-react";
import { createElement } from "react";
import { createHashRouter, Navigate, type RouteObject, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "./layout/AppShell";
import { NotFoundView } from "./layout/NotFoundView";
import { getPanels, type PanelDef, panelHandle, registerPanel } from "./layout/panel-registry";
import { AgentDetailView } from "./pages/agents/AgentDetailView";
import { AgentsView } from "./pages/agents/AgentsView";
import { HomeView } from "./pages/home/HomeView";
import { InsightsView } from "./pages/insights/InsightsView";
import { MemoryView } from "./pages/memory/MemoryView";
import { CatalogView } from "./pages/models/CatalogView";
import { ModelsView } from "./pages/models/ModelsView";
import { ProvidersView } from "./pages/models/ProvidersView";
import { RuntimeConfigView } from "./pages/models/RuntimeConfigView";
import DiagnosisReportView from "./pages/records/DiagnosisReportView";
import { DimensionReportsView } from "./pages/records/DimensionReportsView";
import { PlaybackView } from "./pages/records/PlaybackView";
import { RecordsView } from "./pages/records/RecordsView";
import { SettingsView } from "./pages/settings/SettingsView";
import { SkillsView } from "./pages/skills/SkillsView";
import { TasksView } from "./pages/tasks/TasksView";
import { TodoView } from "./pages/todo/TodoView";
import { VoiceView } from "./pages/voice/VoiceView";
import { WorkspaceView } from "./pages/workspace/WorkspaceView";

// ── Panel 注册（唯一元数据源）────────────────────────────────────────
// 注册进 panelRegistry 后：侧栏、路由表、外壳都从它派生。加一个面板 = 这里加一项。
// 本文件是这张表唯一的消费者入口，所以注册必须在建表之前完成（模块求值顺序）。

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

	// 自带顶栏：工作台的上下文条（Agent / 工作区 / Project / 会话）与操作区（新会话 /
	// compact / 右栏 / 手机预览）只属于这一页 —— 通用顶栏不代管，别的页面也不继承。
	registerPanel({
		id: "workspace",
		title: "会话工作台",
		icon: MessagesSquare,
		group: "primary",
		order: 2,
		path: "/workspace",
		mount: () => WorkspaceView,
		customTopbar: true,
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

	// 模型控制中心（#01）：/models 壳 + 三个子工作区（catalog/providers/config），
	// index 重定向 /models/catalog —— 子工作区是面板自带的路由片段（children），
	// 深链可达，侧栏仍指向 /models。
	registerPanel({
		id: "models",
		title: "模型控制中心",
		icon: Cpu,
		group: "primary",
		order: 7,
		path: "/models",
		mount: () => ModelsView,
		children: [
			{ index: true, element: <Navigate to="/models/catalog" replace /> },
			{ path: "catalog", element: <CatalogView /> },
			{ path: "providers", element: <ProvidersView /> },
			{ path: "config", element: <RuntimeConfigView /> },
		],
	});

	// W3 D2：用量面板（serve get_stats）。
	registerPanel({
		id: "insights",
		title: "用量",
		icon: BarChart3,
		group: "primary",
		order: 8,
		path: "/insights",
		mount: () => InsightsView,
	});

	// W3 D3：记忆面板（serve get_memory 三分区投影）。
	registerPanel({
		id: "memory",
		title: "记忆",
		icon: Brain,
		group: "primary",
		order: 9,
		path: "/memory",
		mount: () => MemoryView,
	});

	// W3 D4：定时任务面板壳（cron 配置预览；数据等 B6 gateway cron 代理命令）。
	registerPanel({
		id: "tasks",
		title: "定时任务",
		icon: CalendarClock,
		group: "primary",
		order: 10,
		path: "/tasks",
		mount: () => TasksView,
	});

	// W3 D5：技能面板（get_skills 只读列表；启停 toggle 等 B3 协议）。
	registerPanel({
		id: "skills",
		title: "技能",
		icon: Lightbulb,
		group: "primary",
		order: 11,
		path: "/skills",
		mount: () => SkillsView,
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

// ── 路由表（由注册表派生）─────────────────────────────────────────────

/** /agents/:id —— Agent 详情页（内容区打开，保留左侧导航栏）。 */
function AgentDetailRoute(): React.JSX.Element {
	const { id } = useParams();
	const navigate = useNavigate();
	if (!id) return <AgentsView />;
	return <AgentDetailView agentId={id} onClose={() => navigate("/agents")} />;
}

/** 面板 → 路由：path / element / children 全部来自注册表，路由表里不再另抄一份 path→组件。 */
function panelRoute(def: PanelDef): RouteObject {
	return {
		path: def.path,
		element: createElement(def.mount()),
		children: def.children,
		handle: panelHandle(def.id),
	};
}

/** 面板路由（按 id 索引，与 appRoutes 里是同一批对象）。 */
const PANEL_ROUTES = new Map<string, RouteObject>(getPanels().map(def => [def.id, panelRoute(def)]));

/** 取面板路由片段；未注册的面板 id 直接抛（表是派生的，取不到只可能是注册表被改坏）。 */
export function panelRouteOf(id: string): RouteObject {
	const route = PANEL_ROUTES.get(id);
	if (!route) throw new Error(`panel 未注册：${id}`);
	return route;
}

/**
 * 不属于任何面板的补充路由。它们也要认领自己的面板（handle）：
 * 穿哪件外壳、当前位置写什么是路由说了算，不是按路径前缀猜。
 */
const EXTRA_ROUTES: RouteObject[] = [
	{ path: "/agents/:id", element: <AgentDetailRoute />, handle: panelHandle("agents") },
	{ path: "/records/:id", element: <PlaybackView />, handle: panelHandle("records") },
	{ path: "/records/:sessionId/diagnosis", element: <DiagnosisReportView />, handle: panelHandle("records") },
	{ path: "/records/dimension/:dim", element: <DimensionReportsView />, handle: panelHandle("records") },
	// P5 移动端裁剪：同一件工作台的窄版，路径不同、外壳与面板相同。
	{ path: "/m", element: <WorkspaceView compact />, handle: panelHandle("workspace") },
];

/**
 * 兜底路由：没人认领的路径仍然长在壳里（侧栏在、能自己走掉）。
 *
 * 不靠 React Router 的默认错误页——那是给开发者看的，连侧栏都没有；
 * 打错的深链和过期的书签落到这里才看得出“导航没错，是这个位置不存在”。
 */
const FALLBACK_ROUTES: RouteObject[] = [{ path: "*", element: <NotFoundView /> }];

/** 完整路由树（AppShell 为根）。测试以 memory router 复用这棵树。 */
export const appRoutes: RouteObject[] = [
	{
		element: <AppShell />,
		children: [...PANEL_ROUTES.values(), ...EXTRA_ROUTES, ...FALLBACK_ROUTES],
	},
];

/**
 * /models 子树（模型控制中心 #01）。导出的是表里那一份对象，不是另建的副本：
 * 测试用它起 memory router 时，渲染的正是生产路由。
 */
export const modelsRoutes: RouteObject[] = [panelRouteOf("models")];

export const router = createHashRouter(appRoutes);
