import { describe, expect, it } from "bun:test";
import { classifyScope, type PathContainment, type ScopeAnchors } from "../src/scope";

/**
 * 共享范围规则（wire）—— 技能页与 composer 上下文条目用的是同一条。
 *
 * 这里只测**规则本身**（顺序/优先级/缺省锚点），包含判定用一份纯文本实现（与浏览器侧同形）：
 * 规则不该依赖某个运行时的路径归一能力，那件事由调用方按自己的真实能力传进来。
 */

const contains: PathContainment = (root, candidate) => {
	const trimmed = root.replace(/\/+$/, "");
	return candidate === trimmed || candidate.startsWith(`${trimmed}/`);
};

function anchors(patch: Partial<ScopeAnchors> & Pick<ScopeAnchors, "agentDir" | "sessionCwd">): ScopeAnchors {
	return patch;
}

describe("classifyScope", () => {
	it("agentDir / projectRoot / 其他三分，且同名前缀目录不算在内", () => {
		const context = anchors({
			agentDir: "/root/agents/hr",
			sessionCwd: "/root/cornfield",
			projectRoot: "/root/cornfield",
		});
		expect(classifyScope("/root/agents/hr/.cornfield/skills/a/SKILL.md", context, contains)).toBe("agent");
		expect(classifyScope("/root/cornfield/.cornfield/skills/b/SKILL.md", context, contains)).toBe("project");
		// 兄弟目录：/root/cornfield-next 不在 /root/cornfield 内
		expect(classifyScope("/root/cornfield-next/.cornfield/skills/c/SKILL.md", context, contains)).toBe("global");
		expect(classifyScope("/root/home/.claude/skills/d/SKILL.md", context, contains)).toBe("global");
	});

	it("没有 Project 归属（缺省，不是空串）时会话 cwd 自己也算 project", () => {
		const context = anchors({ agentDir: "/root/agent", sessionCwd: "/root/repo" });
		expect(classifyScope("/root/repo/.cornfield/skills/x/SKILL.md", context, contains)).toBe("project");
		expect(classifyScope("/root/other/x.md", context, contains)).toBe("global");
	});

	it("锚点重合时 agentDir 优先：registry agent 的会话根就是它的 agentDir", () => {
		const context = anchors({ agentDir: "/root/agents/hr", sessionCwd: "/root/agents/hr", projectRoot: "/root" });
		expect(classifyScope("/root/agents/hr/skills/x/SKILL.md", context, contains)).toBe("agent");
	});

	it("projectRoot 落在 agentDir 里时，agentDir 里的路径仍然算 agent", () => {
		// 会话 Project 比 Agent 的家更深（例如 Agent 的家就是仓库根）：更具体的那条先判。
		const context = anchors({ agentDir: "/root/repo", sessionCwd: "/root/repo/src", projectRoot: "/root/repo/src" });
		expect(classifyScope("/root/repo/src/a.ts", context, contains)).toBe("agent");
	});

	it("包含判定由调用方给（seam）：判定说不在就不在，规则不自己再算一遍", () => {
		const context = anchors({ agentDir: "/root/agents/hr", sessionCwd: "/root/agents/hr" });
		const nothingContains: PathContainment = () => false;
		expect(classifyScope("/root/agents/hr/a.ts", context, nothingContains)).toBe("global");
		// 根自身算在范围内（判定口径由调用方定义，规则只问「在不在」）
		const selfOnly: PathContainment = (root, candidate) => root === candidate;
		expect(classifyScope("/root/agents/hr", context, selfOnly)).toBe("agent");
	});
});
