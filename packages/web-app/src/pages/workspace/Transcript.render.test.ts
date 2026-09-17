import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { AgentInfoDto } from "@cornfield/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionView, TranscriptMessage } from "../../state/session-store";
import * as sessionStoreModule from "../../state/session-store";
import * as useSessionModule from "../../state/use-session";
import { TRANSCRIPT_FOLLOW_THRESHOLD_PX, Transcript, TranscriptFollow } from "./Transcript";

/**
 * 转录区两件事被钉在这里：
 *   1. **轮间距**：行间距 gap-3 / 顶部 pt-5 —— 断言整个 class 串，不接受「含有 gap-3」
 *      这种到处都成立的写法（用户消息行自己就是 `gap-3`）。
 *   2. **贴底跟随**：用户的滚动事件是唯一真相来源。回归对象是「往上翻之后被新消息拉回底部」。
 *
 * 为什么贴底行为用一个纯对象（TranscriptFollow）而不是渲染整个组件来测：这套测试环境
 * 没有 DOM（全仓 web-app 用的是 react-dom/server 静态渲染，不跑 effect，也没有 happy-dom /
 * jsdom 之类的依赖），而 scrollHeight / clientHeight 在字符串渲染里根本不存在。
 * TranscriptFollow 就是组件 onScroll 与 effect 各自调到的那份状态，两个调用点各一行。
 */

const HR_AGENT: AgentInfoDto = {
	id: "hr",
	name: "HR 助手",
	face: "H",
	workspace: "hr",
	kind: "worker",
	status: "idle",
	agentDir: "/Users/me/.cornfield/agents/hr",
	active: true,
};

const USER_MSG: TranscriptMessage = { id: "u1", role: "user", text: "帮我看下这个工单", tools: [], done: true };

const ASSISTANT_MSG: TranscriptMessage = {
	id: "a1",
	role: "assistant",
	model: "claude-opus-4-6",
	text: "看完了，结论是……",
	tools: [],
	done: true,
};

/** 在途的 live 行（内容还在生成，尚无 entryId）。 */
const LIVE_MSG: TranscriptMessage = {
	id: "live-1",
	role: "assistant",
	model: "claude-opus-4-6",
	thinking: "在想……",
	thinkingStreaming: true,
	tools: [],
	done: false,
};

let currentView: SessionView;

const useSessionSpy = spyOn(useSessionModule, "useSession").mockImplementation(() => currentView);
// 静态渲染不跑 effect，也不点任何操作条：真调用在这里显式失败，别静默通过。
const useSessionStoreSpy = spyOn(sessionStoreModule, "useSessionStore").mockImplementation(
	() =>
		({
			forkFrom: () => {
				throw new Error("静态渲染不应分叉");
			},
			undoExchange: () => {
				throw new Error("静态渲染不应撤销");
			},
			retryFrom: () => {
				throw new Error("静态渲染不应重试");
			},
			abortRetry: () => {
				throw new Error("静态渲染不应重试");
			},
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
		sessionId: "s-1",
		sessionName: "转录区",
		attachmentAddress: "hr",
		messages: [],
		messageEntryIds: {},
		isStreaming: false,
		activeToolNames: [],
		queued: 0,
		todo: [],
		flags: { autoCompaction: false, autoRetry: false },
		agents: [HR_AGENT],
		env: null,
		activeAgentId: "hr",
		historyLoading: false,
		sessionTreeLoading: false,
		agentTodosPending: false,
		gitChangesPending: false,
		projectsPending: false,
		...patch,
	};
	return currentView;
}

function render(patch: Partial<SessionView>): string {
	viewOf(patch);
	return renderToStaticMarkup(createElement(Transcript));
}

/** 把整页 HTML 按行容器拆开：0 = user 行，1 = assistant（/live）行。 */
function rowsOf(html: string): string[] {
	return html.split('<div class="msg-row').slice(1);
}

/** 这一行里「灰着」的按钮各写着什么 title（不依赖属性顺序）。 */
function disabledTitlesIn(row: string): string[] {
	return [...row.matchAll(/<button[^>]*>/g)]
		.map(match => match[0])
		.filter(tag => tag.includes(" disabled"))
		.map(tag => /title="([^"]*)"/.exec(tag)?.[1] ?? "");
}

describe("Transcript 轮间距与顶部留白", () => {
	it("行容器收紧到 gap-3，顶部 pt-5，底部 pb-3 不动", () => {
		const html = render({ messages: [USER_MSG, ASSISTANT_MSG] });
		expect(html).toContain("min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-3");
		expect(html).toContain("mx-auto flex max-w-[1100px] flex-col gap-3");
		// 反向回归：旧的 gap-7 / pt-7 不得残留（含它们的其它节点也不该出现在转录区）
		expect(html).not.toContain("gap-7");
		expect(html).not.toContain("pt-7");
	});

	it("空会话照样是同一套容器（间距不靠消息撑出来）", () => {
		const html = render({ messages: [] });
		expect(html).toContain("min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-3");
		expect(html).toContain("mx-auto flex max-w-[1100px] flex-col gap-3");
	});
});

describe("TranscriptFollow 贴底跟随（用户的滚动事件是唯一真相来源）", () => {
	/** 视口 600、内容 3000 的滚动盒子。 */
	const boxAt = (scrollTop: number): { scrollHeight: number; scrollTop: number; clientHeight: number } => ({
		scrollHeight: 3000,
		scrollTop,
		clientHeight: 600,
	});

	it("初始即贴底：首次内容到达滚到底部", () => {
		const box = boxAt(0);
		new TranscriptFollow().contentChanged(box);
		expect(box.scrollTop).toBe(3000);
	});

	it("往上翻之后，新消息到达不改变 scrollTop", () => {
		const follow = new TranscriptFollow();
		const box = boxAt(0);
		follow.contentChanged(box); // 首屏贴底
		expect(box.scrollTop).toBe(3000);

		box.scrollTop = 900; // 用户往上翻（距底 1500 > 阈值）
		follow.userScrolled(box);

		box.scrollHeight = 3400; // 新消息 / 流式 delta 让内容变长
		follow.contentChanged(box);

		expect(box.scrollTop).toBe(900); // 原地不动，不被拉回底部
	});

	it("连着来多条也不拉回（滚动状态不会被内容变化重新判定成贴底）", () => {
		const follow = new TranscriptFollow();
		const box = boxAt(0);
		follow.contentChanged(box);

		box.scrollTop = 900;
		follow.userScrolled(box);

		for (const height of [3200, 3400, 4100]) {
			box.scrollHeight = height;
			follow.contentChanged(box);
		}
		expect(box.scrollTop).toBe(900);
	});

	it("在底部时新消息到达仍贴底（反向回归）", () => {
		const follow = new TranscriptFollow();
		const box = boxAt(2400); // 2400 + 600 = 3000，正贴底
		follow.userScrolled(box);

		box.scrollHeight = 3600;
		follow.contentChanged(box);

		expect(box.scrollTop).toBe(3600);
	});

	it("内容变短（压缩）也不会把它重新判成贴底：只有用户的滚动能改写这个状态", () => {
		const follow = new TranscriptFollow();
		const box = boxAt(900);
		follow.userScrolled(box); // 用户往上翻了，距底 1500

		box.scrollHeight = 1300; // 上下文压缩，内容比视口高不了多少了
		follow.contentChanged(box);

		// 此刻度量上「就在底部」，但用户并没有滚回来 —— 不许自作主张拉到底
		expect(box.scrollTop).toBe(900);
	});

	it("用户自己滚回底部 → 重新跟随", () => {
		const follow = new TranscriptFollow();
		const box = boxAt(0);
		follow.contentChanged(box);

		box.scrollTop = 900;
		follow.userScrolled(box);
		box.scrollHeight = 3400;
		follow.contentChanged(box);
		expect(box.scrollTop).toBe(900);

		box.scrollTop = 2800; // 3400 - 2800 - 600 = 0，回到最底
		follow.userScrolled(box);
		box.scrollHeight = 3800;
		follow.contentChanged(box);
		expect(box.scrollTop).toBe(3800);
	});

	it("阈值是「距底 120px 以内」，边界两侧各判一次", () => {
		const follow = new TranscriptFollow();
		const box = boxAt(2280); // 3000 - 2280 - 600 = 120：不算在底部
		follow.userScrolled(box);
		follow.contentChanged(box);
		expect(box.scrollTop).toBe(2280);

		const nearBottom = boxAt(2281); // 119：算在底部
		follow.userScrolled(nearBottom); // 同一条状态被用户的滚动重新打开
		nearBottom.scrollHeight = 3600;
		follow.contentChanged(nearBottom);
		expect(nearBottom.scrollTop).toBe(3600);

		expect(TRANSCRIPT_FOLLOW_THRESHOLD_PX).toBe(120);
	});
});

describe("Transcript 消息级操作条：能用就是真名，不能用就说清为什么", () => {
	it("当前会话（拿得到 entryId）→ 三条都是真名、一条不灰", () => {
		const html = render({
			messages: [USER_MSG, ASSISTANT_MSG],
			messageEntryIds: { u1: "e-user-1", a1: "e-user-1" },
		});
		const [userRow, assistantRow] = rowsOf(html);
		expect(userRow).toContain('title="从此处分叉"');
		expect(assistantRow).toContain('title="撤销本轮"');
		expect(assistantRow).toContain('title="重新生成"');
		expect(assistantRow).toContain('title="从此处分叉"');
		expect(disabledTitlesIn(userRow)).toEqual([]);
		expect(disabledTitlesIn(assistantRow)).toEqual([]);
	});

	it("历史会话（messageEntryIds 里没有这些消息）→ 灰着，并且说清是哪一条不能用", () => {
		const html = render({ messages: [USER_MSG, ASSISTANT_MSG] });
		const [userRow, assistantRow] = rowsOf(html);
		expect(disabledTitlesIn(assistantRow)).toEqual([
			"不在当前会话，无法撤销",
			"不在当前会话，无法重新生成",
			"不在当前会话，无法分叉",
		]);
		expect(disabledTitlesIn(userRow)).toEqual(["不在当前会话，无法分叉"]);
		// 灰按钮不得顶着动作名（那正是用户报上来的假承诺）
		expect(assistantRow).not.toContain('title="撤销本轮"');
		expect(assistantRow).not.toContain('title="重新生成"');
		expect(assistantRow).not.toContain('title="从此处分叉"');
	});

	it("还在生成（live 行）→ 原因说生成中，不是「不在当前会话」", () => {
		const html = render({ live: LIVE_MSG });
		const [liveRow] = rowsOf(html);
		const disabled = disabledTitlesIn(liveRow);
		expect(disabled.slice(0, 3)).toEqual(["生成中，暂不可用", "生成中，暂不可用", "生成中，暂不可用"]);
		// live 行还只有 thinking、没有正文，复制也禁得有理（这条与上面三条不同源）
		expect(disabled[3]).toBe("复制");
		// 两种不可用原因不许互相顶替：生成中不能说成拿不到 entryId
		expect(liveRow).not.toContain("不在当前会话");
	});
});
