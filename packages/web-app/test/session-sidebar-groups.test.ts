import { describe, expect, it } from "bun:test";
import type { SessionRecordSummary } from "../src/lib/records";
import { type CurrentRow, groupSessions, type SidebarRow } from "../src/pages/workspace/SessionSidebar";

/**
 * 会话侧栏的分组 —— 只有一根轴：**谁在服务这条会话**。
 *
 * 曾经是两根轴、两个 tab：「WebUI 会话」按 Agent 分组，「CLI 会话」按会话自己记下的归属分组。
 * 而 tab 的划分用的是 `source`，serve 侧那是按 agentId 判的（default 恒等于 cli，见
 * `wire-server.ts` 的 `list_sessions`）—— 于是 default 这个正常注册的 Agent 在默认打开的
 * 「WebUI 会话」tab 里一个组头都没有，它的会话全在另一个 tab 里。既有用例钉的是那根被撤掉的轴，
 * 这组用例钉收口后的语义：
 *   - 分组只看 Agent：同一个 Agent 的会话，来自不同目录、记了不同归属，都是**同一组**；
 *   - 组序 = 行的顺序（pin 置顶 / 时间倒序不被重排），组头跟着组内最新那一行走；
 *   - 当前会话单独置顶，不并进任何 Agent 组；
 *   - key 的形状稳定（`agent:<id>` / `current`），React 列表不会因为 Agent 名里带冒号而串组。
 */

function session(patch: Partial<SessionRecordSummary> & { id: string }): SessionRecordSummary {
	return {
		name: patch.id,
		agent: "default",
		startedAt: "2026-09-15T10:00:00.000Z",
		messageCount: 1,
		status: "completed",
		source: "cli",
		...patch,
	};
}

const DIR_A = "/Users/me/.cornfield/agents/default/sessions/--Users--me--a/by-date/2026-09-15/100000__a1.jsonl";
const DIR_B = "/Users/me/.cornfield/agents/default/sessions/--Users--me--b/by-date/2026-09-15/100000__b1.jsonl";

const NO_AGENTS = (agent: string): string => agent;

describe("groupSessions：按 Agent 分组（谁在服务这条会话）", () => {
	it("同一个 Agent 的会话，来自不同目录 → 同一组（目录只是文件摆在哪）", () => {
		const rows: SidebarRow[] = [session({ id: "s1", sessionFile: DIR_A }), session({ id: "s2", sessionFile: DIR_B })];

		const groups = groupSessions(rows, { agentLabel: NO_AGENTS });

		expect(groups).toHaveLength(1);
		expect(groups[0]?.key).toBe("agent:default");
		expect(groups[0]?.rows.map(r => r.id)).toEqual(["s1", "s2"]);
	});

	it("同一个 Agent 的会话，记了不同 Project → 仍是同一组（归属不是分组轴）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", projectId: "dtc" }),
			session({ id: "s2", projectId: "mkt" }),
			session({ id: "s3" }),
		];

		const groups = groupSessions(rows, { agentLabel: NO_AGENTS });

		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("default");
		expect(groups[0]?.rows.map(r => r.id)).toEqual(["s1", "s2", "s3"]);
		// Project 的 id / 名字一个都不许出现在组标签里 —— 它退到了行副标题
		expect(groups.map(g => g.label)).not.toContain("dtc");
		expect(groups.map(g => g.label)).not.toContain("米克原子 DTC");
	});

	it("不同 Agent → 不同组，组头用显示名（未登记的 Agent 用 id）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", agent: "hr" }),
			session({ id: "s2", agent: "default" }),
			session({ id: "s3", agent: "ghost" }),
		];
		const agentLabel = (agent: string): string => (agent === "hr" ? "HR 助理" : agent);

		const groups = groupSessions(rows, { agentLabel });

		expect(groups.map(g => g.label)).toEqual(["HR 助理", "default", "ghost"]);
		expect(groups.map(g => g.key)).toEqual(["agent:hr", "agent:default", "agent:ghost"]);
	});

	it("挂进来的哪一行的副标题都不变：agent 是组头的事", () => {
		// 断言的是分组不吞行、不改行（行的副标题由 SessionRow 渲染，另有用例）
		const rows: SidebarRow[] = [
			session({ id: "s1", agent: "hr" }),
			session({ id: "s2", agent: "hr" }),
			session({ id: "s3", agent: "oracle" }),
		];

		const groups = groupSessions(rows, { agentLabel: NO_AGENTS });

		expect(groups.map(g => g.rows.length)).toEqual([2, 1]);
		expect(groups.flatMap(g => g.rows)).toHaveLength(rows.length);
	});

	it("当前会话单独置顶，且不并进任何 Agent 组", () => {
		const current: CurrentRow = { id: "live", name: "当前会话", agent: "attached", current: true };
		const rows: SidebarRow[] = [current, session({ id: "s1", agent: "attached" })];

		const groups = groupSessions(rows, { agentLabel: NO_AGENTS });

		// 当前会话那行的 agent 字面量是 "attached"，不许拿它和真 Agent 组撞在一起
		expect(groups.map(g => g.label)).toEqual(["当前会话", "attached"]);
		expect(groups.map(g => g.key)).toEqual(["current", "agent:attached"]);
		expect(groups[0]?.rows.map(r => r.id)).toEqual(["live"]);
		expect(groups[1]?.rows.map(r => r.id)).toEqual(["s1"]);
	});

	it("组的顺序 = 行的顺序（pin 置顶 / 时间倒序排过的顺序不被重排）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", agent: "hr" }),
			session({ id: "s2", agent: "default" }),
			session({ id: "s3", agent: "hr" }),
		];

		const groups = groupSessions(rows, { agentLabel: NO_AGENTS });

		expect(groups.map(g => g.label)).toEqual(["hr", "default"]);
		expect(groups[0]?.rows.map(r => r.id)).toEqual(["s1", "s3"]);
		// 组头的位置跟着组内**最新**那一行：default 的会话比 hr 的第二条新，所以它排前面
		expect(groups[1]?.rows.map(r => r.id)).toEqual(["s2"]);
	});

	it("Agent 叫 current 也不会和「当前会话」组撞", () => {
		const current: CurrentRow = { id: "live", name: "当前会话", agent: "attached", current: true };
		const rows: SidebarRow[] = [current, session({ id: "s1", agent: "current" })];

		const groups = groupSessions(rows, { agentLabel: NO_AGENTS });

		expect(groups.map(g => g.key)).toEqual(["current", "agent:current"]);
		expect(groups.map(g => g.rows.length)).toEqual([1, 1]);
	});
});
