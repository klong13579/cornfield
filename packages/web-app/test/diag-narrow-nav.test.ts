import { describe, expect, it } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { SidebarAgentContext, SidebarNav } from "../src/layout/AppSidebar";
import { MobileNavPanel } from "../src/layout/MobileNav";
import { getPanelGroups, getPanels } from "../src/layout/panel-registry";
import type { SessionView } from "../src/state/session-store";

/**
 * T7：窄屏主导航可达。
 *
 * 桌面侧栏（AppSidebar 的 <nav aria-label="主导航">）在 <md 断点下 `display:none`，窄屏
 * （390 宽）从此找不到任何一级导航入口。MobileNavPanel 是那个入口：右上角固定汉堡钮 + 从左
 * 侧滑出的抽屉，抽屉里画的是**同一份**注册表导航（SidebarNav + getPanelGroups），不是另抄的
 * 面板表。
 *
 * 测试策略与 app-shell-nav.test.ts 同一套：直接调用无 hook 的组件函数拿到元素树、触发
 * onClick；不 SSR 含 NavLink 的树（NavLink 的 useLocation 只在 Router 上下文里能用）。
 * MobileNavPanel 本身无 hook（view 由参数进），可直接调用。
 */

// ── 最小 DOM 垫片（../src/router 模块求值里 createHashRouter 会读 window/history；
//    只有它需要，MobileNavPanel 本身不碰浏览器 API）──
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
const { NavLink } = await import("react-router-dom");
// 副作用：注册 12 个面板（getPanelGroups / MobileNavPanel 抽屉要读这份注册表）。
await import("../src/router");

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
		attachmentAddress: "",
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
		agentTodosPending: false,
		gitChangesPending: false,
		...patch,
	};
}

// ── 元素树工具（直接调用组件函数得到的就是普通元素树）──

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

function propsOf(el: ReactElement): Record<string, unknown> {
	return el.props as Record<string, unknown>;
}

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
	return "";
}

function findButton(root: ReactNode, ariaLabel: string): ReactElement {
	const found = collect(root).find(el => el.type === "button" && propsOf(el)["aria-label"] === ariaLabel);
	if (!found) throw new Error(`元素树里没有 aria-label=「${ariaLabel}」的 <button>`);
	return found;
}

function fireClick(el: ReactElement): void {
	const onClick = propsOf(el).onClick;
	if (typeof onClick !== "function") throw new Error(`元素上没有 onClick：${String(el.type)}`);
	onClick();
}

const NAV_TITLES = [
	"首页",
	"会话工作台",
	"会话记录",
	"Agent 总览",
	"Skills",
	"Memory",
	"Todo",
	"模型",
	"语音",
	"定时任务",
	"用量",
	"设置",
];

describe("MobileNavPanel：窄屏主导航入口", () => {
	const view = viewOf({ connected: false });

	it("关闭态只有入口钮（aria-label=打开主导航、md:hidden、aria-expanded=false），没有抽屉与遮罩", () => {
		const tree = MobileNavPanel({ view, open: false, onToggle: noop, onClose: noop });
		const toggle = findButton(tree, "打开主导航");
		expect(String(propsOf(toggle).className)).toContain("md:hidden");
		expect(propsOf(toggle)["aria-expanded"]).toBe(false);
		expect(propsOf(toggle)["aria-controls"]).toBe("mobile-nav");
		// 没展开时抽屉与遮罩都不在
		expect(collect(tree).some(el => el.type === "nav")).toBe(false);
		expect(collect(tree).some(el => propsOf(el)["aria-label"] === "关闭主导航")).toBe(false);
	});

	it("入口钮是原生 button：onClick 触发 onToggle（Enter/Space 由浏览器原生给 button）", () => {
		let toggled = 0;
		const tree = MobileNavPanel({ view, open: false, onToggle: () => (toggled += 1), onClose: noop });
		fireClick(findButton(tree, "打开主导航"));
		expect(toggled).toBe(1);
	});

	it("展开态：抽屉是 nav[aria-label=主导航]，且复用同一份共享导航（SidebarNav 4 组 12 面板）", () => {
		const tree = MobileNavPanel({ view, open: true, onToggle: noop, onClose: noop });
		const nav = collect(tree).find(el => el.type === "nav");
		expect(nav).toBeDefined();
		expect(propsOf(nav as ReactElement)["aria-label"]).toBe("主导航");
		expect(String(propsOf(nav as ReactElement).className)).toContain("md:hidden");

		// 抽屉里不是另抄一张面板表：同一个 SidebarNav 组件、同一份 getPanelGroups 事实。
		const sidebarNav = collect(tree).find(el => el.type === SidebarNav);
		expect(sidebarNav).toBeDefined();
		const groups = propsOf(sidebarNav as ReactElement).groups as Array<{ title: string; panels: unknown[] }>;
		expect(groups.map(g => g.title)).toEqual(["工作", "Agent", "能力", "系统"]);
		expect(groups.reduce((n, g) => n + g.panels.length, 0)).toBe(12);
	});

	it("抽屉里的导航链接点中会关抽屉：SidebarNav 的 onNavigate 接的是 onClose", () => {
		const onClose = (): void => {};
		const tree = MobileNavPanel({ view, open: true, onToggle: noop, onClose });
		const sidebarNav = collect(tree).find(el => el.type === SidebarNav);
		expect(propsOf(sidebarNav as ReactElement).onNavigate).toBe(onClose);
	});

	it("遮罩点击与关闭钮都关抽屉", () => {
		let closed = 0;
		const tree = MobileNavPanel({ view, open: true, onToggle: noop, onClose: () => (closed += 1) });
		fireClick(findButton(tree, "关闭主导航"));
		expect(closed).toBe(1);
		const backdrop = collect(tree).find(
			el =>
				el.type === "div" &&
				propsOf(el)["aria-hidden"] === true &&
				String(propsOf(el).className).includes("bg-ink/30"),
		);
		expect(backdrop).toBeDefined();
		fireClick(backdrop as ReactElement);
		expect(closed).toBe(2);
	});

	it("未连接态入口照样可用：入口无 disabled，抽屉的「当前 Agent」块拿到未连接视图", () => {
		const tree = MobileNavPanel({ view, open: true, onToggle: noop, onClose: noop });
		expect(propsOf(findButton(tree, "打开主导航")).disabled).toBeUndefined();
		const ctx = collect(tree).find(el => el.type === SidebarAgentContext);
		expect(ctx).toBeDefined();
		expect((propsOf(ctx as ReactElement).view as SessionView).connected).toBe(false);
	});
});

describe("SidebarNav：共享导航内容不变，且可挂 onNavigate 收尾", () => {
	it("不带 onNavigate 时仍是 4 组 12 条链接（桌面侧栏内容零改动）", () => {
		const tree = SidebarNav({ groups: getPanelGroups() });
		expect(
			collect(tree)
				.filter(el => el.type === NavLink)
				.map(el => propsOf(el)["aria-label"]),
		).toEqual(NAV_TITLES);
		expect(
			collect(tree)
				.filter(el => el.type === "h2")
				.map(el => textOf(propsOf(el).children)),
		).toEqual(["工作", "Agent", "能力", "系统"]);
	});

	it("带 onNavigate 时每条 NavLink 的 onClick 都接到收尾回调", () => {
		let navigated = 0;
		const tree = SidebarNav({ groups: getPanelGroups(), onNavigate: () => (navigated += 1) });
		const links = collect(tree).filter(el => el.type === NavLink);
		expect(links.length).toBe(12);
		for (const link of links) {
			expect(typeof propsOf(link).onClick).toBe("function");
		}
		fireClick(links[0]);
		expect(navigated).toBe(1);
	});
});

describe("SidebarAgentContext：未连接如实说，不与「先选择 Agent」混为一谈", () => {
	it("未连接视图渲染「未连接」，不是「先选择 Agent」", () => {
		const html = renderToStaticMarkup(createElement(SidebarAgentContext, { view: viewOf({ connected: false }) }));
		expect(html).toContain("未连接");
		expect(html).not.toContain("先选择 Agent");
	});
});

describe("面板注册表：抽屉与侧栏读同一份事实", () => {
	it("四个组、共 12 个面板，导航标题与路由一一对应", () => {
		expect(getPanelGroups().map(g => g.title)).toEqual(["工作", "Agent", "能力", "系统"]);
		expect(getPanels().length).toBe(12);
		expect(getPanels().map(p => p.title)).toEqual(NAV_TITLES);
	});
});
