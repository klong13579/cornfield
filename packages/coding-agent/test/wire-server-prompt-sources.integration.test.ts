/**
 * F5 e2e — `get_agent_prompt_sources`：agentDir 里到底有哪些 prompt 源。
 *
 * 之前这份清单写在前端（web-app Prompts tab 硬编码 7 项）并且已经漂移：
 * `.omp/SYSTEM.md` 是旧路径（实际是 `.cornfield/SYSTEM.md`）、`AGENTS-personal.md` 与 `CONTEXT.md`
 * 全仓库只有那一处提到（根本不存在），而真正 always-on 的 `TOOLS.md` /
 * `knowledge/external-workspaces.md` 反而没有入口。
 *
 * 真 serve + 隔离 HOME，验证：
 *   1. 清单是那 7 个 prompt 源、按骨架写出顺序，一个不多一个不少（`TODO.md` 已退出 prompt 面）；
 *   2. **逐项报 exists**——缺的那项也在清单里（不是裁成「存在的那些」）；
 *   3. 是活读（补上文件后 exists 变 true），不是启动时快照；
 *   4. 非 prompt 面（.gitignore / .cornfield/config.yml / skills/lint/SKILL.md）不混进来；
 *   5. 未知 agent → 报错，不拿焦点 agent 顶上。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@cornfield/client";
import type { AgentPromptSourcesDto } from "@cornfield/wire";
import { waitForServe } from "./wait-for-serve";

/** prompt 面 = 会被读进模型上下文的那些，顺序即骨架的写出顺序。 */
const EXPECTED_PROMPT_PATHS = [
	"AGENTS.md",
	"mission.md",
	"TOOLS.md",
	"user.md",
	"prompt-includes.json",
	".cornfield/SYSTEM.md",
	"knowledge/external-workspaces.md",
];

/** 一开始只放两个 prompt 源（其余靠「补文件后 exists 变 true」证明是活读）。 */
const SEEDED_PROMPT_FILES = ["AGENTS.md", "user.md"];

let isolatedHome: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let info = { url: "", token: "" };
let hrAgentDir: string;

async function seedAgents(home: string): Promise<string> {
	hrAgentDir = path.join(home, "agents", "hr");
	await fs.mkdir(path.join(hrAgentDir, "sessions"), { recursive: true });
	await fs.mkdir(path.join(hrAgentDir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(hrAgentDir, ".cornfield", "workspace.json"),
		JSON.stringify({
			schemaVersion: 2,
			id: "hr",
			name: "hr-agent",
			type: "agent",
			root: ".",
			projectRoot: ".",
			skillsDir: ".cornfield/skills/",
			sessionsDir: "sessions/",
		}),
	);
	for (const rel of SEEDED_PROMPT_FILES) {
		await Bun.write(path.join(hrAgentDir, rel), `seed: ${rel}\n`);
	}
	// 非 prompt 面的文件也放一个：它不该出现在清单里。
	await Bun.write(path.join(hrAgentDir, ".gitignore"), "sessions/\n");
	const registryDir = path.join(home, ".cornfield", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: { hr: { path: hrAgentDir, registeredAt: new Date().toISOString(), template: "default" } },
		}),
	);
	return hrAgentDir;
}

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-prompts-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	const projectCwd = path.join(isolatedHome, "project");
	await fs.mkdir(projectCwd, { recursive: true });
	await seedAgents(isolatedHome);

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

describe("get_agent_prompt_sources", () => {
	test("列出全部 prompt 源并逐项报 exists（缺的也在清单里）", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const dto = await client.request<AgentPromptSourcesDto>({
				type: "get_agent_prompt_sources",
				sessionId: "hr",
			});

			// 一个不多、一个不少，且顺序稳定（UI 直接渲染）。
			expect(dto.sources.map(source => source.path)).toEqual(EXPECTED_PROMPT_PATHS);
			// 每一项都带可渲染的元数据。
			for (const source of dto.sources) {
				expect(source.title.length, source.path).toBeGreaterThan(0);
				expect(source.description.length, source.path).toBeGreaterThan(0);
			}
			// 存在的两个为 true，没建的那 5 个也**在清单里**、报 false。
			expect(Object.fromEntries(dto.sources.map(s => [s.path, s.exists]))).toEqual({
				"AGENTS.md": true,
				"mission.md": false,
				"TOOLS.md": false,
				"user.md": true,
				"prompt-includes.json": false,
				".cornfield/SYSTEM.md": false,
				"knowledge/external-workspaces.md": false,
			});
			// 非 prompt 面混进来就是回归（.gitignore 已在盘上，也不该出现；TODO.md 已退出 prompt 面）。
			const paths = dto.sources.map(source => source.path);
			expect(paths).not.toContain("TODO.md");
			expect(paths).not.toContain(".gitignore");
			expect(paths).not.toContain(".cornfield/config.yml");
			expect(paths).not.toContain(".cornfield/skills/lint/SKILL.md");
		} finally {
			client.close();
		}
	}, 60_000);

	test("补上文件后 exists 变 true（活读，不是启动快照）", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			for (const rel of EXPECTED_PROMPT_PATHS.filter(p => !SEEDED_PROMPT_FILES.includes(p))) {
				await Bun.write(path.join(hrAgentDir, rel), `created later: ${rel}\n`);
			}
			const dto = await client.request<AgentPromptSourcesDto>({
				type: "get_agent_prompt_sources",
				sessionId: "hr",
			});
			expect(dto.sources.every(source => source.exists)).toBe(true);
		} finally {
			client.close();
		}
	}, 60_000);

	test("未知 agent 报错，不拿焦点 agent 顶上", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			await expect(client.request({ type: "get_agent_prompt_sources", sessionId: "no-such-agent" })).rejects.toThrow(
				/unknown agent/,
			);
		} finally {
			client.close();
		}
	}, 60_000);
});
