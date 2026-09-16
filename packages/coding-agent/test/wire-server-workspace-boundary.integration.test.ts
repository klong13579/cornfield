/**
 * T26 — 文件/工具面的边界 = 会话的 WorkspaceContext roots（真 serve 子进程 + 真 projects.json +
 * 隔离 HOME + 真 WS 客户端）。
 *
 * 四组证据，都是「换个实现就会红」的那种：
 *
 *   A 绑定（agent "hr" 的 agentDir 落在声明的 Project root 里）
 *     - `fs_list` 列的是 **Project root**（`"."` 解析到它，不是 agentDir）
 *     - `fs_read` 读得到 agentDir 之外的 Project root 文件（今天会以 `path escapes agentDir` 被拒）
 *     - `fs_write` 落在 Project root 里、agentDir 里没有它
 *     - `git_status` 读的是 Project root 那个仓库（区别于 agentDir 自己的仓库：两个分支名不同）
 *     - 归属 = 那个 Project（`list_projects.currentProjectId`）
 *     - agentDir 的 `workspace.json` 声明的 attachedRoots 也在边界内
 *   B 越界仍被拒：`..` 逃逸 + **符号链接逃逸**（读穿已存在的链接、往链接里新建）都拒绝，
 *     且一个字节都不落盘
 *   C 未绑定（agent "ops" / default）边界 = agentDir，行为与今天逐字节一致
 *   D session-index 持久回归：`list_sessions` 的 projectId 只从会话头读 ——
 *     头里没有就是 undefined，**不**拿 cwd 反推一个（cwd 明明在 Project 里也不推）
 *
 * 布局（全是真实目录，不 mock；每个根各有自己的 git 仓库以便区分）：
 *   <home>/work/project/           ← 声明的 Project root（git 仓库，分支 project-main）
 *   <home>/work/project/.agent/    ← agent "hr" 的 agentDir（自己又是 git 仓库，分支 agent-main）
 *   <home>/work/extra/             ← workspace.json 的 attachedRoots（不属于任何 Project）
 *   <home>/outside/                ← 边界外（secret.txt + 越界写入的落点）
 *   <home>/agents/ops/             ← agent "ops" 的 agentDir（不在任何 Project root 下）
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@cornfield/client";
import { waitForServe } from "./wait-for-serve";

let home: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let serveInfo: { url: string; token: string } = { url: "", token: "" };

let projectRoot: string;
let agentDir: string;
let extraRoot: string;
let outsideDir: string;
let opsDir: string;
/** agentDir 的 workspace.json 坏掉的 agent（声明读不出 ≠ 没声明过）。 */
let badDir: string;

/** agentDir 的 workspace.json 声明的额外根（相对 agentDir 或绝对，这里给绝对路径）。 */
const EXTRA_FILE = "extra-only.txt";
const SHARED_FILE = "shared.txt";

async function runGit(cwd: string, args: string[]): Promise<void> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
	const code = await child.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`);
}

async function pickFreePort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

async function writeRegistry(): Promise<void> {
	const registryDir = path.join(home, ".cornfield", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: {
				hr: { path: agentDir, registeredAt: new Date().toISOString(), template: "default" },
				ops: { path: opsDir, registeredAt: new Date().toISOString(), template: "default" },
				bad: { path: badDir, registeredAt: new Date().toISOString(), template: "default" },
			},
		}),
	);
	// Project 注册表：唯一权威（根不是目录名，是这条声明）。
	await Bun.write(
		path.join(registryDir, "projects.json"),
		JSON.stringify({
			version: 1,
			projects: { "proj-work": { projectId: "proj-work", root: projectRoot, name: "work" } },
		}),
	);
}

async function writeAgentWorkspace(dir: string, name: string, attachedRoots?: string[]): Promise<void> {
	await fs.mkdir(path.join(dir, ".cornfield"), { recursive: true });
	await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
	await Bun.write(
		path.join(dir, ".cornfield", "workspace.json"),
		JSON.stringify({
			schemaVersion: 2,
			id: name,
			name,
			type: "agent",
			root: ".",
			projectRoot: ".",
			skillsDir: ".cornfield/skills/",
			sessionsDir: "sessions/",
			...(attachedRoots ? { attachedRoots } : {}),
		}),
	);
}

beforeAll(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ws-boundary-"));
	savedHome = process.env.HOME;
	process.env.HOME = home;

	projectRoot = path.join(home, "work", "project");
	agentDir = path.join(projectRoot, ".agent");
	extraRoot = path.join(home, "work", "extra");
	outsideDir = path.join(home, "outside");
	opsDir = path.join(home, "agents", "ops");
	badDir = path.join(home, "agents", "bad");

	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(extraRoot, { recursive: true });
	await fs.mkdir(outsideDir, { recursive: true });
	await fs.mkdir(opsDir, { recursive: true });
	await fs.mkdir(path.join(badDir, "sessions"), { recursive: true });

	// ── Project root：自己的 git 仓库（分支名与 agentDir 那个不同，用来分辨 git 读的是哪个根）──
	await runGit(projectRoot, ["init", "-b", "project-main"]);
	await runGit(projectRoot, ["config", "user.email", "test@example.com"]);
	await runGit(projectRoot, ["config", "user.name", "Test"]);
	await Bun.write(path.join(projectRoot, "tracked.txt"), "tracked\n");
	await runGit(projectRoot, ["add", "tracked.txt"]);
	await runGit(projectRoot, ["commit", "-m", "project root seed"]);
	// 未跟踪：给 git_status 一个「读的是这个根」的第二个证据
	await Bun.write(path.join(projectRoot, SHARED_FILE), "shared\n");

	// ── agentDir：自己的 git 仓库 + 声明（含 attachedRoots）──
	await runGit(agentDir, ["init", "-b", "agent-main"]);
	await runGit(agentDir, ["config", "user.email", "test@example.com"]);
	await runGit(agentDir, ["config", "user.name", "Test"]);
	await Bun.write(path.join(agentDir, "agent-only.txt"), "agent\n");
	await runGit(agentDir, ["add", "agent-only.txt"]);
	await runGit(agentDir, ["commit", "-m", "agent dir seed"]);

	// ── 另一个根的文件 + 边界外的文件 ──
	await Bun.write(path.join(extraRoot, EXTRA_FILE), "extra\n");
	await Bun.write(path.join(outsideDir, "secret.txt"), "outside\n");
	await Bun.write(path.join(opsDir, "local.txt"), "ops\n");

	await writeAgentWorkspace(agentDir, "hr", [extraRoot]);
	await writeAgentWorkspace(opsDir, "ops");
	// 声明文件在、但读不出来的 agent（损坏 JSON）——它不是「没声明过」，是「声明读不出」。
	await fs.mkdir(path.join(badDir, ".cornfield"), { recursive: true });
	await fs.writeFile(path.join(badDir, ".cornfield", "workspace.json"), '{ "schemaVersion": 2, "id":\n');
	await writeRegistry();

	// ── 符号链接逃逸的两条路（读穿已存在的链接 / 往链接里新建）──
	await fs.symlink(outsideDir, path.join(projectRoot, "link-out"), "dir");
	await fs.symlink(outsideDir, path.join(opsDir, "link-out"), "dir");

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = await pickFreePort();
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
			// serve 的 cwd = 隔离 HOME（非 git 目录）→ default agent 的 agentDir = 这个目录，未绑定。
			cwd: home,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: home, PI_NO_TITLE: "1" },
		},
	);
	serveInfo = await waitForServe(proc, port);

	// 两个可用的注册 agent 都 attach（fs_* 的会话面判定需要会话；serve 启动时也会预挂载，幂等）。
	// “bad”（声明读不出的那个）故意不 attach：它连 attach 都过不去，见 F 组。
	await withClient(async client => {
		for (const agentId of ["hr", "ops"]) {
			await client.request({ type: "attach", sessionId: agentId } as never);
		}
	});
}, 120_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	if (home) await fs.rm(home, { recursive: true, force: true });
});

async function withClient<T>(fn: (client: PiClient) => Promise<T>): Promise<T> {
	const client = new PiClient({ url: serveInfo.url, token: serveInfo.token, autoReconnect: false });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		client.close();
	}
}

/** /preview 的 HTTP 根（与 WS 同端口）。 */
function previewUrl(agentId: string, rel: string): string {
	const base = serveInfo.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
	return `${base}/preview/${agentId}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

type FsListResult = { path: string; entries: { name: string; type: string }[] };
type FsReadResult = { path: string; text: string; truncated: boolean; version: string };
type FsWriteResult = { path: string; bytesWritten: number; version: string };
type GitStatusResult = { branch: string | null; staged: string[]; unstaged: string[]; untracked: string[] };
type ProjectListResult = { projects: { projectId: string; root: string }[]; currentProjectId?: string };
type SessionIndexResult = { sessions: { sessionId: string; agentId: string; projectId?: string; cwd?: string }[] };

function fsList(client: PiClient, sessionId: string, rel = ""): Promise<FsListResult> {
	return client.request<FsListResult>({ type: "fs_list", sessionId, path: rel } as never);
}

function fsRead(client: PiClient, sessionId: string, rel: string): Promise<FsReadResult> {
	return client.request<FsReadResult>({ type: "fs_read", sessionId, path: rel } as never);
}

function fsWrite(client: PiClient, sessionId: string, rel: string, content: string): Promise<FsWriteResult> {
	return client.request<FsWriteResult>({ type: "fs_write", sessionId, path: rel, content } as never);
}

/** 断言这次命令被服务端拒绝，返回拒绝理由（`PiServerError.serverError` 是服务端原文）。 */
async function refusalOf(send: () => Promise<unknown>): Promise<string> {
	try {
		await send();
	} catch (err) {
		const raw = (err as { serverError?: unknown }).serverError;
		return typeof raw === "string" ? raw : err instanceof Error ? err.message : String(err);
	}
	throw new Error("expected the command to be refused, but it succeeded");
}

describe("A 绑定 Project 的会话：文件面边界 = Project root", () => {
	test('fs_list("") 列的是 Project root，不是 agentDir', async () => {
		await withClient(async client => {
			const res = await fsList(client, "hr");
			const names = res.entries.map(e => e.name);
			// `.agent` 只可能来自 Project root（agentDir 的父目录）；agentDir 自己的条目一个都不该有。
			expect(names).toContain(".agent");
			expect(names).toContain(SHARED_FILE);
			expect(names).not.toContain("agent-only.txt");
		});
	}, 30_000);

	test("fs_read 读得到 agentDir 之外、Project root 之内的文件", async () => {
		await withClient(async client => {
			const res = await fsRead(client, "hr", SHARED_FILE);
			expect(res.text).toBe("shared\n");
		});
	}, 30_000);

	test("fs_write 落在 Project root 里，agentDir 里没有它", async () => {
		await withClient(async client => {
			const res = await fsWrite(client, "hr", "written-by-hr.txt", "hr\n");
			expect(res.path).toBe("written-by-hr.txt");
			expect(res.bytesWritten).toBe(3);
			expect(await Bun.file(path.join(projectRoot, "written-by-hr.txt")).text()).toBe("hr\n");
			expect(await Bun.file(path.join(agentDir, "written-by-hr.txt")).exists()).toBe(false);
		});
	}, 30_000);

	test("attachedRoots 声明的根也在边界内", async () => {
		await withClient(async client => {
			const res = await fsRead(client, "hr", EXTRA_FILE);
			expect(res.text).toBe("extra\n");
		});
	}, 30_000);

	test("git_status 读的是 Project root 那个仓库（不是 agentDir 自己的仓库）", async () => {
		await withClient(async client => {
			const res = await client.request<GitStatusResult>({ type: "git_status", sessionId: "hr" } as never);
			expect(res.branch).toBe("project-main");
			expect(res.untracked).toContain(SHARED_FILE);
		});
	}, 30_000);

	test("归属 = 该 Project（list_projects.currentProjectId）", async () => {
		await withClient(async client => {
			const res = await client.request<ProjectListResult>({ type: "list_projects", sessionId: "hr" } as never);
			expect(res.currentProjectId).toBe("proj-work");
		});
	}, 30_000);

	test("只读站点 /preview 与 fs_read 同一条边界：Project root 内的产物点得开", async () => {
		// 先经由 fs_write 在这个会话的工作面里落一份产物（落在 **agentDir 之外**）
		// —— /preview 若还锚 agentDir，下面这条就是 400。
		await withClient(async client => {
			await fsWrite(client, "hr", "preview-target.txt", "preview\n");
		});
		const res = await fetch(previewUrl("hr", "preview-target.txt"));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("preview\n");
	}, 30_000);
});

describe("B 越界仍被拒（`..` 与符号链接）", () => {
	test("`..` 逃逸：绑定会话也读不到边界外", async () => {
		await withClient(async client => {
			const refusal = await refusalOf(() => fsRead(client, "hr", "../../outside/secret.txt"));
			expect(refusal).toContain("escapes");
		});
	}, 30_000);

	test("符号链接逃逸（读穿已存在的链接）：Project root 里的 link-out 不算边界内", async () => {
		await withClient(async client => {
			// link-out 在 Project root 里，词法上是边界内的；只有 realpath 归一才看得出它指向外面。
			const refusal = await refusalOf(() => fsRead(client, "hr", "link-out/secret.txt"));
			expect(refusal).toContain("escapes");
		});
	}, 30_000);

	test("符号链接逃逸（往链接里新建）：拒写且边界外一个字节都没落", async () => {
		await withClient(async client => {
			const refusal = await refusalOf(() => fsWrite(client, "hr", "link-out/created.txt", "nope\n"));
			expect(refusal).toContain("escapes");
			expect(await Bun.file(path.join(outsideDir, "created.txt")).exists()).toBe(false);
		});
	}, 30_000);

	test("只读站点 /preview 也拦符号链接：链接里的文件 400", async () => {
		// link-out 在 Project root 里（词法上是边界内），只有 realpath 归一才看得出它指向外面。
		const res = await fetch(previewUrl("hr", "link-out/secret.txt"));
		expect(res.status).toBe(400);
	}, 30_000);
});

describe("C 未绑定 Project 的会话：边界 = agentDir，行为与今天一致", () => {
	test('fs_list("") 列的是 agentDir 自己的条目', async () => {
		await withClient(async client => {
			const res = await fsList(client, "ops");
			const names = res.entries.map(e => e.name);
			expect(names).toContain("local.txt");
			expect(names).not.toContain(SHARED_FILE);
		});
	}, 30_000);

	test("读写都在 agentDir 内完成", async () => {
		await withClient(async client => {
			expect((await fsRead(client, "ops", "local.txt")).text).toBe("ops\n");
			await fsWrite(client, "ops", "written-by-ops.txt", "ops\n");
			expect(await Bun.file(path.join(opsDir, "written-by-ops.txt")).text()).toBe("ops\n");
		});
	}, 30_000);

	test("`..` 与符号链接逃逸照旧被拒（未绑定会话同样不放松）", async () => {
		await withClient(async client => {
			expect(await refusalOf(() => fsRead(client, "ops", "../../outside/secret.txt"))).toContain("escapes");
			expect(await refusalOf(() => fsRead(client, "ops", "link-out/secret.txt"))).toContain("escapes");
		});
	}, 30_000);

	test("default agent（未绑定）边界 = 启动目录", async () => {
		await withClient(async client => {
			const res = await client.request<FsListResult>({ type: "fs_list", sessionId: "default" } as never);
			const names = res.entries.map(e => e.name);
			expect(names).toContain("work");
			expect(names).toContain("outside");
		});
	}, 30_000);
});

describe("D session-index：projectId 只从会话头读，不拿 cwd 反推", () => {
	const DECLARED_ID = "seeded-declared";
	const UNDECLARED_ID = "seeded-undeclared";

	beforeAll(async () => {
		const now = new Date().toISOString();
		const header = (id: string, extra: Record<string, unknown>) =>
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: agentDir, ...extra })}\n`;
		// 头里**有**归属：原样报出来。
		await Bun.write(
			path.join(agentDir, "sessions", `${DECLARED_ID}.jsonl`),
			header(DECLARED_ID, { projectId: "proj-work", projectSource: "session" }),
		);
		// 头里**没有**归属，而 cwd 明明落在 proj-work 的 root 里 —— 仍然必须是 undefined。
		await Bun.write(path.join(agentDir, "sessions", `${UNDECLARED_ID}.jsonl`), header(UNDECLARED_ID, {}));
	});

	test("头里有 projectId 就报它；头里没有就是 undefined（哪怕 cwd 命中一个 Project）", async () => {
		await withClient(async client => {
			const res = await client.request<SessionIndexResult>({ type: "list_sessions", sessionId: "hr" } as never);
			const declared = res.sessions.find(s => s.sessionId === DECLARED_ID);
			const undeclared = res.sessions.find(s => s.sessionId === UNDECLARED_ID);
			expect(declared?.projectId).toBe("proj-work");
			expect(undeclared).toBeDefined();
			expect(undeclared?.projectId).toBeUndefined();
			// cwd 还在（证明这条会话确实被索引到了、而且它的 cwd 就在 Project root 里）
			expect(undeclared?.cwd).toBe(agentDir);
		});
	}, 30_000);
});

/** 一个目录下现有的 jsonl 名单 —— 「一个会话都不建」的落盘证据（新建会话会立即落一个文件）。 */
async function jsonlUnder(root: string): Promise<string[]> {
	const out: string[] = [];
	for await (const rel of new Bun.Glob("**/*.jsonl").scan({ cwd: root, onlyFiles: true })) out.push(rel);
	return out.sort();
}

describe("E new_session.projectId：解析与失败语义（工厂接线尚未落地）", () => {
	/** 会话目录里现有的 jsonl 名单 —— 「一个会话都不建」的落盘证据（新建会话会立刻落一个文件）。 */
	const hrSessionFiles = (): Promise<string[]> => jsonlUnder(path.join(agentDir, "sessions"));
	test("未声明的 projectId → ok:false，且一个会话都不建", async () => {
		await withClient(async client => {
			const before = await hrSessionFiles();
			const refusal = await refusalOf(() =>
				client.request({ type: "new_session", sessionId: "hr", projectId: "proj-nope" } as never),
			);
			expect(refusal).toContain("proj-nope");
			expect(await hrSessionFiles()).toEqual(before);
		});
	}, 30_000);

	test("已声明的 projectId → 解析通过后被「尚未接通」拦下（不退回旧根建会话）", async () => {
		await withClient(async client => {
			const before = await hrSessionFiles();
			const refusal = await refusalOf(() =>
				client.request({ type: "new_session", sessionId: "hr", projectId: "proj-work" } as never),
			);
			expect(refusal).toContain("Project 绑定尚未接通");
			// 报的是**解出来的那个根**：声明的 Project root，不是 agentDir
			expect(refusal).toContain(projectRoot);
			expect(await hrSessionFiles()).toEqual(before);
		});
	}, 30_000);

	test("不带 projectId → 走今天的路（ok:true，不落进归属分支）", async () => {
		await withClient(async client => {
			// 归属分支恒为 ok:false，所以「ok:true」本身就是「没走那条」的证据。
			const res = await client.request<{ cancelled: boolean }>({ type: "new_session", sessionId: "hr" } as never);
			expect(typeof res.cancelled).toBe("boolean");
		});
	}, 30_000);
});

/**
 * 读不出来 ≠ 没声明过。
 *
 * agentDir 的 `workspace.json` 在、但读不出（损坏 JSON / 不是 schema-v2）—— 这是「归属未知」，
 * 不是「没声明过」：降级成后者会把边界悄悄换成 agentDir，把一次真故障渲染成一次正常的「没绑项目」。
 *
 * （Project 注册表本身读坏的情况在 serve 层观祭不到：进程启动就死在 `agent-directory` 的
 * `loadProjects` 上（不是本模块的判定），所以这里钉的是能观察到的那个入口 —— 声明读不出。
 * 注册表读坏的 resolver 级语义由 T24 的 `session-workspace.test.ts` 负责。）
 */
describe("F 声明读不出：答不出来就说读不出（不降级成「没声明过」）", () => {
	test("损坏的 workspace.json：文件面拒，而不是拿 agentDir 冒充边界", async () => {
		await withClient(async client => {
			const refusal = await refusalOf(() =>
				client.request({ type: "fs_read", sessionId: "bad", path: "whatever.txt" } as never),
			);
			expect(refusal).toContain("workspace.json");

			// 隔离：坏声明只影响它自己那个 agent
			expect((await fsRead(client, "hr", SHARED_FILE)).text).toBe("shared\n");
		});
	}, 30_000);

	test("同一个 agent 连 attach 都过不去（会话不得以一个它没声明过的 Agent 起）", async () => {
		// 这是 `./agent-scope` 之外的另一道门（session-agent 的默认 Agent 解析）在拒：
		// 它把「new_session + 声明读不出」这条路彻底堵在前面，所以本模块的 ok:false 看不到实跑。
		// 断言它是为了“没人静默降级”这条事实，不是为了本模块的判定。
		await withClient(async client => {
			const refusal = await refusalOf(() => client.request({ type: "attach", sessionId: "bad" } as never));
			expect(refusal).toContain("workspace.json");
		});
	}, 30_000);
});
