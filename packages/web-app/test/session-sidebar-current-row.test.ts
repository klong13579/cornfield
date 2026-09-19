import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type CurrentRow, SessionRow, type SidebarRow, sessionRowAction } from "../src/pages/workspace/SessionSidebar";

/**
 * 会话侧栏「当前会话」那一行的点击语义与文案。
 *
 * 缺陷的形状：点别的会话进了回放，再点顶上「当前会话」**没有任何反应** —— 那一行的 `onClick`
 * 当时是 `undefined`。三种行三件事，这一组把三支都钉住，并且钉住回放态下这一行**要画成可点的
 * 样子**（不然用户还是不知道能点回去）。
 *
 * 静态渲染（react-dom/server）不跑 effect，所以 `SessionRow` 是纯展示的：props 进、标记出。
 */

const HISTORY_ROW: SidebarRow = {
	id: "h1",
	name: "昨天的会话",
	agent: "hr",
	startedAt: "2026-09-15T10:00:00.000Z",
	messageCount: 3,
	status: "completed",
	source: "agent",
};

const LIVE_CURRENT: CurrentRow = { id: "live", name: "实时会话", agent: "attached", current: true };
const PLAYBACK_CURRENT: CurrentRow = { ...LIVE_CURRENT, playback: true };

describe("sessionRowAction：哪种行做哪件事", () => {
	function recorder(): { calls: string[]; actions: Parameters<typeof sessionRowAction>[1] } {
		const calls: string[] = [];
		return {
			calls,
			actions: {
				openHistorySession: record => void calls.push(`open:${record.id}`),
				returnToLiveSession: () => void calls.push("live"),
			},
		};
	}

	it("历史会话 → 打开回放", () => {
		const { calls, actions } = recorder();
		sessionRowAction(HISTORY_ROW, actions)?.();
		expect(calls).toEqual(["open:h1"]);
	});

	it("当前会话（实时）→ 没有动作（点它就是「我本来就在这」）", () => {
		const { actions } = recorder();
		expect(sessionRowAction(LIVE_CURRENT, actions)).toBeUndefined();
	});

	it("当前会话（回放中）→ 回到实时", () => {
		const { calls, actions } = recorder();
		sessionRowAction(PLAYBACK_CURRENT, actions)?.();
		expect(calls).toEqual(["live"]);
	});
});

describe("SessionRow 文案：回放态那一行要看得出来能点回去", () => {
	function render(row: SidebarRow): string {
		return renderToStaticMarkup(
			createElement(SessionRow, {
				row,
				pinned: false,
				active: false,
				onTogglePin: () => undefined,
				onClick: sessionRowAction(row, {
					openHistorySession: () => undefined,
					returnToLiveSession: () => undefined,
				}),
			}),
		);
	}

	it("实时：只说「当前会话」", () => {
		const html = render(LIVE_CURRENT);
		expect(html).toContain("当前会话");
		expect(html).toContain('title="当前会话"');
		expect(html).not.toContain("回放中");
	});

	it("回放中：说「回放中 · 点这里回到实时」，title 说清点它干什么", () => {
		const html = render(PLAYBACK_CURRENT);
		expect(html).toContain("回放中 · 点这里回到实时");
		expect(html).toContain('title="回到实时会话"');
		// 名字照旧是实时那条 —— 这一行回答的是「回哪去」，不是「现在在看什么」
		expect(html).toContain("实时会话");
	});

	it("历史会话：照旧说「打开会话」，不掺回放字样", () => {
		const html = render(HISTORY_ROW);
		expect(html).toContain("打开会话");
		expect(html).toContain("hr");
		expect(html).not.toContain("回放中");
	});
});
