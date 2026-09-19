import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactDto } from "../../lib/pi-client-api";
import type { SessionView } from "../../state/session-store";
import * as sessionStoreModule from "../../state/session-store";
import * as useSessionModule from "../../state/use-session";
import { ArtifactRow, ArtifactsPanel } from "./ArtifactsPanel";

/**
 * 产物面板：三种「没有」不许互相顶替。
 *
 * 这个面板最容易犯的错不是画错，而是**说错**：连不上 serve 或会话身份还没挂载时，
 * 屏幕上写「暂无产物」，用户就会以为 agent 什么都没生成 —— 而真实情况是**根本没问过**。
 * 所以断言全部盯着「屏幕上到底写了哪一句」，与右栏文件/改动两 tab 同句式。
 *
 * 静态渲染（react-dom/server）不跑 effect：`loading` 与两个前提态（未连接 / 未挂载）
 * 都在**渲染时**判定（不是 effect 里补写），所以这三态在这一层就能整份验。
 */

/** 会话身份（焦点附件的地址）：绑了 Project 的会话，地址 != Agent 名。 */
const SESSION_ADDRESS = "hr\u0000/Users/me/work/mika";

let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
// 静态渲染不跑 effect（所以 listArtifacts 不会被调用）；真调用在这里显式失败，别静默通过。
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			listArtifacts: () => Promise.reject(new Error("静态渲染不应读取产物")),
		}) as unknown as ReturnType<typeof sessionStoreModule.useSessionStore>,
);

afterAll(() => {
	useSessionSpy.mockRestore();
	useSessionStoreSpy.mockRestore();
});

function render(input: { connected: boolean; attachmentAddress: string }): string {
	currentView = { isStreaming: false } as SessionView;
	return renderToStaticMarkup(
		createElement(ArtifactsPanel, {
			connected: input.connected,
			attachmentAddress: input.attachmentAddress,
			sessionFile: "/Users/me/.cornfield/agent/sessions/by-date/2026-09-16/143205__a1b2c3d4.jsonl",
		}),
	);
}

describe("ArtifactsPanel 三种「没有」分开显示", () => {
	it("未连接 → 说未连接（不说「暂无产物」，也不闪一下「加载中」）", () => {
		const html = render({ connected: false, attachmentAddress: SESSION_ADDRESS });
		expect(html).toContain("未连接——读不到产物清单");
		expect(html).not.toContain("暂无产物");
		expect(html).not.toContain("加载中");
		expect(html).not.toContain("等待会话挂载");
	});

	it("连上了但会话身份还没挂载 → 说等待挂载，不说没有产物", () => {
		const html = render({ connected: true, attachmentAddress: "" });
		expect(html).toContain("等待会话挂载");
		expect(html).not.toContain("暂无产物");
		expect(html).not.toContain("未连接");
	});

	it("两个前提都在（还没读到）→ 说加载中，不说没有产物", () => {
		const html = render({ connected: true, attachmentAddress: SESSION_ADDRESS });
		expect(html).toContain("加载中");
		expect(html).not.toContain("暂无产物");
	});

	it("三句话互不相同（把它们说成同一句就是这一版修掉的缺陷）", () => {
		const disconnected = render({ connected: false, attachmentAddress: "" });
		const unmounted = render({ connected: true, attachmentAddress: "" });
		const loading = render({ connected: true, attachmentAddress: SESSION_ADDRESS });
		expect(new Set([disconnected, unmounted, loading]).size).toBe(3);
	});
});

/**
 * 产物行：这本账里两种来源都有（agent 写出的文件 + 用户贴进来的图），所以每行必须说清
 * 是谁放进来的。两个标记各管一件事 —— type 决定点开怎么预览，source 说明归属。
 */
describe("ArtifactRow 来源与类型标记", () => {
	function renderRow(overrides: Partial<ArtifactDto>): string {
		return renderToStaticMarkup(
			createElement(ArtifactRow, {
				entry: {
					id: "dashboard.html",
					title: "dashboard.html",
					type: "html",
					source: "agent",
					path: "dashboard.html",
					updatedAt: 0,
					size: 2048,
					...overrides,
				},
				selected: false,
				onOpen: () => undefined,
			}),
		);
	}

	it("用户发进来的行写「我发的」", () => {
		const html = renderRow({ source: "user", title: "uploaded-20260919093439-eca746db.png" });
		expect(html).toContain("我发的");
		expect(html).not.toContain(">agent<");
	});

	it("agent 写出的行写「agent」", () => {
		const html = renderRow({ source: "agent" });
		expect(html).toContain(">agent<");
		expect(html).not.toContain("我发的");
	});

	it("类型标记仍在（两个标记不互相顶替）", () => {
		const html = renderRow({ source: "user", type: "image", title: "a.png" });
		expect(html).toContain(">image<");
		expect(html).toContain("我发的");
	});

	it("标题与大小都看得见", () => {
		const html = renderRow({ title: "dashboard.html", size: 2048 });
		expect(html).toContain("dashboard.html");
		expect(html).toContain("2K");
	});
});
