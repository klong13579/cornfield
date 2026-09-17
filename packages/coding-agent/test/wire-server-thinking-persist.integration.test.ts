/**
 * F3 e2e — 看板选 thinking 档位必须真的落盘。
 *
 * 症状：`set_thinking_level` 走 `AgentSession#setThinkingLevel(level)`（persist 缺省 false），
 * 于是 UI 上改了档位、两份配置文件都不动，重启回退，且没有任何提示。
 *
 * 真 serve + 隔离 HOME，验证三件事（不 prompt，不产生费用）：
 *   1. 不带 `persist` → 会话内档位确实变了，但配置文件不出现 `defaultThinkingLevel`；
 *   2. `persist:true` → 同一个文件里真的出现 `defaultThinkingLevel: <新档位>`；
 *   3. 之后再不带 `persist` 改档 → 文件里仍是第 2 步写下的值（不是「写了一次就随便改」）。
 *
 * 落点也一并钉住（F6 要把两份 config 收成一份，先要看清今天写的是哪一份）：
 * default agent 的配置根是全局 agent 目录，即 `<HOME>/.cornfield/agent/config.yml`；
 * 同目录下的 `.cornfield/config.yml`（Settings 的项目覆盖层）不应被这条命令创建。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@cornfield/agent";
import { PiClient } from "@cornfield/client";
import { YAML } from "bun";
import { waitForServe } from "./wait-for-serve";

let isolatedHome: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let info = { url: "", token: "" };

/** default agent 的配置根：`Settings.init()` 的 agentDir（全局 agent 目录），不是 serve 的 cwd。 */
const agentDir = (): string => path.join(isolatedHome, ".cornfield", "agent");
/** Settings 的项目覆盖层（`<agentDir>/.cornfield/config.yml`）—— 本命令不该碰它。 */
const projectConfigPath = (): string => path.join(agentDir(), ".cornfield", "config.yml");

/** Settings 的保存是 100ms 防抖；取 500ms 余量再读盘。 */
const SAVE_SETTLE_MS = 500;

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-thinking-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	// serve 的 cwd 取隔离 HOME 下的空目录：否则带上本仓库自己的项目级 .cornfield。
	const projectCwd = path.join(isolatedHome, "project");
	await fs.mkdir(projectCwd, { recursive: true });

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = await new Promise<number>(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(p));
		});
	});
	proc = Bun.spawn(
		[
			"bun",
			`${repoRoot}/packages/coding-agent/src/cli.ts`,
			"serve",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
			"--no-extensions",
		],
		{
			cwd: projectCwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
		},
	);
	info = await waitForServe(proc, port);
}, 70_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

/** 读配置文件的 `defaultThinkingLevel`；文件不存在返回 undefined（不是「读失败」）。 */
async function readPersistedLevel(): Promise<unknown> {
	if (!(await Bun.file(path.join(agentDir(), "config.yml")).exists())) return undefined;
	const parsed = YAML.parse(await Bun.file(path.join(agentDir(), "config.yml")).text()) as Record<string, unknown>;
	return parsed.defaultThinkingLevel;
}

describe("set_thinking_level 的 persist 开关", () => {
	test("不带 persist 不落盘；persist:true 落到 <agentDir>/config.yml", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const initial = (await client.request<{ thinkingLevel?: string }>({ type: "get_state" })).thinkingLevel;
			expect(typeof initial).toBe("string");
			// 档位候选从内核自己的答复取（模型的档位范围可能是非连续的，比如只有 low/high/xhigh）：
			// 拿一个模型不支持的档位去测，测到的是夹取结果而不是这条命令的行为。
			const available = (
				await client.request<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" })
			).levels;
			const candidates = available.filter(level => level !== initial);
			expect(candidates.length).toBeGreaterThanOrEqual(2);
			// 也避开当前档位：内核只在档位真的变化时才写盘，用一个「已经就是这个值」的档位
			// 去测 persist，测出来的是内核的幂等而不是这条命令的行为。
			const [withoutPersist, withPersist] = candidates;

			// ① 不带 persist：会话内档位变了，盘上什么都没多。
			await client.request({ type: "set_thinking_level", level: withoutPersist });
			const afterEphemeral = (await client.request<{ thinkingLevel?: string }>({ type: "get_state" })).thinkingLevel;
			expect(afterEphemeral).toBe(withoutPersist); // 不是在空跑：档位确实生效了
			await Bun.sleep(SAVE_SETTLE_MS);
			expect(await readPersistedLevel()).toBeUndefined();

			// ② persist:true：同一个文件里真的出现 defaultThinkingLevel。
			await client.request({ type: "set_thinking_level", level: withPersist, persist: true });
			await Bun.sleep(SAVE_SETTLE_MS);
			expect(await readPersistedLevel()).toBe(withPersist);

			// ③ 再不带 persist 改档：会话变了，盘上不动 —— 「看板改了」不等于「配置改了」。
			await client.request({ type: "set_thinking_level", level: withoutPersist });
			const afterSecondEphemeral = (await client.request<{ thinkingLevel?: string }>({ type: "get_state" }))
				.thinkingLevel;
			expect(afterSecondEphemeral).toBe(withoutPersist);
			await Bun.sleep(SAVE_SETTLE_MS);
			expect(await readPersistedLevel()).toBe(withPersist);

			// 落点是 <agentDir>/config.yml，不是 <agentDir>/.cornfield/config.yml（F6 的两份 config）。
			await expect(Bun.file(projectConfigPath()).exists()).resolves.toBe(false);
		} finally {
			client.close();
		}
	}, 60_000);
});
