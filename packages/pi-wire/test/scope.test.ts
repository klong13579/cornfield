import { describe, expect, it } from "bun:test";
import { classifyScope, type PathContainment, pickDeepestRootIndex, type ScopeAnchors } from "../src/scope";

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

describe("pickDeepestRootIndex（最深祖先 root 获胜）", () => {
	it("root 自身命中（含带尾斜杠的写法，与不带斜杠等价）", () => {
		expect(pickDeepestRootIndex(["/a/b"], "/a/b")).toBe(0);
		expect(pickDeepestRootIndex(["/a/b/"], "/a/b")).toBe(0);
		expect(pickDeepestRootIndex(["/a/b"], "/a/b/")).toBe(0);
	});

	it("后代命中（任意深度）", () => {
		expect(pickDeepestRootIndex(["/a/b"], "/a/b/c/d")).toBe(0);
	});

	it("未命中 / 空列表 → -1", () => {
		expect(pickDeepestRootIndex(["/a/b"], "/a/other")).toBe(-1);
		expect(pickDeepestRootIndex([], "/a/b")).toBe(-1);
	});

	it("前缀相似但不是祖先：/a/b 不得命中 /a/bc（两边同理）", () => {
		expect(pickDeepestRootIndex(["/a/b"], "/a/bc")).toBe(-1);
		expect(pickDeepestRootIndex(["/a/bc"], "/a/b")).toBe(-1);
	});

	it("多个命中取最深者（嵌套声明遮蔽父级）", () => {
		const roots = ["/a", "/a/b/c", "/a/b"];
		expect(pickDeepestRootIndex(roots, "/a/b/c/d")).toBe(1);
		expect(pickDeepestRootIndex(roots, "/a/b/x")).toBe(2);
		expect(pickDeepestRootIndex(roots, "/a/other")).toBe(0);
	});

	it("同深并列时取声明在前的那一个（结果稳定，不依赖输入顺序之外的东西）", () => {
		expect(pickDeepestRootIndex(["/a/b", "/a/b/"], "/a/b/c")).toBe(0);
		expect(pickDeepestRootIndex(["/a/b/", "/a/b"], "/a/b/c")).toBe(0);
	});

	it("空串 root 跳过（归一化可能产出空串，它不是任何路径的祖先）", () => {
		expect(pickDeepestRootIndex([""], "/a/b")).toBe(-1);
		expect(pickDeepestRootIndex(["", "/a"], "/a/b")).toBe(1);
	});

	it("根目录是 `/` 时它是所有绝对路径的祖先", () => {
		expect(pickDeepestRootIndex(["/"], "/a/b")).toBe(0);
		expect(pickDeepestRootIndex(["/", "/a"], "/a/b")).toBe(1);
	});

	it("Windows 形式（`\\` 分隔符）同样按分隔符边界判定", () => {
		expect(pickDeepestRootIndex(["C:\\a\\b"], "C:\\a\\b\\c")).toBe(0);
		expect(pickDeepestRootIndex(["C:\\a\\b"], "C:\\a\\bc")).toBe(-1);
		expect(pickDeepestRootIndex(["C:\\a", "C:\\a\\b"], "C:\\a\\b\\c")).toBe(1);
	});

	it("调用方归一好后比较：函数自己不折叠、不去尾斜杠之外的归一", () => {
		// 未归一的重复分隔符不是本函数的义务 —— 它按字面边界判，认不出来就说没命中
		expect(pickDeepestRootIndex(["/a//b/"], "/a/b/c")).toBe(-1);
	});
});

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
