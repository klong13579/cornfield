/**
 * Project 绑定闭环 e2e —— 真实 serve（源码）+ 真实 web-app（dist）+ 真实 Chrome。
 *
 * 这条链证明的是**用户能看见的那件事**：在界面上选一个 Project、建一个会话，这个会话就真的
 * 落在那份 Project 的根里 —— 能列它的文件、能读、能写回磁盘，且界面上的归属读数带着来源。
 * 单测与 wire 层集成测试各证一半，这里证「点下去真的成立」。
 *
 * 编排（与 file-edit.spec.ts 同构）：
 *   1. dist 先由 `bun run --cwd=packages/web-app build` 产出；vite preview 起 dist（随机端口）
 *   2. serve 以源码启动（bun packages/coding-agent/src/cli.ts，不用可能过期的 dist 二进制）
 *   3. 浏览器（系统 Chrome）注入 localStorage 连接配置指向该 serve 端口
 *
 * 隔离：
 *   - HOME = 临时目录；Project registry 写在 `<HOME>/.cornfield/agent/projects.json`，
 *     只声明一个 Project，root 指向另一个临时目录 —— 用户真实的 registry / 会话 / 仓库一个都不碰。
 *   - serve 的 cwd = 另一个临时 git 仓库（default agent 的工作根），里面放一个**对照文件**：
 *     绑定前文件面看得见它、看不见 Project 的文件；绑定后反过来。
 *
 * 断言链：基线（文件面 = serve 自己的根）→ 顶栏选工作上下文 → 新会话表单读的就是它 → 提交
 * → 文件面换成 Project 的根（对照文件消失）→ 归属读数出现该项目 → 在那个根里打开文件、改、保存
 * → 磁盘真的变了。每步截图到 test-results/projbind/。
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
const DEFAULT_MARKER = "DEFAULT_ROOT.txt";
const PROJECT_MARKER = "PROJECT_ROOT.txt";

/**
 * 隔离：交给 serve 的 gateway wire 端口是个**没人监听**的口。
 *
 * 前端不再自己写死 7892（F7：端口由 serve 在 hello_ack 里报），所以隔离 HOME 下的页面只会去
 * 问这个死端口并快速失败 —— 不会连上本机真实运营中的 gateway（那会让页面上出现别的进程的数据）。
 */
const DEAD_GATEWAY_WIRE_PORT = "47831";
const PROJECT_ID = "e2e-proj";
const PROJECT_NAME = "E2E 项目";
const SHOTS = "test-results/projbind";

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

type RecordedFrame = { dir: "c2s" | "s2c"; at: number; frame: unknown };

/**
 * 夹在浏览器与 serve 之间的 WS 录制代理。
 *
 * 为什么需要它：要证明的是「UI 真发出去的那一帧」把消息投给了**哪个会话**，而这条判据在浏览器里
 * 看不见（隔离 HOME 没有 LLM key，用户消息也不会 flush 到 JSONL）。代理只转发 + 记录，不改一帧。
 */
function startRecordingProxy(targetPort: number): {
	port: number;
	frames: RecordedFrame[];
	stop: () => void;
} {
	const frames: RecordedFrame[] = [];
	const decode = (msg: string | Uint8Array): string => (typeof msg === "string" ? msg : new TextDecoder().decode(msg));
	const server = Bun.serve<{ upstream?: WebSocket; pending: string[] }>({
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req, { data: { pending: [] } })) return undefined;
			return new Response("proxy: websocket only", { status: 426 });
		},
		websocket: {
			open(ws) {
				const upstream = new WebSocket(`ws://127.0.0.1:${targetPort}/ws`);
				ws.data.upstream = upstream;
				upstream.addEventListener("open", () => {
					for (const queued of ws.data.pending) upstream.send(queued);
					ws.data.pending = [];
				});
				upstream.addEventListener("message", ev => {
					const text = decode(ev.data as string | Uint8Array);
					try {
						frames.push({ dir: "s2c", at: Date.now(), frame: JSON.parse(text) });
					} catch {
						// 非 JSON 帧照转不记
					}
					if (ws.readyState === WebSocket.OPEN) ws.send(text);
				});
				upstream.addEventListener("close", () => {
					try {
						ws.close();
					} catch {
						// 已关
					}
				});
			},
			message(ws, msg) {
				const text = decode(msg as string | Uint8Array);
				try {
					frames.push({ dir: "c2s", at: Date.now(), frame: JSON.parse(text) });
				} catch {
					// 非 JSON 帧照转不记
				}
				const upstream = ws.data.upstream;
				if (upstream?.readyState === WebSocket.OPEN) upstream.send(text);
				else ws.data.pending.push(text);
			},
			close(ws) {
				ws.data.upstream?.close();
			},
		},
	});
	return {
		port: server.port ?? 0,
		frames,
		stop: () => {
			void server.stop(true);
		},
	};
}

test.use({ viewport: { width: 1920, height: 1000 } });

test.describe("Project 绑定闭环（真实 serve + 真实前端）", () => {
	test("选工作上下文 → 建会话 → 落在那个 Project 的根里：能列/能读/能写，归属带来源", async ({ page }) => {
		const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "projbind-e2e-home-"));
		const defaultRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "projbind-e2e-default-"));
		const projRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "projbind-e2e-proj-"));

		await fsp.writeFile(path.join(defaultRoot, DEFAULT_MARKER), "default root\n");
		await fsp.writeFile(path.join(projRoot, PROJECT_MARKER), "marker-original\n");
		execFileSync("git", ["init", "-q"], { cwd: defaultRoot });

		// Project registry：只声明这一个，root 指到另一个临时目录
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
			{
				cwd: defaultRoot,
				env: {
					...process.env,
					HOME: homeDir,
					PI_NO_TITLE: "1",
					CORNFIELD_GATEWAY_WIRE_PORT: DEAD_GATEWAY_WIRE_PORT,
				},
			},
		);
		const preview = spawn(
			"bun",
			["x", "vite", "preview", "--port", String(appPort), "--strictPort", "--host", "127.0.0.1"],
			{
				cwd: path.join(repoRoot, "packages/web-app"),
				env: process.env,
			},
		);

		try {
			await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 60_000, "serve 启动");
			// 浏览器连的是录制代理，不是 serve 本身（只转发+记录，不改一帧）
			const proxy = startRecordingProxy(servePort);
			const serveUrl = `ws://127.0.0.1:${proxy.port}/ws`;
			await waitForHttp(`http://127.0.0.1:${appPort}/`, 30_000);

			await page.addInitScript(
				(cfg: { wsUrl: string }) => {
					localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl: cfg.wsUrl, token: "" }));
					localStorage.setItem("cornfield.workspace.rightPanel", "1");
				},
				{ wsUrl: serveUrl },
			);
			await page.goto(`http://127.0.0.1:${appPort}/#/workspace`, { waitUntil: "domcontentloaded" });
			await page.locator(".conn-dot:not(.reconnecting)").first().waitFor({ state: "visible", timeout: 60_000 });
			await page.screenshot({ path: `${SHOTS}/1-connected.png`, fullPage: false });

			// ── 1. 基线：还没绑 Project，文件面是 serve 自己的根 ──
			await expect(page.locator(`[data-path="${DEFAULT_MARKER}"]`)).toBeVisible({ timeout: 30_000 });
			await expect(page.locator(`[data-path="${PROJECT_MARKER}"]`)).toHaveCount(0);
			await page.screenshot({ path: `${SHOTS}/2-baseline-default-root.png` });

			// ── 2. 顶栏选工作上下文（不是会话归属，是「下一个新会话落在哪」）──
			// chip 是 <details><summary>：面板默认收起，选择器在面板里
			const chip = page.locator("details > summary.chip").first();
			await chip.click();
			await page.getByLabel("工作上下文", { exact: true }).selectOption(PROJECT_ID);
			await page.screenshot({ path: `${SHOTS}/3-working-context-panel.png` });

			// root 字段：浏览器直开**没有桌面壳** —— 该有的是「能少打」（候选里是本机已声明过的项目根），
			// 不该有的是一个点了没反应的「浏览…」按钮（它只在 Electron 壳里存在）。
			const rootInput = page.getByLabel("项目根路径");
			await expect(rootInput).toBeVisible();
			await expect(rootInput).toHaveAttribute("list", "project-root-suggestions");
			await expect(page.locator("#project-root-suggestions option")).toHaveCount(1);
			await expect(page.locator("#project-root-suggestions option")).toHaveAttribute("value", projRoot);
			await expect(page.getByRole("button", { name: "浏览…" })).toHaveCount(0);

			await chip.click(); // 收起面板，免得挡住顶栏按钮

			// ── 3. 打开新建会话表单：它的 Project 字段读的就是工作上下文 ──
			await page.locator("header").getByRole("button", { name: "新会话" }).click();
			await expect(page.getByLabel("Project", { exact: true })).toHaveValue(PROJECT_ID);
			await page.screenshot({ path: `${SHOTS}/4-form-project-selected.png` });

			// ── 4. 提交 → 会话落在 Project 的根：文件面换过来 ──
			await page.getByRole("button", { name: "新建会话" }).click();
			await expect(page.locator(`[data-path="${PROJECT_MARKER}"]`)).toBeVisible({ timeout: 30_000 });
			await expect(page.locator(`[data-path="${DEFAULT_MARKER}"]`)).toHaveCount(0);
			// 归属读数是 serve 的权威值，并且带来源（会话记下的 / 按目录算出的）
			await expect(page.getByText(PROJECT_NAME).first()).toBeVisible({ timeout: 15_000 });
			await page.screenshot({ path: `${SHOTS}/5-session-in-project-root.png` });

			// ── 5. 在那个根里读 + 写：磁盘真的变了 ──
			await page.locator(`[data-path="${PROJECT_MARKER}"]`).click();
			await expect(page.getByLabel(`编辑 ${PROJECT_MARKER}`)).toHaveValue("marker-original\n", { timeout: 15_000 });
			await page.getByLabel(`编辑 ${PROJECT_MARKER}`).fill("marker-edited-by-ui\n");
			await page.getByRole("button", { name: "保存", exact: true }).click();
			await expect
				.poll(async () => fsp.readFile(path.join(projRoot, PROJECT_MARKER), "utf8"), {
					timeout: 15_000,
					message: "保存后 Project root 里的文件应该真的变了",
				})
				.toBe("marker-edited-by-ui\n");
			await page.screenshot({ path: `${SHOTS}/6-saved-into-project-root.png` });

			// ── 6. 发消息：UI 真发出去的那一帧，sessionId 必须是**会话身份**（不是 Agent 名） ──
			// 判据取 c2s 帧：绑定后 UI 给 fs_list/fs_read/fs_write/git_changes 发的 sessionId 就是会话身份
			// （附件地址 = `Agent 名 + NUL + 工作根`），消息也必须发到同一个身份上。
			const fsFrames = proxy.frames
				.filter(f => f.dir === "c2s")
				.map(f => (f.frame as { command?: { type?: string; sessionId?: string } }).command)
				.filter((c): c is { type: string; sessionId?: string } => c !== undefined)
				.filter(c => ["fs_list", "fs_read", "fs_write", "git_changes"].includes(c.type ?? ""));
			const addresses = new Set(
				fsFrames.map(c => c.sessionId).filter((v): v is string => typeof v === "string" && v.includes("\u0000")),
			);
			expect(addresses.size).toBe(1);
			const boundAddress = [...addresses][0] as string;
			console.log("PROBE 会话身份（附件地址）=", boundAddress.replace(projRoot, "<projRoot>"));
			expect(boundAddress.endsWith(projRoot)).toBe(true);

			const composer = page.getByPlaceholder(/发消息，或直接提问/);
			await composer.fill("PROBE-MESSAGE-INTO-BOUND-SESSION");
			await page.getByRole("button", { name: "发送" }).click();
			await expect
				.poll(
					() =>
						proxy.frames.filter(f => {
							const command = (f.frame as { command?: { type?: string } }).command;
							return f.dir === "c2s" && command?.type === "prompt";
						}).length,
					{ timeout: 15_000, message: "发送后应当有一帧 prompt 出去" },
				)
				.toBeGreaterThan(0);

			const prompts = proxy.frames
				.filter(f => f.dir === "c2s")
				.map(f => (f.frame as { command?: { type?: string; sessionId?: string; message?: string } }).command)
				.filter((c): c is { type: string; sessionId?: string; message?: string } => c?.type === "prompt");
			const sent = prompts.at(-1);
			console.log("PROBE prompt.sessionId =", String(sent?.sessionId).replace(projRoot, "<projRoot>"));
			console.log("PROBE prompt.message =", JSON.stringify(sent?.message).slice(0, 60));
			expect(sent?.sessionId).toBe(boundAddress);
			expect(sent?.sessionId).not.toBe("default");
			await page.screenshot({ path: `${SHOTS}/7-message-sent.png` });
		} finally {
			kill(serve);
			kill(preview);
			await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(defaultRoot, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(projRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	});
});
