import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { TodoPhaseDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import * as fileWorkflowModule from "../../state/file-workflow-store";
import { EMPTY_FILE_WORKFLOW } from "../../state/file-workflow-store";
import type { SessionView } from "../../state/session-store";
import * as uiStoreModule from "../../state/ui-store";
import { getUiStore } from "../../state/ui-store";
import * as useSessionModule from "../../state/use-session";
import { WorkspaceView } from "./WorkspaceView";

/**
 * 工作台「当前计划」的两条用户决策钉在这里（PlanStrip 自己的四态/进度/点击契约在
 * `test/app-shell-nav.test.ts` 的「当前计划区域」里，不重复）：
 *
 *   1. **默认折叠** —— 本会话已经有计划时，进页面看到的也是折叠态。初值在工作台手上
 *      （组件无 hook）；这里渲的是真工作台，所以钉住的就是「进页面那一眼」。
 *   2. **几何跟着转录列** —— 外层 `px-6` + 内层 `max-w-[1100px]`，与会话框（Transcript）同一段。
 *      自成一套宽度的后果是比会话框窄一截（改前 760：1440 视口下两者左边缘差 170px）。
 *
 * 环境约束同仓库其它渲染用例：`react-dom/server` 静态渲染、无 DOM。所以这里只能钉「初值」与
 * 「标记」；点表头翻转那一步由 PlanStrip 用例用真处理器钉（`fireOnText`）。
 */

const PHASES: TodoPhaseDto[] = [
	{
		name: "第一阶段",
		tasks: [
			{ content: "读任务包", status: "completed" },
			{ content: "写实现", status: "pending" },
		],
	},
];

function viewOf(patch: Partial<SessionView>): SessionView {
	return {
		connected: true,
		reconnecting: false,
		wsUrl: "ws://127.0.0.1:1/ws",
		protocolVersion: 1,
		phase: "idle",
		model: null,
		thinkingLevel: null,
		sessionId: "sess-1",
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
		projectsPending: false,
		agentTodosPending: false,
		gitChangesPending: false,
		...patch,
	};
}

/** 本会话已经跑出计划的那一眼——「默认折叠」说的就是这一眼。 */
const PLAN_VIEW: SessionView = viewOf({ todo: PHASES });

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => PLAN_VIEW);
const useUiStateSpy = spyOn(uiStoreModule, "useUiState").mockImplementation(() => getUiStore().getSnapshot());
const useFileWorkflowSpy = spyOn(fileWorkflowModule, "useFileWorkflow").mockImplementation(() => EMPTY_FILE_WORKFLOW);

afterAll(() => {
	for (const spy of [useSessionSpy, useUiStateSpy, useFileWorkflowSpy]) spy.mockRestore();
});

/** 工作台（compact：侧栏 / 右栏 / 手机预览不进这一屏，留下会话列与计划条）。 */
function renderWorkbench(): string {
	const router = createMemoryRouter(
		[{ path: "/workspace", element: createElement(WorkspaceView, { compact: true }) }],
		{ initialEntries: ["/workspace"] },
	);
	return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("工作台的当前计划条", () => {
	it("默认折叠：本会话有计划，进页面也是折叠态，表头读数照留", () => {
		const html = renderWorkbench();
		expect(html).toContain("当前计划");
		expect(html).toContain("完成 1/2");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('title="展开任务列表"');
		expect(html).not.toContain("读任务包");
		expect(html).not.toContain("写实现");
	});

	it("几何跟着转录列：外层 px-6 + 内层 max-w-[1100px]，与 Transcript 同一段", () => {
		const html = renderWorkbench();
		// 会话框
		expect(html).toContain("mx-auto flex max-w-[1100px] flex-col gap-3");
		// 计划条（外层内缩 24px 与转录区滚动容器同款，内层才是那一列）
		expect(html).toContain('<div class="px-6"><section class="mx-auto mb-1 w-full max-w-[1100px]');
	});
});
