/**
 * registry.json 的并发写。
 *
 * 症状（F1 的 worker 先量到的）：`registerAgent` 是「读整份 → 改一条 → 写回整份」。CLI 里
 * 「一次一个人敲」让这个假设成立，但 `cornfield serve` 逐帧并发处理命令 —— 两个客户端同时
 * `create_agent`，后写的那次会把先写的条目抹掉：两个 agentDir 都在盘上，`agent list` 里少一个。
 * 同进程并发两次 `runAgentInit` 实测 5/5 轮丢条目。
 *
 * 这里钉的是不变式本身：注册表的 read-modify-write 互斥（锁在 `skeleton/registry.ts` 里，
 * 所以 CLI / serve / gateway 三个写方都受保护），不是某个调用方自己排的队。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadRegistry, registerAgent, unregisterAgent } from "../src/skeleton/registry";

let isolatedHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "cf-registry-lock-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
});

afterEach(async () => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

async function makeAgentDir(name: string): Promise<string> {
	const dir = path.join(isolatedHome, "agents", name);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

describe("registry.json 的并发写", () => {
	test("8 个并发 registerAgent：一个都不能丢", async () => {
		const names = Array.from({ length: 8 }, (_, i) => `concurrent-${i}`);
		const dirs = await Promise.all(names.map(makeAgentDir));

		await Promise.all(names.map((name, i) => registerAgent(name, dirs[i]!)));

		const reg = await loadRegistry();
		expect(Object.keys(reg.agents).sort()).toEqual([...names].sort());
	});

	test("已有条目在并发注册里不被抹掉", async () => {
		const existing = await makeAgentDir("existing");
		await registerAgent("existing", existing);

		const names = Array.from({ length: 6 }, (_, i) => `late-${i}`);
		const dirs = await Promise.all(names.map(makeAgentDir));
		await Promise.all(names.map((name, i) => registerAgent(name, dirs[i]!)));

		const reg = await loadRegistry();
		expect(Object.keys(reg.agents).sort()).toEqual(["existing", ...names].sort());
	});

	test("并发 register 与 unregister 不同名：注销的那个不复活、注册的那个不消失", async () => {
		const doomed = await makeAgentDir("doomed");
		await registerAgent("doomed", doomed);
		const fresh = await makeAgentDir("fresh");

		await Promise.all([unregisterAgent("doomed"), registerAgent("fresh", fresh)]);

		const reg = await loadRegistry();
		expect(Object.keys(reg.agents)).toEqual(["fresh"]);
	});

	test("并发写之后文件仍是完整 JSON（不是半截：读得回来且条目齐全）", async () => {
		const names = Array.from({ length: 12 }, (_, i) => `burst-${i}`);
		const dirs = await Promise.all(names.map(makeAgentDir));
		await Promise.all(names.map((name, i) => registerAgent(name, dirs[i]!)));

		const raw = await Bun.file(path.join(isolatedHome, ".cornfield", "agent", "registry.json")).text();
		const parsed = JSON.parse(raw) as { version: number; agents: Record<string, unknown> };
		expect(parsed.version).toBe(2);
		expect(Object.keys(parsed.agents).length).toBe(names.length);
	});
});
