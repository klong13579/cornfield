import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MsgActions, type MsgActionsProps, UNAVAILABLE_REASON_FALLBACK } from "./MsgActions";

/**
 * MsgActions 的两条契约：
 *   1. **能用就是真名**：handler 在 ⇒ title = 动作名（撤销本轮 / 重新生成 / 从此处分叉）。
 *   2. **不能用就说清为什么**：handler 不在 ⇒ disabled，title = 父层传下来的真实原因；
 *      父层没传原因也不编，只说「暂不可用」。
 *
 * 为什么盯着这个：一条灰着、title 写着「尚未接入」的按钮是假承诺，用户最初报的就是它。
 * 但「原因」不能由这里推断 —— 只有父层知道是内容还在生成还是拿不到 entryId，
 * 所以这里测的是「传什么显示什么」，以及**不传时的兜底不许装作知道原因**。
 *
 * 单独开文件的原因：角色门控与逐动作粒度（只灰 fork、只灰 undo……）在 Transcript 里出不来 ——
 * 那边三条 handler 由同一个 entryId 一次性决定，而 AssistantTurn 永远按 assistant 渲染。
 */

const UNDO = "撤销本轮";
const REGEN = "重新生成";
const FORK = "从此处分叉";
const COPY = "复制";
const ALL_ACTIONS = [UNDO, REGEN, FORK];

function render(props: MsgActionsProps): string {
	return renderToStaticMarkup(createElement(MsgActions, props));
}

/** 从静态 HTML 取出每个按钮的 (title, 是否 disabled)，按渲染顺序。 */
function buttons(html: string): { title: string; disabled: boolean }[] {
	return [...html.matchAll(/<button[^>]*class="icon-btn"[^>]*>/g)].map(match => {
		const tag = match[0];
		return { title: /title="([^"]*)"/.exec(tag)?.[1] ?? "", disabled: tag.includes(" disabled") };
	});
}

function buttonOf(html: string, title: string): { title: string; disabled: boolean } | undefined {
	return buttons(html).find(button => button.title === title);
}

const noop = (): void => undefined;

describe("MsgActions：handler 在 → 真名且能点", () => {
	it("三个 handler + 文本都在 → 四条 title 各就各位，一个都不 disabled", () => {
		const html = render({ messageRole: "assistant", text: "结论……", onUndo: noop, onRegenerate: noop, onFork: noop });
		expect(buttons(html).map(b => b.title)).toEqual([UNDO, REGEN, FORK, COPY]);
		expect(buttons(html).filter(b => b.disabled)).toEqual([]);
	});

	it("只给了一部分 handler → 只有缺的那个灰，其余照旧是真名", () => {
		const html = render({ messageRole: "assistant", text: "结论……", onUndo: noop, onFork: noop });
		// 没传原因 ⇒ 那个灰按钮只说「暂不可用」，不许顶用动作名
		expect(buttons(html)).toEqual([
			{ title: UNDO, disabled: false },
			{ title: UNAVAILABLE_REASON_FALLBACK, disabled: true },
			{ title: FORK, disabled: false },
			{ title: COPY, disabled: false },
		]);
	});
});

describe("MsgActions：handler 不在 → 灰显 + 父层给的真实原因", () => {
	it("按动作分别取原因（三条各说各的，不是一句话贴三遍）", () => {
		const html = render({
			messageRole: "assistant",
			text: "结论……",
			disabledReasons: {
				undo: "不在当前会话，无法撤销",
				regenerate: "不在当前会话，无法重新生成",
				fork: "不在当前会话，无法分叉",
			},
		});
		expect(buttons(html)).toEqual([
			{ title: "不在当前会话，无法撤销", disabled: true },
			{ title: "不在当前会话，无法重新生成", disabled: true },
			{ title: "不在当前会话，无法分叉", disabled: true },
			{ title: COPY, disabled: false },
		]);
	});

	it("换一种原因（生成中）照实显示，按钮名一个都不露", () => {
		const html = render({
			messageRole: "assistant",
			text: "结论……",
			disabledReasons: { undo: "生成中，暂不可用", regenerate: "生成中，暂不可用", fork: "生成中，暂不可用" },
		});
		expect(buttons(html).map(b => b.title)).toEqual([
			"生成中，暂不可用",
			"生成中，暂不可用",
			"生成中，暂不可用",
			COPY,
		]);
		expect(
			buttons(html)
				.slice(0, 3)
				.every(b => b.disabled),
		).toBe(true);
	});

	it("父层没说原因 → 只说「暂不可用」，不编原因、也不假装能用", () => {
		const html = render({ messageRole: "assistant", text: "结论……" });
		const fallback = buttons(html).slice(0, 3);
		expect(fallback.map(b => b.title)).toEqual([
			UNAVAILABLE_REASON_FALLBACK,
			UNAVAILABLE_REASON_FALLBACK,
			UNAVAILABLE_REASON_FALLBACK,
		]);
		expect(fallback.every(b => b.disabled)).toBe(true);
		// 兜底不许出现任何一个动作名（那正是用户报上来的假承诺）
		expect(ALL_ACTIONS.filter(name => html.includes(`title="${name}"`))).toEqual([]);
	});

	it("只缺 fork（user 行没有 entryId）→ 只有它灰，撤销/重新生成根本不出现", () => {
		const html = render({
			messageRole: "user",
			text: "帮我看下这个工单",
			disabledReasons: { fork: "不在当前会话，无法分叉" },
		});
		expect(buttons(html)).toEqual([
			{ title: "不在当前会话，无法分叉", disabled: true },
			{ title: COPY, disabled: false },
		]);
	});

	it("角色门控不是灰显：user 行传了 handler 也只出现 fork", () => {
		const html = render({
			messageRole: "user",
			text: "帮我看下这个工单",
			onUndo: noop,
			onRegenerate: noop,
			onFork: noop,
		});
		expect(buttons(html)).toEqual([
			{ title: FORK, disabled: false },
			{ title: COPY, disabled: false },
		]);
	});
});

describe("MsgActions：复制按钮不受上面这套影响", () => {
	it("有文本 → 始终在、始终能点（哪怕三个动作全灰）", () => {
		const html = render({ messageRole: "assistant", text: "结论……" });
		expect(buttonOf(html, COPY)).toEqual({ title: COPY, disabled: false });
	});

	it("没有文本 → 只有它禁用（这条是实话：确实没东西可复制）", () => {
		const html = render({ messageRole: "assistant" });
		expect(buttonOf(html, COPY)).toEqual({ title: COPY, disabled: true });
	});
});
