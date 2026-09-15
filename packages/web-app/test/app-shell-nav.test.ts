import { describe, expect, it } from "bun:test";
import type { AgentInfoDto } from "@cornfield/wire";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { AgentSwitcher } from "../src/layout/AgentSwitcher";
import { AppShell } from "../src/layout/AppShell";
import { NotFoundView } from "../src/layout/NotFoundView";
import { ProjectSwitcher } from "../src/layout/ProjectSwitcher";
import { activePanelOf, getPanels, panelHandle } from "../src/layout/panel-registry";
import type { ProjectRecordDto } from "../src/lib/pi-client-api";
import { WorkspaceView } from "../src/pages/workspace/WorkspaceView";
import type { SessionView } from "../src/state/session-store";

/**
 * T10D：Navigation 与 AppShell 收口。
 *
 * 三件事在这里被钉住：
 *   1. **一份元数据**：panelRegistry 是导航 + 路由 + 外壳的唯一来源；路由表的每个元素就是
 *      面板 mount 出来的组件，旧的 PAGE_META / findPageMeta 不再存在（深链与刷新因此走同一条路）。
 *   2. **路由上下文**：当前面板由匹配链上的 handle 解析 —— 子路由（/models/catalog、
 *      /records/:id）命中自己的面板，没人认领的路径不会冒充某个面板。
 *   3. **上下文控件**：Agent / Project 两个控件各自只读自己的来源，三种「没有」
 *      （未连接 / 未声明 / 未归属、读不到）不会被说成同一件事；外壳不代管工作台操作。
 *
 * 本文件不 mock 任何模块：两个 Switcher 是无 hook 的纯函数组件（直接调用即可拿到元素树、
 * 触发 onChange/onClick），AppShell 只读路由匹配链与注册表，不需要会话 store。
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

const { renderToStaticMarkup } = await import("react-dom/server");
const { createMemoryRouter, matchRoutes, RouterProvider } = await import("react-router-dom");
const { appRoutes } = await import("../src/router");

// ── 测试替身 ─────────────────────────────────────────────────────────

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

	it("侧栏分组来自注册表（primary 若干 + bottom 设置）", () => {
		const primary = getPanels().filter(p => p.group === "primary");
		const bottom = getPanels().filter(p => p.group === "bottom");
		expect(primary.length).toBeGreaterThan(5);
		expect(bottom.map(p => p.id)).toEqual(["settings"]);
	});

	it("旧元数据（PAGE_META / findPageMeta / PageMeta）已经删掉，没有第二份路径→标题表", async () => {
		const routerModule = (await import("../src/router")) as Record<string, unknown>;
		expect(routerModule.PAGE_META).toBeUndefined();
		expect(routerModule.findPageMeta).toBeUndefined();
	});
});

// ── 2. 路由上下文：深链、刷新、子路由归属 ─────────────────────────────

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
		expect(html).toContain('CornField 多端前端 <span class="text-ink">技能</span>');
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
	it("读得到并已归属：chip 是项目名，清单标出「当前」与 root", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ projects: PROJECTS, currentProjectId: "dtc" }),
			}),
		);
		expect(html).toContain(">DTC</b>");
		expect(html).toContain("当前");
		expect(html).toContain("/Users/me/cornfield");
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

	it("归属还没算完：显示读取中，绝不显示「未归属」（那是一个尚未计算的答案）", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, { view: viewOf({ projects: PROJECTS, projectsPending: true }) }),
		);
		expect(html).toContain(">…</b>");
		expect(html).not.toContain("未归属");
	});

	it("确实没声明过：说清是空集，并给出声明文件路径", () => {
		const html = renderToStaticMarkup(createElement(ProjectSwitcher, { view: viewOf({ projects: [] }) }));
		expect(html).toContain(">未声明</b>");
		expect(html).toContain("~/.cornfield/agent/projects.json");
	});

	it("声明了但当前会话不在其中：显示未归属，而不是未声明", () => {
		const html = renderToStaticMarkup(
			createElement(ProjectSwitcher, { view: viewOf({ projects: PROJECTS, currentProjectId: undefined }) }),
		);
		expect(html).toContain(">未归属</b>");
		expect(html).not.toContain("未声明");
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

		let refreshed = 0;
		const tree = ProjectSwitcher({ view: viewOf({ projects: [] }), onRefresh: () => (refreshed += 1) });
		fire(tree, "button", "onClick", undefined);
		expect(refreshed).toBe(1);
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

	it("Agent 数量变化不影响 Project 读数（客户端 scope 不随 Agent 变）", () => {
		const withAgents = renderToStaticMarkup(
			createElement(ProjectSwitcher, {
				view: viewOf({ agents: AGENTS, projects: PROJECTS, currentProjectId: "dtc" }),
			}),
		);
		const withoutAgents = renderToStaticMarkup(
			createElement(ProjectSwitcher, { view: viewOf({ agents: [], projects: PROJECTS, currentProjectId: "dtc" }) }),
		);
		expect(withAgents).toBe(withoutAgents);
	});

	it("未连接时两个控件各自说各自的「未连接」，都不编造内容", () => {
		const view = viewOf({ connected: false, projects: undefined });
		expect(renderToStaticMarkup(createElement(AgentSwitcher, { view, onSelect: noop }))).toContain("未连接");
		expect(renderToStaticMarkup(createElement(ProjectSwitcher, { view }))).toContain(
			"未连接——Project registry 不可用",
		);
	});
});
