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
	test("未声明任何绑定 → 合法（行上报 unbound，运行面拒绝执行）", async () => {
		const resolved = await resolveScheduleAgentForWrite({}, async () => ({
			resolution: "unbound",
			error: "无绑定",
		}));
		expect(resolved.ok).toBe(true);
		if (resolved.ok) expect(resolved.binding.resolution).toBe("unbound");
	});

	test("声明的 agentId 未注册 → 拒绝写入（不静默改用别的 home）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ agentId: "ghost", agentDir: "/tmp/whatever" }, async () =>
			bindFromDirectory(ENTRIES, "/tmp/whatever", "ghost"),
		);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toContain("ghost");
	});

	test("声明的 Agent 已注册但 home 不在 → 拒绝写入（调度跑不起来，不能报成功）", async () => {
		const resolved = await resolveScheduleAgentForWrite({ agentDir: "/Users/me/.cornfield/agents/gone" }, async () =>
			bindFromDirectory(ENTRIES, "/Users/me/.cornfield/agents/gone", undefined),
		);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.error).toContain("agentDir 不存在");
	});

	test("legacy 目录（不是任何注册 Agent 的家）→ 允许写入并保留声明的路径", async () => {
		const resolved = await resolveScheduleAgentForWrite(
			{ agentDir: "/Users/me/OMP-workspace-test/omp-atomix" },
			async () => bindFromDirectory(ENTRIES, "/Users/me/OMP-workspace-test/omp-atomix", undefined),
		);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.binding.agentDir).toBe("/Users/me/OMP-workspace-test/omp-atomix");
			expect(resolved.binding.agentId).toBeUndefined();
		}
	});

	test("已注册且 home 在 → 落盘的身份是解析后的 agentId + agentDir", async () => {
		const resolved = await resolveScheduleAgentForWrite({ agentId: "hr" }, async () =>
			bindFromDirectory(ENTRIES, undefined, "hr"),
		);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.binding.agentId).toBe("hr");
			expect(resolved.binding.agentDir).toBe("/Users/me/.cornfield/agents/hr");
		}
	});
});
