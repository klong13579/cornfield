/**
 * T9 文件编辑闭环 e2e —— 真实 serve（源码）+ 真实 web-app（dist）+ 真实 Chrome。
 *
 * 这是**唯一**能证明「编辑器写的字真的落到磁盘上、冲突真的挡住了、大文件真的降级了」的证据层：
 * 单测驱动的是内存替身，这里驱动的是真的文件系统。
 *
 * 编排（与 smoke.spec.ts 同构）：
 *   1. dist 已由 `bun run build` 产出；vite preview 起 dist（随机端口）
 *   2. serve 以源码启动（bun packages/coding-agent/src/cli.ts，不用可能过期的 dist 二进制）
 *   3. 浏览器（系统 Chrome）注入 localStorage 连接配置指向该 serve 端口
 *
 * 隔离（不需要真实 LLM 鉴权，全程不发 prompt 语义请求）：
 *   - HOME = 临时目录 → 没有 ~/.cornfield/agent/registry.json，于是只有 serve 自带的
 *     default agent，它的 workspace 根 = serve 进程 cwd 的 git 仓库根 = 临时 git 仓库。
 *     用户真实的 agent registry / 会话 / 仓库一个都不碰。
 *   - 项目文件都在临时目录里，测试自己 stat/读它们来判定「磁盘上到底是什么」。
 *
 * 断言链：文件树上点开文件 → 编辑 → 保存（磁盘真的变了）→ 外部改写 → 保存被拒（磁盘没被覆盖）
 * → 「用我的覆盖」→ 磁盘变成我的 → 大文件只读降级 → 选区进上下文项 → 发送带上 @mention 与选区
 * → 新会话（文件视图随会话作废）。
 *
 * 前置：`bun run --cwd=packages/web-app build`（npm script `e2e:smoke` 已带）。
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FILE = "hello.txt";
const BIG_FILE = "big.txt";
const BIG_FILE_BYTES = 200 * 1024;
/** 多字节文本：45000 个汉字 = 135000 字节（超 128KiB），但字符数只有 45000（不到 128K）。 */
const CJK_FILE = "cjk.txt";
const CJK_CHARS = 45_000;

function freePort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

function waitForOutput(proc: ChildProcess, matcher: RegExp, timeoutMs: number, label: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			proc.stdout?.removeAllListeners();
			proc.stderr?.removeAllListeners();
			reject(new Error(`${label} 超时（${timeoutMs}ms）未匹配 ${matcher}`));
		}, timeoutMs);
		const onData = (buf: Buffer) => {
			const m = buf.toString().match(matcher);
			if (m) {
				clearTimeout(timer);
				proc.stdout?.removeListener("data", onData);
				proc.stderr?.removeListener("data", onData);
				resolve(m[0]);
			}
		};
		proc.stdout?.on("data", onData);
		proc.stderr?.on("data", onData);
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

/**
 * 视口取宽一些：本 spec 要同时看到左栏会话与右栏文件（两块 300px 面板）。
 * 默认 1440 宽时中栏的顶栏按钮会与右栏重叠（既有布局在双栏同开时的宽度余量问题，与本票无关）。
 */
test.use({ viewport: { width: 1920, height: 1000 } });

test.describe("文件编辑闭环（真实 serve + 真实文件系统）", () => {
	test("浏览/编辑/保存/冲突/大文件/选区上下文项/会话归属", async ({ page }) => {
		const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "t9-e2e-home-"));
		const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), "t9-e2e-proj-"));
		const projectFile = path.join(projectDir, FILE);
		const bigFile = path.join(projectDir, BIG_FILE);
		const disk = (): Promise<string> => fsp.readFile(projectFile, "utf8");

		await fsp.writeFile(projectFile, "alpha\nbeta\ngamma\n");
		await fsp.writeFile(bigFile, `${`x`.repeat(BIG_FILE_BYTES)}\n`);
		await fsp.writeFile(path.join(projectDir, CJK_FILE), "中".repeat(CJK_CHARS));
		// 真 git 仓库：serve 的 default agent 根 = cwd 的仓库根（不经回退路径）
		execFileSync("git", ["init", "-q"], { cwd: projectDir });

		const servePort = await freePort();
		const appPort = await freePort();
		const serveUrl = `ws://127.0.0.1:${servePort}/ws`;
		const serve = spawn(
			"bun",
			[
				`${repoRoot}/packages/coding-agent/src/cli.ts`,
				"serve",
				"--port",
				String(servePort),
				"--host",
				"127.0.0.1",
				"--no-extensions",
			],
			{ cwd: projectDir, env: { ...process.env, HOME: homeDir, PI_NO_TITLE: "1" } },
		);
		const preview = spawn(
			"bun",
			["x", "vite", "preview", "--port", String(appPort), "--strictPort", "--host", "127.0.0.1"],
			{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
		);

		try {
			await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 60_000, "serve 启动");
			await waitForHttp(`http://127.0.0.1:${appPort}/`, 30_000);

			// 连接配置 + 右栏展开（都是 localStorage 偏好，必须在首次导航前写好）
			await page.addInitScript(
				(cfg: { wsUrl: string }) => {
					localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl: cfg.wsUrl, token: "" }));
					localStorage.setItem("cornfield.workspace.rightPanel", "1");
				},
				{ wsUrl: serveUrl },
			);
			await page.goto(`http://127.0.0.1:${appPort}/#/workspace`, { waitUntil: "domcontentloaded" });
			await page.locator(".conn-dot:not(.reconnecting)").first().waitFor({ state: "visible", timeout: 60_000 });

			// ── 1. 文件树里点开文件：内容来自磁盘 ──
			const treeFile = page.locator(`[data-path="${FILE}"]`);
			await treeFile.waitFor({ state: "visible", timeout: 30_000 });
			await treeFile.click();
			await expect(page.getByLabel(`编辑 ${FILE}`)).toHaveValue("alpha\nbeta\ngamma\n");

			// ── 2. 编辑 → 未保存 → 保存 → 磁盘真的变了 ──
			await page.getByLabel(`编辑 ${FILE}`).fill("alpha\nBETA\ngamma\n");
			await expect(page.getByText("未保存", { exact: true })).toBeVisible();
			await page.getByRole("button", { name: "保存", exact: true }).click();
			await expect
				.poll(async () => disk(), { timeout: 15_000, message: "保存后磁盘应变成编辑器里的内容" })
				.toBe("alpha\nBETA\ngamma\n");
			await expect(page.getByText("未保存", { exact: true })).toHaveCount(0);

			// ── 3. 外部改写（Agent/别人）→ 保存被拒 → 一个字节都没被覆盖 ──
			await page.getByLabel(`编辑 ${FILE}`).fill("my version\n");
			await fsp.writeFile(projectFile, "external version\n");
			await page.getByRole("button", { name: "保存", exact: true }).click();
			await expect(page.getByText(/保存被拒绝/)).toBeVisible({ timeout: 15_000 });
			expect(await disk()).toBe("external version\n");

			// 冲突差异：看得见两边的区别（服务端 diff，不是前端自己比的）
			await page.getByRole("button", { name: "看磁盘差异" }).click();
			await expect(page.getByText("磁盘上的版本", { exact: false })).toBeVisible();
			// 「看磁盘差异」回答的是「盘上变成什么了」：before = 我打开时的基线，after = 磁盘现在的版本
			// （行号与行内容在相邻 span 里，不拼成一个字符串，所以按 diff 行类型断言）
			await expect(page.locator('[data-diff-kind="del"]').first()).toContainText("alpha");
			await expect(page.locator('[data-diff-kind="add"]').first()).toContainText("external version");
			await page.getByRole("button", { name: "返回" }).click();

			// ── 4. 「用我的覆盖」：以磁盘版本为基线重写 ──
			await page.getByRole("button", { name: "用我的覆盖" }).click();
			await expect.poll(async () => disk(), { timeout: 15_000 }).toBe("my version\n");
			await expect(page.getByText(/保存被拒绝/)).toHaveCount(0);

			// ── 5. 大文件只读降级（>128KB 拿不到全文，不能整段写回） ──
			await page.locator(`[data-path="${BIG_FILE}"]`).click();
			await expect(page.getByLabel(`编辑 ${BIG_FILE}`)).toHaveAttribute("readonly", "", { timeout: 15_000 });
			await expect(page.getByText("只读 · 已截断")).toBeVisible();
			await expect(page.getByText(/超过 128KB/)).toBeVisible();

			// 多字节文本按**字节**判（中文 3B/字）：字符数不到 128K 也照样只读降级，
			// 否则编辑器会拿半份中文去写回，把文件真截断。
			await page.locator(`[data-path="${CJK_FILE}"]`).click();
			await expect(page.getByLabel(`编辑 ${CJK_FILE}`)).toHaveAttribute("readonly", "", { timeout: 15_000 });
			await expect(page.getByText("只读 · 已截断")).toBeVisible();

			// ── 6. 回到小文件：选区 → 上下文项 → 发送带上 @mention 与选区原文 ──
			// 外部把文件改回已知内容，再用「重新加载」同步（这一步同时验证重载按钮）
			await fsp.writeFile(projectFile, "alpha\nbeta\ngamma\n");
			await page.locator(`[data-path="${FILE}"]`).click();
			await page.getByRole("button", { name: "重新加载" }).click();
			await expect(page.getByLabel(`编辑 ${FILE}`)).toHaveValue("alpha\nbeta\ngamma\n");

			const editor = page.getByLabel(`编辑 ${FILE}`);
			await editor.click();
			await page.keyboard.press("ControlOrMeta+A");
			const addSelection = page.getByRole("button", { name: /将选区加入上下文/ });
			await expect(addSelection).toBeEnabled();
			await addSelection.click();
			await expect(page.locator(".chip", { hasText: `${FILE}:1-3` })).toBeVisible();

			const composer = page.getByPlaceholder(/发消息，或直接提问/);
			await composer.fill("看这段");
			await page.getByRole("button", { name: "发送" }).click();
			// 发送 = 草稿 + 序列化块：@路径 走运行时既有的提及通道，选区原文随围栏内联
			const echo = page.locator("div.bg-user-bg", { hasText: "看这段" }).first();
			await expect(echo).toContainText(`@${FILE}`);
			await expect(echo).toContainText("[选区 hello.txt:1-3]");
			await expect(echo).toContainText("alpha");
			// 条目随消息发走：不再挂在下一条消息上
			await expect(page.locator(".chip", { hasText: `${FILE}:1-3` })).toHaveCount(0, { timeout: 10_000 });

			// ── 7. 换会话：文件视图随会话作废（不是一个全局的编辑器） ──
			// 顶栏那个（侧栏列表里也有一个同名按钮）
			await page.locator("header").getByRole("button", { name: "新会话" }).click();
			await expect(page.getByText("点击左侧目录展开，点文件查看或编辑")).toBeVisible({ timeout: 20_000 });
			await expect(page.getByLabel(`编辑 ${FILE}`)).toHaveCount(0);
		} finally {
			kill(serve);
			kill(preview);
			await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});
});
