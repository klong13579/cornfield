/**
 * F1「前端能建 agent」的 e2e —— 真 serve（源码）+ 真 dist + 真 Chrome。
 *
 * 这条链证明的是**用户点下去真的成立**：在界面上建一个 agent，serve 上真的多出一个 agentDir
 * （骨架文件 + registry 登记），列表里出现它，详情页打得开。单测与 wire 层集成测试各证一半
 * （表单语义 / 命令面到磁盘），这里证整条链。
 *
 * 编排（与 project-binding.spec.ts 同构）：
 *   1. dist 先由 `bun run --cwd=packages/web-app build` 产出；vite preview 起 dist（随机端口）
 *   2. serve 以源码启动（bun packages/coding-agent/src/cli.ts，不用可能过期的 dist 二进制）
 *   3. 浏览器（系统 Chrome）注入 localStorage 连接配置指向该 serve 端口
 *
 * 隔离：HOME = 临时目录 —— 新 agentDir 落在 `<HOME>/.cornfield/agents/<名字>/`，registry 写在
 * `<HOME>/.cornfield/agent/registry.json`；用户真实的 registry / agents 目录一个都不碰。
 *
 * 断言链：建一个 → serve 盘上真的有它（mission.md + registry）→ 列表里出现它 → 详情页是它
 * → 同名再建一次是「本来就在、补齐了缺的文件」（成功，不是错误，也不多出一张卡）
 * → 名字非法时显示 serve 的原文且盘上什么都没多出来。
 *
 * 前置：`bun run --cwd=packages/web-app build`。
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const AGENT_NAME = "e2e-maker";
const SHOTS = "test-results/agent-create";

/**
 * 隔离：交给 serve 的 gateway wire 端口是个**没人监听**的口。
 *
 * 前端不再自己写死 7892（F7：端口由 serve 在 hello_ack 里报），所以隔离 HOME 下的页面只会去
 * 问这个死端口并快速失败 —— 不会连上本机真实运营中的 gateway（那会让页面上出现别的进程的数据）。
 */
const DEAD_GATEWAY_WIRE_PORT = "47831";

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

async function exists(p: string): Promise<boolean> {
	try {
		await fsp.stat(p);
		return true;
	} catch {
		return false;
	}
}

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe("创建员工（真实 serve + 真实前端）", () => {
	test("建一个 agent → 盘上有它、列表有它、详情页打得开；同名与非法名各说各的实话", async ({ page }) => {
		const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-create-e2e-home-"));
		const serveCwd = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-create-e2e-cwd-"));
		const agentDir = path.join(homeDir, ".cornfield", "agents", AGENT_NAME);
		const registryFile = path.join(homeDir, ".cornfield", "agent", "registry.json");

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
				cwd: serveCwd,
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
			{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
		);

		try {
			await waitForHttp(`http://127.0.0.1:${servePort}/health`, 60_000);
			await waitForHttp(`http://127.0.0.1:${appPort}/`, 30_000);

			await page.addInitScript(
				(cfg: { wsUrl: string }) => {
					localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl: cfg.wsUrl, token: "" }));
				},
				{ wsUrl: `ws://127.0.0.1:${servePort}/ws` },
			);
			await page.goto(`http://127.0.0.1:${appPort}/#/workspace`, { waitUntil: "domcontentloaded" });
			// 工作台顶栏的连接点是「真连上了」的权威信号（Agent 管理页自己没有这个点）
			await page.locator(".conn-dot:not(.reconnecting)").first().waitFor({ state: "visible", timeout: 60_000 });
			await page.getByRole("link", { name: "Agent 管理" }).click();
			await expect(page.getByRole("button", { name: "创建员工" }).first()).toBeVisible({ timeout: 30_000 });
			await page.screenshot({ path: `${SHOTS}/1-agents-list.png` });

			// ── 1. 建：填名字 → 提交 ──
			await page.getByRole("button", { name: "创建员工" }).first().click();
			await page.getByLabel("名字").fill(AGENT_NAME);
			await page.screenshot({ path: `${SHOTS}/2-form-filled.png` });
			await page.getByRole("button", { name: "创建", exact: true }).click();

			// ── 2. 落到它的详情页（新建的成功直接进详情：列表已经刷成 serve 的现状）──
			await expect(page).toHaveURL(new RegExp(`#/agents/${AGENT_NAME}$`), { timeout: 30_000 });
			await expect(page.getByRole("heading", { name: AGENT_NAME })).toBeVisible({ timeout: 30_000 });
			await page.screenshot({ path: `${SHOTS}/3-detail-page.png` });

			// ── 3. 盘上的真相：agentDir 建出来了，registry 里有它 ──
			expect(await exists(path.join(agentDir, "mission.md"))).toBe(true);
			const registry = JSON.parse(await fsp.readFile(registryFile, "utf8")) as {
				agents: Record<string, { path: string }>;
			};
			expect(registry.agents[AGENT_NAME]?.path).toBe(agentDir);

			// ── 4. 列表里有它（且只有一张卡）──
			await page.getByRole("button", { name: "返回 Agent 列表" }).click();
			await expect(page.getByText(AGENT_NAME, { exact: true })).toHaveCount(1, { timeout: 30_000 });
			await page.screenshot({ path: `${SHOTS}/4-list-has-it.png` });

			// ── 5. 同名再来一次：是「本来就在、补齐了缺的文件」（成功），不是错误、也不多出一张卡 ──
			await page.getByRole("button", { name: "创建员工" }).first().click();
			await page.getByLabel("名字").fill(AGENT_NAME);
			await page.getByRole("button", { name: "创建", exact: true }).click();
			await expect(page.getByText("本来就在")).toBeVisible({ timeout: 30_000 });
			await page.screenshot({ path: `${SHOTS}/5-already-existed.png` });
			await page.getByRole("button", { name: "收起" }).click();
			await expect(page.getByText(AGENT_NAME, { exact: true })).toHaveCount(1);

			// ── 6. 名字非法：显示 serve 的原文，盘上什么都没多出来 ──
			await page.getByRole("button", { name: "创建员工" }).first().click();
			await page.getByLabel("名字").fill("../escape");
			await page.getByRole("button", { name: "创建", exact: true }).click();
			const alert = page.getByRole("alert");
			await expect(alert).toBeVisible({ timeout: 30_000 });
			await expect(alert).toContainText("Names cannot contain");
			await expect(alert).toContainText("../escape");
			await page.screenshot({ path: `${SHOTS}/6-server-rejection.png` });

			// 报错就是真的没写：坏名字的目录不存在，列表还是那一个
			expect(await exists(path.join(homeDir, ".cornfield", "agents", "escape"))).toBe(false);
			await page.getByRole("button", { name: "收起" }).click();
			await expect(page.getByText(AGENT_NAME, { exact: true })).toHaveCount(1);
			await page.screenshot({ path: `${SHOTS}/7-list-unchanged.png` });
		} finally {
			kill(serve);
			kill(preview);
			await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(serveCwd, { recursive: true, force: true }).catch(() => undefined);
		}
	});
});
