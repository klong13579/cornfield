/**
 * `Settings` 的两个基座各有主人，别混：
 *
 *   - `agentDir` 默认 = **default Agent 的家**（`~/.cornfield/agents/default`）—— 它的 `config.yml` / 会话 / 记忆。
 *     客户端作用域的东西（凭证、registry、缓存）在客户端目录（`~/.cornfield/agent`），不是这里。
 *   - `cwd` 默认 = **进程的项目目录**（`getProjectDir()`）—— 它决定**项目层**读哪一个
 *     `<cwd>/.cornfield/config.yml`。F6 的「写侧跟随读侧优先级」也靠它。
 *
 * 测试用 `setProjectDir()` 而不是 `process.chdir()`：`getProjectDir()` 是导入期缓存，chdir 改不动它。
 *
 * 反例（本票验证时实测）：把 `cwd` 默认值也改成「家」之后，在一个带 `.cornfield/config.yml` 的仓库里跑
 * `cornfield config get grep.enabled`，答案从 `false` 变成 `true` —— 仓库自己的项目层不再被读到。
 * 这条用例就是钉住这件事：项目层跟 cwd 走，不跟家走。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultAgentHome, getProjectDir, setProjectDir } from "@cornfield/utils";
import { Settings } from "../src/config/settings";

let tmp: string;
let savedHome: string | undefined;
let savedCwd: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cf-settings-layer-"));
	savedHome = process.env.HOME;
	savedCwd = process.cwd();
	process.env.HOME = tmp;
});

afterEach(async () => {
	setProjectDir(savedCwd); // 先restore cwd（getProjectDir 是导入期缓存，改它要走过 setProjectDir）
	if (savedHome !== undefined) process.env.HOME = savedHome;
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(tmp, { recursive: true, force: true });
});

/** 造一个「仓库」：cwd 里有 `.cornfield/config.yml`。 */
async function makeRepo(name: string, key: string, value: string): Promise<string> {
	const repo = path.join(tmp, "repos", name);
	await fs.mkdir(path.join(repo, ".cornfield"), { recursive: true });
	await Bun.write(path.join(repo, ".cornfield", "config.yml"), `${key}:\n  enabled: ${value}\n`);
	return repo;
}

describe("Settings 的两个基座", () => {
	test("项目层 = cwd 的 .cornfield/config.yml；agentDir = default Agent 的家", async () => {
		const repo = await makeRepo("r1", "grep", "false");
		setProjectDir(repo);

		const settings = await Settings.create();

		// 项目层来自 cwd，不是来自家
		expect(settings.get("grep.enabled")).toBe(false);
		// 另一头：agentDir 默认是 default Agent 的家（客户端目录不在这里）
		expect(settings.getAgentDir()).toBe(getDefaultAgentHome());
		// 字面路径也钉一次：函数的取值不能悄悄换个布局。
		expect(settings.getAgentDir()).toBe(path.join(tmp, ".cornfield", "agents", "default"));
		// 裸跑 CLI（无 agent 身份）：配置根 = 进程项目目录 ⇒ 记忆与演化两把 key 相等，
		// 票 27 的拆 key 对裸跑 CLI 逐字节不变。
		expect(settings.getCwd()).toBe(getProjectDir());
	});

	test("换一个 cwd，项目层跟着换（家不变）", async () => {
		const repoA = await makeRepo("a", "grep", "false");
		const repoB = await makeRepo("b", "grep", "true");

		setProjectDir(repoA);
		const inA = await Settings.create();
		expect(inA.get("grep.enabled")).toBe(false);

		setProjectDir(repoB);
		const inB = await Settings.create();
		expect(inB.get("grep.enabled")).toBe(true);
		// 家不随 cwd 变
		expect(inB.getAgentDir()).toBe(inA.getAgentDir());
	});

	test("家那层自己写同样的键时，项目层仍然压过它（合并视图的优先级没变）", async () => {
		const repo = await makeRepo("r3", "grep", "false");
		const home = getDefaultAgentHome();
		await fs.mkdir(path.join(home, ".cornfield"), { recursive: true });
		await Bun.write(path.join(home, ".cornfield", "config.yml"), "grep:\n  enabled: true\n");
		setProjectDir(repo);

		const settings = await Settings.create();
		expect(settings.get("grep.enabled")).toBe(false);
	});
});
