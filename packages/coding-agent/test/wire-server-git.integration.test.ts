import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@oh-my-pi/pi-client";

/**
 * 票 02 e2e — serve git 最小集（git_status/git_diff/git_log/git_show/git_branches）。
 * 三个场景：有改动 + 多分支仓库、空仓库。真实 serve 子进程 + pi-client。
 */
const URL_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;
const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

async function runGit(cwd: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout as ReadableStream<Uint8Array>).text(),
		new Response(child.stderr as ReadableStream<Uint8Array>).text(),
	]);
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`);
	return stdout;
}

async function pickPort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(p));
		});
	});
}

async function spawnServe(
	cwd: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; info: { url: string; token: string } }> {
	const port = await pickPort();
	const proc = Bun.spawn(
		[
			"bun",
			`${REPO_ROOT}/packages/coding-agent/src/cli.ts`,
			"serve",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
			"--no-extensions",
		],
		{ cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_NO_TITLE: "1" } },
	);
	const deadline = Date.now() + 60_000;
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`serve exited; log:\n${buf.slice(-1500)}`);
		buf += dec.decode(value);
		const m = buf.match(URL_RE);
		if (m) {
			reader.releaseLock();
			return { proc, info: { url: `ws://127.0.0.1:${m[1]}/ws${m[2] ?? ""}`, token: m[3] ?? "" } };
		}
	}
	reader.releaseLock();
	throw new Error(`serve not ready; log:\n${buf.slice(-1500)}`);
}

describe("git 最小集 — 有改动 + 多分支仓库", () => {
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let info = { url: "", token: "" };

	beforeAll(async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-rich-"));
		await runGit(repo, ["init", "-b", "main"]);
		await runGit(repo, ["config", "user.email", "test@example.com"]);
		await runGit(repo, ["config", "user.name", "Test"]);
		await Bun.write(path.join(repo, "a.txt"), "alpha\n");
		await runGit(repo, ["add", "-A"]);
		await runGit(repo, ["commit", "-m", "first"]);
		// 第二笔 commit + 分支
		await Bun.write(path.join(repo, "a.txt"), "alpha\nbeta\n");
		await runGit(repo, ["add", "-A"]);
		await runGit(repo, ["commit", "-m", "second"]);
		await runGit(repo, ["branch", "feature"]);
		// 改动：未暂存修改 + 未跟踪文件
		await Bun.write(path.join(repo, "a.txt"), "alpha\nbeta\ngamma\n");
		await Bun.write(path.join(repo, "b.txt"), "untracked\n");

		const spawned = await spawnServe(repo);
		proc = spawned.proc;
		info = spawned.info;
	}, 70_000);

	afterAll(async () => {
		if (proc) {
			proc.kill();
			await proc.exited;
		}
	});

	test("git_status：当前分支 + staged/unstaged/untracked 列表", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const res = await client.request<{
				branch: string | null;
				staged: string[];
				unstaged: string[];
				untracked: string[];
			}>({
				type: "git_status",
			});
			expect(res.branch).toBe("main");
			expect(res.staged).toEqual([]);
			expect(res.unstaged).toContain("a.txt");
			expect(res.untracked).toContain("b.txt");
		} finally {
			client.close();
		}
	});

	test("git_diff：working tree diff 包含改动文件", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const res = await client.request<{ diff: string }>({ type: "git_diff" });
			expect(res.diff).toContain("a.txt");
			expect(res.diff).toContain("gamma");
		} finally {
			client.close();
		}
	});

	test("git_log：hash/author/message 结构正确", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const res = await client.request<{ commits: { hash: string; author: string; message: string }[] }>({
				type: "git_log",
				count: 10,
			});
			expect(res.commits.length).toBeGreaterThanOrEqual(2);
			expect(res.commits[0].message).toBe("second");
			expect(res.commits[0].author).toBe("Test");
			expect(res.commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			client.close();
		}
	});

	test("git_show：单 commit 详情包含提交信息", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const res = await client.request<{ revision: string; detail: string }>({ type: "git_show", revision: "HEAD" });
			expect(res.revision).toBe("HEAD");
			expect(res.detail).toContain("second");
		} finally {
			client.close();
		}
	});

	test("git_branches：local + current（多分支）", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const res = await client.request<{ current: string | null; local: string[]; remote: string[] }>({
				type: "git_branches",
			});
			expect(res.current).toBe("main");
			expect(res.local).toContain("main");
			expect(res.local).toContain("feature");
		} finally {
			client.close();
		}
	});
});

describe("git 最小集 — 空仓库（无 commit）", () => {
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let info = { url: "", token: "" };

	beforeAll(async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-empty-"));
		await runGit(repo, ["init", "-b", "main"]);
		await Bun.write(path.join(repo, "seed.txt"), "seed\n");

		const spawned = await spawnServe(repo);
		proc = spawned.proc;
		info = spawned.info;
	}, 70_000);

	afterAll(async () => {
		if (proc) {
			proc.kill();
			await proc.exited;
		}
	});

	test("git_log：空仓库返回空 commits（不报错）", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const res = await client.request<{ commits: unknown[] }>({ type: "git_log" });
			expect(res.commits).toEqual([]);
		} finally {
			client.close();
		}
	});

	test("git_branches：空仓库 local 为空、current 为非 null", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			const res = await client.request<{ current: string | null; local: string[]; remote: string[] }>({
				type: "git_branches",
			});
			expect(res.local).toEqual([]);
			expect(res.current).not.toBeNull();
		} finally {
			client.close();
		}
	});
});
