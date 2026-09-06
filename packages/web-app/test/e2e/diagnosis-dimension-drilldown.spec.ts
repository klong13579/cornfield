/**
 * 诊断大盘「工具」维度点击下钻闭环（真实 serve + 真实 web-app + 真实浏览器点击）。
 *
 * 编排：
 *   1. 隔离 agentDir；从真实用户级会话拷贝一份种子 JSONL（含工具错误 → 工具维度 fail）
 *   2. serve 以源码启动（随机端口，真实 skill/诊断脚本路径，无 LLM 依赖——简单诊断不走模型）
 *   3. 浏览器页面内直接用 WS 调 diagnose_session(sessionFile) → 轮询 aggregate_diagnosis
 *      直到 dimensionReports.tool 非空（SQLite 已 upsert）
 *   4. vite preview 起 dist；注入连接 → 切「健康度大盘」
 *   5. 断言「工具」维度卡 enabled → 点击 → hash 跳转 /records/:sessionId/diagnosis
 *   6. 详情页点「工具调用链路」卡头 → 展开内容（判定依据/修复建议）可见
 *
 * 门：仅真实浏览器可跑（playwright channel chrome）；无需 E2E=1（不走 LLM）。
 * 运行：bunx playwright test packages/web-app/test/e2e/diagnosis-dimension-drilldown.spec.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const APP_PORT = 4173;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// 种子会话：真实用户级会话（aborted + 35 个工具错误 → dim tool=fail，dimensionReports.tool 有行）
const SEED_SESSION = path.join(
	os.homedir(),
	".cornfield/agent/sessions/-Desktop-Narwal-cornfield/by-date/2026-09-03/185149__0b5624dd.jsonl",
);

function freePort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

function waitForOutput(proc: ChildProcess, matcher: RegExp, timeoutMs: number, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）未匹配 ${matcher}`)), timeoutMs);
		const onData = (buf: Buffer) => {
			if (matcher.test(buf.toString())) {
				clearTimeout(timer);
				proc.stdout?.removeListener("data", onData);
				proc.stderr?.removeListener("data", onData);
				resolve();
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
			// 未就绪
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

test.setTimeout(240_000);

test("诊断大盘工具维度点击下钻 + 详情页展开", async ({ page }) => {
	const seedStat = await fsp.stat(SEED_SESSION).catch(() => null);
	test.skip(!seedStat, `种子会话不存在：${SEED_SESSION}`);

	// ── 1. 隔离 agentDir + 种会话 ──
	const isoDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-diag-e2e-"));
	// agentDir 根下的会话目录结构：<agentDir>/sessions/<proj>/by-date/<date>/<file>
	// extractAgentId 取 /sessions/ 前缀 basename（agentDir 名），extractSessionDate 取 by-date。
	const seedRel = path.join("sessions", "iso-proj", "by-date", "2026-09-05", "seed__e2e.jsonl");
	const sessionFile = path.join(isoDir, seedRel);
	await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
	await fsp.copyFile(SEED_SESSION, sessionFile);

	const servePort = await freePort();
	const serveUrl = `ws://127.0.0.1:${servePort}/ws`;
	const serve = spawn(
		"bun",
		[`${repoRoot}/packages/coding-agent/src/cli.ts`, "serve", "--port", String(servePort), "--host", "127.0.0.1", "--no-extensions"],
		{ env: { ...process.env, PI_NO_TITLE: "1", CORNFIELD_AGENT_DIR: isoDir } },
	);
	const preview = spawn(
		"bun",
		["x", "vite", "preview", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"],
		{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
	);

	try {
		await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 30_000, "serve 启动");
		await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, 30_000);

		// ── 2. 浏览器内 WS：诊断 + 轮询聚合落库 ──
		const seedOutcome = await page.evaluate(
			async ({ wsUrl, sessionFile }) => {
				const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
				const ws = new WebSocket(wsUrl);
				await new Promise<void>((resolve, reject) => {
					ws.onopen = () => resolve();
					ws.onerror = () => reject(new Error("ws open failed"));
				});
				let nextId = 1;
				const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
				const helloDone = new Promise<void>((resolve, reject) => {
					const t = setTimeout(() => reject(new Error("hello_ack timeout")), 10_000);
					ws.onmessage = (e: MessageEvent) => {
						const frame = JSON.parse(String(e.data)) as { type?: string; id?: string; result?: unknown; error?: string };
						if (frame.type === "hello_ack") {
							clearTimeout(t);
							resolve();
							return;
						}
						if ((frame.type === "response" || frame.type === "error") && frame.id) {
							const p = pending.get(frame.id);
							if (!p) return;
							pending.delete(frame.id);
							if (frame.type === "response") p.resolve(frame.result);
							else p.reject(new Error(frame.error ?? "cmd error"));
						}
					};
				});
				ws.send(JSON.stringify({ id: "hello-1", type: "hello", token: "", version: 1 }));
				await helloDone;
				const req = (command: Record<string, unknown>) =>
					new Promise<unknown>((resolve, reject) => {
						const id = `c${nextId++}`;
						pending.set(id, { resolve, reject });
						ws.send(JSON.stringify({ id, type: "request", command }));
					});

				await req({ type: "diagnose_session", sessionFile });
				let toolReports = 0;
				const deadline = Date.now() + 90_000;
				while (Date.now() < deadline) {
					await sleep(500);
					const agg = (await req({ type: "aggregate_diagnosis" })) as {
						dimensionReports?: Record<string, unknown[]>;
					};
					toolReports = agg.dimensionReports?.tool?.length ?? 0;
					if (toolReports > 0) break;
				}
				ws.close();
				return { toolReports };
			},
			{ wsUrl: serveUrl, sessionFile },
		);
		expect(seedOutcome.toolReports).toBeGreaterThan(0);

		// ── 3. 连接 web-app → 大盘 → 点「工具」卡 ──
		await page.addInitScript((wsUrl: string) => {
			localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl, token: "" }));
		}, serveUrl);
		// workspace 页有 conn-dot（/records 页无）；先在此确认连接，再 hash 导航到 records（不重载，连接保留）
		await page.goto(`http://127.0.0.1:${APP_PORT}/#/workspace`, { waitUntil: "domcontentloaded" });
		await page.locator(".conn-dot:not(.reconnecting)").first().waitFor({ state: "visible", timeout: 30_000 });
		await page.goto(`http://127.0.0.1:${APP_PORT}/#/records`, { waitUntil: "domcontentloaded" });

		await page.getByRole("button", { name: "健康度大盘" }).click();
		await page.getByText("6 维度失败率").waitFor({ state: "visible", timeout: 30_000 });

		const toolCard = page.getByRole("button", { name: /^工具/ }).first();
		await toolCard.waitFor({ state: "visible", timeout: 30_000 });
		expect(await toolCard.isEnabled()).toBe(true);

		// ── 4. 点击 → 断言跳转诊断详情页 ──
		await toolCard.click();
		await page.waitForURL(/#\/records\/[^/]+\/diagnosis/, { timeout: 30_000 });

		// ── 5. 详情页「工具调用链路」卡展开 ──
		const toolDim = page.getByRole("button", { name: /工具调用链路/ }).first();
		await toolDim.waitFor({ state: "visible", timeout: 30_000 });
		await toolDim.click();
		// 展开内容：basis 渲染「判定依据」label，tool dim basis 恒非空
		await page.getByText("判定依据").waitFor({ state: "visible", timeout: 15_000 });

		await page.screenshot({ path: path.join("test-results", "diag-tool-drilldown.png"), fullPage: true });
	} finally {
		kill(serve);
		kill(preview);
		await fsp.rm(isoDir, { recursive: true, force: true }).catch(() => undefined);
	}
});
