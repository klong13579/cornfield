/**
 * F2 冒烟（W3 收尾）—— 真实 serve → 真实 web-app → prompt → 流式断言。
 *
 * 编排（spec 内自管，双进程 + 双端口）：
 *   1. build 已在 `test:ci` 前置完成；vite preview 起 dist（127.0.0.1:4173）
 *   2. serve 以源码启动（bun packages/coding-agent/src/cli.ts，绝不依赖可能过期的
 *      dist/omp 二进制）、随机端口、真实 HOME（取真实 LLM 鉴权）
 *   3. 浏览器（系统 Chrome）注入 localStorage 连接配置指向该 serve 端口
 *
 * 断言：连上（conn-dot connected）→ 发 prompt → 用户回显 → 回合结束（✓ 已完成）→
 * 流式渲染（streaming 状态触发 + 文本非空）。
 * 流式硬断言已恢复（STREAM-1 修复 pi-client-adapter message_update 字段名不匹配，
 * live 层现能收到 progress 增量）。
 *
 * 门上：E2E=1 才执行（真实 LLM 调用）；CI 默认 skip——`E2E=1 bun run test:ci` 本地验收用。
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const PROMPT = "冒烟测试：请只回复 OK 两个字母，不要调用任何工具。";
const APP_PORT = 4173;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

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

test.setTimeout(180_000);
test.skip(!process.env.E2E, "F2 冒烟需要真实 LLM 鉴权——设 E2E=1 才执行（bun run test:ci 已显式带 E2E=1 语义）");

test("smoke: 真实 serve → 连接 → prompt → 流式回复", async ({ page }) => {
	const servePort = await freePort();
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
		{ env: { ...process.env, PI_NO_TITLE: "1" } },
	);
	const preview = spawn(
		"bun",
		["x", "vite", "preview", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"],
		{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
	);

	try {
		await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 30_000, "serve 启动");
		await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, 30_000);
		await page.goto("/workspace", { waitUntil: "domcontentloaded" });
	} catch (err) {
		kill(serve);
		kill(preview);
		throw err;
	}

	try {
		// 注入连接配置后重载（goto 之后 addInitScript 也需生效于下次导航）
		await page.addInitScript((wsUrl: string) => {
			localStorage.setItem("omp.serve.connection", JSON.stringify({ wsUrl, token: "" }));
		}, serveUrl);
		await page.goto("/workspace", { waitUntil: "domcontentloaded" });

		// ── 断言 1：连接建立（conn-dot connected）──
		await page.locator(".conn-dot:not(.reconnecting)").first().waitFor({ state: "visible", timeout: 30_000 });
		await page.getByText("connected", { exact: true }).waitFor({ state: "visible" });

		// ── 断言 2：发送 prompt ──
		const composer = page.getByPlaceholder(/发消息，或直接提问/);
		await composer.waitFor({ state: "visible", timeout: 15_000 });
		await composer.fill(PROMPT);
		await page.getByRole("button", { name: "发送" }).click();

		// ── 断言 3：流式断言——发送瞬间起并发 100ms 轮询 meta 行，不阻塞其余等待 ──
		// meta 行（assistant 内容 div 的第一个子 div）在流式期间显示 streaming，落定后 ✓ 已完成
		const metaProbe = page.locator(".avatar.assistant + div > div:first-child").last();
		const textProbe = page.locator(".avatar.assistant + div > div:nth-child(2)").last();
		let sawStreaming = false;
		let lastMetaText = "";
		const lengths: number[] = [];
		const pollDeadline = Date.now() + 90_000;
		const poll = (async () => {
			while (Date.now() < pollDeadline) {
				const meta = (await metaProbe.textContent().catch(() => "")) ?? "";
				const body = (await textProbe.textContent().catch(() => "")) ?? "";
				if (meta.length > 0) lastMetaText = meta;
				if (body.trim().length > 0) lengths.push(body.trim().length);
				if (meta.includes("streaming")) sawStreaming = true;
				await page.waitForTimeout(100);
			}
		})();

		// 用户回显（bg-user-bg 气泡）
		await page.locator("div.bg-user-bg", { hasText: "冒烟测试" }).waitFor({ state: "visible", timeout: 15_000 });

		// 回复落定：meta 行出现 ✓ 已完成
		await page.getByText("✓ 已完成", { exact: true }).first().waitFor({ state: "visible", timeout: 120_000 });
		await poll;
		console.log(
			"[smoke] sawStreaming=",
			sawStreaming,
			"lastMeta=",
			JSON.stringify(lastMetaText),
			"textLens=",
			JSON.stringify([...new Set(lengths)].slice(0, 12)),
		);

		// 回复文本非空（硬断言）——文本容器 = 内容 div 的 nth-child(2)
		const assistantText = await page
			.locator(".avatar.assistant + div")
			.last()
			.locator(":scope > div:nth-child(2)")
			.textContent();
		expect(assistantText?.trim().length ?? 0).toBeGreaterThan(0);
		// 流式硬断言（STREAM-1 修复后必须触发）：meta 行曾出现 streaming + 文本非空
		expect(sawStreaming).toBe(true);
		expect(new Set(lengths).size).toBeGreaterThan(0);

		await page.screenshot({ path: path.join("test-results", "smoke-reply.png"), fullPage: true });
	} finally {
		kill(serve);
		kill(preview);
	}
});
