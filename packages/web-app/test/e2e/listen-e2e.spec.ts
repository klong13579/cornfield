/**
 * 听记（VOICE-D）UI e2e —— 真实 serve（本仓库源码，隔离配置根）→ vite preview → 浏览器。
 *
 * 编排（spec 内自管）：
 *   1. serve 以源码启动（bun packages/coding-agent/src/cli.ts）、随机端口、隔离 CORNFIELD_CONFIG_DIR
 *      （不碰真实 ~/.cornfield/listen）；spec 预置一条历史录音 json
 *   2. vite preview 起 build 后 dist（4174）
 *   3. 浏览器注入 localStorage 连接配置指向该 serve；假麦克风 flags
 *
 * 覆盖：
 *   A. 历史列表真实加载：预置 json → 页面「听记」tab 渲染文件名 → 搜索过滤 → 展开预览
 *   B. UI 四态 + 链路连通：假麦克风录音（orb listening + 计时）→ 停止 → 转写（静音 →
 *      whisper 无文本 → 服务端 ok:false → UI 错误态）。证明 getUserMedia→AudioContext→
 *      WAV 编码→独立短连接 record_transcribe 全链路在浏览器跑通。
 *
 * 真实语音转写正确性由 coding-agent/test/wire-server-listen.integration.test.ts（E2E=1）
 * 覆盖（test-voice.wav → 本地 whisper → 文本 + 落盘一致）。
 *
 * 门上：E2E=1（`bun run test:ci` 已带）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

const APP_PORT = 4174;
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

test.setTimeout(180_000);
test.skip(!process.env.E2E, "听记 UI e2e 在 E2E 门后执行（bun run test:ci）");

test.use({
	launchOptions: {
		args: [
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			"--autoplay-policy=no-user-gesture-required",
		],
	},
});

test("听记：历史真实加载 + 假麦克风四态 UI 链路", async ({ page }) => {
	const servePort = await freePort();
	const serveUrl = `ws://127.0.0.1:${servePort}/ws`;
	const isoHome = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-listen-ui-e2e-"));

	// 预置一条历史录音（serve 的 ~/CORNFIELD_CONFIG_DIR/listen/）
	await fsp.mkdir(path.join(isoHome, "listen"), { recursive: true });
	await fsp.writeFile(
		path.join(isoHome, "listen", "2026-08-20-e2e历史.json"),
		JSON.stringify({
			version: 1,
			recorded_at: "2026-08-20T08:00:00.000Z",
			text: "E2E 历史记录转写文本，用于验证列表渲染。",
		}),
		"utf-8",
	);

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
		{ env: { ...process.env, CORNFIELD_CONFIG_DIR: isoHome, PI_NO_TITLE: "1" } },
	);
	let serveErr = "";
	serve.stderr?.on("data", d => {
		serveErr = (serveErr + d.toString()).slice(-4000);
	});
	let serveOut = "";
	serve.stdout?.on("data", d => {
		serveOut = (serveOut + d.toString()).slice(-4000);
	});
	// 已知环境问题：spec 内起的新 serve 进程在部分环境下中途退出（code=0，进程组信号干扰）。
	// 功能正确性由 coding-agent 集成测试（E2E=1 真实转写/落盘/listen_list）覆盖；本 spec 是
	// UI 回归锁，若 serve 早退则历史断言超时 —— 手动 E2E 验收时可按需重跑。
	const preview = spawn(
		"bun",
		["x", "vite", "preview", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"],
		{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
	);

	try {
		await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 30_000, "serve 启动");
		await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, 30_000);

		await page.addInitScript((wsUrl: string) => {
			localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl, token: "" }));
		}, serveUrl);
		// 路由是 hash 模式（createHashRouter）——voice 页在 /#/voice
		await page.goto(`http://127.0.0.1:${APP_PORT}/#/voice`, { waitUntil: "domcontentloaded" });

		// ── 切到「听记」tab ──
		await page.getByRole("button", { name: "听记" }).click();

		// ── A. 历史列表真实加载（listen_list → 预置 json 渲染） ──
		await page
			.getByText("2026-08-20-e2e历史.json", { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 15_000 });
		// 搜索过滤
		await page.getByPlaceholder("搜索关键词…").fill("不存在的词");
		await page.getByText("没有匹配", { exact: false }).waitFor({ state: "visible", timeout: 5_000 });
		await page.getByPlaceholder("搜索关键词…").fill("E2E");
		await page
			.getByText("2026-08-20-e2e历史.json", { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 5_000 });
		// 展开预览
		await page.getByRole("button", { name: "查看" }).click();
		await page.getByText("E2E 历史记录转写文本", { exact: false }).waitFor({ state: "visible", timeout: 5_000 });
		await page.screenshot({ path: path.join("test-results", "listen-history.png"), fullPage: true });

		// ── B. 假麦克风四态：录音 → 停止 → 转写 → 错误态（链路连通） ──
		await page.getByRole("button", { name: "开始录音" }).click();
		// recording：orb listening 动效 + 计时出现（元素级断言——textContent 无换行，行锚正则永不匹配）
		await page
			.getByText(/^\d{2}:\d{2}$/)
			.first()
			.waitFor({ state: "visible", timeout: 8_000 });
		await page.waitForTimeout(1_200);
		await page.screenshot({ path: path.join("test-results", "listen-recording.png"), fullPage: true });
		await page.getByText("停止并转写", { exact: true }).click();
		// 转写中（orb working + 转写中文案）
		await page.getByText("转写中…", { exact: false }).first().waitFor({ state: "visible", timeout: 5_000 });
		// 静音音频 → whisper 无文本 → 服务端 ok:false → UI 错误态
		await page.waitForFunction(
			() =>
				(document.body.textContent ?? "").includes("转写失败") ||
				(document.body.textContent ?? "").includes("no text"),
			undefined,
			{ timeout: 120_000 },
		);
		await page.screenshot({ path: path.join("test-results", "listen-error.png"), fullPage: true });
		console.log("[listen-e2e] 历史加载 + 四态链路验证完成");
	} finally {
		kill(serve);
		kill(preview);
	}
});
