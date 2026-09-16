/**
 * 工作台右栏「产物 / 改动」两个 tab 的浏览器 e2e —— 真实 serve（源码）+ 真实 web-app（dist）+ 真实 Chrome。
 *
 * 编排（与 file-edit.spec.ts / project-binding.spec.ts 同构）：
 *   1. dist 由 `bun run --cwd=packages/web-app build` 产出；vite preview 起 dist（随机端口）
 *   2. serve 以源码启动（bun packages/coding-agent/src/cli.ts），cwd = 临时 git 仓库
 *   3. 浏览器注入 localStorage 连接配置指向该 serve 端口
 *
 * ## 产物 tab 的数据从哪来（本 spec 的种法）
 *
 * `list_artifacts` 的权威实现是 `packages/coding-agent/src/server/artifacts.ts`：它**不扫目录**，
 * 而是读会话 JSONL 里 assistant 消息的 toolCall（write / edit / puppeteer screenshot），拿
 * `arguments.path` 去会话的 workspace roots 里落根，**只收已经存在的文件**，相对路径相对它所属的那个
 * 根（`fileWithinRoots`）。所以「种一个产物」= 两件事：在根里放一个真文件 + 在**那个会话的 JSONL**
 * 里放一条指向它的 toolCall。
 *
 * 会话 JSONL 的路径由服务端在启动时定下（`serve:session` 日志里的 `sessionFile`；文件本身是
 * **惰性落盘**的 —— fresh serve 启动后 `<sessions>/<encoded-cwd>/by-date/<date>/` 目录都还不存在），
 * 客户端快照 `session_snapshot.sessionFile` 带的就是它，产物面板把它原样回传给 `list_artifacts`。
 * 本 spec 因此先起 serve、从它的日志里拿到这个路径再种文件 —— 种的是**这个会话自己的账本**，
 * 不是随手造一个 JSONL 塞进 sessions 目录（那只能命中 agent 维度的扫描路径，命不中会话隔离视图）。
 *
 * 隔离：HOME = 临时目录（registry / 会话 / 技能一个都不碰真人的）；根目录全在临时目录里。
 *
 * 断言链：
 *   1. 产物 tab：种进去的产物真的被列出来（html/markdown/text 分类与来源会话一致）→ 点开看得到内容
 *      → 磁盘上删掉之后点开**报错**（不是渲染成空文件）→ 与文件 tab 来回切不串
 *   2. 绑了 Project 的会话：产物按**会话身份**（附件地址）读与开 —— 同名文件在两个根里内容不同，
 *      preview 给出的必须是 Project 根那一份；同一会话的「改动」组也读 Project 根（不是 git 仓库 → 报错，
 *      不是「没有改动」）
 *   3. 改动 tab：清单与 `git status --porcelain` 一致、按来源分组、点条目能在文件面打开；磁盘上已删的条目
 *      点开是**明说读不到**；「工作区干净」「读不到」「未连接」是三句不同的话
 *
 * 前置：`bun run --cwd=packages/web-app build`。
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SHOTS = "test-results/panel";

/** 三个 tab 的标签（RightPanel 的三 tab 定义）。 */
const TAB_FILES = "文件";
const TAB_ARTIFACTS = "产物";
const TAB_CHANGES = "改动";

function freePort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {
			// 未就绪，重试
		}
		await new Promise(r => setTimeout(r, 300));
	}
	throw new Error(`HTTP 未就绪：${url}`);
}

function kill(proc: ChildProcess): void {
	try {
		proc.kill("SIGTERM");
	} catch {
		// 已退出
	}
}

/** 一次 serve 运行的编排句柄：进程 + 它到目前为止的合并输出（stdout + stderr 按到达顺序）。 */
interface Serve {
	proc: ChildProcess;
	output: () => string;
}

/**
 * 起一个真 serve，并把它的输出**全部留住**（不是「等某一行」——日志行是后续断言的锚点：
 * `serve:session` 带 sessionFile，`serve:listening` 带 ws 地址）。
 */
function spawnServe(input: { homeDir: string; cwd: string; port: number }): Serve {
	const chunks: string[] = [];
	const proc = spawn(
		"bun",
		[
			`${repoRoot}/packages/coding-agent/src/cli.ts`,
			"serve",
			"--port",
			String(input.port),
			"--host",
			"127.0.0.1",
			"--no-extensions",
		],
		{ cwd: input.cwd, env: { ...process.env, HOME: input.homeDir, PI_NO_TITLE: "1" } },
	);
	proc.stdout?.on("data", (buf: Buffer) => chunks.push(buf.toString()));
	proc.stderr?.on("data", (buf: Buffer) => chunks.push(buf.toString()));
	return { proc, output: () => chunks.join("") };
}

/** 等到 serve 的输出里出现 matcher（每次重读累积输出，不存在「监听器装晚了丢行」的窗口）。 */
async function waitForOutput(serve: Serve, matcher: RegExp, timeoutMs: number, label: string): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hit = serve.output().match(matcher);
		if (hit) return hit[0];
		if (Date.now() > deadline) throw new Error(`${label} 超时（${timeoutMs}ms）未匹配 ${matcher}`);
		await new Promise(r => setTimeout(r, 200));
	}
}

/** `serve:session` 日志里的 sessionFile（快照会把这个值交给客户端，产物面板再原样回传）。 */
function sessionFileOf(output: string): string {
	const hit = output.match(/"sessionFile":"([^"]+)"/);
	if (!hit?.[1]) throw new Error(`serve 输出里没有 sessionFile：${output}`);
	return hit[1];
}

/** 客户端发出的 wire 命令里，本 spec 关心的那几个字段。 */
interface WireCommand {
	type: string;
	sessionId?: string;
	sessionFile?: string;
}

/** 解析一帧客户端 → 服务端文本帧；不是 request 帧/读不出来就返回 undefined（不做猜测）。 */
function commandOf(payload: string): WireCommand | undefined {
	if (!payload.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const frame = parsed as { type?: unknown; command?: unknown };
	if (frame.type !== "request") return undefined;
	const raw = frame.command;
	if (typeof raw !== "object" || raw === null) return undefined;
	const cmd = raw as { type?: unknown; sessionId?: unknown; sessionFile?: unknown };
	if (typeof cmd.type !== "string") return undefined;
	return {
		type: cmd.type,
		...(typeof cmd.sessionId === "string" ? { sessionId: cmd.sessionId } : {}),
		...(typeof cmd.sessionFile === "string" ? { sessionFile: cmd.sessionFile } : {}),
	};
}

/** 种进会话账本的一条工具调用（结构与 session-manager 落盘的同构，见 artifacts.ts 的提取规则）。 */
interface SeedCall {
	/** 工具名：write / edit。 */
	name: string;
	/** 工具参数里的路径（相对会话工作根，或绝对路径）。 */
	path: string;
}

/** 造一份会话 JSONL：header + 若干 assistant toolCall。 */
function sessionJsonl(calls: readonly SeedCall[], cwd: string): string {
	const now = new Date().toISOString();
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "e2e-panel-session", timestamp: now, cwd, title: "panel" }),
		...calls.map((call, index) =>
			JSON.stringify({
				type: "message",
				id: `e2e-panel-${index}`,
				parentId: null,
				timestamp: now,
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: `call_${index}`,
							name: call.name,
							arguments: { path: call.path, content: "" },
						},
					],
					stopReason: "stop",
					timestamp: Date.now(),
				},
			}),
		),
	];
	return `${lines.join("\n")}\n`;
}

/** 把产物种进**某个会话自己的账本**（路径必须是真的落盘目录，可能还没被创建）。 */
async function seedSessionArtifacts(sessionFile: string, calls: readonly SeedCall[], cwd: string): Promise<void> {
	await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
	await fsp.writeFile(sessionFile, sessionJsonl(calls, cwd), "utf8");
}

/** 右栏里某个 tab 的按钮（role=tab）。 */
function tab(page: import("@playwright/test").Page, label: string) {
	return page.getByRole("tab", { name: label });
}

test.use({ viewport: { width: 1920, height: 1000 } });

test.describe("工作台右栏 产物 / 改动 两个 tab（真实 serve + 真实前端）", () => {
	test("产物 tab：真产物被列出并可预览；磁盘上删掉之后点开报错而不是空白文件", async ({ page }) => {
		const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "panel-art-home-"));
		const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "panel-art-root-"));

		// 三个真文件：markdown / text / 一个稍后从磁盘删掉的（用来验「读不到 ≠ 空文件」）
		const notesPath = path.join(rootDir, "panel_notes.md");
		const rawPath = path.join(rootDir, "panel_raw.txt");
		const gonePath = path.join(rootDir, "panel_gone.txt");
		await fsp.writeFile(notesPath, "# Panel Notes\nmarkdown-body-line\n");
		await fsp.writeFile(rawPath, "plain-body-line\n");
		await fsp.writeFile(gonePath, "will-be-deleted\n");
		execFileSync("git", ["init", "-q"], { cwd: rootDir });

		const servePort = await freePort();
		const appPort = await freePort();
		const serve = spawnServe({ homeDir, cwd: rootDir, port: servePort });
		const preview = spawn(
			"bun",
			["x", "vite", "preview", "--port", String(appPort), "--strictPort", "--host", "127.0.0.1"],
			{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
		);

		try {
			await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 60_000, "serve 启动");
			// 会话账本的路径由服务端定：拿到它才能把产物种进**这个会话**（会话隔离视图按它读）
			const sessionFile = sessionFileOf(serve.output());
			await seedSessionArtifacts(
				sessionFile,
				[
					{ name: "write", path: "panel_notes.md" },
					{ name: "write", path: "panel_raw.txt" },
					{ name: "write", path: "panel_gone.txt" },
				],
				rootDir,
			);
			await waitForHttp(`http://127.0.0.1:${appPort}/`, 30_000);

			const commands: WireCommand[] = [];
			page.on("websocket", socket => {
				socket.on("framesent", frame => {
					const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
					const command = commandOf(payload);
					if (command) commands.push(command);
				});
			});

			await page.addInitScript(
				(cfg: { wsUrl: string }) => {
					localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl: cfg.wsUrl, token: "" }));
					localStorage.setItem("cornfield.workspace.rightPanel", "1");
				},
				{ wsUrl: `ws://127.0.0.1:${servePort}/ws` },
			);
			await page.goto(`http://127.0.0.1:${appPort}/#/workspace`, { waitUntil: "domcontentloaded" });
			await page.locator(".conn-dot:not(.reconnecting)").first().waitFor({ state: "visible", timeout: 60_000 });

			// ── 1. 产物 tab：种进去的三条真的被列出来 ──
			await tab(page, TAB_ARTIFACTS).click();
			await expect
				.poll(() => commands.filter(c => c.type === "list_artifacts").length, { timeout: 30_000 })
				.toBeGreaterThan(0);
			const firstRead = commands.filter(c => c.type === "list_artifacts").at(-1);
			// 未绑 Project 的会话：会话身份就是 Agent 名，账本就是服务端日志里那一个
			expect(firstRead?.sessionId).toBe("default");
			expect(firstRead?.sessionFile).toBe(sessionFile);

			await expect(page.locator("aside").getByText("panel_notes.md")).toBeVisible({ timeout: 30_000 });
			await expect(page.locator("aside").getByText("panel_raw.txt")).toBeVisible();
			await expect(page.locator("aside").getByText("panel_gone.txt")).toBeVisible();
			// 分类跟着扩展名（artifacts.ts 的 classifyArtifact）：md/文本各一条，读不到「暂无产物」
			await expect(page.locator("aside").getByText("markdown", { exact: true })).toBeVisible();
			await expect(page.locator("aside").getByText("暂无产物")).toHaveCount(0);
			await page.screenshot({ path: `${SHOTS}/1-artifacts-listed.png` });

			// ── 2. 点开文本类产物：预览面给出磁盘上的原文 ──
			await page
				.locator("aside")
				.getByRole("button", { name: /panel_raw\.txt/ })
				.click();
			await expect(page.locator("aside pre")).toContainText("plain-body-line", { timeout: 15_000 });
			await page.screenshot({ path: `${SHOTS}/2-artifact-text-preview.png` });

			// 点开 markdown：走 fs_read + Markdown 渲染（与文本预览是同一份真实内容，两种摆法）
			await page
				.locator("aside")
				.getByRole("button", { name: /panel_notes\.md/ })
				.click();
			await expect(page.locator("aside").getByText("markdown-body-line")).toBeVisible({ timeout: 15_000 });
			await page.screenshot({ path: `${SHOTS}/3-artifact-markdown-preview.png` });

			// ── 3. 磁盘上删掉之后点开：必须报「读不到」，不能渲染成空文件 ──
			await fsp.rm(gonePath, { force: true });
			await page
				.locator("aside")
				.getByRole("button", { name: /panel_gone\.txt/ })
				.click();
			// 服务端 fs_read 的原文（wire-server.ts:2893 `no such file: <basename>`）
			await expect(page.locator("aside").getByText("no such file: panel_gone.txt")).toBeVisible({
				timeout: 15_000,
			});
			// 预览区此刻只能是那句错误：没有 <pre>（= 没有被当成「空文件」渲染出来）
			await expect(page.locator("aside pre")).toHaveCount(0);
			await page.screenshot({ path: `${SHOTS}/4-artifact-missing-file-error.png` });

			// ── 4. 与文件 tab 来回切：不串（文件树不留在产物 tab，产物清单回来还在） ──
			await tab(page, TAB_FILES).click();
			await expect(page.locator(`aside [data-path="panel_raw.txt"]`)).toBeVisible({ timeout: 30_000 });
			await tab(page, TAB_ARTIFACTS).click();
			await expect(page.locator("aside").getByText("panel_raw.txt")).toBeVisible({ timeout: 30_000 });
			// 产物 tab 里不应该出现文件树的节点（两个 tab 的 DOM 互斥）
			await expect(page.locator("aside [data-path]")).toHaveCount(0);
			// 上一步的错误态也不跟着切回来（它是那一次点开的答案，不是产物 tab 的状态）
			await expect(page.locator("aside").getByText("no such file: panel_gone.txt")).toHaveCount(0);
			await page.screenshot({ path: `${SHOTS}/5-tab-switch-no-bleed.png` });
		} finally {
			kill(serve.proc);
			kill(preview);
			await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test("产物 tab 身份：绑 Project 的会话按会话身份读/开产物（同名文件两个根，给出的是 Project 那一份）", async ({
		page,
	}) => {
		const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "panel-id-home-"));
		const defaultRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "panel-id-default-"));
		const projRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "panel-id-proj-"));
		const PROJECT_ID = "e2e-panel-proj";
		const PROJECT_NAME = "E2E 产物项目";
		/** 同名、两条不同的内容：产物预览给出的是哪一份，就是哪一个根。 */
		const SAME_NAME = "panel_same.md";
		const ONLY_IN_PROJ = "panel_only_proj.txt";

		await fsp.writeFile(path.join(defaultRoot, SAME_NAME), "# 默认根产物\ndefault-root-content\n");
		await fsp.writeFile(path.join(projRoot, SAME_NAME), "# 项目产物\nproj-root-content\n");
		await fsp.writeFile(path.join(projRoot, ONLY_IN_PROJ), "proj-only-line\n");
		execFileSync("git", ["init", "-q"], { cwd: defaultRoot });
		// Project 根**不是** git 仓库（下面顺手验「改动」读不到 ≠ 没有改动，且读的是这个根）

		const registryPath = path.join(homeDir, ".cornfield", "agent", "projects.json");
		await fsp.mkdir(path.dirname(registryPath), { recursive: true });
		await fsp.writeFile(
			registryPath,
			`${JSON.stringify(
				{ version: 1, projects: { [PROJECT_ID]: { projectId: PROJECT_ID, name: PROJECT_NAME, root: projRoot } } },
				null,
				2,
			)}\n`,
		);

		const servePort = await freePort();
		const appPort = await freePort();
		const serve = spawnServe({ homeDir, cwd: defaultRoot, port: servePort });
		const preview = spawn(
			"bun",
			["x", "vite", "preview", "--port", String(appPort), "--strictPort", "--host", "127.0.0.1"],
			{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
		);

		try {
			await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 60_000, "serve 启动");
			const rootSessionFile = sessionFileOf(serve.output());
			await waitForHttp(`http://127.0.0.1:${appPort}/`, 30_000);

			const commands: WireCommand[] = [];
			page.on("websocket", socket => {
				socket.on("framesent", frame => {
					const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
					const command = commandOf(payload);
					if (command) commands.push(command);
				});
			});

			await page.addInitScript(
				(cfg: { wsUrl: string }) => {
					localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl: cfg.wsUrl, token: "" }));
					localStorage.setItem("cornfield.workspace.rightPanel", "1");
				},
				{ wsUrl: `ws://127.0.0.1:${servePort}/ws` },
			);
			await page.goto(`http://127.0.0.1:${appPort}/#/workspace`, { waitUntil: "domcontentloaded" });
			await page.locator(".conn-dot:not(.reconnecting)").first().waitFor({ state: "visible", timeout: 60_000 });

			// ── 基线：没绑 Project 的会话读的是 serve 自己的根 ──
			await tab(page, TAB_ARTIFACTS).click();
			await expect
				.poll(() => commands.filter(c => c.type === "list_artifacts").length, { timeout: 30_000 })
				.toBeGreaterThan(0);
			expect(commands.filter(c => c.type === "list_artifacts").at(-1)?.sessionId).toBe("default");
			// 未绑时会话账本里没有产物 → 空态（这里是**真的**没有，不是读不到）
			await expect(page.locator("aside").getByText("暂无产物")).toBeVisible({ timeout: 30_000 });

			// ── 顶栏选工作上下文 → 新会话落在 Project 的根 ──
			const chip = page.locator("details > summary.chip").first();
			await chip.click();
			await page.getByLabel("工作上下文", { exact: true }).selectOption(PROJECT_ID);
			await chip.click();
			await page.locator("header").getByRole("button", { name: "新会话" }).click();
			await page.getByRole("button", { name: "新建会话" }).click();
			await expect(page.getByText(PROJECT_NAME).first()).toBeVisible({ timeout: 20_000 });

			// ── 产物读取的 wire 身份 = **会话身份**（附件地址 = `agent\u0000工作根`） ──
			const projectAddress = `default\u0000${projRoot}`;
			await expect
				.poll(() => commands.filter(c => c.type === "list_artifacts" && c.sessionId === projectAddress).length, {
					timeout: 30_000,
				})
				.toBeGreaterThan(0);
			const projectRead = commands.filter(c => c.type === "list_artifacts" && c.sessionId === projectAddress).at(-1);
			// 拿 Agent 名「default」读会解到**未绑定**的那个附件（另一个根）——不是这个会话的工作面
			expect(projectRead?.sessionId).not.toBe("default");
			const projectSessionFile = projectRead?.sessionFile;
			expect(typeof projectSessionFile).toBe("string");
			if (typeof projectSessionFile !== "string") throw new Error("产物读取没有带 sessionFile（会话隔离视图失效）");
			expect(projectSessionFile).not.toBe(rootSessionFile);

			// 种进**这个会话**的账本：同名文件在两个根里都存在，看它给出哪一份
			await seedSessionArtifacts(
				projectSessionFile,
				[
					{ name: "write", path: SAME_NAME },
					{ name: "write", path: ONLY_IN_PROJ },
				],
				projRoot,
			);
			// 换一次 tab 触发重读（产物清单按会话身份 + sessionFile 取）
			await tab(page, TAB_FILES).click();
			await tab(page, TAB_ARTIFACTS).click();

			await expect(page.locator("aside").getByText(ONLY_IN_PROJ)).toBeVisible({ timeout: 30_000 });
			await page
				.locator("aside")
				.getByRole("button", { name: new RegExp(SAME_NAME.replace(".", "\\.")) })
				.click();
			// 同名文件两个根：预览给出 Project 根那一份 = 读与开都按会话身份走
			await expect(page.locator("aside").getByText("proj-root-content")).toBeVisible({ timeout: 15_000 });
			await expect(page.locator("aside").getByText("default-root-content")).toHaveCount(0);
			await page.screenshot({ path: `${SHOTS}/6-project-artifact-by-session-identity.png` });

			// ── 同一个会话的「改动」组：读的也是这个 Project 根（不是 git 仓库 → 读不到 ≠ 没有改动） ──
			await tab(page, TAB_CHANGES).click();
			await expect(
				page
					.locator("aside")
					.getByText(/读不到改动：Server rejected "git_changes": git_changes failed: not a git repository: /),
			).toBeVisible({ timeout: 30_000 });
			await expect(page.locator("aside").getByText("工作区没有改动")).toHaveCount(0);
			await page.screenshot({ path: `${SHOTS}/7-project-changes-not-a-repo.png` });
		} finally {
			kill(serve.proc);
			kill(preview);
			await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(defaultRoot, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(projRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test("改动 tab：清单与 git status 一致、点条目打开文件、删除/干净/未连接各说各的话", async ({ page }) => {
		const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "panel-chg-home-"));
		const repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), "panel-chg-repo-"));
		const tracked = path.join(repoDir, "tracked.txt");
		const untracked = path.join(repoDir, "untracked.txt");

		await fsp.writeFile(tracked, "v1\n");
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		execFileSync("git", ["add", "tracked.txt"], { cwd: repoDir });
		execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-q", "-m", "init"], {
			cwd: repoDir,
		});
		// 真改动：一个已跟踪文件被改 + 一个未跟踪新文件
		await fsp.writeFile(tracked, "v2-changed\n");
		await fsp.writeFile(untracked, "new file\n");

		const servePort = await freePort();
		const appPort = await freePort();
		const serve = spawnServe({ homeDir, cwd: repoDir, port: servePort });
		const preview = spawn(
			"bun",
			["x", "vite", "preview", "--port", String(appPort), "--strictPort", "--host", "127.0.0.1"],
			{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
		);

		try {
			await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 60_000, "serve 启动");
			await waitForHttp(`http://127.0.0.1:${appPort}/`, 30_000);

			await page.addInitScript(
				(cfg: { wsUrl: string }) => {
					localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl: cfg.wsUrl, token: "" }));
					localStorage.setItem("cornfield.workspace.rightPanel", "1");
				},
				{ wsUrl: `ws://127.0.0.1:${servePort}/ws` },
			);
			await page.goto(`http://127.0.0.1:${appPort}/#/workspace`, { waitUntil: "domcontentloaded" });
			await page.locator(".conn-dot:not(.reconnecting)").first().waitFor({ state: "visible", timeout: 60_000 });

			// ── 1. 改动清单 = git status --porcelain 的事实，逐条对上 ──
			await tab(page, TAB_CHANGES).click();
			// 本会话那一组（读它的会话身份就是缺省的 default 附件）
			const group = page.locator("aside").getByText("本会话", { exact: true });
			await expect(group).toBeVisible({ timeout: 30_000 });
			await expect(page.locator('aside [data-change-path="tracked.txt"]')).toBeVisible({ timeout: 30_000 });
			await expect(page.locator('aside [data-change-path="untracked.txt"]')).toBeVisible();

			const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" })
				.split("\n")
				.filter(line => line.trim() !== "")
				.map(line => line.slice(3).trim());
			const domPaths = (
				await page
					.locator("aside [data-change-path]")
					.evaluateAll(els => els.map(el => el.getAttribute("data-change-path")))
			)
				.filter((p): p is string => p !== null)
				.sort();
			expect(domPaths).toEqual([...porcelain].sort());
			expect(porcelain).toEqual(["tracked.txt", "untracked.txt"]);

			// 两轴徽标（porcelain 的 X/Y）：已跟踪文件是「工作区 修改」，新文件是「工作区 未跟踪」
			const trackedRow = page.locator('aside [data-change-path="tracked.txt"]');
			await expect(trackedRow).toContainText("工作区 修改");
			const untrackedRow = page.locator('aside [data-change-path="untracked.txt"]');
			await expect(untrackedRow).toContainText("工作区 未跟踪");
			await page.screenshot({ path: `${SHOTS}/8-changes-list.png` });

			// ── 2. 点条目 → 在文件 tab 里打开那个文件（真内容） ──
			await untrackedRow.click();
			await expect(page.getByLabel("编辑 untracked.txt")).toHaveValue("new file\n", { timeout: 20_000 });

			// ── 3. 来回切 tab：清单与打开的文件都还在该在的地方 ──
			await tab(page, TAB_CHANGES).click();
			await expect(page.locator('aside [data-change-path="untracked.txt"]')).toBeVisible({ timeout: 20_000 });
			await tab(page, TAB_FILES).click();
			await expect(page.getByLabel("编辑 untracked.txt")).toHaveValue("new file\n", { timeout: 20_000 });
			await page.screenshot({ path: `${SHOTS}/9-changes-tab-switch.png` });

			// ── 4. 磁盘上已删的文件也是一条改动：点开它要在文件面**明说读不到**（不是静默无反应） ──
			await fsp.rm(tracked, { force: true });
			await tab(page, TAB_CHANGES).click();
			await page.locator("aside").getByRole("button", { name: "刷新" }).click();
			const deletedRow = page.locator('aside [data-change-path="tracked.txt"]');
			await expect(deletedRow).toContainText("工作区 删除", { timeout: 20_000 });
			await deletedRow.click();
			await expect(
				page
					.locator("aside")
					.getByText(/no such file: tracked\.txt/)
					.first(),
			).toBeVisible({
				timeout: 20_000,
			});

			// ── 5. 工作区干净：是「读到了，确实没有改动」，不是「读不到」 ──
			await fsp.writeFile(tracked, "v1\n");
			await fsp.rm(untracked, { force: true });
			await tab(page, TAB_CHANGES).click();
			await page.locator("aside").getByRole("button", { name: "刷新" }).click();
			await expect(page.locator("aside").getByText("工作区没有改动")).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("aside").getByText(/读不到改动/)).toHaveCount(0);
			await page.screenshot({ path: `${SHOTS}/10-changes-clean.png` });

			// ── 6. 未连接：文件 / 改动各自说「读不到」，与「没有改动」不是一句话 ──
			// 另开一个页面（不复用上面那个）：连接配置走 addInitScript，而它在**每次导航**都会执行 ——
			// 在同一个 page 上改 localStorage 再 reload 会被它覆写回去，验不出「连不上」这一态。
			const deadPage = await page.context().newPage();
			await deadPage.addInitScript(() => {
				localStorage.setItem(
					"cornfield.serve.connection",
					JSON.stringify({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }),
				);
				localStorage.setItem("cornfield.workspace.rightPanel", "1");
			});
			await deadPage.goto(`http://127.0.0.1:${appPort}/#/workspace`, { waitUntil: "domcontentloaded" });
			await expect(deadPage.locator("aside").getByText("未连接——文件系统不可用")).toBeVisible({ timeout: 30_000 });
			await deadPage.getByRole("tab", { name: TAB_CHANGES }).click();
			await expect(deadPage.locator("aside").getByText("未连接——读不到工作区改动")).toBeVisible({
				timeout: 20_000,
			});
			await expect(deadPage.locator("aside").getByText("工作区没有改动")).toHaveCount(0);
			await deadPage.getByRole("tab", { name: TAB_ARTIFACTS }).click();
			// 存证：产物 tab 在这一态只渲染「暂无产物」——与上面两句都不是一回事（未连接 ≠ 没有产物）。
			// 本 spec 不断言它（那是把缺陷钉死成预期）；根因坐标：ArtifactsPanel.tsx 把未挂载身份
			// （空串）直接当成 ready+空清单，而文件/改动两个 tab 都按 view.connected 分开说。
			await deadPage.screenshot({ path: `${SHOTS}/11-disconnected-tabs.png` });
			await deadPage.close();
		} finally {
			kill(serve.proc);
			kill(preview);
			await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(repoDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});
});
