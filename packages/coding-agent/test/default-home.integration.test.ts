/**
 * The default Agent's home — real `serve`, isolated HOME, no mocks.
 *
 * Two facts this file pins, both from the split of "the client dir" and "the default Agent's home"
 * (`docs/agent-task-control-plane-v1.md` §12, `docs/agent-task-control-plane-v1-implementation.md` §2):
 *
 *   1. A session of the default Agent lands **in its home** (`~/.cornfield/agents/default/sessions/<encoded-cwd>`),
 *      while the session's own cwd stays the process cwd (P1). The client dir must not grow a
 *      second copy of that session directory.
 *   2. When the registry's `default` entry and the home this process resolves disagree, `serve`
 *      refuses to start — loudly, naming both paths. A session belongs to exactly one home, so
 *      there is no "pick one" branch to test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { waitForServe } from "./wait-for-serve";

let isolatedHome: string;
let savedHome: string | undefined;
let projectCwd: string;

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-default-home-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	projectCwd = path.join(isolatedHome, "repo");
	await fs.mkdir(projectCwd, { recursive: true });
});

afterAll(async () => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const defaultHome = (): string => path.join(isolatedHome, ".cornfield", "agents", "default");
const clientDir = (): string => path.join(isolatedHome, ".cornfield", "agent");
/**
 * The session file `serve` reports for its default session, read from the client's log file.
 *
 * stdout of a piped child is buffered until exit, so the log *file* is the observable channel;
 * the reported path is the child's own statement about where it opened its session.
 */
async function waitForSessionFile(_proc: ReturnType<typeof Bun.spawn>, timeoutMs = 20_000): Promise<string> {
	const logsDir = path.join(isolatedHome, ".cornfield", "logs");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const logs = await fs.readdir(logsDir).catch(() => [] as string[]);
		for (const name of logs) {
			const text = await Bun.file(path.join(logsDir, name))
				.text()
				.catch(() => "");
			const match = text.match(/"sessionFile":"([^"]+)"/);
			if (match) return match[1]!;
		}
		await Bun.sleep(200);
	}
	throw new Error("serve never reported a session file");
}

async function freePort(): Promise<number> {
	return await new Promise<number>(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

/** Write the registry the client would have, with `default` at the given path. */
async function writeRegistry(defaultPath: string | undefined): Promise<void> {
	const registryDir = clientDir();
	await fs.mkdir(registryDir, { recursive: true });
	const agents: Record<string, unknown> = {};
	if (defaultPath !== undefined) {
		agents.default = { path: defaultPath, registeredAt: new Date().toISOString(), template: "default" };
	}
	await Bun.write(path.join(registryDir, "registry.json"), JSON.stringify({ version: 2, agents }, null, 2));
}

function spawnServe(port: number): ReturnType<typeof Bun.spawn> {
	return Bun.spawn(
		[process.execPath, CLI, "serve", "--port", String(port), "--host", "127.0.0.1", "--no-extensions"],
		{
			cwd: projectCwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
		},
	);
}

describe("default Agent 的家 = ~/.cornfield/agents/default", () => {
	test("真 serve：default 的新会话根在 <home>/sessions/<encoded-cwd>/by-date/，client dir 不长第二份", async () => {
		await writeRegistry(defaultHome());
		const port = await freePort();
		const proc = spawnServe(port);
		try {
			await waitForServe(proc, port);

			// serve 自己报的会话文件路径 —— 布局由子进程说，不由测试猜。
			const sessionFile = await waitForSessionFile(proc);
			const relative = path.relative(defaultHome(), sessionFile);
			expect(relative).toMatch(/^sessions\/.+\/by-date\/\d{4}-\d{2}-\d{2}\/\d{6}__[0-9a-f]{8}\.jsonl$/);

			// 编码的是**进程 cwd**（P1），不是家：cwd 在 HOME 下 → home 相对编码 `<home>/repo` → `-repo`。
			const encoded = relative.split(path.sep)[1] ?? relative.split("/")[1]!;
			expect(encoded).toBe("-repo");
			const sessionRoot = path.join(defaultHome(), "sessions", encoded);
			expect(
				await fs.stat(sessionRoot).then(
					stat => stat.isDirectory(),
					() => false,
				),
			).toBe(true);

			// 客户端的 sessions 根下不许有同一个 cwd 的「第二份家」。
			expect(
				await fs.stat(path.join(clientDir(), "sessions", encoded)).then(
					stat => stat.isDirectory(),
					() => false,
				),
			).toBe(false);
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 90_000);

	test("注册表与解析出的家不一致：serve 拒绝启动，并说清两个路径", async () => {
		const declared = path.join(isolatedHome, "somewhere-else");
		await fs.mkdir(declared, { recursive: true });
		await writeRegistry(declared);

		const port = await freePort();
		const proc = spawnServe(port);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		]);

		expect(exitCode).not.toBe(0);
		const output = `${stdout}\n${stderr}`;
		// 错误文本钉住：两个路径都在，且明确说「拒绝挑一个」。
		expect(output).toContain(`declares Agent "default" at "${declared}"`);
		expect(output).toContain(`resolves the default Agent's home to "${defaultHome()}"`);
		expect(output).toContain("refusing to pick either");
		// 没起来 = 也没有把任何会话落进那个没人认的家。
		await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
	}, 60_000);
});
