/**
 * T10C · Schedule 的 Agent 绑定解析（单元）。
 *
 * 这里判的不是「注册表恰好长这样」，而是三条规则本身 —— 所以被测的是纯函数
 * `bindFromDirectory`，注册表内容以 fixture 传入：
 *
 *   registered    身份解析到了（agentId 必有值）
 *   unregistered  有执行 home，但它不是任何注册 Agent 的家（身份未知）
 *   unbound       既无 agentId 也无 agentDir —— 不执行
 *
 * 关键反例（写面）：**声明了**一个不存在的 agentId，不能因为「agentDir 还能用」就
 * 悄悄绑到别人身上；**没声明**绑定则是合法状态（行上报 unbound，运行面拒绝执行）。
 */

import { describe, expect, test } from "bun:test";
import type { AgentDirectoryEntry } from "@cornfield/coding-agent/agent-domain/agent-directory";
import { bindFromDirectory, resolveScheduleAgentForWrite } from "./agent-binding";

function entry(
	agentId: string,
	agentDir: string,
	opts: { displayName?: string; enabled?: boolean; projectIds?: string[] } = {},
): AgentDirectoryEntry {
	return {
		agent: {
			agentId,
			agentDir,
			displayName: opts.displayName ?? agentId,
			enabled: opts.enabled ?? true,
			...(opts.projectIds ? { projectIds: opts.projectIds } : {}),
		},
	};
}

const ENTRIES: AgentDirectoryEntry[] = [
	entry("hr", "/Users/me/.cornfield/agents/hr", { displayName: "HR 助理", projectIds: ["proj-hr"] }),
	entry("coding", "/Users/me/.cornfield/agents/coding", { displayName: "Coding" }),
	entry("gone", "/Users/me/.cornfield/agents/gone", { enabled: false }),
];

describe("bindFromDirectory", () => {
	test("agentDir 命中注册 Agent：身份与 home 都解析出来（displayName 来自注册表，不是 id）", () => {
		const binding = bindFromDirectory(ENTRIES, "/Users/me/.cornfield/agents/hr", undefined);
		expect(binding.resolution).toBe("registered");
		expect(binding.agentId).toBe("hr");
		expect(binding.agentDir).toBe("/Users/me/.cornfield/agents/hr");
		expect(binding.displayName).toBe("HR 助理");
		expect(binding.enabled).toBe(true);
		expect(binding.projectIds).toEqual(["proj-hr"]);
	});

	test("路径写法差异（尾随分隔符）仍能命中同一个 Agent", () => {
		const binding = bindFromDirectory(ENTRIES, "/Users/me/.cornfield/agents/hr/", undefined);
		expect(binding.resolution).toBe("registered");
		expect(binding.agentId).toBe("hr");
	});

	test("只声明 agentId：home 取自注册表（agentDirSource=registry）", () => {
		const binding = bindFromDirectory(ENTRIES, undefined, "coding");
		expect(binding.resolution).toBe("registered");
		expect(binding.agentId).toBe("coding");
		expect(binding.agentDir).toBe("/Users/me/.cornfield/agents/coding");
		expect(binding.agentDirSource).toBe("registry");
	});

	test("两者都声明且都指向同一个 Agent：按目录解析，身份一致", () => {
		const binding = bindFromDirectory(ENTRIES, "/Users/me/.cornfield/agents/coding", "coding");
		expect(binding.agentId).toBe("coding");
		expect(binding.agentDir).toBe("/Users/me/.cornfield/agents/coding");
		expect(binding.agentDirSource).toBe("declared");
	});

	test("agentDir 不是任何注册 Agent 的家 → unregistered，且不因此报成 unbound", () => {
		const binding = bindFromDirectory(ENTRIES, "/Users/me/OMP-workspace-test/omp-atomix", undefined);
		expect(binding.resolution).toBe("unregistered");
		expect(binding.agentId).toBeUndefined();
		expect(binding.agentDir).toBe("/Users/me/OMP-workspace-test/omp-atomix");
		expect(binding.error).toContain("不是任何已注册 Agent 的家");
	});

	test("声明的 agentId 不存在 + agentDir 也认不出 → unregistered，错误里点名那个 id", () => {
		const binding = bindFromDirectory(ENTRIES, "/tmp/whatever", "ghost");
		expect(binding.resolution).toBe("unregistered");
		expect(binding.error).toContain("ghost");
	});

	test("已注册但 agentDir 不存在（禁用）：身份解析到了、enabled=false 且给出原因", () => {
		const binding = bindFromDirectory(ENTRIES, "/Users/me/.cornfield/agents/gone", undefined);
		expect(binding.resolution).toBe("registered");
		expect(binding.agentId).toBe("gone");
		expect(binding.enabled).toBe(false);
		expect(binding.error).toContain("agentDir 不存在");
	});

	test("只声明未注册的 agentId（无目录）→ unregistered，不返回 agentId（未解析就不是身份）", () => {
		const binding = bindFromDirectory(ENTRIES, undefined, "ghost");
		expect(binding.resolution).toBe("unregistered");
		expect(binding.agentId).toBeUndefined();
		expect(binding.error).toContain("未注册");
	});

	test("legacy accountId 当 home 用时标注 agentDirSource=legacy-account", () => {
		const binding = bindFromDirectory(ENTRIES, "/tmp/legacy-dir", undefined, true);
		expect(binding.resolution).toBe("unregistered");
		expect(binding.agentDirSource).toBe("legacy-account");
	});
});

describe("resolveScheduleAgentForWrite", () => {
	const loadEntries = async (): Promise<AgentDirectoryEntry[]> => ENTRIES;

	test("keep：不改绑定（调用方根本不该走解析）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ kind: "keep" }, loadEntries);
		expect(resolved.ok).toBe(false);
	});

	test("unbind：清空绑定（agentId/agentDir 都不落盘，行保留、不执行）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ kind: "unbind" }, loadEntries);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.binding.resolution).toBe("unbound");
			expect(resolved.binding.agentId).toBeUndefined();
			expect(resolved.binding.agentDir).toBeUndefined();
		}
	});

	test("bind 两个字段都不给：调用方错误（清空要用 unbind，不是空 bind）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ kind: "bind" }, loadEntries);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toContain("unbind");
	});

	test("只给 agentId：落盘注册 home（agentDir 由注册表补全）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ kind: "bind", agentId: "hr" }, loadEntries);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.binding.agentId).toBe("hr");
			expect(resolved.binding.agentDir).toBe("/Users/me/.cornfield/agents/hr");
		}
	});

	test("声明的 agentId 未注册 → 拒绝写入（不静默改用别的 home / 别的身份）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ kind: "bind", agentId: "ghost" }, loadEntries);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toContain("ghost");
	});

	test("只给 agentDir：**整个绑定换成该目录**，identity 随之解析出来（不是补丁）", async () => {
		const resolved = await resolveScheduleAgentForWrite(
			{ kind: "bind", agentDir: "/Users/me/.cornfield/agents/coding" },
			loadEntries,
		);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.binding.agentId).toBe("coding");
			expect(resolved.binding.agentDir).toBe("/Users/me/.cornfield/agents/coding");
		}
	});

	test("只给 legacy agentDir（无注册拥有者）→ 落盘路径且** identity 被清空**（旧 agentId 不得粘上来）", async () => {
		const legacyDir = "/Users/me/OMP-workspace-test/omp-atomix";
		const resolved = await resolveScheduleAgentForWrite({ kind: "bind", agentDir: legacyDir }, loadEntries);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.binding.agentDir).toBe(legacyDir);
			expect(resolved.binding.agentId).toBeUndefined();
			expect(resolved.binding.resolution).toBe("unregistered");
		}
	});

	test("同时给 agentId + agentDir 且指向**不同** Agent → 拒绝（不静默采用目录）", async () => {
		const resolved = await resolveScheduleAgentForWrite(
			{ kind: "bind", agentId: "hr", agentDir: "/Users/me/.cornfield/agents/coding" },
			loadEntries,
		);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.error).toContain("指向不同 Agent");
			expect(resolved.error).toContain("coding");
		}
	});

	test("同时给 agentId + 不平的 agentDir（目录不是任何注册 Agent 的家）→ 拒绝", async () => {
		const resolved = await resolveScheduleAgentForWrite(
			{ kind: "bind", agentId: "hr", agentDir: "/tmp/somewhere-else" },
			loadEntries,
		);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toContain("不是 Agent「hr」注册的家");
	});

	test("同时给且一致（同一 Agent 的注册 home）→ 通过", async () => {
		const resolved = await resolveScheduleAgentForWrite(
			{ kind: "bind", agentId: "hr", agentDir: "/Users/me/.cornfield/agents/hr" },
			loadEntries,
		);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) expect(resolved.binding.agentId).toBe("hr");
	});

	test("已注册但 home 不在 → 拒绝写入（调度跑不起来，不能报成功）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ kind: "bind", agentId: "gone" }, loadEntries);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toContain("agentDir 不存在");
	});

	test("registry 读不出来 → 拒绝（声明的身份无法校验，不写未校验的绑定）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ kind: "bind", agentId: "hr" }, async () => {
			throw new Error("registry.json 损坏");
		});
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toContain("registry.json 损坏");
	});
});
