/**
 * agentDir 文件清单（单一真相）的契约测试。
 *
 * 这份清单存在的理由就是「别再三处各写一份」：骨架写出哪些文件（`skeleton/assets.ts`）、
 * `cornfield agent validate` 按什么级别要求它们（`cli/agent-cli.ts`）、前端 Prompt 源视图列哪些
 * （`get_agent_prompt_sources`）。所以这里钉住三件事：
 *   1. 清单覆盖骨架写出的**每一个**文件，不多不少；
 *   2. prompt 面正好是那 7 个（`.omp/SYSTEM.md` 是旧路径、AGENTS-personal.md/CONTEXT.md 从来不存在）；
 *      `TODO.md` **不在其中**：它已退出注入（历史任务留档），当前任务在 `<agentDir>/.cornfield/agent-todos.json`；
 *   3. 从清单推导出的三个校验集与字面量逐位相同（元素 + 顺序）—— validate 输出不许变形。
 */

import { describe, expect, test } from "bun:test";
import { AGENT_DIR_FILES, AGENT_DIR_PROMPT_FILES, agentDirFilesWithRequirement } from "../src/skeleton/agent-dir-files";
import { SKELETON_FILES } from "../src/skeleton/assets";

/**
 * validate 的三个集合（改造前写在 `cli/agent-cli.ts` 里的字面量）。顺序是契约的一部分。
 *
 * `TODO.md` 从 always-on 移出（2026-09-19：它退出注入流程，requirement 降为 optional）——
 * 这是那次改动**有意**改的契约，不是漂移：缺它不再报 error。
 */
const HISTORICAL_ALWAYS_ON = ["AGENTS.md", "mission.md", "TOOLS.md", "knowledge/external-workspaces.md"];
const HISTORICAL_RUNTIME_HARD_DEPS = [".cornfield/config.yml"];
const HISTORICAL_RUNTIME_RECOMMENDED = ["prompt-includes.json", ".gitignore", ".cornfield/SYSTEM.md"];

/** prompt 面：会被读进模型上下文的那些（其余的要么是配置面、要么是技能面、要么是忽略规则）。 */
const EXPECTED_PROMPT_SURFACE = [
	"AGENTS.md",
	"mission.md",
	"TOOLS.md",
	"user.md",
	"prompt-includes.json",
	".cornfield/SYSTEM.md",
	"knowledge/external-workspaces.md",
	// 「其它面」的四个（列出反例，防有人顺手把 .gitignore 也当 prompt 源）：
	// TODO.md 在这里：不再注入，也不再由 agent 维护（历史任务留档）。
	"TODO.md",
	".gitignore",
	".cornfield/config.yml",
	".cornfield/skills/lint/SKILL.md",
];

describe("agentDir 文件清单（单一真相）", () => {
	test("覆盖骨架写出的每一个文件，且不重复", () => {
		const manifest = AGENT_DIR_FILES.map(file => file.relPath);
		const skeleton = SKELETON_FILES.map(file => file.relPath);

		expect(new Set(manifest).size).toBe(manifest.length); // 无重复
		// 双向相等：少了 = 有文件没登记；多了 = 登记了一个骨架根本不写的文件。
		expect([...manifest].sort()).toEqual([...skeleton].sort());
	});

	test("prompt 面正好是 7 个，其余 4 个不在其中", () => {
		const promptPaths = AGENT_DIR_PROMPT_FILES.map(file => file.relPath);
		const otherPaths = AGENT_DIR_FILES.filter(file => file.surface === "other").map(file => file.relPath);

		expect(promptPaths).toEqual(EXPECTED_PROMPT_SURFACE.slice(0, 7));
		expect(otherPaths).toEqual(EXPECTED_PROMPT_SURFACE.slice(7));
		// prompt 面必须是声明顺序（= 骨架写出顺序），供 UI 直接渲染。
		expect(promptPaths).toEqual(AGENT_DIR_FILES.filter(f => f.surface === "prompt").map(f => f.relPath));
	});

	test("推导出的三个校验集与历史字面量逐位相同", () => {
		expect(agentDirFilesWithRequirement("always-on")).toEqual(HISTORICAL_ALWAYS_ON);
		expect(agentDirFilesWithRequirement("hard-dep")).toEqual(HISTORICAL_RUNTIME_HARD_DEPS);
		expect(agentDirFilesWithRequirement("recommended")).toEqual(HISTORICAL_RUNTIME_RECOMMENDED);
	});

	test("每条都带非空的 title / description（UI 直接渲染，不许留空）", () => {
		for (const file of AGENT_DIR_FILES) {
			expect(file.relPath.length, file.relPath).toBeGreaterThan(0);
			expect(file.title.length, file.relPath).toBeGreaterThan(0);
			expect(file.description.length, file.relPath).toBeGreaterThan(0);
		}
	});

	test("user.md 的描述与 assets.ts 的注释同义（项目级人设，刻意不进 prompt-includes）", () => {
		const user = AGENT_DIR_FILES.find(file => file.relPath === "user.md");
		expect(user).toBeDefined();
		const description = user?.description ?? "";
		// 三个事实缺一不可：它是 agentDir 级的、它覆盖用户级 ~/.cornfield/user.md、它不进 includes。
		expect(description).toContain("agentDir 级");
		expect(description).toContain("~/.cornfield/user.md");
		expect(description).toContain("prompt-includes.json");
		expect(user?.surface).toBe("prompt");
	});
});
