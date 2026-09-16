import { describe, expect, it } from "bun:test";
import { delegateFailureNote, resultStateOf, STATUS_LABEL, shortTime } from "../src/pages/workspace/session-tree-logic";

/**
 * T8：会话树面板的判定逻辑。
 *
 * 「带回结果」按钮的可点是这条闭环唯一的用户入口 —— 它必须与服务端
 * `bring_back_child_result` 的成功条件严格一致：
 *   有 resultRef 且还没有 resultBroughtBackAt。
 * 任何放宽都会让用户点到一个必然失败、或重复注入同一份结果的按钮。
 */

describe("resultStateOf", () => {
	it("没有结果指针 → 不可带回", () => {
		expect(resultStateOf({})).toEqual({ label: "无结果", canBringBack: false });
	});

	it("有结果但还没带回 → 可带回", () => {
		expect(resultStateOf({ resultRef: "/tmp/r.md" })).toEqual({ label: "结果待带回", canBringBack: true });
	});

	it("已带回 → 不可再带回（重复带回不会二次注入）", () => {
		expect(resultStateOf({ resultRef: "/tmp/r.md", resultBroughtBackAt: 1_700_000_000_000 })).toEqual({
			label: "已带回",
			canBringBack: false,
		});
	});

	it("带回时间戳为 0 也算已带回（0 是有效时间戳，不是缺省）", () => {
		expect(resultStateOf({ resultRef: "/tmp/r.md", resultBroughtBackAt: 0 }).canBringBack).toBe(false);
	});
});

describe("shortTime", () => {
	const now = 1_700_000_000_000;

	it("一分钟内是「刚刚」", () => {
		expect(shortTime(now - 30_000, now)).toBe("刚刚");
	});

	it("分钟与小时粒度", () => {
		expect(shortTime(now - 5 * 60_000, now)).toBe("5 分钟前");
		expect(shortTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
	});

	it("超过一天回落到日期", () => {
		expect(shortTime(now - 30 * 3_600_000, now)).toMatch(/\d{2}\/\d{2}/);
	});
});

describe("status", () => {
	it("五种状态都有中文标签（不做静默兜底）", () => {
		expect(Object.keys(STATUS_LABEL).sort()).toEqual(["cancelled", "completed", "failed", "running", "waiting_user"]);
	});
});

/**
 * 委派失败后的提示（review P2-1）。
 *
 * 客户端**不知道**子会话有没有起来：serve 会在账本里先把节点写成 `failed` 再招错，断线时
 * 子进程甚至可能已经起来了。所以这句话只能指向刚重读过的账本 —— 任何「没有起子会话」的
 * 说法都是客户端造出来的结论。
 */
describe("delegateFailureNote", () => {
	it("账本读得到：只说以树上的记录为准", () => {
		const note = delegateFailureNote(undefined);
		expect(note).toContain("以树上的记录为准");
	});

	it("不声称「没有起子会话」（那是客户端无从知道的事）", () => {
		for (const note of [delegateFailureNote(undefined), delegateFailureNote("read failed")]) {
			for (const forbidden of ["没有起子会话", "不会多一行", "未创建", "没起子会话"]) {
				expect(note).not.toContain(forbidden);
			}
		}
	});

	it("账本也读不到：得承认此刻无从判断，不能给结论", () => {
		const note = delegateFailureNote("session tree entry 1: unreadable");
		expect(note).toContain("无从判断");
		expect(note).not.toContain("以树上的记录为准");
	});
});
