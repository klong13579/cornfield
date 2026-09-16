import { describe, expect, it } from "bun:test";
import type { SessionRecordSummary } from "../src/lib/records";
import { type CurrentRow, groupSessions, type SidebarRow } from "../src/pages/workspace/SessionSidebar";

/**
 * 会话侧栏的分组键。
 *
 * T28 把 CLI 源的分组键从「sessionFile 里的 encoded-cwd」换成**会话自己记下的归属**
 * （`list_sessions[].projectId`）：目录只是会话文件摆在哪，归属是会话记录里写下的事实，
 * 两者不是一回事。这组用例钉的就是这条替换的两个方向：
 *   - 同一个目录下的会话，记了不同归属 → **不同组**（旧行为会把它们合成一组）；
 *   - 不同目录下的会话，记了同一个归属 → **同一组**（旧行为会把它们拆开）；
 *   - 没记过归属的 → 一个明说出来的桶，不拿目录名冒充一个 Project。
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

const CLI_DIR_A = "/Users/me/.cornfield/agent/sessions/--Users--me--a/by-date/2026-09-15/100000__a1.jsonl";
const CLI_DIR_B = "/Users/me/.cornfield/agent/sessions/--Users--me--b/by-date/2026-09-15/100000__b1.jsonl";

const NO_AGENTS = (agent: string): string => agent;

const PROJECTS = [
	{ projectId: "dtc", name: "米克原子 DTC" },
	{ projectId: "mkt", name: "市场部" },
];

describe("groupSessions：按会话记下的归属分组（不再猜路径）", () => {
	it("同一目录下的会话记了不同归属 → 不同组（旧行为会把它们合成一组）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", sessionFile: CLI_DIR_A, projectId: "dtc" }),
			session({ id: "s2", sessionFile: CLI_DIR_A, projectId: "mkt" }),
		];

		const groups = groupSessions(rows, { source: "cli", agentLabel: NO_AGENTS, projects: PROJECTS });

		expect(groups.map(g => g.label)).toEqual(["米克原子 DTC", "市场部"]);
		expect(groups.map(g => g.rows.map(r => r.id))).toEqual([["s1"], ["s2"]]);
	});

	it("不同目录下的会话记了同一个归属 → 同一组（旧行为会把它们拆开）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", sessionFile: CLI_DIR_A, projectId: "dtc" }),
			session({ id: "s2", sessionFile: CLI_DIR_B, projectId: "dtc" }),
		];

		const groups = groupSessions(rows, { source: "cli", agentLabel: NO_AGENTS, projects: PROJECTS });

		expect(groups).toHaveLength(1);
		expect(groups[0]?.rows.map(r => r.id)).toEqual(["s1", "s2"]);
	});

	it("没记过归属 → 「未记录归属」桶，不拿目录名冒充一个 Project，也不藏起来", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", sessionFile: CLI_DIR_A }),
			session({ id: "s2", sessionFile: CLI_DIR_B }),
		];

		const groups = groupSessions(rows, { source: "cli", agentLabel: NO_AGENTS, projects: PROJECTS });

		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("未记录归属");
		expect(groups[0]?.rows.map(r => r.id)).toEqual(["s1", "s2"]);
		// 目录名一个都不许出现在组标签里
		expect(groups.map(g => g.label)).not.toContain("/Users/me/a");
	});

	it("Project 名字取自注册表；注册表没读到 / 里没有这个 id → 显示 id（id 是事实，名字不是必须的）", () => {
		const rows: SidebarRow[] = [session({ id: "s1", projectId: "dtc" }), session({ id: "s2", projectId: "ghost" })];

		expect(
			groupSessions(rows, { source: "cli", agentLabel: NO_AGENTS, projects: PROJECTS }).map(g => g.label),
		).toEqual(["米克原子 DTC", "ghost"]);
		expect(groupSessions(rows, { source: "cli", agentLabel: NO_AGENTS }).map(g => g.label)).toEqual(["dtc", "ghost"]);
	});

	it("当前会话单独置顶，且不并进任何 Project 组", () => {
		const current: CurrentRow = { id: "live", name: "当前会话", agent: "attached", current: true };
		const rows: SidebarRow[] = [current, session({ id: "s1", projectId: "dtc" })];

		const groups = groupSessions(rows, { source: "cli", agentLabel: NO_AGENTS, projects: PROJECTS });

		expect(groups.map(g => g.label)).toEqual(["当前会话", "米克原子 DTC"]);
	});

	it("组的顺序 = 行的顺序（pin 置顶 / 时间倒序排过的顺序不被重排）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", projectId: "mkt" }),
			session({ id: "s2", projectId: "dtc" }),
			session({ id: "s3", projectId: "mkt" }),
		];

		const groups = groupSessions(rows, { source: "cli", agentLabel: NO_AGENTS, projects: PROJECTS });

		expect(groups.map(g => g.label)).toEqual(["市场部", "米克原子 DTC"]);
		expect(groups[0]?.rows.map(r => r.id)).toEqual(["s1", "s3"]);
	});

	it("webui 源照旧按 Agent 分组：Project 不参与那一个轴（谁干的是另一个问题）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", agent: "hr", source: "agent", projectId: "dtc" }),
			session({ id: "s2", agent: "default", source: "agent", projectId: "dtc" }),
		];
		const agentLabel = (agent: string): string => (agent === "hr" ? "HR 助理" : "Default");

		const groups = groupSessions(rows, { source: "webui", agentLabel, projects: PROJECTS });

		expect(groups.map(g => g.label)).toEqual(["HR 助理", "Default"]);
	});

	it("两个轴上的同一个 id 不会撞组（`project:x` ≠ `agent:x`）", () => {
		const rows: SidebarRow[] = [
			session({ id: "s1", agent: "dtc", source: "agent" }),
			session({ id: "s2", source: "cli", projectId: "dtc", agent: "dtc" }),
		];

		expect(groupSessions(rows, { source: "webui", agentLabel: NO_AGENTS, projects: PROJECTS })).toHaveLength(1);
		const cliGroups = groupSessions(rows, { source: "cli", agentLabel: NO_AGENTS, projects: PROJECTS });
		expect(cliGroups.map(g => g.key)).toEqual(["unrecorded", "project:dtc"]);
		expect(cliGroups.map(g => g.label)).toEqual(["未记录归属", "米克原子 DTC"]);
	});
});
