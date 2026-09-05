import { afterEach, describe, expect, it, mock } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import type { SessionSnapshotDto } from "@cornfield/wire";
import type { ReactElement } from "react";
import { getPanels } from "../src/layout/panel-registry";
import { PiClientAdapter, type ServeConnectionConfig } from "../src/state/pi-client-adapter";
import { SessionStore } from "../src/state/session-store";

/**
 * 模型控制中心 #01（骨架与信息架构）回归测试：
 * 1. /models 升级为控制中心壳 + 三个子路由（catalog/providers/config），index 重定向 /models/catalog；
 * 2. 断连态：明确提示 + 重试入口（修「未连接时永久骨架屏」）；
 * 3. 错误暴露：set_model 失败写 store.commandError（修静默吞错），页面渲染可诊断信息；
 * 4. 现有能力（模型目录）整体归位 CatalogView。
 *
 * 测试环境无 DOM：react-router 的 createHashRouter（router.tsx 模块求值）需要最小
 * document/window/history 垫片（真路由只求值不导航）；渲染断言用 react-dom/server
 * 直渲「真路由表」导出的 modelsRoutes（memory router），use-session 以等价 hook 替身
 * （renderToStaticMarkup 下 useSyncExternalStore 缺 getServerSnapshot 会抛错）。
 */

// ── 最小 DOM 垫片（仅满足 createHashHistory 求值读取；导航测试走 memory router）──
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

// ── use-session 的 SSR 替身：直读测试 store 快照（订阅契约本身由 useSyncExternalStore 保证）──
let testStore: SessionStore = new SessionStore();
mock.module("../src/state/use-session", () => ({
	useSession: () => testStore.getSnapshot(),
}));

// ── 模块导入（垫片与 mock 之后；react-router-dom 的 matchRoutes 一并取用）──
const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { createMemoryRouter, matchRoutes, Navigate, RouterProvider } = await import("react-router-dom");
const { findPageMeta, modelsRoutes } = await import("../src/router");
const { ModelsView } = await import("../src/pages/models/ModelsView");
const { CatalogView } = await import("../src/pages/models/CatalogView");
const { ProvidersView } = await import("../src/pages/models/ProvidersView");
const { RuntimeConfigView } = await import("../src/pages/models/RuntimeConfigView");

// ── FakeWebSocket（与 session-store-serve-fix.test.ts 同一模式）──
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
const config: ServeConnectionConfig = { wsUrl: "ws://127.0.0.1:1/ws", token: "" };

afterEach(() => {
	for (const adapter of createdAdapters) adapter.disconnect();
	createdAdapters.length = 0;
});

/** 解析已发出的 request 帧（不含 hello/ping）。 */
function sentRequests(): Array<{ id: string; command: Record<string, unknown> }> {
	return (lastCreated?.sent ?? [])
		.map(s => JSON.parse(s) as { type?: string; id?: string; command?: Record<string, unknown> })
		.filter(
			(f): f is { id: string; command: Record<string, unknown> } => f.type === "request" && !!f.id && !!f.command,
		);
}

/** 用当前最新 request 帧的 id 回失败响应。 */
function respondError(error: string): void {
	const reqs = sentRequests();
	lastCreated?.receive(JSON.stringify({ type: "response", id: reqs[reqs.length - 1]!.id, ok: false, error }));
}

/** 新建 store（未连接）。 */
function freshStore(): SessionStore {
	lastCreated = undefined;
	const adapter = new PiClientAdapter(config, fakeCtor);
	createdAdapters.push(adapter);
	testStore = new SessionStore();
	testStore.init(adapter);
	return testStore;
}

/** 新建 store 并完成 hello 握手（已连接）。 */
async function createConnectedStore(): Promise<SessionStore> {
	const store = freshStore();
	const connectPromise = store.connect();
	lastCreated?.onopen?.({});
	lastCreated?.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1 }));
	await connectPromise;
	return store;
}

/** 推一条权威快照（设置当前会话模型）。 */
function pushSnapshot(modelId: string): void {
	const snapshot: SessionSnapshotDto = {
		seq: 2,
		phase: "idle",
		retryAttempt: 0,
		isCompacting: false,
		isStreaming: false,
		sessionId: "sess-1",
		sessionName: "default",
		model: { provider: "narwal-plan", id: modelId, name: modelId },
		messages: [],
		messageEntryIds: {},
		todoPhases: [],
		activeToolNames: [],
		queuedMessageCount: 0,
		autoCompactionEnabled: false,
		autoRetryEnabled: false,
	};
	lastCreated?.receive(
		JSON.stringify({ type: "push", event: { type: "session_snapshot", sessionId: "default", snapshot } }),
	);
}

/** 用真路由表导出的 modelsRoutes 建记忆路由并 SSR 直渲指定路径。 */
function renderAt(path: string): string {
	const router = createMemoryRouter(modelsRoutes, { initialEntries: [path] });
	return renderToStaticMarkup(React.createElement(RouterProvider, { router }));
}

/** 路由匹配（叶子 match 的 React 元素取出）。 */
function leafElementOf(path: string): { match: ReturnType<typeof matchRoutes> | null; el: ReactElement | undefined } {
	const matches = matchRoutes(modelsRoutes, path);
	const el = matches?.at(-1)?.route.element as ReactElement | undefined;
	return { match: matches, el };
}

describe("模型控制中心：路由骨架", () => {
	it("/models 重定向到 /models/catalog（index → Navigate replace）", () => {
		const { match, el } = leafElementOf("/models");
		expect(match?.at(-1)?.route.index).toBe(true);
		expect(el?.type).toBe(Navigate);
		expect(el?.props).toMatchObject({ to: "/models/catalog", replace: true });
		// /models 壳 = ModelsView（控制中心），子路由挂在它下面
		const parentEl = match?.[0]?.route.element as ReactElement | undefined;
		expect(parentEl?.type).toBe(ModelsView);
	});

	it("三个子路由可达：路由表映射 + 真实导航", async () => {
		const cases = [
			{ path: "/models/catalog", view: CatalogView, segment: "catalog" },
			{ path: "/models/providers", view: ProvidersView, segment: "providers" },
			{ path: "/models/config", view: RuntimeConfigView, segment: "config" },
		] as const;
		for (const c of cases) {
			const { el } = leafElementOf(c.path);
			expect(el?.type).toBe(c.view);
		}
		// 真实导航：memory router 上逐个 navigate，location 与匹配段随动
		const router = createMemoryRouter(modelsRoutes, { initialEntries: ["/models/catalog"] });
		for (const c of cases) {
			await router.navigate(c.path);
			expect(router.state.location.pathname).toBe(c.path);
			expect(router.state.matches.at(-1)?.route.path).toBe(c.segment);
		}
	});

	it("panel 注册表与页面 meta 更新为「模型控制中心」，子路径回退匹配 /models", () => {
		expect(getPanels().find(p => p.id === "models")?.title).toBe("模型控制中心");
		const meta = findPageMeta("/models/catalog");
		expect(meta?.id).toBe("models");
		expect(meta?.name).toBe("模型控制中心");
	});
});

describe("模型控制中心：断连态（修永久骨架屏）", () => {
	it("未连接：壳渲染明确断连提示与重试入口，不渲染骨架屏与目录内容", () => {
		freshStore();
		const html = renderAt("/models/catalog");
		expect(html).toContain("与 serve 未连接");
		expect(html).toContain("重试连接");
		expect(html).not.toContain("skeleton");
		// 子路由出口被断连提示替代（目录本体不渲染）
		expect(html).not.toContain("停用 provider 或单模型在列表内操作");
	});
});

describe("模型控制中心：状态条与子工作区渲染", () => {
	it("连接后：状态条显示当前会话模型（serve 快照）", async () => {
		const store = await createConnectedStore();
		pushSnapshot("deepseek-v4-flash");
		const html = renderAt("/models/catalog");
		expect(html).toContain("当前会话模型");
		expect(html).toContain("deepseek-v4-flash");
		expect(store.getSnapshot().model).toBe("deepseek-v4-flash");
	});

	it("三个子工作区出口渲染（目录归位 + 两个占位壳）", async () => {
		await createConnectedStore();
		expect(renderAt("/models/catalog")).toContain("模型目录");
		expect(renderAt("/models/providers")).toContain("Provider 管理");
		expect(renderAt("/models/config")).toContain("运行时配置");
	});
});

describe("模型控制中心：错误暴露（修静默吞错）", () => {
	it("set_model 失败：错误写入 store.commandError 并渲染可诊断信息 + 清除入口", async () => {
		const store = await createConnectedStore();
		store.setModel("openai/gpt-x", "openai");
		respondError("model not found: openai/gpt-x");
		await Bun.sleep(0);

		expect(store.getSnapshot().commandError).toContain("model not found: openai/gpt-x");
		const html = renderAt("/models/catalog");
		expect(html).toContain("model not found: openai/gpt-x");
		expect(html).toContain("清除");
	});

	it("fetchModels 失败向上抛错（目录据此渲染错误态 + 重试）", async () => {
		await createConnectedStore();
		const promise = testStore.fetchModels();
		respondError("models unavailable");
		expect(promise).rejects.toThrow("models unavailable");
	});
});
