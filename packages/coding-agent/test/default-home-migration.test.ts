/**
 * `migrateDefaultAgentHome` — the ownership list and the two shapes that matter.
 *
 * Real temp dirs, real files, no mocks: the point of the migration is what ends up on disk.
 * Isolated by pointing both roots at temp dirs (`setClientDir` / `setDefaultAgentHome`), so the
 * developer's own `~/.cornfield/agent` and `~/cf-workspace` are never touched.
 *
 * Cases:
 *   - only the old side has data → everything moves, the config is merged into the home's
 *     `.cornfield/config.yml` (doc §12), and the client-side config file stays readable;
 *   - both sides have data → the home's copy wins (never overwritten), the source copy stays in
 *     the client dir and is *reported*, and config keys the home alone declares survive.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setClientDir, setConfigRootDir, setDefaultAgentHome } from "@cornfield/utils";
import { YAML } from "bun";
import { checkDefaultAgentHome, DEFAULT_HOME_OWNERSHIP, migrateDefaultAgentHome } from "../src/skeleton/default-home";

let root: string;
let clientDir: string;
let home: string;
let savedHomeEnv: string | undefined;
let savedClientEnv: string | undefined;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-default-home-migration-"));
	clientDir = path.join(root, "client", "agent");
	home = path.join(root, "cf-workspace");
	await fs.mkdir(clientDir, { recursive: true });
	await fs.mkdir(path.join(home, ".cornfield"), { recursive: true });
	savedHomeEnv = process.env.HOME;
	savedClientEnv = process.env.CORNFIELD_CLIENT_DIR;
	process.env.HOME = path.join(root, "home");
	setConfigRootDir(path.join(root, "client"));
	setClientDir(clientDir);
	setDefaultAgentHome(home);
});

afterEach(async () => {
	setConfigRootDir(undefined);
	setDefaultAgentHome(undefined);
	if (savedClientEnv === undefined) delete process.env.CORNFIELD_CLIENT_DIR;
	else setClientDir(savedClientEnv);
	if (savedHomeEnv === undefined) delete process.env.HOME;
	else process.env.HOME = savedHomeEnv;
	await fs.rm(root, { recursive: true, force: true });
});

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Write a fixture file and backdate it: a file written *just now* is "in use by a live process"
 * as far as the migration is concerned (that is the rule under test elsewhere), so ordinary
 * fixtures must look like files that have settled.
 */
async function write(file: string, content: string, ageMs: number = TWO_HOURS_MS): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	const when = (Date.now() - ageMs) / 1000;
	await fs.utimes(file, when, when);
}

async function exists(p: string): Promise<boolean> {
	return await fs.stat(p).then(
		() => true,
		() => false,
	);
}

async function listing(dir: string): Promise<string[]> {
	return (await fs.readdir(dir).catch(() => [])).sort();
}

const entryOf = (report: Awaited<ReturnType<typeof migrateDefaultAgentHome>>, name: string) =>
	report.entries.find(entry => entry.name === name);

describe("归属清单", () => {
	test("每个 agent 侧条目都有落点，client 侧条目都带原因", () => {
		for (const item of DEFAULT_HOME_OWNERSHIP) {
			if (item.owner === "agent") expect(item.target).toBeTruthy();
			else expect(item.reason.length).toBeGreaterThan(0);
		}
		// 用户拍板过的四类：会话 / 配置 / 记忆 / 命令 归家；客户端进程的东西不搬。
		const agentOwned = DEFAULT_HOME_OWNERSHIP.filter(i => i.owner === "agent").map(i => i.name);
		expect(agentOwned).toContain("sessions");
		expect(agentOwned).toContain("config.yml");
		expect(agentOwned).toContain("memories");
		expect(agentOwned).toContain("commands");
		expect(DEFAULT_HOME_OWNERSHIP.filter(i => i.owner === "client").map(i => i.name)).toContain("skills");
	});
});

describe("只有旧的一边有数据", () => {
	test("sessions / memories / commands 搬到家，config 合进 <home>/.cornfield/config.yml", async () => {
		await write(path.join(clientDir, "sessions", "-repo", "by-date", "2026-01-01", "a.jsonl"), "{}\n");
		await write(path.join(clientDir, "sessions", "-other", "by-date", "2026-01-01", "b.jsonl"), "{}\n");
		await write(path.join(clientDir, "memories", "-repo", "MEMORY.md"), "hello\n");
		await write(path.join(clientDir, "commands", "deploy.md"), "run deploy\n");
		await write(
			path.join(clientDir, "config.yml"),
			YAML.stringify({ theme: { dark: "titanium" }, shellPath: "/bin/zsh" }, null, 2),
		);
		// 客户端侧的东西：一个字节都不许动。
		await write(path.join(clientDir, "registry.json"), "{}\n");

		const report = await migrateDefaultAgentHome();

		expect(await listing(path.join(home, "sessions"))).toEqual(["-other", "-repo"]);
		expect(await exists(path.join(home, "sessions", "-repo", "by-date", "2026-01-01", "a.jsonl"))).toBe(true);
		expect(await listing(path.join(home, "memories"))).toEqual(["-repo"]);
		expect(await listing(path.join(home, "commands"))).toEqual(["deploy.md"]);

		// 家里的配置根：doc §12 说的那个文件，内容 = 旧 config.yml（源赢）。
		const merged = YAML.parse(await Bun.file(path.join(home, ".cornfield", "config.yml")).text()) as Record<
			string,
			unknown
		>;
		expect(merged.shellPath).toBe("/bin/zsh");
		expect(merged.theme).toEqual({ dark: "titanium" });

		// 旧文件仍在（它还是客户端级配置层的一张脸），不是「搬走就没」。
		expect(await exists(path.join(clientDir, "config.yml"))).toBe(true);
		expect(await exists(path.join(clientDir, "registry.json"))).toBe(true);

		const sessions = entryOf(report, "sessions");
		expect(sessions?.status).toBe("moved");
		expect(sessions?.movedCount).toBe(2);
		const config = entryOf(report, "config.yml");
		expect(config?.status).toBe("merged");
		expect(config?.sourceHash).toBeTruthy();
		expect(config?.targetHash).toBeTruthy();
		// client 侧条目留在原地，并且报告里说得出为什么。
		expect(entryOf(report, "skills")?.status).toBe("absent");
		expect(entryOf(report, "blobs")?.reason).toContain("client root");
		expect(report.before.clientDirEntries).toBeGreaterThan(report.after.clientDirEntries);
	});
});

describe("两边都有数据", () => {
	test("同名条目不覆盖也不删：家的那份赢，旧的那份留在原地被报出来", async () => {
		// sessions：一个同名（冲突）+ 一个只有旧边（可搬）
		await write(path.join(clientDir, "sessions", "shared", "old.jsonl"), "old\n");
		await write(path.join(clientDir, "sessions", "-repo", "new.jsonl"), "new\n");
		await write(path.join(home, "sessions", "shared", "home.jsonl"), "home\n");

		// 配置：两边都写了同名键，且家这边有一个旧边没有的键。
		await write(
			path.join(clientDir, "config.yml"),
			YAML.stringify({ shellPath: "/bin/zsh", theme: { dark: "titanium" } }, null, 2),
		);
		await write(
			path.join(home, ".cornfield", "config.yml"),
			YAML.stringify({ shellPath: "/bin/bash", perAgentProbe: 7 }, null, 2),
		);

		const report = await migrateDefaultAgentHome();

		// 家的那份没被动过
		expect(await listing(path.join(home, "sessions", "shared"))).toEqual(["home.jsonl"]);
		expect(await Bun.file(path.join(home, "sessions", "shared", "home.jsonl")).text()).toBe("home\n");
		// 旧的那份也还在（没删）
		expect(await Bun.file(path.join(clientDir, "sessions", "shared", "old.jsonl")).text()).toBe("old\n");
		// 不冲突的那条搬过去了
		expect(await exists(path.join(home, "sessions", "-repo", "new.jsonl"))).toBe(true);

		const sessions = entryOf(report, "sessions");
		expect(sessions?.conflicts).toEqual(["shared"]);
		expect(sessions?.movedCount).toBe(1);

		// 配置合并：源（旧文件，本次真正生效的那层）赢；家这边独有的键保留。
		const merged = YAML.parse(await Bun.file(path.join(home, ".cornfield", "config.yml")).text()) as Record<
			string,
			unknown
		>;
		expect(merged.shellPath).toBe("/bin/zsh");
		expect(merged.perAgentProbe).toBe(7);
		expect(merged.theme).toEqual({ dark: "titanium" });
	});

	test("正在被写入的会话文件不动（活跃进程的路径不许被搬走）", async () => {
		const live = path.join(clientDir, "sessions", "-repo", "by-date", "2026-01-01", "live.jsonl");
		// 「刚刚」= 有一个进程正拿着这个路径在追加。
		await write(live, "live\n", 0);
		await write(path.join(clientDir, "sessions", "-other", "by-date", "2025-01-01", "old.jsonl"), "old\n");
		const now = Date.now();

		const report = await migrateDefaultAgentHome({ liveWindowMs: 60_000, now });

		expect(await exists(live)).toBe(true);
		expect(await exists(path.join(home, "sessions", "-other", "by-date", "2025-01-01", "old.jsonl"))).toBe(true);
		expect(entryOf(report, "sessions")?.live).toContain("-repo");
	});

	test("幂等：第二次跑没有东西可搬，家不变", async () => {
		await write(path.join(clientDir, "sessions", "-repo", "a.jsonl"), "a\n");
		const first = await migrateDefaultAgentHome();
		expect(entryOf(first, "sessions")?.status).toBe("moved");

		const before = await listing(path.join(home, "sessions", "-repo"));
		const second = await migrateDefaultAgentHome();
		expect(entryOf(second, "sessions")?.status).toBe("absent");
		expect(await listing(path.join(home, "sessions", "-repo"))).toEqual(before);
	});
});

describe("注册表里 default 的路径 vs 本进程解析出的家", () => {
	/** registry.json 按 call-time HOME 解析（`skeleton/registry`），这里也用 HOME 隔离。 */
	async function writeRegistry(defaultPath: string | undefined): Promise<void> {
		const dir = path.join(process.env.HOME!, ".cornfield", "agent");
		await fs.mkdir(dir, { recursive: true });
		const agents: Record<string, unknown> = defaultPath
			? { default: { path: defaultPath, registeredAt: "x", template: "default" } }
			: {};
		await Bun.write(path.join(dir, "registry.json"), JSON.stringify({ version: 2, agents }, null, 2));
	}

	test("一致：ok", async () => {
		setDefaultAgentHome(undefined);
		const resolved = path.join(process.env.HOME!, "cf-workspace");
		await writeRegistry(resolved);
		const check = await checkDefaultAgentHome();
		expect(check).toEqual({ home: resolved, registryPath: resolved, ok: true });
	});

	test("没有声明：没有可比较的两边（ok，不是「挑了一个」）", async () => {
		setDefaultAgentHome(undefined);
		await writeRegistry(undefined);
		const check = await checkDefaultAgentHome();
		expect(check.ok).toBe(true);
		expect(check.registryPath).toBeUndefined();
	});

	test("不一致：ok=false 且错误文本同时点名两个路径", async () => {
		setDefaultAgentHome(undefined);
		const declared = path.join(process.env.HOME!, "somewhere-else");
		await writeRegistry(declared);
		const check = await checkDefaultAgentHome();
		expect(check.ok).toBe(false);
		expect(check.registryPath).toBe(declared);
		expect(check.message).toContain(`declares Agent "default" at "${declared}"`);
		expect(check.message).toContain(
			`resolves the default Agent's home to "${path.join(process.env.HOME!, "cf-workspace")}"`,
		);
		expect(check.message).toContain("refusing to pick either");
	});
});
