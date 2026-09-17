import { describe, expect, it } from "bun:test";
import type { AgentInfoDto, ProjectRecordDto, StatsAggregatedDto, StatsFolderRowDto } from "@cornfield/wire";
import type { SessionRecordSummary } from "../../lib/records";
import {
	attributeFolder,
	attributeFolders,
	decodeFolderPath,
	findCurrentSession,
	folderKeyOf,
	matchProjectForPath,
	normalizePath,
	type ScopeRollupRow,
	scopeSections,
} from "./insights-scope";

/**
 * 用量面板 scope 归属的单元测试。
 *
 * 这里锁的是「不造数据」的四条底线：
 *   - 扁平文件（gateway）不构成目录布局 → 不给它编一个目录 key
 *   - 目录在 stats 里有行、索引里没会话 → Agent 未归属（单独成组），不并入任何 Agent
 *   - Project 命中按「最深祖先」判，前缀边界不能把 `/proj-other` 认成 `/proj` 的后代
 *   - 汇总口径是求和 + 加权错误率（不是各行错误率取平均）
 */

function folderRow(folder: string, patch: Partial<StatsAggregatedDto> = {}): StatsFolderRowDto {
	return {
		folder,
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		cacheRate: 0,
		totalCost: 0,
		totalPremiumRequests: 0,
		avgDuration: null,
		avgTtft: null,
		avgTokensPerSecond: null,
		firstTimestamp: 0,
		lastTimestamp: 0,
		...patch,
	};
}

function session(patch: Partial<SessionRecordSummary> & { sessionFile?: string }): SessionRecordSummary {
	return {
		id: "s1",
		name: "会话一",
		agent: "HR",
		startedAt: "2026-09-15T10:00:00.000Z",
		messageCount: 3,
		status: "completed",
		source: "cli",
		...patch,
	};
}

const SESSIONS_ROOT = "/Users/me/.cornfield/agent/sessions";

/** by-date 目录布局的会话文件（<sessionsRoot>/<encoded-cwd>/by-date/<date>/<file>）。 */
function byDateFile(encodedCwd: string, file = "143205__a1b2c3d4.jsonl"): string {
	return `${SESSIONS_ROOT}/${encodedCwd}/by-date/2026-09-15/${file}`;
}

/** gateway 扁平会话文件（<agentDir>/sessions/<convId>.jsonl）——不属于任何目录行。 */
function flatFile(agentDir: string, convId = "conv-9f3a1b2c"): string {
	return `${agentDir}/sessions/${convId}.jsonl`;
}

function agentMeta(id: string, name: string): AgentInfoDto {
	return { id, name, face: name.slice(0, 1), workspace: id, kind: "worker", status: "idle" };
}

function project(projectId: string, root: string, name = projectId): ProjectRecordDto {
	return { projectId, root, name };
}

function groupOf(rows: ScopeRollupRow[], key: string): ScopeRollupRow | undefined {
	return rows.find(row => row.key === key);
}

describe("folderKeyOf", () => {
	it("by-date 目录布局 → 取 encoded-cwd 段并还原为绝对路径", () => {
		expect(folderKeyOf(byDateFile("--Users--me--proj"))).toBe("/Users/me/proj");
	});

	it("Windows 分隔符同样识别", () => {
		expect(folderKeyOf("C:\\Users\\me\\agent\\sessions\\--Users--me--proj\\by-date\\x.jsonl")).toBe("/Users/me/proj");
	});

	it("gateway 扁平文件不是目录布局 → null（不编目录 key）", () => {
		expect(folderKeyOf(flatFile("/Users/me/agents/hr"))).toBeNull();
	});

	it("sessions 段之后没有内容 / 没有 sessionFile → null", () => {
		expect(folderKeyOf(`${SESSIONS_ROOT}/file.jsonl`)).toBeNull();
		expect(folderKeyOf(undefined)).toBeNull();
	});
});

describe("decodeFolderPath", () => {
	it("编码名 → 绝对路径（前导 -- 是根，-- 是分隔符）", () => {
		expect(decodeFolderPath("--Users--me--proj")).toBe("/Users/me/proj");
	});

	it("已解码路径原样归一（不会把目录名里合法的 -- 拆开）", () => {
		expect(decodeFolderPath("/Users/me/proj")).toBe("/Users/me/proj");
		expect(decodeFolderPath("/Users/me/foo--bar")).toBe("/Users/me/foo--bar");
	});

	it("去尾随分隔符 + 折叠重复分隔符 + 反斜杠归一", () => {
		expect(decodeFolderPath("--Users--my--proj--")).toBe("/Users/my/proj");
		expect(decodeFolderPath("//Users//me//proj/")).toBe("/Users/me/proj");
		expect(decodeFolderPath("\\Users\\me\\proj")).toBe("/Users/me/proj");
	});

	it("空串与相对路径 → null（无法断言是绝对路径）", () => {
		expect(decodeFolderPath("")).toBeNull();
		expect(decodeFolderPath("   ")).toBeNull();
		expect(decodeFolderPath("proj/deep")).toBeNull();
	});
});

describe("normalizePath", () => {
	it("保留根目录，不把它归一成空串", () => {
		expect(normalizePath("/")).toBe("/");
		expect(normalizePath("/Users/me/")).toBe("/Users/me");
	});
});

describe("matchProjectForPath（最深祖先获胜；规则在 pi-wire，这里只做词法归一）", () => {
	const projects = [project("p-parent", "/Users/me"), project("p-child", "/Users/me/proj")];

	it("root 自身命中", () => {
		expect(matchProjectForPath(projects, "/Users/me/proj")?.projectId).toBe("p-child");
	});

	it("嵌套 root：深者胜（子项目遮蔽父项目）", () => {
		expect(matchProjectForPath(projects, "/Users/me/proj/sub")?.projectId).toBe("p-child");
		expect(matchProjectForPath(projects, "/Users/me/other")?.projectId).toBe("p-parent");
	});

	it("前缀边界：/Users/me/proj-other 不是 /Users/me/proj 的后代", () => {
		expect(matchProjectForPath([project("p-child", "/Users/me/proj")], "/Users/me/proj-other")).toBeUndefined();
	});

	it("尾随分隔符与反斜杠归一后仍命中", () => {
		expect(matchProjectForPath([project("p", "/Users/me/proj/")], "/Users/me/proj")?.projectId).toBe("p");
		expect(matchProjectForPath([project("p", "\\Users\\me\\proj")], "/Users/me/proj")?.projectId).toBe("p");
	});

	it("registry 未读到（undefined）→ 没有答案，不是「未归属」", () => {
		expect(matchProjectForPath(undefined, "/Users/me/proj")).toBeUndefined();
		expect(matchProjectForPath([], "/Users/me/proj")).toBeUndefined();
	});

	it("词法归一后成了空串的 root 不构成归属（空不是任何路径的祖先）", () => {
		const hits = matchProjectForPath([project("p-empty", "   "), project("p", "/Users/me/proj")], "/Users/me/proj");
		expect(hits?.projectId).toBe("p");
		expect(matchProjectForPath([project("p-empty", "   ")], "/Users/me/proj")).toBeUndefined();
	});
});

describe("attributeFolder", () => {
	const agents = [agentMeta("hr", "HR"), agentMeta("ops", "Ops")];

	it("由落在该目录的会话推出 Agent（registry 解析 id 与显示名）", () => {
		const attribution = attributeFolder("/Users/me/proj", {
			sessions: [session({ agent: "HR", sessionFile: byDateFile("--Users--me--proj") })],
			agents,
		});
		expect(attribution.agents).toEqual({ state: "known", value: { ids: ["hr"], names: ["HR"] } });
	});

	it("registry 里没有的 Agent → 原样回落身份串（不编 id）", () => {
		const attribution = attributeFolder("/Users/me/proj", {
			sessions: [session({ agent: "外包-甲", sessionFile: byDateFile("--Users--me--proj") })],
			agents,
		});
		expect(attribution.agents).toEqual({ state: "known", value: { ids: ["外包-甲"], names: ["外包-甲"] } });
	});

	it("同一目录多个 Agent → 全列出（不硬塞给某一个）", () => {
		const attribution = attributeFolder("/Users/me/proj", {
			sessions: [
				session({
					id: "s-ops",
					agent: "Ops",
					sessionFile: byDateFile("--Users--me--proj", "090000__bbbbbbbb.jsonl"),
				}),
				session({ agent: "HR", sessionFile: byDateFile("--Users--me--proj") }),
			],
			agents,
		});
		expect(attribution.agents).toEqual({ state: "known", value: { ids: ["hr", "ops"], names: ["HR", "Ops"] } });
	});

	it("gateway 扁平文件不构成目录归属：只认 by-date 会话", () => {
		const attribution = attributeFolder("/Users/me/proj", {
			sessions: [
				session({ agent: "HR", sessionFile: byDateFile("--Users--me--proj") }),
				session({ id: "s-flat", agent: "Ops", sessionFile: flatFile("/Users/me/agents/ops") }),
			],
			agents,
		});
		expect(attribution.agents).toEqual({ state: "known", value: { ids: ["hr"], names: ["HR"] } });
	});

	it("索引已加载但没有任何会话落在这个目录 → unassigned（确实未归属）", () => {
		const attribution = attributeFolder("/Users/me/proj", {
			sessions: [session({ agent: "Ops", sessionFile: flatFile("/Users/me/agents/ops") })],
			agents,
		});
		expect(attribution.agents).toEqual({ state: "unassigned" });
	});

	it("索引未加载（sessions 缺省）→ unknown，**不是** unassigned（没读过名单不下结论）", () => {
		const attribution = attributeFolder("/Users/me/proj", { agents });
		expect(attribution.agents).toEqual({ state: "unknown" });
	});

	it("Project 归属：命中/未命中/未加载三态分开", () => {
		const hit = attributeFolder("/Users/me/proj", {
			sessions: [],
			projects: [project("p-child", "/Users/me/proj")],
		});
		expect(hit.project).toEqual({ state: "known", value: "p-child" });

		const miss = attributeFolder("/Users/me/nowhere", { sessions: [], projects: [project("p", "/Users/me/proj")] });
		expect(miss.project).toEqual({ state: "unassigned" });
	});

	it("registry 未读到（projects 缺省）→ unknown（**不得**当未归属）", () => {
		const attribution = attributeFolder("/Users/me/proj", { sessions: [] });
		expect(attribution.project).toEqual({ state: "unknown" });
	});

	it("registry 读到了但确实没声明过（[]）→ unassigned（空名单是一个事实）", () => {
		const attribution = attributeFolder("/Users/me/proj", { sessions: [], projects: [] });
		expect(attribution.project).toEqual({ state: "unassigned" });
	});
});

describe("attributeFolders", () => {
	it("与逐个 attributeFolder 结果一致（同一份索引口径）", () => {
		const sources = {
			sessions: [
				session({ agent: "HR", sessionFile: byDateFile("--Users--me--proj") }),
				session({ id: "s2", agent: "Ops", sessionFile: byDateFile("--Users--me--other") }),
			],
			agents: [agentMeta("hr", "HR"), agentMeta("ops", "Ops")],
			projects: [project("p-child", "/Users/me/proj"), project("p-parent", "/Users/me")],
		};
		const index = attributeFolders(["/Users/me/proj", "/Users/me/other", "/Users/me/proj"], sources);
		expect([...index.keys()]).toEqual(["/Users/me/proj", "/Users/me/other"]);
		expect(index.get("/Users/me/proj")).toEqual(attributeFolder("/Users/me/proj", sources));
		expect(index.get("/Users/me/proj")?.project).toEqual({ state: "known", value: "p-child" });
		expect(index.get("/Users/me/other")?.agents).toEqual({ state: "known", value: { ids: ["ops"], names: ["Ops"] } });
		expect(index.get("/Users/me/other")?.project).toEqual({ state: "known", value: "p-parent" });
	});
});

describe("rollupByAgent（求和 + 加权错误率）", () => {
	const sources = {
		sessions: [
			session({ id: "s-a", agent: "HR", sessionFile: byDateFile("--a") }),
			session({ id: "s-b", agent: "HR", sessionFile: byDateFile("--b") }),
			session({ id: "s-c", agent: "Ops", sessionFile: byDateFile("--c") }),
			session({ id: "s-d", agent: "Ops", sessionFile: byDateFile("--d") }),
		],
		agents: [agentMeta("hr", "HR"), agentMeta("ops", "Ops")],
	};

	it("多行求和：请求/tokens/费用直接相加，folderCount 记行数", () => {
		const rows = [
			folderRow("/a", {
				totalRequests: 100,
				failedRequests: 10,
				totalInputTokens: 1000,
				totalOutputTokens: 500,
				totalCost: 1.5,
			}),
			folderRow("/b", {
				totalRequests: 10,
				failedRequests: 5,
				totalInputTokens: 100,
				totalOutputTokens: 50,
				totalCost: 0.5,
			}),
		];
		const attribution = attributeFolders(
			rows.map(row => row.folder),
			sources,
		);
		const groups = scopeSections({ rows, attribution }).byAgent;
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("HR");
		expect(groups[0]?.folderCount).toBe(2);
		expect(groups[0]?.totalRequests).toBe(110);
		expect(groups[0]?.failedRequests).toBe(15);
		expect(groups[0]?.totalInputTokens).toBe(1100);
		expect(groups[0]?.totalOutputTokens).toBe(550);
		expect(groups[0]?.totalCost).toBeCloseTo(2, 10);
	});

	it("errorRate 按请求数加权，不是各行错误率取平均", () => {
		const rows = [
			folderRow("/a", { totalRequests: 100, failedRequests: 10, errorRate: 0.1 }),
			folderRow("/b", { totalRequests: 10, failedRequests: 5, errorRate: 0.5 }),
		];
		const attribution = attributeFolders(
			rows.map(row => row.folder),
			sources,
		);
		const group = groupOf(scopeSections({ rows, attribution }).byAgent, "agent:hr");
		expect(group?.errorRate).toBeCloseTo(15 / 110, 10);
		expect(group?.errorRate).not.toBeCloseTo(0.3, 3); // 直接平均会得到 0.3
	});

	it("无请求的组 errorRate 为 0（0 请求不能算出错误率）", () => {
		const rows = [folderRow("/a", { totalRequests: 0, failedRequests: 0 })];
		const attribution = attributeFolders(
			rows.map(row => row.folder),
			sources,
		);
		expect(scopeSections({ rows, attribution }).byAgent[0]?.errorRate).toBe(0);
	});

	it("未归属目录单独成组，不并入任何 Agent", () => {
		const rows = [
			folderRow("/a", { totalRequests: 100, failedRequests: 10, totalCost: 1 }),
			folderRow("/unknown", { totalRequests: 7, failedRequests: 7, totalCost: 9 }),
		];
		const attribution = attributeFolders(
			rows.map(row => row.folder),
			sources,
		);
		const sections = scopeSections({ rows, attribution });
		expect(sections.byAgent.map(group => group.key)).toEqual(["agent:hr"]);
		expect(sections.byAgent[0]?.totalRequests).toBe(100);
		expect(sections.unassignedAgent).toHaveLength(1);
		expect(sections.unassignedAgent[0]?.kind).toBe("unassigned");
		expect(sections.unassignedAgent[0]?.totalRequests).toBe(7);
		expect(sections.unassignedAgent[0]?.errorRate).toBe(1);
	});

	it("多 Agent 目录进 shared 组，不重复计入任何 Agent", () => {
		const rows = [folderRow("/ab", { totalRequests: 50, failedRequests: 5, totalCost: 2 })];
		const attribution = attributeFolders(
			rows.map(row => row.folder),
			{
				sessions: [
					session({ id: "s-a", agent: "HR", sessionFile: byDateFile("--ab") }),
					session({ id: "s-b", agent: "Ops", sessionFile: byDateFile("--ab", "080000__cccccccc.jsonl") }),
				],
				agents: sources.agents,
			},
		);
		const sections = scopeSections({ rows, attribution });
		expect(sections.byAgent).toEqual([]);
		expect(sections.unassignedAgent).toHaveLength(1);
		expect(sections.unassignedAgent[0]?.kind).toBe("shared");
		expect(sections.unassignedAgent[0]?.totalRequests).toBe(50);
	});

	it("stats 里同一目录出现两行 → 两行都算（stats 说了算，不去重）", () => {
		const rows = [
			folderRow("/a", { totalRequests: 3, totalCost: 0.25 }),
			folderRow("/a", { totalRequests: 4, totalCost: 0.25 }),
		];
		const attribution = attributeFolders(
			rows.map(row => row.folder),
			sources,
		);
		const group = scopeSections({ rows, attribution }).byAgent[0];
		expect(group?.folderCount).toBe(2);
		expect(group?.totalRequests).toBe(7);
		expect(group?.totalCost).toBeCloseTo(0.5, 10);
	});

	it("空行集 → 空分组（不是 0 行组）", () => {
		expect(scopeSections({ rows: [], attribution: attributeFolders([], { sessions: [] }) }).byAgent).toEqual([]);
	});
});

describe("rollupByProject", () => {
	const projects = [project("p-child", "/Users/me/proj", "子项目"), project("p-parent", "/Users/me", "父项目")];
	const attribution = attributeFolders(["/Users/me/proj/src", "/Users/me/other", "/tmp/loose"], {
		sessions: [],
		projects,
	});

	it("按命中的 Project 汇总，label 用 Project 名", () => {
		const rows = [folderRow("/Users/me/proj/src", { totalRequests: 20, totalCost: 1 })];
		const sections = scopeSections({ rows, attribution, projects });
		expect(sections.byProject.map(group => group.label)).toEqual(["子项目"]);
		expect(sections.unassignedProject).toEqual([]);
	});

	it("未归属 Project 的行单独成组，不并入任何 Project", () => {
		const rows = [
			folderRow("/Users/me/proj/src", { totalRequests: 20, totalCost: 1 }),
			folderRow("/tmp/loose", { totalRequests: 5, totalCost: 0.1 }),
		];
		const sections = scopeSections({ rows, attribution, projects });
		expect(sections.byProject.map(group => group.totalRequests)).toEqual([20]);
		expect(sections.unassignedProject).toHaveLength(1);
		expect(sections.unassignedProject[0]?.totalRequests).toBe(5);
		expect(sections.unassignedProject[0]?.kind).toBe("unassigned");
	});

	it("registry 未读到（projects 缺省）→ 行落**归属未知**桶，不进未归属（没读过名单不下结论）", () => {
		const rows = [folderRow("/Users/me/proj/src", { totalRequests: 20 })];
		const pendingAttribution = attributeFolders(
			rows.map(row => row.folder),
			{ sessions: [] },
		);
		const sections = scopeSections({ rows, attribution: pendingAttribution });
		expect(sections.byProject).toEqual([]);
		expect(sections.unassignedProject).toEqual([]);
		expect(sections.unknownProject).toHaveLength(1);
		expect(sections.unknownProject[0]?.kind).toBe("unknown");
		expect(sections.unknownProject[0]?.label).toContain("registry 未加载");
		expect(sections.unknownProject[0]?.totalRequests).toBe(20);
	});

	it("registry 读到了但确实没声明过（[]）→ 才进未归属桶", () => {
		const rows = [folderRow("/Users/me/proj/src", { totalRequests: 20 })];
		const loose = attributeFolders(
			rows.map(row => row.folder),
			{ sessions: [], projects: [] },
		);
		const sections = scopeSections({ rows, attribution: loose, projects: [] });
		expect(sections.unknownProject).toEqual([]);
		expect(sections.unassignedProject[0]?.totalRequests).toBe(20);
	});

	it("Projects 名单里查不到名字时回落显示 id", () => {
		const rows = [folderRow("/Users/me/proj/src", { totalRequests: 1 })];
		const sections = scopeSections({ rows, attribution, projects: [] });
		expect(sections.byProject[0]?.label).toBe("p-child");
	});
});

describe("scopeSections.sessionRows", () => {
	const rows = [folderRow("/a", { totalRequests: 1 }), folderRow("/b", { totalRequests: 2 })];
	const attribution = attributeFolders(
		rows.map(row => row.folder),
		{ sessions: [] },
	);

	it("给定会话目录 key → 取该目录的原始行（目录级，不是会话级）", () => {
		expect(scopeSections({ rows, attribution, sessionFolderKey: "/a" }).sessionRows.map(row => row.folder)).toEqual([
			"/a",
		]);
	});

	it("无会话目录 key / 目录在 stats 里不存在 → 空（不拿别的目录冒充）", () => {
		expect(scopeSections({ rows, attribution }).sessionRows).toEqual([]);
		expect(scopeSections({ rows, attribution, sessionFolderKey: null }).sessionRows).toEqual([]);
		expect(scopeSections({ rows, attribution, sessionFolderKey: "/zzz" }).sessionRows).toEqual([]);
	});
});

describe("findCurrentSession", () => {
	const sessions = [
		session({ id: "s-indexed", sessionFile: byDateFile("--Users--me--proj") }),
		session({ id: "s-flat", agent: "Ops", sessionFile: flatFile("/Users/me/agents/ops") }),
	];

	it("按 sessionFile 命中（路径分隔符归一后比较）", () => {
		const facts = findCurrentSession(sessions, {
			sessionFile: byDateFile("--Users--me--proj").replaceAll("/", "\\"),
		});
		expect(facts.state).toBe("indexed");
		expect(facts.state === "indexed" ? facts.folderKey : null).toBe("/Users/me/proj");
	});

	it("sessionFile 不在索引里 → unindexed（必须明说「不在索引里」）", () => {
		const facts = findCurrentSession(sessions, { sessionFile: "/Users/me/elsewhere/sessions/x.jsonl" });
		expect(facts.state).toBe("unindexed");
	});

	it("命中 gateway 扁平文件 → indexed 但目录未知（folderKey 为 null）", () => {
		const facts = findCurrentSession(sessions, { sessionFile: flatFile("/Users/me/agents/ops") });
		expect(facts.state).toBe("indexed");
		expect(facts.state === "indexed" ? facts.folderKey : "x").toBeNull();
	});

	it("没有 sessionFile 时才按 id 匹配", () => {
		expect(findCurrentSession(sessions, { sessionId: "s-indexed" }).state).toBe("indexed");
		expect(findCurrentSession(sessions, { sessionId: "s-missing" }).state).toBe("unindexed");
	});

	it("既无 sessionFile 也无 sessionId → no-identity（不是「不在索引里」）", () => {
		expect(findCurrentSession(sessions, {}).state).toBe("no-identity");
	});
});
