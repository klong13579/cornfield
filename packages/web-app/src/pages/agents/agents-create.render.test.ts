import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { PiServerError } from "@cornfield/client";
import type { AgentCreateDto, AgentCreateInput, AgentInfoDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionView } from "../../state/session-store";
import * as sessionStoreModule from "../../state/session-store";
import * as useSessionModule from "../../state/use-session";
import { AgentsView } from "./AgentsView";
import {
	CreateAgentPanel,
	type CreateAgentPhase,
	type CreateAgentSubmitter,
	createAgentInputOf,
	EMPTY_CREATE_AGENT_VALUES,
	submitCreateAgent,
} from "./CreateAgentPanel";

/**
 * F1「前端能建 agent」的渲染级单测。
 *
 * 钉的是三件事（都在静态渲染这一层就能验）：
 *   1. 表单值 → 命令入参的转换（空串 = 不指定，不是「一个空目录」）；
 *   2. 提交失败时**面板上写的是 serve 的原文**，不是一句自己编的「创建失败」；
 *      `created:false` 的那次成功也不许被说成「已创建」（它是「本来就在，补齐了缺的文件」）；
 *   3. 列表页两个入口都在，且空态不再教用户「去 agents 目录里建」（那句在有了入口之后就是假话）。
 *
 * 静态渲染不跑 effect、不派发事件，所以「点一下真的建出来」由 e2e
 * （test/e2e/agent-create.spec.ts，真 serve + 真 dist + 真 Chrome）证明；这里只证明提交的
 * 语义与屏上写的字。
 *
 * 依赖替换用 `spyOn` 打在模块对象上（bun:test 的 `mock.module` 会改全局模块注册表、跨测试文件
 * 泄漏，仓库硬约束禁用），afterAll 还原。
 */

// ── 最小 DOM 垫片（react-router-dom / react-router 求值时读 window/history）──
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

const { MemoryRouter } = await import("react-router-dom");

const HR_AGENT: AgentInfoDto = {
	id: "hr-bot",
	name: "hr-bot",
	face: "H",
	workspace: "hr-bot",
	kind: "worker",
	status: "stopped",
};

let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
// 静态渲染不跑 effect：store 只需要存在（真被调用就会显式失败，不会被静默当成「没数据」）。
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			fetchAgents: () => Promise.reject(new Error("静态渲染不应拉 agent 列表")),
			gatewayStatus: () => Promise.reject(new Error("静态渲染不应拉 gateway 状态")),
		}) as unknown as ReturnType<typeof sessionStoreModule.useSessionStore>,
);

afterAll(() => {
	useSessionSpy.mockRestore();
	useSessionStoreSpy.mockRestore();
});

function viewOf(patch: Partial<SessionView>): SessionView {
	currentView = {
		connected: true,
		reconnecting: false,
		wsUrl: "ws://127.0.0.1:1/ws",
		protocolVersion: 1,
		phase: "idle",
		model: null,
		thinkingLevel: null,
		sessionId: "",
		attachmentAddress: "default",
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
		agentTodosPending: false,
		gitChangesPending: false,
		projectsPending: false,
		...patch,
	};
	return currentView;
}

// ── 表单值 → 命令入参 ────────────────────────────────────────────────

describe("createAgentInputOf", () => {
	it("空串 = 不指定：不把空目录/空 mission 送到 serve", () => {
		const input = createAgentInputOf({ name: "  hr-bot ", dir: "", mission: "   " });
		expect(input).toEqual({ name: "hr-bot" });
		expect("dir" in input).toBe(false);
		expect("mission" in input).toBe(false);
	});

	it("填了就原样带上（不在这一层拼路径、不改写）", () => {
		expect(createAgentInputOf({ name: "ops", dir: "/srv/agents", mission: "/tmp/mission.md" })).toEqual({
			name: "ops",
			dir: "/srv/agents",
			mission: "/tmp/mission.md",
		});
	});
});

// ── 提交：成功带读数，失败带 serve 原文 ──────────────────────────────

const CREATED: AgentCreateDto = {
	name: "hr-bot",
	agentDir: "/Users/me/.cornfield/agents/hr-bot",
	created: true,
	filesWritten: 12,
};

function recordingSubmitter(result: AgentCreateDto | Error): {
	submitter: CreateAgentSubmitter;
	calls: AgentCreateInput[];
} {
	const calls: AgentCreateInput[] = [];
	return {
		calls,
		submitter: {
			createAgent: async (input: AgentCreateInput) => {
				calls.push(input);
				if (result instanceof Error) throw result;
				return result;
			},
		},
	};
}

describe("submitCreateAgent", () => {
	it("成功：调 adapter 一次，带的就是表单里的那三个字段，结果原样上抛", async () => {
		const { submitter, calls } = recordingSubmitter(CREATED);
		const outcome = await submitCreateAgent(submitter, { name: "hr-bot", dir: "", mission: "" });
		expect(calls).toEqual([{ name: "hr-bot" }]);
		expect(outcome).toEqual({ ok: true, agent: CREATED });
	});

	it('serve 拒绝：带出的是**服务端原文**（不是客户端包的 `Server rejected "…"` 前缀）', async () => {
		const server = new PiServerError(
			"create_agent",
			"Invalid agent name: \"../escape\". Names cannot contain '..' segments.",
		);
		const { submitter } = recordingSubmitter(server);
		const outcome = await submitCreateAgent(submitter, { name: "../escape", dir: "", mission: "" });
		expect(outcome.ok).toBe(false);
		expect(outcome.ok ? "" : outcome.message).toBe(
			"Invalid agent name: \"../escape\". Names cannot contain '..' segments.",
		);
	});

	it("不是 serve 的判决（断线/超时）也说它自己的话，不改写成「创建失败」", async () => {
		const { submitter } = recordingSubmitter(new Error("WebSocket disconnected before response arrived"));
		const outcome = await submitCreateAgent(submitter, { name: "hr-bot", dir: "", mission: "" });
		expect(outcome.ok ? "" : outcome.message).toBe("WebSocket disconnected before response arrived");
	});
});

// ── 面板：三态 +「另一种成功」分得开 ────────────────────────────────

function renderPanel(phase: CreateAgentPhase, values = EMPTY_CREATE_AGENT_VALUES): string {
	return renderToStaticMarkup(
		createElement(CreateAgentPanel, {
			values,
			phase,
			onChange: () => undefined,
			onSubmit: () => undefined,
			onClose: () => undefined,
			onOpenAgent: () => undefined,
		}),
	);
}

describe("CreateAgentPanel 的提交状态", () => {
	it("idle：三个字段都在，名字为空时创建按钮按不动", () => {
		const html = renderPanel({ kind: "idle" });
		expect(html).toContain('id="create-agent-name"');
		expect(html).toContain('id="create-agent-dir"');
		expect(html).toContain('id="create-agent-mission"');
		expect(html).toMatch(/<button[^>]*disabled[^>]*>创建<\/button>/);
		expect(html).not.toContain("已创建");
	});

	it("submitting：按钮禁用 + 说明进行中，不显示任何结论", () => {
		const html = renderPanel({ kind: "submitting" }, { name: "hr-bot", dir: "", mission: "" });
		expect(html).toContain("创建中…");
		expect(html).toContain("正在创建 hr-bot");
		expect(html).not.toContain("已创建");
		expect(html).not.toContain("serve 的答复（原文）");
	});

	it("failed：屏上是 serve 的原文（逐字），表单还在（名字可以改完重提）", () => {
		const message = "Invalid agent name: \"../escape\". Names cannot contain '..' segments.";
		const html = renderPanel({ kind: "failed", message }, { name: "../escape", dir: "", mission: "" });
		expect(html).toContain("serve 的答复（原文）");
		expect(html).toContain(
			"Invalid agent name: &quot;../escape&quot;. Names cannot contain &#x27;..&#x27; segments.",
		);
		expect(html).toContain('id="create-agent-name"');
		expect(html).not.toContain("创建中…");
	});

	it("existing（created:false）：说清是「本来就在、补齐了缺的文件」，不冒充新建", () => {
		const html = renderPanel(
			{ kind: "existing", agent: { ...CREATED, created: false, filesWritten: 0 } },
			{ name: "hr-bot", dir: "", mission: "" },
		);
		expect(html).toContain("本来就在");
		expect(html).toContain(CREATED.agentDir);
		expect(html).toContain("打开详情");
		expect(html).not.toContain("创建中…");
	});
});

// ── 列表页的两个入口 ────────────────────────────────────────────────

function renderAgentsView(agents: AgentInfoDto[]): string {
	viewOf({ agents });
	return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AgentsView)));
}

describe("AgentsView 的创建入口", () => {
	it("空态：入口在，且不再教用户「去 agents 目录里建」", () => {
		const html = renderAgentsView([]);
		expect(html).toContain("还没有 agent。");
		expect(html).toContain("创建员工");
		expect(html).not.toContain("在 agents 目录创建");
	});

	it("有 agent：筛选行右侧的入口在，空态不显示", () => {
		const html = renderAgentsView([HR_AGENT]);
		expect(html).toContain("创建员工");
		expect(html).not.toContain("还没有 agent。");
	});

	it("默认不开表单（入口点了才开）", () => {
		expect(renderAgentsView([HR_AGENT])).not.toContain('id="create-agent-name"');
	});
});
