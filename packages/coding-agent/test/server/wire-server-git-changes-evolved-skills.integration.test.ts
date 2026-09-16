/**
 * T13 集成：**真 serve 子进程 + 真 WS** —— `git_changes` 与 `get_evolved_skills` 的命令面。
 *
 * 断言三件事，每件都不能只在单元层成立：
 *   1. 真磁盘：命令面读出来的是 serve 目标 agent 那个仓库的**真**工作区（路径、两轴状态、来源路径都真）；
 *   2. 真 DB：命令面读出来的是真的是 `evolution.db` 的 `skills` 表（字段逐个对，不是空壳）；
 *   3. 读不到（不是 git 仓库 / 未注册 agent / 库打不开）一律 `ok:false`，并且**响应 id 就是请求 id**
 *      —— 客户端按 id 关联请求，错误响应丢了 id 就变成一个没人认领的帧（前端只能超时）。
 *
 * 隔离 HOME：registry.json / evolution.db 全在临时目录里，不碰真机的 `~/.cornfield`。
 *
 * 注意执行顺序：最后一组用例会**删掉/占掉**演化库（库不存在、库打不开这两种事实要真造出来），
 * 所以它们必须排在使用演化库的用例之后 —— bun test 按声明顺序跑，不要把它们提前。
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMemoryDbPath } from "@cornfield/self-evolution/memory/storage";
import { initSchema } from "@cornfield/self-evolution/storage/db";
import { SqliteSkillStore } from "@cornfield/self-evolution/storage/skills";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { registerAgent } from "../../src/skeleton/registry";
import { waitForServe } from "../wait-for-serve";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

interface Frame {
	type: string;
	id?: string;
	ok?: boolean;
	result?: unknown;
	error?: unknown;
	[k: string]: unknown;
}

let isolatedHome = "";
let savedHome: string | undefined;
let repo = "";
let nogitDir = "";
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";
let dbPath = "";

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
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

function nextFrame(ws: WebSocket, predicate: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			ws.removeEventListener("message", onMessage as EventListener);
			resolve(undefined);
		}, timeoutMs);
		const onMessage = (event: MessageEvent) => {
			const frame = JSON.parse(String(event.data)) as Frame;
			if (!predicate(frame)) return;
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage as EventListener);
			resolve(frame);
		};
		ws.addEventListener("message", onMessage as EventListener);
	});
}

async function connect(): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = event => reject(new Error(`ws error: ${String(event)}`));
	});
	const token = url.match(/token=([a-zA-Z0-9]+)/)?.[1] ?? "";
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token }));
	const ack = await nextFrame(ws, frame => frame.type === "hello_ack", 10_000);
	if (!ack) throw new Error("no hello_ack");
	return ws;
}

let seq = 0;

/**
 * 发一条命令，返回**原样的响应帧**（连 id 一起）。
 * 故意不按 id 过滤等待：按 id 等的话，「响应丢了 id」会变成超时，看不出是丢了 id ——
 * 这里要断言的正是那个 id。
 */
async function request(command: Record<string, unknown>): Promise<{ frame: Frame; id: string }> {
	const ws = await connect();
	try {
		const id = `t13-${++seq}`;
		ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
		const frame = await nextFrame(ws, candidate => candidate.type === "response", 30_000);
		if (!frame) throw new Error(`timeout: ${String(command.type)}`);
		return { frame, id };
	} finally {
		ws.close();
	}
}

async function requestOk<T>(command: Record<string, unknown>): Promise<T> {
	const { frame, id } = await request(command);
	if (frame.ok !== true) throw new Error(`expected ok, got: ${JSON.stringify(frame)}`);
	expect(frame.id).toBe(id);
	return frame.result as T;
}

async function requestFail(command: Record<string, unknown>): Promise<{ id: string; error: string }> {
	const { frame, id } = await request(command);
	expect(frame.ok).toBe(false);
	// 错误响应必须挂着请求 id：丢 id 的响应客户端认不出来（只能等超时）。
	expect(frame.id).toBe(id);
	return { id, error: typeof frame.error === "string" ? frame.error : JSON.stringify(frame.error) };
}

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-new-wire-commands-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	// ── 真仓库：一条未暂存修改 + 一条纯 rename + 一个未跟踪文件 ──
	repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-new-wire-repo-"));
	await runGit(repo, ["init", "-q", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test"]);
	await Bun.write(path.join(repo, "modified.txt"), "one\n");
	await Bun.write(path.join(repo, "seed.txt"), "seed\n");
	await runGit(repo, ["add", "-A"]);
	await runGit(repo, ["commit", "-qm", "seed"]);
	await Bun.write(path.join(repo, "modified.txt"), "one changed\n");
	await runGit(repo, ["mv", "seed.txt", "renamed.txt"]);
	await Bun.write(path.join(repo, "untracked.txt"), "new\n");

	// ── 不是 git 仓库的 agentDir（注册进 registry，"unknown agent" 之外的第二种读不到）──
	nogitDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-new-wire-nogit-"));
	await registerAgent("nogit", nogitDir);

	// ── 真演化库：用真 schema + 真写入器 ──
	dbPath = resolveMemoryDbPath(repo);
	expect(dbPath.startsWith(isolatedHome)).toBe(true);
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	initSchema(db);
	const store = new SqliteSkillStore(db);
	await store.upsert({
		name: "wire-seeded-skill",
		description: "集成测试种下的技能",
		taskPattern: "命令面读演化技能",
		approach: "真库真读",
		tools: ["read", "grep"],
		pitfalls: ["别把读不到当空集"],
		createdAt: 1_700_000_000_000,
		usageCount: 3,
		lastUsedAt: 1_700_000_100_000,
		successCount: 2,
		failureCount: 1,
		version: 2,
		qualityScore: 80,
	});
	db.close();

	const port = await pickPort();
	proc = Bun.spawn(
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
		{
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
		},
	);
	url = (await waitForServe(proc, port, 60_000)).url;
}, 90_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
	await fs.rm(repo, { recursive: true, force: true });
	await fs.rm(nogitDir, { recursive: true, force: true });
});

describe("命令面 → 真磁盘 / 真 DB", () => {
	test("git_changes：读的是目标 agent 那个仓库的真工作区", async () => {
		const result = await requestOk<{
			repoRoot: string;
			changes: unknown[];
			error?: string;
		}>({ type: "git_changes" });

		expect(await fs.realpath(result.repoRoot)).toBe(await fs.realpath(repo));
		expect(result.changes).toEqual([
			{ path: "modified.txt", index: null, worktree: "modified" },
			{ path: "renamed.txt", oldPath: "seed.txt", index: "renamed", worktree: null },
			{ path: "untracked.txt", index: null, worktree: "untracked" },
		]);
		expect(result.error).toBeUndefined();
	});

	test("git_changes：新增改动当场可见（不是缓存快照）", async () => {
		await Bun.write(path.join(repo, "later.txt"), "later\n");

		const result = await requestOk<{ changes: { path: string }[] }>({ type: "git_changes" });
		expect(result.changes.map(change => change.path)).toContain("later.txt");

		await fs.rm(path.join(repo, "later.txt"));
	});

	test("get_evolved_skills：读的是真 evolution.db 的 skills 表", async () => {
		const result = await requestOk<{
			skills: Record<string, unknown>[];
			error?: string;
		}>({ type: "get_evolved_skills" });

		expect(result.skills.length).toBe(1);
		const skill = result.skills[0] ?? {};
		expect(skill.name).toBe("wire-seeded-skill");
		expect(skill.tools).toEqual(["read", "grep"]);
		expect(skill.pitfalls).toEqual(["别把读不到当空集"]);
		expect(skill.qualityScore).toBe(80);
		expect(skill.usageCount).toBe(3);
		// skills 表里没有的字段不许出现在答复里
		expect(Object.hasOwn(skill, "optimizationCount")).toBe(false);
		expect(result.error).toBeUndefined();
	});
});

describe("命令面 → 读不到：ok:false 且 id 不丢", () => {
	test("git_changes：未注册的 agent", async () => {
		const failure = await requestFail({ type: "git_changes", sessionId: "no-such-agent" });

		expect(failure.error).toContain("unknown agent: no-such-agent");
	});

	test("git_changes：仓库不存在（agentDir 不是 git 仓库）", async () => {
		const failure = await requestFail({ type: "git_changes", sessionId: "nogit" });

		expect(failure.error).toContain("not a git repository");
		expect(failure.error).toContain(nogitDir);
	});

	test("get_evolved_skills：未注册的 agent", async () => {
		const failure = await requestFail({ type: "get_evolved_skills", sessionId: "no-such-agent" });

		expect(failure.error).toContain("unknown agent: no-such-agent");
	});

	test("get_evolved_skills：库不存在 = 明确空集（ok:true，不是 read 失败）", async () => {
		await fs.rm(dbPath, { force: true });

		const result = await requestOk<{ skills: unknown[]; error?: string }>({ type: "get_evolved_skills" });

		expect(result.skills).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	test("get_evolved_skills：库打不开 = ok:false（不退化成空清单）", async () => {
		await fs.mkdir(dbPath, { recursive: true });

		const failure = await requestFail({ type: "get_evolved_skills" });

		expect(failure.error).toContain("evolved skills unavailable");
	});
});
