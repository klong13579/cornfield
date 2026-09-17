import { describe, expect, it } from "bun:test";
import type { ChildSessionStatusDto } from "../src/lib/pi-client-api";
import {
	childProcessStateOf,
	delegateFailureNote,
	focusProcessState,
	PROCESS_LABEL,
	resultStateOf,
	STATUS_LABEL,
	shortTime,
} from "../src/pages/workspace/session-tree-logic";

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

/**
 * 进程状态（T15）：账本只能说到它知道的那一步，说不出来的必须是「未知」。
 *
 * 最要紧的一条是反过来的：**非终态 + 有 pid 不是 healthy**。`lastPid` 是「最后见到」，
 * `get_session_tree` 读账本时又不跑 reconcile，父会话重启后陈旧条目会一直说 running ——
 * 拿它推 healthy 就是编。
 */
describe("childProcessStateOf", () => {
	const child = (patch: Partial<{ sessionId: string; status: ChildSessionStatusDto; lastPid: number }>) => ({
		sessionId: "child-1",
		status: "running" as ChildSessionStatusDto,
		...patch,
	});

	it("五档都有词（不做静默兜底）", () => {
		expect(Object.keys(PROCESS_LABEL).sort()).toEqual(["failed", "healthy", "starting", "stopped", "unknown"]);
	});

	it("非终态 + 有 pid：未知，并把「账本未复核」和那个 pid 摆出来（不是 healthy）", () => {
		const reading = childProcessStateOf(child({ status: "running", lastPid: 4242 }));
		expect(reading.state).toBe("unknown");
		expect(reading.label).toBe(PROCESS_LABEL.unknown);
		expect(reading.detail).toContain("账本未复核");
		expect(reading.detail).toContain("4242");
	});

	it("waiting_user 与 running 一样是「不确定」：等待你 不等于 进程活着", () => {
		expect(childProcessStateOf(child({ status: "waiting_user", lastPid: 7 })).state).toBe("unknown");
	});

	it("非终态 + 没 pid：未知，并且说清它就是缺 pid", () => {
		const reading = childProcessStateOf(child({ status: "running" }));
		expect(reading.state).toBe("unknown");
		expect(reading.detail).toContain("没有 pid");
	});

	it("completed / cancelled：运行已结束（stopped）", () => {
		for (const status of ["completed", "cancelled"] as const) {
			const reading = childProcessStateOf(child({ status, lastPid: 11 }));
			expect(reading.state).toBe("stopped");
			expect(reading.detail).toContain(status);
		}
	});

	it("failed 就是 failed：不套成 crashed（父会话判的失败与进程崩溃不是一回事）", () => {
		for (const patch of [{ status: "failed" as const }, { status: "failed" as const, lastPid: 99 }]) {
			const reading = childProcessStateOf(child(patch));
			expect(reading.state).toBe("failed");
			expect(reading.label).not.toContain("崩溃");
			expect(reading.detail).not.toContain("崩溃");
		}
	});

	it("starting 只认手上那一档事实，而且要账本还没给出 pid", () => {
		const starting = childProcessStateOf(child({ status: "running" }), { startingChildId: "child-1" });
		expect(starting.state).toBe("starting");

		// 账本已经记下 pid：早就不是「刚发出」了，本地回执退场
		expect(childProcessStateOf(child({ status: "running", lastPid: 1 }), { startingChildId: "child-1" }).state).toBe(
			"unknown",
		);
		// 账本说它已经结束：账本赢，不看本地回执
		expect(childProcessStateOf(child({ status: "completed" }), { startingChildId: "child-1" }).state).toBe("stopped");
		// 说的是别的子会话：对这条不生效
		expect(childProcessStateOf(child({}), { startingChildId: "child-2" }).state).toBe("unknown");
	});

	it("词表外的状态不许被归进任何一档（线上 JSON 不受类型约束）", () => {
		const reading = childProcessStateOf(child({ status: "zombie" as ChildSessionStatusDto }));
		expect(reading.state).toBe("unknown");
		expect(reading.detail).toContain("zombie");
	});
});

describe("focusProcessState", () => {
	it("账本读到了：焦点会话刚应答了它，这一档才算「进程活着有凭据」", () => {
		const reading = focusProcessState({ sessionId: "sess-root", children: [] });
		expect(reading.state).toBe("healthy");
		expect(reading.detail).toContain("应答");
	});

	it("还没读到账本：未知，不拿 healthy 顶位", () => {
		const reading = focusProcessState(undefined);
		expect(reading.state).toBe("unknown");
		expect(reading.detail).toContain("还没读到账本");
	});
});
