import { afterEach, describe, expect, it, mock } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { AgentInfoDto, TodoPhaseDto } from "@cornfield/wire";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { PathField, type PathFieldProps } from "../src/components/PathField";
import { ProjectList } from "../src/components/ProjectContext";
import { AgentSwitcher } from "../src/layout/AgentSwitcher";
import { AppShell } from "../src/layout/AppShell";
import { SidebarAgentContext, SidebarNav } from "../src/layout/AppSidebar";
import { NotFoundView } from "../src/layout/NotFoundView";
import {
	EMPTY_PROJECT_DRAFT,
	ProjectPanel,
	type ProjectPanelState,
	ProjectSwitcher,
	projectDraftToInput,
} from "../src/layout/ProjectSwitcher";
import { activePanelOf, getPanelGroups, getPanels, panelHandle } from "../src/layout/panel-registry";
import type { DirectoryPicker } from "../src/lib/path-picker";
import type { ChildSessionNodeDto, ProjectRecordDto } from "../src/lib/pi-client-api";
import { projectFieldState, projectLabelOf } from "../src/lib/project-read-model";
import {
	agentIdentitySource,
	EMPTY_NEW_SESSION_DRAFT,
	NewSessionForm,
	type NewSessionInput,
	newSessionInputOf,
	newSessionSubmitState,
	PROJECT_FIELD_NOTE,
	TITLE_FIELD_NOTE,
} from "../src/pages/workspace/NewSessionForm";
import { ChildSessionCard } from "../src/pages/workspace/SessionTree";
import { PlanStrip, planAreaOf, planProgressOf, WorkspaceView } from "../src/pages/workspace/WorkspaceView";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore, type SessionView } from "../src/state/session-store";

/**
 * T10D：Navigation 与 AppShell 收口。
 *
 * 三件事在这里被钉住：
 *   1. **一份元数据**：panelRegistry 是导航 + 路由 + 外壳的唯一来源；路由表的每个元素就是
 *      面板 mount 出来的组件，旧的 PAGE_META / findPageMeta 不再存在（深链与刷新因此走同一条路）。
 *   2. **路由上下文**：当前面板由匹配链上的 handle 解析 —— 子路由（/models/catalog、
 *      /records/:id）命中自己的面板，没人认领的路径不会冒充某个面板。
 * 3. **上下文控件**：Agent / Project 两个控件各自只读自己的来源，三种「没有」
 *      （未连接 / 空集 / 不属于任何 Project、读不到）不会被说成同一件事；外壳不代管工作台操作。
 *
 * 本文件只 mock 一处：use-session 的 SSR 替身（侧栏要读「当前 Agent / 工作上下文」，而
 * renderToStaticMarkup 下 useSyncExternalStore 缺 getServerSnapshot 会直接抛错，真 store 在没有
 * init() 的测试里也没有快照可读）。两个 Switcher 的面板仍是无 hook 的纯函数组件（直接调用即可
 * 拿到元素树、触发 onChange/onClick），AppShell 只读路由匹配链与注册表；Project 写面那一段
 * 用真 store + 假 socket（只替掉网络层）。
 */

// ── 最小 DOM 垫片（只为满足 ../src/router 模块求值里 createHashRouter 读取 window/history；
//    真正的路由断言走 memory router，不碰浏览器 history）──
const noop = (): void => {};
(globalThis as { document?: unknown }).document = { defaultView: globalThis };
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { history?: unknown }).history = {
	state: { idx: 0 },
	length: 1,
	scrollRestoration: "manual",
	pushState: noop,
	replaceState: noop,
	go: noop,
	back: noop,
	forward: noop,
};
(globalThis as { location?: unknown }).location = {
	hash: "",
	pathname: "/",
	search: "",
	origin: "http://localhost",
	href: "http://localhost/",
	assign: noop,
	replace: noop,
	reload: noop,
};

// ── 测试替身 ────────────────────────────────────────────────────────

/**
 * 侧栏要读会话视图（当前 Agent / 工作上下文），而这里不连真 socket：
 * 直渲外壳时把 use-session 换成一份固定视图 —— renderToStaticMarkup 下 useSyncExternalStore 缺
 * getServerSnapshot 会抛错，真 store 在没 init() 的测试里也拿不出快照。
 *
 * 必须在下面的 import 之前注册：外壳模块在那一刻才被求值，替身得先到位。
 */
mock.module("../src/state/use-session", () => ({ useSession: () => shellView }));

/** 外壳的空态：未连接、无 Agent、无 Project（viewOf 是函数声明，可以先用后置）。 */
const shellView: SessionView = viewOf({ connected: false });

const { renderToStaticMarkup } = await import("react-dom/server");
const { createMemoryRouter, matchRoutes, NavLink, RouterProvider } = await import("react-router-dom");
const { appRoutes } = await import("../src/router");

function viewOf(patch: Partial<SessionView>): SessionView {
	return {
		connected: true,
		reconnecting: false,
		wsUrl: "ws://127.0.0.1:1/ws",
		protocolVersion: 1,
		phase: "idle",
		model: null,
		thinkingLevel: null,
		sessionId: "",
		messages: [],
		messageEntryIds: {},
		isStreaming: false,
		activeToolNames: [],
		queued: 0,
		todo: [],
		flags: { autoCompaction: false, autoRetry: false },
		agents: [],
		env: null,
		historyLoading: false,
		sessionTreeLoading: false,
		projectsPending: false,
		...patch,
	};
}

const AGENTS: AgentInfoDto[] = [
	{ id: "default", name: "Default", face: "D", workspace: "root", kind: "coding", status: "idle" },
	{ id: "hr", name: "HR", face: "H", workspace: "hr", kind: "worker", status: "online" },
];

const PROJECTS: ProjectRecordDto[] = [
	{ projectId: "cornfield", root: "/Users/me/cornfield", name: "CornField" },
	{ projectId: "dtc", root: "/Users/me/dtc", name: "DTC", defaultAgentId: "hr" },
];

/** 没人认领的路径落在外壳里时用的替身（真能力页要连会话 store，本票不测它们的内部）。 */
const CapabilityStub = (): ReactElement => createElement("div", null, "能力页主体");
const WorkbenchStub = (): ReactElement => createElement("div", null, "工作台主体");

/** 把 matchRoutes 的 route.handle 摊平成 activePanelOf 的入参形状（useMatches 给的就是这个形状）。 */
function handlesOf(path: string): Array<{ handle?: unknown }> {
	return (matchRoutes(appRoutes, path) ?? []).map(match => ({ handle: match.route.handle }));
}

/** 深度优先收集元素（直接调用组件函数得到的就是普通元素树）。 */
function collect(root: ReactNode, out: ReactElement[] = []): ReactElement[] {
	if (Array.isArray(root)) {
		for (const child of root) collect(child, out);
		return out;
	}
	if (!isValidElement(root)) return out;
	out.push(root);
	collect((root.props as { children?: ReactNode }).children, out);
	return out;
}

/** 元素树里的可见文本（JSX 的 {expr}文本 会拆成多个子节点，比较文案前先拼起来）。 */
function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
	return "";
}

function elementOfType(root: ReactNode, type: string): ReactElement {
	const found = collect(root).find(el => el.type === type);
	if (!found) throw new Error(`元素树里没有 <${type}>`);
	return found;
}

/** 触发元素上的事件处理器（SSR 拿不到 DOM，但元素树上的 props 就是真的处理器）。 */
function fire(root: ReactNode, type: string, handler: string, payload: unknown): void {
	const el = elementOfType(root, type);
	const fn = (el.props as Record<string, unknown>)[handler];
	if (typeof fn !== "function") throw new Error(`<${type}> 上没有 ${handler}`);
	(fn as (arg: unknown) => void)(payload);
}

/**
 * 按可见文字找元素再触发处理器。
 *
 * 面板里有好几个按钮，只按「第一个 <button>」定位会打到那个文字不相干的刷新钮上。
 */
function fireOnText(root: ReactNode, type: string, text: string, handler: string, payload?: unknown): void {
	const el = collect(root).find(
		node => node.type === type && textOf((node.props as { children?: ReactNode }).children) === text,
	);
	if (!el) throw new Error(`元素树里没有文字为「${text}」的 <${type}>`);
	const fn = (el.props as Record<string, unknown>)[handler];
	if (typeof fn !== "function") throw new Error(`<${type}>「${text}」上没有 ${handler}`);
	(fn as (arg: unknown) => void)(payload);
}

// ── 1. 一份元数据：注册表 ↔ 路由表 ────────────────────────────────────

describe("面板元数据只有一份（注册表即路由表）", () => {
	it("每个面板的 path 都能在路由表里找到，且元素就是 mount() 出来的组件", () => {
		const root = appRoutes[0];
		const children = root?.children ?? [];
		for (const panel of getPanels()) {
			const route = children.find(child => child.path === panel.path);
			expect(route, `面板 ${panel.id} 没有路由`).toBeDefined();
			expect(route?.element?.type).toBe(panel.mount());
		}
	});

	it("侧栏分组来自注册表：四个组、每组都有条目、没有面板落在未声明的组里", () => {
		const groups = getPanelGroups();
		expect(groups.map(group => group.title)).toEqual(["工作", "Agent", "能力", "系统"]);
		expect(groups.reduce((n, group) => n + group.panels.length, 0)).toBe(getPanels().length);
		for (const group of groups) {
			expect(group.panels.length, `组「${group.title}」一个条目都没有`).toBeGreaterThan(0);
		}
	});

	it("旧元数据（PAGE_META / findPageMeta / PageMeta）已经删掉，没有第二份路径→标题表", async () => {
		const routerModule = (await import("../src/router")) as Record<string, unknown>;
		expect(routerModule.PAGE_META).toBeUndefined();
		expect(routerModule.findPageMeta).toBeUndefined();
	});
});

// ── 1b. 侧栏渲染：组标题与组内条目顺序 ────────────────────────────────

/**
 * mock（docs/proma-comparison/mock.html）的左侧导航，逐项拄平。
 *
 * 这份字面量故意不按 PANEL_GROUPS / order 算：从注册表算出来的期望值永远等于自己，
 * 什么都钉不住 —— 要发现的正是「注册表被改了顺序/mock 名没对齐」这类漂移。
 */
const MOCK_SIDEBAR = [
	"组：工作",
	"项：首页",
	"项：会话工作台",
	"项：会话记录",
	"组：Agent",
	"项：Agent 总览",
	"组：能力",
	"项：Skills",
	"项：Memory",
	"项：Todo",
	"项：模型",
	"项：语音",
	"组：系统",
	"项：定时任务",
	"项：用量",
	"项：设置",
];

/** 侧栏渲染出来的一行：组标题（<h2>）与条目（NavLink）的屏幕文字。 */
function sidebarLines(root: ReactNode): string[] {
	return collect(root)
		.map(el => {
			if (el.type === "h2") return `组：${textOf((el.props as { children?: ReactNode }).children)}`;
			if (el.type === NavLink) return `项：${String((el.props as { "aria-label"?: string })["aria-label"])}`;
			return null;
		})
		.filter((line): line is string => line !== null);
}

describe("侧栏按组分段渲染", () => {
	it("四个组标题 + 组内条目顺序与 mock 一致", () => {
		expect(sidebarLines(SidebarNav({ groups: getPanelGroups() }))).toEqual(MOCK_SIDEBAR);
	});

	it("条目标题对应现有的路由（本次只改导航分组，路由一个都没动）", () => {
		const links = collect(SidebarNav({ groups: getPanelGroups() })).filter(el => el.type === NavLink);
		expect(
			links.map(el => [
				String((el.props as { "aria-label"?: string })["aria-label"]),
				(el.props as { to?: string }).to,
			]),
		).toEqual([
			["首页", "/"],
			["会话工作台", "/workspace"],
			["会话记录", "/records"],
			["Agent 总览", "/agents"],
			["Skills", "/skills"],
			["Memory", "/memory"],
			["Todo", "/todo"],
			["模型", "/models"],
			["语音", "/voice"],
			["定时任务", "/tasks"],
			["用量", "/insights"],
			["设置", "/settings"],
		]);
	});
});

// ── 1c. 侧栏顶块：当前 Agent 与工作上下文 ────────────────────────────

describe("SidebarAgentContext", () => {
	it("没有焦点 Agent：mock 的两行文案（未选择 Agent / 先选择 Agent）", () => {
		const html = renderToStaticMarkup(createElement(SidebarAgentContext, { view: viewOf({ agents: [] }) }));
		expect(html).toContain("当前 Agent");
		expect(html).toContain("未选择 Agent");
		expect(html).toContain("先选择 Agent");
	});

	it("未连接：说未连接，不说「先选择 Agent」（那时候没得选）", () => {
		const html = renderToStaticMarkup(
			createElement(SidebarAgentContext, { view: viewOf({ connected: false, agents: AGENTS }) }),
		);
		expect(html).toContain("未连接");
		expect(html).not.toContain("先选择 Agent");
	});

	it("有焦点：名字是那个 Agent，提示行是工作上下文（与顶栏 chip 同一份读模型）", () => {
		const html = renderToStaticMarkup(
			createElement(SidebarAgentContext, {
				view: viewOf({ activeAgentId: "hr", agents: AGENTS, projects: PROJECTS, workingProjectId: "dtc" }),
			}),
		);
		expect(html).toContain(">HR</div>");
		expect(html).toContain(">DTC</div>");
	});
});

// ── 2. 路由上下文：当前面板由匹配链决定 ─────────────────────────────

describe("路由上下文：当前面板由匹配链决定", () => {
	it("刷新（冷启动）：注册表与路由表在模块求值时就绪，不依赖任何一次导航", () => {
		expect(getPanels().length).toBe(12);
		expect(appRoutes[0]?.children?.length).toBe(12 + 6); // 12 个面板 + 5 条补充路由 + 1 条兜底
	});

	it("每个面板路径都解析出自己", () => {
		for (const panel of getPanels()) {
			expect(activePanelOf(handlesOf(panel.path))?.id, `${panel.path} 的面板`).toBe(panel.id);
		}
	});

	it("深链到子工作区 / 参数子路由：落回自己的面板，而不是根", () => {
		const cases: Array<[string, string]> = [
			["/models", "models"],
			["/models/catalog", "models"],
			["/models/providers", "models"],
			["/models/config", "models"],
			["/agents/hr", "agents"],
			["/records/abc", "records"],
			["/records/abc/diagnosis", "records"],
			["/records/dimension/intent", "records"],
		];
		for (const [path, id] of cases) {
			expect(activePanelOf(handlesOf(path))?.id, path).toBe(id);
		}
	});

	it("移动端工作台（/m）穿工作台的面板外壳（自带顶栏）", () => {
		const panel = activePanelOf(handlesOf("/m"));
		expect(panel?.id).toBe("workspace");
		expect(panel?.customTopbar).toBe(true);
	});

	it("没人认领的路径不冒充任何面板", () => {
		expect(activePanelOf(handlesOf("/nope"))).toBeUndefined();
		expect(activePanelOf([])).toBeUndefined();
	});

	it("没人认领的路径走壳内的兜底页，不是 React Router 的开发者错误页", () => {
		const fallback = appRoutes[0]?.children?.at(-1);
		expect(fallback?.path).toBe("*");
		expect(fallback?.element?.type).toBe(NotFoundView);
	});

	it("路由 handle 里的面板 id 不存在时建表期就抛（不是运行期悄悄少一件外壳）", () => {
		expect(() => panelHandle("nope")).toThrow("panel 未注册：nope");
	});
});

// ── 3. 外壳：把当前面板的顶栏画对，且不代管工作台操作 ────────────────

describe("AppShell：外壳只画导航，不画工作台操作", () => {
	function renderShellAt(path: string): string {
		const routes = [
			{
				element: createElement(AppShell),
				children: [
					{ path: "/skills", element: createElement(CapabilityStub), handle: panelHandle("skills") },
					{ path: "/workspace", element: createElement(WorkbenchStub), handle: panelHandle("workspace") },
					{ path: "*", element: createElement(NotFoundView) },
				],
			},
		];
		const router = createMemoryRouter(routes, { initialEntries: [path] });
		return renderToStaticMarkup(createElement(RouterProvider, { router }));
	}

	it("能力页：通用顶栏画出「当前位置」，内容区是能力页本体", () => {
		const html = renderShellAt("/skills");
		// 断言到顶栏自己的标记 —— 侧栏也含「技能」两个字，只测子串会被侧栏满足。
		expect(html).toContain('CornField 多端前端 <span class="text-ink">Skills</span>');
		expect(html).toContain("能力页主体");
	});

	it("能力页上没有工作台的操作与上下文控件（不把工作台操作泄漏到能力页）", () => {
		const html = renderShellAt("/skills");
		expect(html).not.toContain("新会话");
		expect(html).not.toContain("compact");
		expect(html).not.toContain("切换 Agent");
		expect(html).not.toContain("手机预览");
		expect(html).not.toContain("重新读取项目列表");
	});

	it("自带顶栏的面板：外壳不画通用顶栏，那一行由工作台自己负责", () => {
		const html = renderShellAt("/workspace");
		expect(html).not.toContain("CornField 多端前端");
		expect(html).toContain("工作台主体");
	});

	it("工作台本体（带操作区的那件）只挂在工作台路由上，能力页不会得到它", () => {
		const children = appRoutes[0]?.children ?? [];
		const carrying = children.filter(child => child.element?.type === WorkspaceView).map(child => child.path);
		expect(carrying.sort()).toEqual(["/m", "/workspace"]);
	});

	it("没人认领的路径：兜底页长在外壳里（侧栏还在、能走掉），不是白屏", () => {
		const html = renderShellAt("/nope-xyz");
		expect(html).toContain("未找到这个位置");
		expect(html).toContain("/nope-xyz");
		expect(html).toContain("会话工作台"); // 侧栏仍渲染（非空导航）
		// 顶栏不冒充任何一个面板：标题位是空的（而不是落在 Home）
		expect(html).toContain('CornField 多端前端 <span class="text-ink"></span>');
	});
});

// ── 4. Agent 上下文控件 ──────────────────────────────────────────────

describe("AgentSwitcher", () => {
	const noop = (): void => {};

	it("未连接：控件禁用并写明未连接，不列一个点不动的 Agent 列表", () => {
		const html = renderToStaticMarkup(
			createElement(AgentSwitcher, { view: viewOf({ connected: false, agents: AGENTS }), onSelect: noop }),
		);
		expect(html).toContain("未连接");
		expect(html).toContain("disabled");
	});

	it("连上了但一个 Agent 都没注册：说清是没注册，而不是没连接", () => {
		const html = renderToStaticMarkup(createElement(AgentSwitcher, { view: viewOf({ agents: [] }), onSelect: noop }));
		expect(html).toContain("未注册 Agent");
		expect(html).not.toContain("未连接");
		expect(html).toContain("disabled");
	});

	it("当前焦点 Agent 选中；非 online 的带状态后缀", () => {
		const html = renderToStaticMarkup(
			createElement(AgentSwitcher, { view: viewOf({ activeAgentId: "hr", agents: AGENTS }), onSelect: noop }),
		);
		expect(html).toContain('value="hr"');
		expect(html).toContain("Default（idle）");
	});

	it("切换：onChange 报出选中的 agent id（调用方接 store.focusAgent）", () => {
		const picked: string[] = [];
		const tree = AgentSwitcher({
			view: viewOf({ activeAgentId: "default", agents: AGENTS }),
			onSelect: id => picked.push(id),
		});
		fire(tree, "select", "onChange", { target: { value: "hr" } });
		expect(picked).toEqual(["hr"]);
	});

	it("焦点 Agent 不在注册表里：不假装选中谁，摆占位、原样 id 只进 title", () => {
		// serve 的焦点可能是 36 字符的会话 uuid（实测：当选项文字会把顶栏挤爆）。
		const tree = AgentSwitcher({
			view: viewOf({ activeAgentId: "01a0a6bd-0238-7000-af2e-6b4226db8312", agents: AGENTS }),
			onSelect: noop,
		});
		const select = elementOfType(tree, "select");
		expect((select.props as { value?: string }).value).toBe("");
		const option = collect(tree).find(el => el.type === "option" && (el.props as { value?: string }).value === "");
		if (!option) throw new Error("元素树里没有占位选项");
		expect(textOf((option.props as { children?: ReactNode }).children)).toBe("焦点未注册");
		const label = elementOfType(tree, "label");
		expect(String((label.props as { title?: string }).title)).toContain("01a0a6bd-0238-7000-af2e-6b4226db8312");
		// 注册表里的人照旧可选
		expect(collect(tree).some(el => (el.props as { value?: string }).value === "hr")).toBe(true);
	});
});

// ── 5. Project 上下文控件 ────────────────────────────────────────────

describe("ProjectSwitcher", () => {
	it("选了工作上下文：chip 是那个项目名，清单标出「工作」与「当前会话」与 root", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: PROJECTS, currentProjectId: "dtc", workingProjectId: "dtc" }),
			}),
		);
		expect(html).toContain(">DTC</b>");
		// 两个标记是两件事：工作（下一个新会话落在哪）与会话归属（serve 的读数）
		expect(html).toContain("工作");
		expect(html).toContain("当前会话");
		expect(html).toContain("/Users/me/cornfield");
	});

	it("没选工作上下文：chip 说「不指定」，不拿会话归属冒充选择，也不拿第一个凑数", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: PROJECTS, currentProjectId: "dtc" }),
			}),
		);
		expect(html).toContain(">不指定</b>");
		// 会话归属另有其事，在面板里单独一行说（不能顶替选择，但也不能丢掉）
		expect(html).toContain("当前会话");
		expect(html).toContain(">DTC<");
	});

	it("读不到 ≠ 没声明：错误态不画空态，也不说「未声明」", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: undefined, projectsError: "Project store is not valid JSON" }),
			}),
		);
		expect(html).toContain(">读取失败</b>");
		expect(html).toContain("Project 读取失败");
		expect(html).not.toContain("未声明");
	});

	it("名单还没读到：chip 读取中，绝不显示「不指定」（那是一个尚未读到的问题的答案）", () => {
		const html = renderToStaticMarkup(createElement(ProjectSwitcher, { view: viewOf({ projects: undefined }) }));
		expect(html).toContain(">…</b>");
		expect(html).not.toContain(">不指定</b>");
	});

	it("切会话后归属重算：工作上下文选择器照常可用（名单没变），归属读数不冒充「未归属」", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: PROJECTS, workingProjectId: "dtc", projectsPending: true }),
			}),
		);
		// 选择器读的是名单，不因归属重算而变成「读取中」
		expect(html).toContain(">DTC</b>");
		expect(html).toContain("归属未知");
		expect(html).not.toContain(">未归属<");
	});

	it("确实没声明过：说清是空集，并给出声明文件路径", () => {
		const html = renderToStaticMarkup(createElement(ProjectSwitcher, { view: viewOf({ projects: [] }) }));
		expect(html).toContain(">未声明</b>");
		expect(html).toContain("~/.cornfield/agent/projects.json");
	});

	it("工作上下文选过的项目已不在注册表：照实说出来，不静默改成别的", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, { view: viewOf({ projects: PROJECTS, workingProjectId: "gone" }) }),
		);
		expect(html).toContain("gone（已不在注册表）");
		expect(html).not.toContain(">不指定</b>");
	});

	it("名单还没读到：不冒充「已不在注册表」，但选项得在（不然 value 会被画成空白）", () => {
		// 恢复出来的工作上下文会先遇到这个状态：选择已经在，名单还在路上
		const html = renderToStaticMarkup(createElement(ProjectSwitcher, { view: viewOf({ workingProjectId: "demo" }) }));
		expect(html).toContain('value="demo"');
		expect(html).toContain("名单还没读到");
		expect(html).not.toContain("已不在注册表");
	});

	it("当前会话归属：来源分开说（会话记录 / 按目录匹配），两者不是一个可信度", () => {
		const recorded = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: PROJECTS, currentProjectId: "dtc", currentProjectSource: "session" }),
			}),
		);
		expect(recorded).toContain("来源：会话记录");

		const matched = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: PROJECTS, currentProjectId: "dtc", currentProjectSource: "cwd" }),
			}),
		);
		expect(matched).toContain("来源：按目录匹配（旧会话回落）");

		// 没问过 / 还没重算完：说不知道，不说「未归属」
		const unasked = renderToStaticMarkup(
			createElement(ProjectSwitcher, { view: viewOf({ projects: PROJECTS, projectsPending: true }) }),
		);
		expect(unasked).toContain("归属未知");
		// serve 真的答过「没有任何东西声明过」才是未归属
		const none = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: PROJECTS, currentProjectSource: "none" }),
			}),
		);
		expect(none).toContain("未归属");
		expect(none).toContain("没有任何东西声明过");
	});

	it("未连接：写明 registry 不可用，不拿空列表顶替", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, { view: viewOf({ connected: false, projects: undefined }) }),
		);
		expect(html).toContain("未连接——Project registry 不可用");
		expect(html).not.toContain("未声明");
	});

	it("重读入口：给了 onRefresh 才画按钮（不给就不画点了没反应的按钮），点了真的重读", () => {
		const without = renderToStaticMarkup(createElement(ProjectSwitcher, { view: viewOf({ projects: [] }) }));
		expect(without).not.toContain("重新读取项目列表");

		// 面板是受控的无 hook 组件，可以直接调用；壳（ProjectSwitcher）自己持有草稿/错误/忙碌态，
		// 只能在 React 里渲染，所以这一条点按钮的断言针对面板本身。
		let refreshed = 0;
		const tree = panelOf({ view: viewOf({ projects: [] }), onRefresh: () => (refreshed += 1) });
		fire(tree, "button", "onClick", undefined);
		expect(refreshed).toBe(1);
	});

	it("选择器真的接 store：改它把选中的 projectId 交出去（空串 = 不指定）", () => {
		const picked: string[] = [];
		const tree = panelOf({
			view: viewOf({ projects: PROJECTS, workingProjectId: "dtc" }),
			onSelectProject: id => picked.push(id),
		});
		fire(tree, "select", "onChange", { target: { value: "mkt" } });
		fire(tree, "select", "onChange", { target: { value: "" } });
		expect(picked).toEqual(["mkt", ""]);
	});
});

// ── 6. 上下文隔离：两个控件各读各的来源 ──────────────────────────────

describe("上下文隔离：Agent 与 Project 互不污染", () => {
	const noop = (): void => {};

	it("Project 读失败不会把 Agent 控件带偏（Agent 照常显示当前服务者）", () => {
		const view = viewOf({ activeAgentId: "hr", agents: AGENTS, projectsError: "boom" });
		const agentHtml = renderToStaticMarkup(createElement(AgentSwitcher, { view, onSelect: noop }));
		const projectHtml = renderToStaticMarkup(createElement(ProjectSwitcher, { view }));
		expect(agentHtml).toContain('value="hr"');
		expect(agentHtml).not.toContain("boom");
		expect(projectHtml).toContain("boom");
	});

	it("Agent 数量变化不影响 Project 的读数（客户端 scope 不随 Agent 变）", () => {
		// 读数 = chip 上的归属判定 + 已声明清单，两者都不看 agents。
		// （声明表单里的默认 Agent 选择器**故意**来自注册表 —— 那不是 Project 的读数。）
		const withAgents = viewOf({ agents: AGENTS, projects: PROJECTS, currentProjectId: "dtc" });
		const withoutAgents = viewOf({ agents: [], projects: PROJECTS, currentProjectId: "dtc" });
		expect(projectLabelOf(withAgents)).toEqual(projectLabelOf(withoutAgents));
		expect(renderToStaticMarkup(createElement(ProjectList, { view: withAgents }))).toBe(
			renderToStaticMarkup(createElement(ProjectList, { view: withoutAgents })),
		);
	});

	it("未连接时两个控件各自说各自的「未连接」，都不编造内容", () => {
		const view = viewOf({ connected: false, projects: undefined });
		expect(renderToStaticMarkup(createElement(AgentSwitcher, { view, onSelect: noop }))).toContain("未连接");
		expect(renderToStaticMarkup(createElement(ProjectSwitcher, { view }))).toContain(
			"未连接——Project registry 不可用",
		);
	});
});

// ── 7. Project 写面：声明 / 删除真的落到 wire，错误原样显示 ────────────

/**
 * 写面的测试替身：真 `PiClientAdapter` + 假 socket。
 *
 * 面板、壳、草稿→记录的转换、store 全部是真源码（直接调用，不 mock 模块）；被替掉的只有网络
 * 这一层，断言的也是链路上真实发出的命令。
 *
 * 这里证不了的：在浏览器里点那一下（本目录没有 DOM 测试环境）。所以「声明可达」由三段接起来：
 * 表单确实画在控件里 → 点「声明」真的把动作交出去 → 动作真的发出了 `set_project` 并重读列表。
 */
let lastCreated: FakeWebSocket | undefined;
const createdAdapters: PiClientAdapter[] = [];

class FakeWebSocket implements PiWebSocketLike {
	readyState = 1;
	sent: string[] = [];
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;

	constructor(_url: string) {
		lastCreated = this;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}
}

const fakeCtor: PiWebSocketCtor = FakeWebSocket;
const WS_CONFIG: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

afterEach(() => {
	for (const adapter of createdAdapters) adapter.disconnect();
	createdAdapters.length = 0;
});

function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

function respondTo(id: string, result: unknown): void {
	lastCreated?.receive(JSON.stringify({ type: "response", id, ok: true, result }));
}

function respondErrorTo(id: string, error: string): void {
	lastCreated?.receive(JSON.stringify({ type: "response", id, ok: false, error }));
}

async function createConnectedStore(): Promise<SessionStore> {
	lastCreated = undefined;
	const adapter = new PiClientAdapter(WS_CONFIG, fakeCtor);
	createdAdapters.push(adapter);
	const store = new SessionStore();
	store.init(adapter);
	const connectPromise = store.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
	return store;
}

/** 受控的 Project 面板（无 hook，可直接调用）：没给的处理器一律空实现。 */
function panelOf({
	view,
	state,
	workingProjectId,
	onSelectProject,
	onRefresh,
	onChange,
	onDeclare,
	onDelete,
	rootSuggestions,
	servePicker,
}: {
	view: SessionView;
	state?: ProjectPanelState;
	workingProjectId?: string;
	onSelectProject?: (projectId: string) => void;
	onRefresh?: () => void;
	onChange?: (patch: Partial<ProjectPanelState>) => void;
	onDeclare?: () => void;
	onDelete?: () => void;
	rootSuggestions?: readonly string[];
	servePicker?: DirectoryPicker;
}): ReactElement {
	return ProjectPanel({
		view,
		state: state ?? { draft: EMPTY_PROJECT_DRAFT, deleteTargetId: "", busy: null },
		workingProjectId: workingProjectId ?? "",
		onSelectProject: onSelectProject ?? noop,
		...(onRefresh ? { onRefresh } : {}),
		onChange: onChange ?? noop,
		onDeclare: onDeclare ?? noop,
		onDelete: onDelete ?? noop,
		...(rootSuggestions ? { rootSuggestions } : {}),
		...(servePicker ? { servePicker } : {}),
	});
}

// ── 7b. root 字段：能打 / 能选 / 能少打 ───────────────────────────────

/**
 * 桌面壳的替身。本文件在模块顶部把 `window` 设成了 `globalThis`（router 求值需要它），
 * 所以壳就挂在 `globalThis.api` 上；每个用例自己拆掉，不留长命全局改动。
 */
function installShell(pickDirectory: (defaultPath?: string) => unknown): void {
	(globalThis as { api?: unknown }).api = { dialog: { pickDirectory } };
}

/**
 * 面板里那个路径控件**自己**（不是它渲染出来的东西）。
 *
 * `collect` 只走直接写在外面的元素：嵌套组件（`<PathField …/>`）对它是黑盒子。
 * 但对“面板给了控件什么”这件事，拿它的 props 就是最准的断言 —— 比 HTML 里数元素更贴真实接线。
 * 控件自己渲染成什么样，在 `path-field.render.test.ts` 里单独验。
 */
function pathFieldOf(root: ReactNode): PathFieldProps {
	const el = collect(root).find(node => node.type === PathField);
	if (!el) throw new Error("面板里没有路径控件");
	return el.props as PathFieldProps;
}

describe("Project 声明面板的 root 字段", () => {
	afterEach(() => {
		delete (globalThis as { api?: unknown }).api;
	});

	it("浏览器直开（没有壳）但 serve 连着：按钮照画 —— 走的是 serve 那台机器上的选择框", () => {
		const html = renderToStaticMarkup(createElement(ProjectSwitcher, { view: viewOf({ projects: PROJECTS }) }));
		// root 输入框本身照常在
		expect(html).toContain('aria-label="项目根路径"');
		// 没有壳也能选：浏览器自己拿不到绝对路径（webkitdirectory 只给相对路径），只能由 serve 弹
		expect(html).toContain("浏览…");
	});

	it("控件拿到的是 serve 那条通路（面板连着 serve 时）", () => {
		const pick: DirectoryPicker = () => Promise.resolve({ canceled: true });
		const field = pathFieldOf(panelOf({ view: viewOf({ projects: PROJECTS }), servePicker: pick }));
		expect(field.servePicker).toBe(pick);
	});

	it("有壳：画浏览按钮（按钮在不在只取决于壳在不在，与输入框里有没有内容无关）", () => {
		installShell(() => ({ canceled: true }));
		const html = renderToStaticMarkup(createElement(ProjectSwitcher, { view: viewOf({ projects: PROJECTS }) }));
		expect(html).toContain("浏览…");
	});

	it("候选 = 已声明项目的 root 在前 + 本机用过的路径在后（跨来源去重由控件做）", () => {
		const field = pathFieldOf(
			panelOf({ view: viewOf({ projects: PROJECTS }), rootSuggestions: ["/Users/me/dtc", "/Users/me/new"] }),
		);
		expect(field.suggestions).toEqual(["/Users/me/cornfield", "/Users/me/dtc", "/Users/me/new"]);
	});

	it("还没用过任何路径时，已声明的项目 root 就是候选（第一次就用得上）", () => {
		expect(pathFieldOf(panelOf({ view: viewOf({ projects: PROJECTS }) })).suggestions).toEqual([
			"/Users/me/cornfield",
			"/Users/me/dtc",
		]);
	});

	it("控件拿到的是草稿里的 root（不是另一个副本）", () => {
		const field = pathFieldOf(
			panelOf({
				view: viewOf({ projects: PROJECTS }),
				state: {
					draft: { root: "/Users/me/dtc", defaultAgentId: "" },
					deleteTargetId: "",
					busy: null,
				},
			}),
		);
		expect(field.value).toBe("/Users/me/dtc");
	});

	it("改 root：交出去的是一条草稿改动（写回 root，并清掉上一次的失败文案）", () => {
		const patches: Array<Partial<ProjectPanelState>> = [];
		pathFieldOf(panelOf({ view: viewOf({ projects: PROJECTS }), onChange: p => patches.push(p) })).onChange(
			"/Users/me/picked",
		);
		expect(patches).toEqual([{ draft: { ...EMPTY_PROJECT_DRAFT, root: "/Users/me/picked" }, error: undefined }]);
	});

	it("选择器失败：走面板唯一的错误界面（原文照原样）", () => {
		const patches: Array<Partial<ProjectPanelState>> = [];
		pathFieldOf(panelOf({ view: viewOf({ projects: PROJECTS }), onChange: p => patches.push(p) })).onPickError(
			"Error invoking remote method 'dialog:pick-directory': no handler registered",
		);
		expect(patches).toEqual([
			{ error: "Error invoking remote method 'dialog:pick-directory': no handler registered" },
		]);
	});
});

describe("Project 写面：保存 / 删除", () => {
	it("保存表单长在控件里：只问根路径（+ 焦点不是 default 时的那一档默认 Agent）", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: PROJECTS, agents: AGENTS, activeAgentId: "hr" }),
			}),
		);
		// id 与名称不再问用户：它们是 root 目录名的函数，由 serve 推导
		expect(html).not.toContain('aria-label="project id"');
		expect(html).not.toContain('aria-label="名称"');
		expect(html).toContain("id 与名称取目录名");
		expect(html).toContain('aria-label="项目根路径"');
		// 钮上写的是人能认出的那个动作（不是 wire 里的「声明」），而且是主按钮
		expect(html).toContain("保存</button>");
		expect(html).toContain("不指定默认 Agent");
		// 默认 Agent 是选择项，不是自由文本：清单里的 agent 真的成了选项
		expect(html).toContain('value="hr"');
		expect(html).toContain("HR（hr）");
		// 已声明过才有可删的东西
		expect(html).toContain("选择要删除的 Project");
	});

	it("保存钮与 root 同排：面板把它交给了路径控件的 trailing，不另起一行", () => {
		const field = pathFieldOf(panelOf({ view: viewOf({ projects: PROJECTS, agents: AGENTS }) }));
		const save = field.trailing as ReactElement;
		expect(save.type).toBe("button");
		expect(textOf((save.props as { children?: ReactNode }).children)).toBe("保存");
	});

	it("面板受视口约束：高度不超视口并可滚（矮窗口下保存钮曾被推到屏幕外且无处可滚）", () => {
		const html = renderToStaticMarkup(createElement(ProjectSwitcher, { view: viewOf({ projects: PROJECTS }) }));
		expect(html).toContain("max-h-[calc(100vh-3.5rem)]");
		expect(html).toContain("max-w-[calc(100vw-1rem)]");
		expect(html).toContain("overflow-y-auto");
	});

	it("焦点就是 `default`：不问默认 Agent（那个选择框没有信息量），但保存钮照常在", () => {
		// 没显式给焦点 → activeAgentIdOf 落到注册表第一个（default）
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, { view: viewOf({ projects: PROJECTS, agents: AGENTS }) }),
		);
		expect(html).not.toContain("不指定默认 Agent");
		expect(html).toContain("保存</button>");
		expect(html).toContain('aria-label="项目根路径"');
	});

	it("未连接：不画写面（发不出去的命令不是保存），也不替清单编内容", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, { view: viewOf({ connected: false, projects: undefined }) }),
		);
		expect(html).not.toContain("保存</button>");
		expect(html).not.toContain("选择要删除的 Project");
		expect(html).toContain("未连接——Project registry 不可用");
	});

	it("忙碌文案只说正在跑的那个动作（保存中… / 删除中…）—— 另一个钮不谎报", () => {
		const html = (busy: ProjectPanelState["busy"]): string =>
			renderToStaticMarkup(
				panelOf({
					view: viewOf({ projects: PROJECTS, agents: AGENTS }),
					state: { draft: EMPTY_PROJECT_DRAFT, deleteTargetId: "dtc", busy },
				}),
			);
		// 删除要真的是个可点的目标（没选目标时那个钮本来就是禁用的），否则这条断言问不到删除钮的文字
		expect(html("save")).toContain("保存中…");
		expect(html("save")).not.toContain("删除中…");
		expect(html("delete")).toContain("删除中…");
		expect(html("delete")).not.toContain("保存中…");
		expect(html(null)).not.toContain("中…");
	});

	it("点「保存」真的把动作交出去（不是画着好看的按钮）", () => {
		let declared = 0;
		const tree = panelOf({
			view: viewOf({ projects: PROJECTS, agents: AGENTS }),
			state: {
				draft: { root: "/Users/me/dtc", defaultAgentId: "hr" },
				deleteTargetId: "",
				busy: null,
			},
			onDeclare: () => (declared += 1),
		});
		const save = pathFieldOf(tree).trailing as ReactElement;
		(save.props as { onClick: () => void }).onClick();
		expect(declared).toBe(1);
	});

	it("声明可达：填表 → 声明 → serve 真的收到 set_project（只带 root 与选了的默认 Agent），写完后重读 registry", async () => {
		const store = await createConnectedStore();
		const parsed = projectDraftToInput({ root: "/Users/me/dtc", defaultAgentId: "hr" });
		if (!parsed.ok) throw new Error(parsed.error);

		const pending = store.setProject(parsed.input);
		// 断言可能在响应之前就失败：先挂一个接住 rejection 的分支，别让 afterEach 的断开变成
		// 「测试之间未处理的错误」（重试分支仍在最后真等它）。
		void pending.catch(() => {});

		const write = sentRequests().at(-1);
		expect(write?.command).toMatchObject({
			type: "set_project",
			root: "/Users/me/dtc",
			defaultAgentId: "hr",
		});
		// id 与名称不是客户端的决定：一个也不发，交给 serve 从目录名推
		expect(write?.command).not.toHaveProperty("projectId");
		expect(write?.command).not.toHaveProperty("name");

		// 答复是**存储里那一份**（serve 推出来的 id / 名称在这里才第一次出现），不是我们发出去的那几个字
		const stored: ProjectRecordDto = {
			projectId: "dtc",
			name: "dtc",
			root: "/Users/me/dtc",
			defaultAgentId: "hr",
		};
		respondTo(write!.id, { project: stored });
		await Bun.sleep(0);

		// 写完之后重读（归属由 serve 重算，不是客户端自己拼一份「写入后的样子」）
		const refresh = sentRequests().at(-1);
		expect(refresh?.command).toMatchObject({ type: "list_projects" });
		respondTo(refresh!.id, { projects: PROJECTS, currentProjectId: "dtc" });

		expect(await pending).toMatchObject({ projectId: "dtc" });
		expect(store.getSnapshot().currentProjectId).toBe("dtc");
	});

	it("没选默认 Agent 就不带那个字段（缺省不是空串）", async () => {
		const store = await createConnectedStore();
		const parsed = projectDraftToInput({ root: "/Users/me/cornfield", defaultAgentId: "" });
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.input.defaultAgentId).toBeUndefined();

		const pending = store.setProject(parsed.input);
		void pending.catch(() => {});
		const write = sentRequests().at(-1);
		expect(write?.command).toMatchObject({ type: "set_project", root: "/Users/me/cornfield" });
		// 没选默认 Agent 就是**不发这个字段**（缺省与空串不是一回事）
		expect(write?.command).not.toHaveProperty("defaultAgentId");
		expect(write?.command).not.toHaveProperty("projectId");

		respondTo(write!.id, { project: PROJECTS[0] });
		await Bun.sleep(0);
		respondTo(sentRequests().at(-1)!.id, { projects: [PROJECTS[0]] });
		await pending;
	});

	it("删除：真的发出 delete_project；serve 说「本来就不在」就原样报错，并重读成最新列表", async () => {
		const store = await createConnectedStore();
		const pending = store.deleteProject("dtc");
		void pending.catch(() => {});

		const remove = sentRequests().at(-1);
		expect(remove?.command).toMatchObject({ type: "delete_project", projectId: "dtc" });

		respondErrorTo(
			remove!.id,
			'delete_project failed: no Project declared with projectId "dtc"; nothing was removed.',
		);
		await Bun.sleep(0);

		// 失败也重读：这条判决说明我们手里那份列表是旧的
		const refresh = sentRequests().at(-1);
		expect(refresh?.command).toMatchObject({ type: "list_projects" });
		respondTo(refresh!.id, { projects: [PROJECTS[0]] });

		await expect(pending).rejects.toThrow("nothing was removed");
		expect(store.getSnapshot().projects?.map(p => p.projectId)).toEqual(["cornfield"]);
	});

	it("错误真的被画出来：本地校验的不成立、以及 serve 的原始判决", async () => {
		// 1) 本地就能看出的不成立（空 root）：面板把原文画出来
		const invalid = projectDraftToInput({ root: "   ", defaultAgentId: "" });
		if (invalid.ok) throw new Error("空 root 不该通过");
		const invalidHtml = renderToStaticMarkup(
			createElement(ProjectPanel, {
				view: viewOf({ projects: PROJECTS, agents: AGENTS }),
				state: { draft: EMPTY_PROJECT_DRAFT, deleteTargetId: "", busy: false, error: invalid.error },
				onChange: noop,
				onDeclare: noop,
				onDelete: noop,
			}),
		);
		expect(invalidHtml).toContain(invalid.error);

		// 2) serve 的判决（从一次真失败的写入里取出来）同样原文可见，不被换成自造的提示
		const store = await createConnectedStore();
		// 本地看不出不成立（非空就是合法输入），交给 serve 判：绝对路径那条规则只有它守
		const parsed = projectDraftToInput({ root: "relative/dir", defaultAgentId: "" });
		if (!parsed.ok) throw new Error(parsed.error);
		const pending = store.setProject(parsed.input);
		void pending.catch(() => {});
		const write = sentRequests().at(-1);
		respondErrorTo(
			write!.id,
			'set_project failed: root must be an absolute path (got "relative/dir"); a relative root would resolve against the serve process cwd.',
		);
		await Bun.sleep(0);
		respondTo(sentRequests().at(-1)!.id, { projects: PROJECTS });

		let message = "";
		try {
			await pending;
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("root must be an absolute path");

		const html = renderToStaticMarkup(
			createElement(ProjectPanel, {
				view: viewOf({ projects: PROJECTS, agents: AGENTS }),
				state: { draft: EMPTY_PROJECT_DRAFT, deleteTargetId: "", busy: false, error: message },
				onChange: noop,
				onDeclare: noop,
				onDelete: noop,
			}),
		);
		expect(html).toContain("root must be an absolute path");
	});

	it("草稿→入参：只送 root（去空格）与真的选了的默认 Agent；root 空着就不发", () => {
		const parsed = projectDraftToInput({ root: "  /Users/me/dtc ", defaultAgentId: "  hr " });
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.input).toEqual({ root: "/Users/me/dtc", defaultAgentId: "hr" });

		// 没选默认 Agent：那个字段**不出现**（缺省与空串不是一回事）
		const withoutAgent = projectDraftToInput({ root: "/Users/me/dtc", defaultAgentId: "  " });
		if (!withoutAgent.ok) throw new Error(withoutAgent.error);
		expect(withoutAgent.input).toEqual({ root: "/Users/me/dtc" });

		// id / 名称不再是入参，所以“哪个字段空着”只剩 root 一种
		expect(projectDraftToInput({ root: "", defaultAgentId: "hr" }).ok).toBe(false);
	});

	it("删除目标没选就不发命令（不替用户默认挑一个再删）", () => {
		let removed = 0;
		const tree = panelOf({
			view: viewOf({ projects: PROJECTS, agents: AGENTS }),
			state: { draft: EMPTY_PROJECT_DRAFT, deleteTargetId: "", busy: null },
			onDelete: () => (removed += 1),
		});
		// 没选时删除钮是禁用的（画出来但点不动），选了才可点
		const button = collect(tree).find(node => node.type === "button" && textOf(node.props.children) === "删除");
		if (!button) throw new Error("面板里没有删除钮");
		expect((button.props as { disabled?: boolean }).disabled).toBe(true);

		const ready = panelOf({
			view: viewOf({ projects: PROJECTS, agents: AGENTS }),
			state: { draft: EMPTY_PROJECT_DRAFT, deleteTargetId: "dtc", busy: null },
			onDelete: () => (removed += 1),
		});
		fireOnText(ready, "button", "删除", "onClick");
		expect(removed).toBe(1);
	});
});

// ── 8. 工作台三件（T15）：新建会话表单 ──────────────────────────────

/**
 * 工作台三件的第一件。
 *
 * 这屏的价值全在「它说的是不是真的」：Agent / Project / 标题三个意图，落得下去的发出去，
 * 落不下去的当场明说。所以这里逐态拉出来看屏上到底写了什么；在浏览器里点那一下不在本目录
 * 的能力范围内（没有 DOM 测试环境），表单按受控的无 hook 组件直接调用。
 */
describe("NewSessionForm：三个意图各自落到哪", () => {
	/** 表单外壳：没给的处理器一律空实现。Project 是 store 的工作上下文，由 props 传进来。 */
	function formOf(props: {
		view: SessionView;
		draft?: typeof EMPTY_NEW_SESSION_DRAFT;
		onChange?: (draft: typeof EMPTY_NEW_SESSION_DRAFT) => void;
		projectId?: string;
		onProjectChange?: (projectId: string) => void;
		onCreate?: (input: NewSessionInput) => void;
	}): ReactElement {
		return NewSessionForm({
			draft: EMPTY_NEW_SESSION_DRAFT,
			onChange: noop,
			projectId: "",
			onProjectChange: noop,
			onCreate: noop,
			...props,
		});
	}

	it("就绪：画出默认 Agent、它的来源、以及三个字段各自的去向", () => {
		const html = renderToStaticMarkup(
			createElement(NewSessionForm, {
				view: viewOf({ agents: AGENTS, activeAgentId: "hr" }),
				draft: EMPTY_NEW_SESSION_DRAFT,
				onChange: noop,
				projectId: "",
				onProjectChange: noop,
				onCreate: noop,
			}),
		);
		expect(html).toContain("新会话将由");
		expect(html).toContain("本会话焦点（§10 第 1 级）");
		expect(html).toContain("新建时用当前焦点的 Agent");
		// 两个字段各自的去向当场明说，不靠一个点不动的控件暗示
		expect(html).toContain(PROJECT_FIELD_NOTE);
		expect(html).toContain(TITLE_FIELD_NOTE);
	});

	it("无 Agent：说清是注册表里还没有 Agent，不是「未连接」；提交点不动", () => {
		const tree = formOf({ view: viewOf({ agents: [] }) });
		const html = renderToStaticMarkup(tree);
		expect(html).toContain("注册表里还没有 Agent");
		expect(html).not.toContain("未连接——读不到 Agent 注册表");
		expect((elementOfType(tree, "button").props as { disabled?: boolean }).disabled).toBe(true);
		expect(newSessionSubmitState(viewOf({ agents: [] })).canSubmit).toBe(false);
	});

	it("无 Project：说清「还没声明过」并给出声明文件路径（不是读取失败、也不是读取中）", () => {
		const html = renderToStaticMarkup(
			createElement(NewSessionForm, {
				view: viewOf({ agents: AGENTS, activeAgentId: "hr", projects: [] }),
				draft: EMPTY_NEW_SESSION_DRAFT,
				onChange: noop,
				projectId: "",
				onProjectChange: noop,
				onCreate: noop,
			}),
		);
		expect(html).toContain("还没声明过任何 Project");
		expect(html).toContain("~/.cornfield/agent/projects.json");
		expect(html).not.toContain("读取失败");
		expect(html).not.toContain("读取中");
	});

	it("未连接：Agent 与 Project 各自说自己的「未连接」，都不编内容", () => {
		const html = renderToStaticMarkup(
			createElement(NewSessionForm, {
				view: viewOf({ connected: false, projects: undefined }),
				draft: EMPTY_NEW_SESSION_DRAFT,
				onChange: noop,
				projectId: "",
				onProjectChange: noop,
				onCreate: noop,
			}),
		);
		expect(html).toContain("未连接——读不到 Agent 注册表");
		expect(html).toContain("未连接 —— Project registry 不可用");
		expect(html).not.toContain("还没声明过任何 Project");
	});

	it("Project 读失败：原样显示 serve 的话，不显示成空集", () => {
		const tree = formOf({ view: viewOf({ agents: AGENTS, projectsError: "Project store is not valid JSON" }) });
		const html = renderToStaticMarkup(tree);
		expect(html).toContain("读取失败：Project store is not valid JSON");
		expect(html).not.toContain("还没声明过任何 Project");
		expect(projectFieldState(viewOf({ projectsError: "boom" })).kind).toBe("error");
	});

	it("默认 Agent 的来源：命中 Project 声明的默认就照实说第 2 级", () => {
		const view = viewOf({ agents: AGENTS, activeAgentId: "default", projects: PROJECTS, currentProjectId: "dtc" });
		expect(agentIdentitySource(view, "hr")).toMatchObject({ kind: "project", projectName: "DTC" });
		// 改选了 hr：它是这个 Project 声明的默认 Agent，屏上就写第 2 级
		const html = renderToStaticMarkup(
			createElement(NewSessionForm, {
				view,
				draft: { ...EMPTY_NEW_SESSION_DRAFT, agentId: "hr" },
				onChange: noop,
				projectId: "",
				onProjectChange: noop,
				onCreate: noop,
			}),
		);
		expect(html).toContain("已改选");
		expect(html).toContain("Project「DTC」的默认 Agent（§10 第 2 级）");
	});

	it("Project 声明的默认与焦点不同：明说新会话仍建在焦点上（不假装按声明走）", () => {
		const view = viewOf({ agents: AGENTS, activeAgentId: "default", projects: PROJECTS, currentProjectId: "dtc" });
		const html = renderToStaticMarkup(
			createElement(NewSessionForm, {
				view,
				draft: EMPTY_NEW_SESSION_DRAFT,
				onChange: noop,
				projectId: "",
				onProjectChange: noop,
				onCreate: noop,
			}),
		);
		expect(html).toContain("与当前焦点不同：不改选时仍按当前焦点（§10 第 1 级优先）");
		expect(html).toContain("本会话焦点（§10 第 1 级）");
	});

	it("第 3/4 级看不到就说看不到，不猜一个来源", () => {
		const view = viewOf({ agents: AGENTS, activeAgentId: "default", projects: PROJECTS, currentProjectId: "dtc" });
		const source = agentIdentitySource(view, "ghost");
		expect(source.kind).toBe("unknown");
		expect(source.label).toContain("看不见");
	});

	it("选别的 Agent：提交不再被挡，选中的 Agent 真的交出去", () => {
		const view = viewOf({ agents: AGENTS, activeAgentId: "default" });
		const draft = { ...EMPTY_NEW_SESSION_DRAFT, agentId: "hr" };
		// 跨 Agent 提交在 store 那边已经是顺序正确的（先切后建），这里没有理由再挡
		expect(newSessionSubmitState(view).canSubmit).toBe(true);

		const seen: NewSessionInput[] = [];
		const tree = formOf({ view, draft, onCreate: input => seen.push(input) });
		const html = renderToStaticMarkup(tree);
		expect(html).toContain("已改选");
		expect(html).toContain("提交时先切到它并等 serve 确认");
		expect((elementOfType(tree, "button").props as { disabled?: boolean }).disabled).toBe(false);

		// 提交：交给创建路径的是**被改选的那个** Agent，不是焦点
		fire(tree, "form", "onSubmit", { preventDefault: noop });
		expect(seen).toEqual([{ agentId: "hr" }]);
	});

	it("提交真的把三个字段交出去（去空格；空串不带出去）", () => {
		const seen: NewSessionInput[] = [];
		const view = viewOf({ agents: AGENTS, activeAgentId: "hr" });

		// 什么都不填：不带任何字段（缺省与空串不是一回事）
		const bare = formOf({ view, onCreate: input => seen.push(input) });
		fire(bare, "form", "onSubmit", { preventDefault: noop });
		expect(seen).toEqual([{}]);

		// 两个都填：原样交出去（标题去空格）。Project 不在入参里 ——
		// 「建在哪个 Project」由 store 按工作上下文统一决定（三个建会话的入口问同一个答案）。
		const filled = NewSessionForm({
			view,
			draft: { agentId: "hr", title: "  看下工单  " },
			onChange: noop,
			projectId: "dtc",
			onProjectChange: noop,
			onCreate: input => seen.push(input),
		});
		fire(filled, "form", "onSubmit", { preventDefault: noop });
		expect(seen[1]).toEqual({ agentId: "hr", title: "看下工单" });
	});

	it("草稿→入参：只带真的选过/写过的字段", () => {
		expect(newSessionInputOf(EMPTY_NEW_SESSION_DRAFT)).toEqual({});
		expect(newSessionInputOf({ agentId: "  ", title: "  " })).toEqual({});
		expect(newSessionInputOf({ agentId: "hr", title: "标题" })).toEqual({ agentId: "hr", title: "标题" });
	});
});

// ── 9. 工作台三件（T15）：当前计划区域 ───────────────────────────────

/**
 * 第二件：当前计划。
 *
 * 它是**本会话自己的** Session Todo（快照 `todoPhases`）——不建第二份计划存储、不写进 Todo
 * 工作台或 Agent 板。所以这组用例只钉两件事：四态分开（尤其是「快照还没到」不等于「没有计划」），
 * 以及切换真的交给 store 的现有入口。
 */
describe("当前计划区域", () => {
	const PHASES: TodoPhaseDto[] = [
		{
			name: "第一阶段",
			tasks: [
				{ content: "读任务包", status: "completed" },
				{ content: "写实现", status: "pending" },
				{ content: "旧方案", status: "abandoned" },
				{ content: "跑门禁", status: "in_progress" },
			],
		},
	];

	/** 任务行按钮：表头那个折叠钮带 aria-expanded，不是任务行。 */
	function taskRows(tree: ReactElement): ReactElement[] {
		return collect(tree).filter(
			node => node.type === "button" && !("aria-expanded" in (node.props as Record<string, unknown>)),
		);
	}

	it("四态分开：未连接 / 快照未到 / 确实没有计划 / 有计划", () => {
		const base = viewOf({});
		expect(planAreaOf({ ...base, connected: false, todo: PHASES }).kind).toBe("disconnected");
		expect(planAreaOf({ ...base, sessionId: "", todo: [] }).kind).toBe("waiting");
		expect(planAreaOf({ ...base, sessionId: "sess-1", todo: [] }).kind).toBe("empty");
		const phases = planAreaOf({ ...base, sessionId: "sess-1", todo: PHASES });
		expect(phases.kind).toBe("phases");
		expect(phases.phases).toHaveLength(1);
	});

	it("快照还没到：不拿「没有计划」顶位（那是一个还没到的答案）", () => {
		const area = planAreaOf({ connected: true, sessionId: "", todo: [] });
		expect(area.label).not.toContain("没有计划");
		expect(
			renderToStaticMarkup(PlanStrip({ area, collapsed: true, onToggle: noop, onToggleCollapsed: noop })),
		).not.toContain("完成 0/0");
	});

	it("未连接：说清读不到，不画空计划", () => {
		const area = planAreaOf({ connected: false, sessionId: "sess-1", todo: [] });
		const html = renderToStaticMarkup(PlanStrip({ area, collapsed: true, onToggle: noop, onToggleCollapsed: noop }));
		expect(html).toContain("未连接——读不到本会话的计划");
		expect(html).not.toContain("本次会话还没有计划");
	});

	it("进度：放弃单列，不与完成相加", () => {
		expect(planProgressOf(PHASES)).toEqual({ done: 1, total: 4, abandoned: 1 });
		expect(planProgressOf([])).toEqual({ done: 0, total: 0, abandoned: 0 });
	});

	it("展开：画出相位/进度/来源，未终结的两态点得动，进行中与已放弃是只读读数", () => {
		const clicked: Array<[string, number]> = [];
		const tree = PlanStrip({
			area: planAreaOf({ connected: true, sessionId: "sess-1", todo: PHASES }),
			collapsed: false,
			onToggle: (phaseName, index) => clicked.push([phaseName, index]),
			onToggleCollapsed: noop,
		});
		const html = renderToStaticMarkup(tree);
		expect(html).toContain("当前计划");
		expect(html).toContain("本会话的 Session Todo");
		expect(html).toContain("完成 1/4");
		expect(html).toContain("放弃 1");
		expect(html).toContain("第一阶段");
		expect(html).toContain("读任务包");

		const rows = taskRows(tree);
		expect(rows).toHaveLength(4);
		// 只有 pending / completed 点得动（store.toggleTodo 就是在这一对之间来回换）
		expect(rows.map(row => (row.props as { disabled?: boolean }).disabled)).toEqual([false, false, true, true]);

		(rows[1]!.props as { onClick: () => void }).onClick();
		expect(clicked).toEqual([["第一阶段", 1]]);
	});

	it("默认折叠：本会话有计划也不画任务行，表头读数照留", () => {
		const tree = PlanStrip({
			area: planAreaOf({ connected: true, sessionId: "sess-1", todo: PHASES }),
			collapsed: true,
			onToggle: noop,
			onToggleCollapsed: noop,
		});
		const html = renderToStaticMarkup(tree);
		// 折叠省的是纵向空间，不是把信息藏了：进度和来源都还在表头上
		expect(html).toContain("当前计划");
		expect(html).toContain("完成 1/4");
		expect(html).toContain("放弃 1");
		expect(html).toContain("本会话的 Session Todo");
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("第一阶段");
		expect(html).not.toContain("读任务包");
		expect(taskRows(tree)).toHaveLength(0);
	});

	it("展开：任务行才出现，表头就是那个切换入口", () => {
		const tree = PlanStrip({
			area: planAreaOf({ connected: true, sessionId: "sess-1", todo: PHASES }),
			collapsed: false,
			onToggle: noop,
			onToggleCollapsed: noop,
		});
		expect(renderToStaticMarkup(tree)).toContain('aria-expanded="true"');
		expect(taskRows(tree)).toHaveLength(4);
	});

	it("点表头：把折叠交回工作台（组件自己不持有状态）", () => {
		let toggles = 0;
		const tree = PlanStrip({
			area: planAreaOf({ connected: true, sessionId: "sess-1", todo: PHASES }),
			collapsed: true,
			onToggle: noop,
			onToggleCollapsed: () => {
				toggles += 1;
			},
		});
		fireOnText(tree, "button", "当前计划完成 1/4 · 放弃 1本会话的 Session Todo", "onClick");
		expect(toggles).toBe(1);
	});

	it("没有计划可折的三种态：不画折叠控件，两态渲染逐字节相同", () => {
		const areas = [
			planAreaOf({ connected: false, sessionId: "sess-1", todo: [] }),
			planAreaOf({ connected: true, sessionId: "", todo: [] }),
			planAreaOf({ connected: true, sessionId: "sess-1", todo: [] }),
		];
		for (const area of areas) {
			const expanded = renderToStaticMarkup(
				PlanStrip({ area, collapsed: false, onToggle: noop, onToggleCollapsed: noop }),
			);
			// 画一个点了没用的箭头，比不画它更坏
			expect(expanded).not.toContain("aria-expanded");
			expect(
				renderToStaticMarkup(PlanStrip({ area, collapsed: true, onToggle: noop, onToggleCollapsed: noop })),
			).toBe(expanded);
		}
	});
});

// ── 10. 工作台三件（T15）：子会话卡片的进程读数 ──────────────────────

/**
 * 第三件：子会话卡片上的 process state。
 *
 * 判据本身在 `session-tree-logic.test.ts`（包括「非终态 + 有 pid 不是 healthy」那条），这里钉的是
 * **它到底有没有画到屏上**：卡片是受控无 hook 组件，直接调用就能拿到元素树。
 */
describe("ChildSessionCard：三个维度各画各的", () => {
	function node(patch: Partial<ChildSessionNodeDto> = {}): ChildSessionNodeDto {
		return {
			sessionId: "child-1",
			parentSessionId: "sess-root",
			rootSessionId: "sess-root",
			depth: 1,
			agentId: "hr",
			status: "running",
			objective: "研究编辑器方案",
			createdAt: 1_000,
			updatedAt: 2_000,
			...patch,
		};
	}

	function cardOf(
		child: ChildSessionNodeDto,
		extra: {
			startingChildId?: string;
			busy?: boolean;
			bringingBack?: boolean;
			onBringBack?: (id: string) => void;
		} = {},
	): ReactElement {
		return ChildSessionCard({
			child,
			busy: extra.busy ?? false,
			bringingBack: extra.bringingBack ?? false,
			onBringBack: extra.onBringBack ?? noop,
			...(extra.startingChildId === undefined ? {} : { startingChildId: extra.startingChildId }),
		});
	}

	/** 卡里就一个带回钮（没有就是元素树变了，直接报出来）。 */
	function backButtonOf(tree: ReactElement): ReactElement {
		const found = collect(tree).find(el => el.type === "button");
		if (!found) throw new Error("子会话卡片里没有带回钮");
		return found;
	}

	it("非终态 + 有 pid：画「进程 未知」并把依据（含 pid）摆出来", () => {
		const html = renderToStaticMarkup(cardOf(node({ lastPid: 4242 })));
		expect(html).toContain("进程 未知");
		expect(html).toContain("账本未复核");
		expect(html).toContain("4242");
	});

	it("completed：进程画「已停止」（不再说未知）", () => {
		const html = renderToStaticMarkup(cardOf(node({ status: "completed", lastPid: 1 })));
		expect(html).toContain("进程 已停止");
		expect(html).not.toContain("进程 未知");
	});

	it("failed：进程画「失败」，原文原因照显示，不换成「崩溃」", () => {
		const html = renderToStaticMarkup(cardOf(node({ status: "failed", statusDetail: "启动后没有挂上 broker" })));
		expect(html).toContain("进程 失败");
		expect(html).toContain("启动后没有挂上 broker");
		expect(html).not.toContain("崩溃");
	});

	it("刚发出、还没有 pid 的那次委派：画「启动中」", () => {
		const html = renderToStaticMarkup(cardOf(node(), { startingChildId: "child-1" }));
		expect(html).toContain("进程 启动中");
		// 别的子会话拿不到这一档
		expect(renderToStaticMarkup(cardOf(node(), { startingChildId: "child-2" }))).toContain("进程 未知");
	});

	it("带回钮的可用性跟着结果状态走（这一次才带回 / 此前已带回）", () => {
		const ready = cardOf(node({ resultRef: "/tmp/r.md" }));
		expect((backButtonOf(ready).props as { disabled?: boolean }).disabled).toBe(false);
		expect(renderToStaticMarkup(ready)).toContain("结果待带回");

		const brought = backButtonOf(cardOf(node({ resultRef: "/tmp/r.md", resultBroughtBackAt: 42 })));
		expect((brought.props as { disabled?: boolean }).disabled).toBe(true);
		expect(String((brought.props as { title?: string }).title)).toContain("此前已带回");
	});

	it("正在带回的那一条才写「带回中…」；别的卡片只是点不动", () => {
		const idle = backButtonOf(cardOf(node({ resultRef: "/tmp/r.md" }), { busy: true }));
		expect((idle.props as { disabled?: boolean }).disabled).toBe(true);
		expect(textOf(idle.props.children as ReactNode)).toContain("带回结果");

		const mine = backButtonOf(cardOf(node({ resultRef: "/tmp/r.md" }), { busy: true, bringingBack: true }));
		expect(textOf(mine.props.children as ReactNode)).toContain("带回中…");
	});
});
