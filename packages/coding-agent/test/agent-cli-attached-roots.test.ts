/**
 * F8 — `attachedRoots` 有了写侧（`cornfield agent init --root`）。
 *
 * 症状：`WorkspaceDeclaration#attachedRoots` 只有读者（`session/session-workspace.ts` 把每个声明的
 * root 折进会话工作面），全仓库没有任何写侧 —— 「一个 agent 读多个根」只能手工改 JSON 才可达。
 *
 * 这里钉住的是写入契约本身：
 *   1. 成功路径落在 `<agentDir>/.cornfield/workspace.json` 的 `attachedRoots`（绝对 realpath）；
 *   2. 加性 + 去重（重复 init 不丢已声明的 root）；
 *   3. 读-改-写保留其它键（含本模块不认识的键）；
 *   4. 非法输入（不存在 / 不是目录 / 就是 agentDir 自己）报错，且**声明文件一个字节都不动**
 *      —— 声明一个不存在的 root 会让这个 agent 的每次会话解析都失败，宁可 init 失败；
 *   5. `agent validate` 对「声明了但已不存在」的 root 报 error（今天它会说 valid: true）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentInit, runAgentValidate } from "../src/cli/agent-cli";
import { readWorkspaceDeclaration, workspaceFilePath } from "../src/skeleton/workspace";

let isolatedHome: string;
let savedHome: string | undefined;
let agentRoot: string;

beforeEach(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "cf-agentdir-roots-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	agentRoot = path.join(isolatedHome, "agents");
	await fs.mkdir(agentRoot, { recursive: true });
});

afterEach(async () => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

/**
 * `dir` 必须显式给：`resolveAgentDir()` 用的是 `os.homedir()`，不是 `process.env.HOME`
 * —— 只隔离 HOME 的话 agentDir 会落进真实 `~/.cornfield/agents/`（隔离的只有 registry，
 * 它的路径是延迟解析的）。本文件的第一版就是这么把测试残留写进真 home 的。
 */
function initAgent(roots?: string[]): ReturnType<typeof runAgentInit> {
	return runAgentInit({ name: "roots-bot", dir: agentRoot, ...(roots ? { roots } : {}) });
}

/** 建一个真实存在的目录，供 --root 指向。 */
async function makeDir(name: string): Promise<string> {
	const dir = path.join(isolatedHome, name);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

async function declaredRoots(agentDir: string): Promise<string[]> {
	const read = await readWorkspaceDeclaration(agentDir);
	if (read.state !== "declared") throw new Error(`expected a declared workspace, got ${read.state}`);
	return read.declaration.attachedRoots ?? [];
}

describe("agent init --root", () => {
	test("写进 attachedRoots（绝对 realpath）并从结果里回传", async () => {
		const shared = await makeDir("shared");
		// macOS 的 /tmp 是符号链接：断言用 realpath，否则测的是路径拼写而不是声明内容。
		const realShared = await fs.realpath(shared);

		const result = await initAgent([shared]);

		expect(result.attachedRoots).toEqual([realShared]);
		expect(await declaredRoots(result.agentDir)).toEqual([realShared]);
		// 反向自证隔离：agentDir 只可能在本次用例的临时父目录下。
		expect(result.agentDir.startsWith(agentRoot)).toBe(true);
	});

	test("可重复 + 幂等：第二个 root 不挤掉第一个，重复同一个 path 不产生第二份", async () => {
		const a = await makeDir("a");
		const b = await makeDir("b");
		const realA = await fs.realpath(a);
		const realB = await fs.realpath(b);

		const first = await initAgent([a]);
		await initAgent([b, a]);

		expect(await declaredRoots(first.agentDir)).toEqual([realA, realB]);
	});

	test("相对路径按 cwd 解析后落绝对路径", async () => {
		const shared = await makeDir("rel-shared");
		const realShared = await fs.realpath(shared);
		const relative = path.relative(process.cwd(), shared);
		// 相对写法才测得着「按 cwd 解析」这条；否则测的是绝对路径直通。
		expect(path.isAbsolute(relative)).toBe(false);

		const result = await initAgent([relative]);
		expect(await declaredRoots(result.agentDir)).toEqual([realShared]);
	});

	test("读-改-写：其它声明键（含本模块不认识的键）原样保留", async () => {
		const shared = await makeDir("shared");
		const first = await initAgent();
		const file = workspaceFilePath(first.agentDir);
		const before = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
		before.customKeyFromAnotherTool = { keep: "me" };
		await Bun.write(file, `${JSON.stringify(before, null, 2)}\n`);

		await initAgent([shared]);

		const after = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
		expect(after.customKeyFromAnotherTool).toEqual({ keep: "me" });
		expect(after.knowledge).toEqual(before.knowledge);
		expect(after.skillsDir).toBe(before.skillsDir);
		expect(after.createdAt).toBe(before.createdAt);
	});

	test("不存在的 root：报错，且声明文件一个字节都不动", async () => {
		const created = await initAgent();
		const file = workspaceFilePath(created.agentDir);
		const before = await Bun.file(file).text();

		await expect(initAgent([path.join(isolatedHome, "nope")])).rejects.toThrow(/--root does not exist/);

		expect(await Bun.file(file).text()).toBe(before);
		expect(await declaredRoots(created.agentDir)).toEqual([]);
	});

	test("指向文件而不是目录：报错且不写", async () => {
		const created = await initAgent();
		const filePath = path.join(isolatedHome, "a-file.txt");
		await Bun.write(filePath, "not a directory\n");
		const before = await Bun.file(workspaceFilePath(created.agentDir)).text();

		await expect(initAgent([filePath])).rejects.toThrow(/is not a directory/);

		expect(await Bun.file(workspaceFilePath(created.agentDir)).text()).toBe(before);
	});

	test("指向 agentDir 自己：报错（agentDir 本来就是根，声明它是在说自己）", async () => {
		const created = await initAgent();

		await expect(initAgent([created.agentDir])).rejects.toThrow(/--root is the agentDir itself/);
		expect(await declaredRoots(created.agentDir)).toEqual([]);
	});
});

describe("agent validate 对声明的 root", () => {
	test("声明的 root 都在 → 不报这条错；其中一个被删掉 → error 且 valid:false", async () => {
		const keep = await makeDir("keep");
		const doomed = await makeDir("doomed");
		const realDoomed = await fs.realpath(doomed);
		const created = await initAgent([keep, doomed]);

		const healthy = await runAgentValidate({ agentDir: created.agentDir });
		expect(healthy.issues.some(i => i.message.includes("Declared attached root"))).toBe(false);

		await fs.rm(doomed, { recursive: true, force: true });
		const broken = await runAgentValidate({ agentDir: created.agentDir });
		const issue = broken.issues.find(i => i.message.includes("Declared attached root"));
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain(realDoomed);
		expect(broken.valid).toBe(false);
	});
});
