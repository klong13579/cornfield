/**
 * T10B：Skills scope 投影的单元测试（纯函数 + 真文件系统，不打桩）。
 *
 * 覆盖：范围判定边界（同名前缀目录不算在内）、版本三事实（声明/指纹/mtime）、
 * 读失败与「文件不存在」分开、停用名单从两个 settings 键收齐、发现警告分流。
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathIsWithin } from "@cornfield/utils";
import { classifyScope } from "@cornfield/wire";
import type { Skill } from "../extensibility/skills";
import {
	collectDisabledInputs,
	projectDisabledSkills,
	projectLoadedSkills,
	readSkillFileFacts,
	type SkillScopeAnchor,
	splitSkillWarnings,
} from "./skill-scope";

const cleanups: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(dir);
	return dir;
}

/** 写一份 SKILL.md，返回绝对路径。 */
async function writeSkill(dir: string, name: string, frontmatter: string): Promise<string> {
	const skillDir = path.join(dir, name);
	await fs.mkdir(skillDir, { recursive: true });
	const file = path.join(skillDir, "SKILL.md");
	await Bun.write(file, frontmatter);
	return file;
}

function facts(
	overrides: Partial<SkillScopeAnchor> & Pick<SkillScopeAnchor, "agentDir" | "sessionCwd">,
): SkillScopeAnchor {
	return { agentId: "hr", ...overrides };
}

/**
 * serve 侧的判定入口 = 共享规则（wire 的 `classifyScope`）+ 本运行时的包含判定
 * （utils 的 `pathIsWithin`，realpath 归一 + 分隔符边界）。技能行里的 scope 就是它算出来的，
 * 所以这里断言的是这条组合（规则本身的行为在 `packages/pi-wire/test/scope.test.ts`）。
 */
const scopeOf = (filePath: string, anchor: SkillScopeAnchor) => classifyScope(filePath, anchor, pathIsWithin);

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("技能范围判定（共享规则 + serve 侧包含判定）", () => {
	test("agentDir / projectRoot / 其他三分，且同名前缀目录不算在内", async () => {
		const root = await tmpDir("scope-classify-");
		const agentDir = path.join(root, "agents", "hr");
		const projectRoot = path.join(root, "cornfield");
		const context = facts({ agentDir, sessionCwd: projectRoot, projectRoot });

		expect(scopeOf(path.join(agentDir, ".cornfield", "skills", "a", "SKILL.md"), context)).toBe("agent");
		expect(scopeOf(path.join(projectRoot, ".cornfield", "skills", "b", "SKILL.md"), context)).toBe("project");
		// 兄弟目录：/root/cornfield-next 不应被当成 /root/cornfield 内
		expect(scopeOf(path.join(root, "cornfield-next", ".cornfield", "skills", "c", "SKILL.md"), context)).toBe(
			"global",
		);
		expect(scopeOf(path.join(root, "home", ".claude", "skills", "d", "SKILL.md"), context)).toBe("global");
	});

	test("没有 Project 归属时会话 cwd 自己也算 project 范围", async () => {
		const root = await tmpDir("scope-session-");
		const context = facts({ agentDir: path.join(root, "agent"), sessionCwd: path.join(root, "repo") });
		expect(scopeOf(path.join(root, "repo", ".cornfield", "skills", "x", "SKILL.md"), context)).toBe("project");
	});

	test("registry agent 的会话根 = 它的 agentDir 时，优先算 agent 而不是 project", async () => {
		const root = await tmpDir("scope-agentdir-");
		const agentDir = path.join(root, "agents", "hr");
		const context = facts({ agentDir, sessionCwd: agentDir, projectRoot: agentDir });
		expect(scopeOf(path.join(agentDir, ".cornfield", "skills", "x", "SKILL.md"), context)).toBe("agent");
	});

	test("包含判定走 pathIsWithin：symlink 两侧归一后算同一处（serve 的归一能力，浏览器做不到）", async () => {
		const root = await tmpDir("scope-symlink-");
		const realAgentDir = path.join(root, "agents", "hr");
		const linkedRoot = path.join(root, "link");
		// 文件真的存在于 agentDir 里（不存在的路径 realpath 会落到字面量，就测不到归一）
		const skillFile = await writeSkill(path.join(realAgentDir, "skills"), "x", "---\ndescription: 冒烟\n---\n正文\n");
		await fs.symlink(root, linkedRoot, "dir");
		// 锚点是真实目录，文件路径走 symlink：只有 realpath 归一才会判成 agent
		const context = facts({ agentDir: realAgentDir, sessionCwd: linkedRoot });
		expect(scopeOf(skillFile, context)).toBe("agent");
		expect(scopeOf(path.join(linkedRoot, "agents", "hr", "skills", "x", "SKILL.md"), context)).toBe("agent");
	});
});

describe("readSkillFileFacts — 版本三事实", () => {
	test("声明了 version 就带回；指纹对同一内容稳定、对改动敏感；mtime 来自文件系统", async () => {
		const dir = await tmpDir("scope-filefacts-");
		const declared = await writeSkill(dir, "with-version", "---\ndescription: 有版本\nversion: 1.2.3\n---\n冒烟\n");
		const first = await readSkillFileFacts(declared);
		if ("error" in first) throw new Error(first.error);
		expect(first.version).toBe("1.2.3");
		expect(first.description).toBe("有版本");
		expect(first.fingerprint).toMatch(/^[0-9a-f]{8}$/);
		expect(first.updatedAt).toBeGreaterThan(0);

		const second = await readSkillFileFacts(declared);
		if ("error" in second) throw new Error(second.error);
		expect(second.fingerprint).toBe(first.fingerprint);

		await Bun.write(declared, "---\ndescription: 有版本\nversion: 1.2.3\n---\n改动\n");
		const third = await readSkillFileFacts(declared);
		if ("error" in third) throw new Error(third.error);
		expect(third.fingerprint).not.toBe(first.fingerprint);
	});

	test("没声明 version 时 version 缺省（不是空串），deprecated 按 frontmatter 判定", async () => {
		const dir = await tmpDir("scope-noversion-");
		const file = await writeSkill(dir, "plain", "---\ndescription: 没版本\ndeprecated: true\n---\n正文\n");
		const result = await readSkillFileFacts(file);
		if ("error" in result) throw new Error(result.error);
		expect(result.version).toBeUndefined();
		expect(result.deprecated).toBe(true);
	});

	test("文件不存在 → error（不是「没有版本」）", async () => {
		const dir = await tmpDir("scope-missing-");
		const result = await readSkillFileFacts(path.join(dir, "nope", "SKILL.md"));
		expect("error" in result).toBe(true);
		if ("error" in result) expect(result.error).toContain("不存在");
	});
});

describe("projectLoadedSkills — 已加载技能", () => {
	test("带出范围/来源/激活/状态；文件读不到标 unavailable 并进 errors；deprecated 进状态", async () => {
		const root = await tmpDir("scope-loaded-");
		const agentDir = path.join(root, "agents", "hr");
		const projectRoot = path.join(root, "repo");
		const context = facts({ agentDir, sessionCwd: projectRoot, projectRoot });

		const okPath = await writeSkill(path.join(agentDir, ".cornfield", "skills"), "ok", "---\ndescription: d\n---\n");
		const gonePath = path.join(agentDir, ".cornfield", "skills", "gone", "SKILL.md");
		const depPath = await writeSkill(
			path.join(projectRoot, ".cornfield", "skills"),
			"legacy",
			"---\ndescription: d\ndeprecated: true\n---\n",
		);

		const skills: Skill[] = [
			{
				name: "ok",
				description: "d",
				filePath: okPath,
				baseDir: path.dirname(okPath),
				source: "native:project",
				_source: { provider: "native", providerName: "Native", path: okPath, level: "project" },
			},
			{
				name: "gone",
				description: "d",
				filePath: gonePath,
				baseDir: path.dirname(gonePath),
				source: "native:project",
				_source: { provider: "native", providerName: "Native", path: gonePath, level: "project" },
			},
			{
				name: "legacy",
				description: "d",
				filePath: depPath,
				baseDir: path.dirname(depPath),
				source: "native:project",
				_source: { provider: "native", providerName: "Native", path: depPath, level: "project" },
			},
		];

		const { rows, errors } = await projectLoadedSkills(context, skills);
		const byName = new Map(rows.map(row => [row.name, row]));

		expect(byName.get("ok")?.scope).toBe("agent");
		expect(byName.get("ok")?.activation).toBe("loaded");
		expect(byName.get("ok")?.status).toBe("enabled");
		expect(byName.get("ok")?.providerName).toBe("Native");
		expect(byName.get("ok")?.path).toBe(okPath);
		expect(byName.get("ok")?.fingerprint).toMatch(/^[0-9a-f]{8}$/);

		expect(byName.get("gone")?.status).toBe("unavailable");
		expect(byName.get("gone")?.fingerprint).toBeUndefined();
		expect(errors.some(e => e.path === gonePath)).toBe(true);

		expect(byName.get("legacy")?.scope).toBe("project");
		expect(byName.get("legacy")?.status).toBe("deprecated");
	});
});

describe("停用名单", () => {
	test("两个 settings 键各带来源；skill: 前缀剥掉；非 skill 扩展 id 忽略；重复名只留一条", () => {
		const inputs = collectDisabledInputs(["a", "b"], ["skill:a", "skill:c", "extension:nav", "skill:nav"]);
		expect(inputs).toEqual([
			{ name: "a", reason: "settings.skills.ignoredSkills" },
			{ name: "b", reason: "settings.skills.ignoredSkills" },
			{ name: "c", reason: "settings.disabledExtensions" },
			{ name: "nav", reason: "settings.disabledExtensions" },
		]);
	});

	test("磁盘上找得到 → 带描述与范围；找不到 → unavailable（停用与不存在是两件事）", async () => {
		const root = await tmpDir("scope-disabled-");
		const agentDir = path.join(root, "agents", "hr");
		const sessionCwd = path.join(root, "repo");
		const context = facts({ agentDir, sessionCwd });
		const found = await writeSkill(
			path.join(agentDir, "skills"),
			"present",
			"---\ndescription: 用户级技能 seed\nversion: 0.1.0\n---\n",
		);

		const rows = await projectDisabledSkills(context, [
			{ name: "present", reason: "settings.skills.ignoredSkills" },
			{ name: "missing", reason: "settings.disabledExtensions" },
		]);
		const byName = new Map(rows.map(row => [row.name, row]));
		expect(byName.get("present")?.description).toContain("用户级技能 seed");
		expect(byName.get("present")?.version).toBe("0.1.0");
		expect(byName.get("present")?.level).toBe("user");
		expect(byName.get("present")?.scope).toBe("agent");
		expect(byName.get("present")?.activation).toBe("discoverable");
		expect(byName.get("present")?.status).toBe("disabled");
		expect(byName.get("present")?.path).toBe(found);

		expect(byName.get("missing")?.status).toBe("unavailable");
		expect(byName.get("missing")?.reason).toContain("settings.disabledExtensions");
		expect(byName.get("missing")?.reason).toContain("找不到");
	});
});

describe("splitSkillWarnings — 发现警告分流", () => {
	test("带技能路径的警告 = 该技能被挡住；空路径 = 扫描级错误", () => {
		const { blocked, errors } = splitSkillWarnings([
			{ skillPath: "/a/skills/dup/SKILL.md", message: 'name collision: "dup" already loaded from /b' },
			{ skillPath: "", message: "scan failed: EACCES" },
		]);
		expect(blocked).toEqual([
			{ name: "dup", path: "/a/skills/dup/SKILL.md", reason: 'name collision: "dup" already loaded from /b' },
		]);
		expect(errors).toEqual([{ path: "", message: "scan failed: EACCES" }]);
	});
});
