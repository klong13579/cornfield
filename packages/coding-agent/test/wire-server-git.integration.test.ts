import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@cornfield/client";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

/**
 * 票 02 e2e — serve git 最小集（git_status/git_diff/git_log/git_show/git_branches）。
 * 三个场景：有改动 + 多分支仓库、空仓库。真实 serve 子进程 + pi-client。
 *
 * 隔离 HOME / 端口 / 预算 / 停摆重试都在 `spawnServeFixture` 里（见该文件的说明）；
 * 临时 git 仓库是本文件自己的用例数据，仍用 `runGit` 原地搭，并以 `cwd` 交给夹具。
 */

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

describe("git 最小集 — 有改动 + 多分支仓库", () => {
	let fixture: ServeFixture | undefined;
	let repo: string;

	beforeAll(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-rich-"));
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

		// 项目注册在隔离 HOME 里：为 `repo` 声明一条 Project，让 `resolveSessionWorkspace`
		// 从 session cwd 命中 Project 并解析出 `projectRoot = repo`。wire-server 内建
		// default meta 的 agentDir = `<HOME>/.cornfield/agents/default`（票 28 新兜底），
		// 不是 git 仓库；git 命令需要走 `projectRoot ?? agentDir` —— 必须把 projectRoot
		// 解析成 repo 才能保留旧 fixture 的语义（git 命令 cwd = repo）。
		async function seedProject(home: string): Promise<void> {
			const storeDir = path.join(home, ".cornfield", "agent");
			await fs.mkdir(storeDir, { recursive: true });
			await Bun.write(
				path.join(storeDir, "projects.json"),
				JSON.stringify({
					version: 1,
					projects: {
						"test-git-rich": {
							projectId: "test-git-rich",
							root: repo,
							name: "test-git-rich",
						},
					},
				}),
			);
		}

		fixture = await spawnServeFixture({
			homePrefix: "omp-git-rich-home-",
			cwd: repo,
			seed: seedProject,
		});
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
		await fs.rm(repo, { recursive: true, force: true });
	});

	test("git_status：当前分支 + staged/unstaged/untracked 列表", async () => {
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
	let fixture: ServeFixture | undefined;
	let repo: string;

	beforeAll(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-empty-"));
		await runGit(repo, ["init", "-b", "main"]);
		await Bun.write(path.join(repo, "seed.txt"), "seed\n");

		async function seedProject(home: string): Promise<void> {
			const storeDir = path.join(home, ".cornfield", "agent");
			await fs.mkdir(storeDir, { recursive: true });
			await Bun.write(
				path.join(storeDir, "projects.json"),
				JSON.stringify({
					version: 1,
					projects: {
						"test-git-empty": {
							projectId: "test-git-empty",
							root: repo,
							name: "test-git-empty",
						},
					},
				}),
			);
		}

		fixture = await spawnServeFixture({
			homePrefix: "omp-git-empty-home-",
			cwd: repo,
			seed: seedProject,
		});
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
		await fs.rm(repo, { recursive: true, force: true });
	});

	test("git_log：空仓库返回空 commits（不报错）", async () => {
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
		await client.connect();
		try {
			const res = await client.request<{ commits: unknown[] }>({ type: "git_log" });
			expect(res.commits).toEqual([]);
		} finally {
			client.close();
		}
	});

	test("git_branches：空仓库 local 为空、current 为非 null", async () => {
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
