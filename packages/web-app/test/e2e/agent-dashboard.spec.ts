/**
 * Agent 看板 e2e —— 真实 serve（源码）+ 真实 web-app（dist）+ 真实 Chrome。
 *
 * 证明两件事（单测都证不了）：
 *   1. 「新增 agent」在隔离 HOME 里用真 CLI 建出来之后，前端 #/agents 真的看得到、详情页打得开。
 *   2. AgentDetailView 的 7 个 tab 逐个打开时渲染的是什么（含空态文案 / 加载失败文案 / console error），
 *      以及「工具开关」读写的到底是不是**这个 agent 自己的** <agentDir>/config.yml。
 *
 * 隔离：HOME = 临时目录（不碰真人 registry / 会话 / 仓库）；serve 的日志与 session 落在临时 HOME 下。
 * 断言里的绝对路径都以 agentDir 为锚，测试自己读磁盘来判定「落盘到底是什么」。
 *
 * 前置：`bun run --cwd=packages/web-app build`（vite preview 起的是 dist）。
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const SHOT_DIR = path.join(repoRoot, "packages/web-app/test-results/agent-dashboard");
const AGENT = "verify-bot";

/** 7 个 tab 的按钮文案（与 AgentDetailView 的 TABS 一致）。 */
const TAB_LABELS = ["Skills", "钉钉", "模型配置", "工具开关", "用户画像", "文件", "Prompts"] as const;

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

interface TabObservation {
	tab: string;
	/** 该 tab 打开后页面正文里可读到的文本（截断）。 */
	text: string;
	/** 该 tab 打开期间新增的 console error / pageerror。 */
	errors: string[];
	screenshot: string;
}

/** 每个 tab 打开后正文里必然出现 / 必然不出现的串（用作回归断言，不是仅截图）。 */
const TAB_EXPECT: Record<string, { has: string[]; hasNot?: string[] }> = {
	Skills: { has: ["个本次会话加载的技能", "lint"] },
	钉钉: { has: ["该 agent 未绑定钉钉机器人"] },
	模型配置: { has: ["模型选择"] },
	工具开关: { has: ["python 工具模式", "glob"] },
	用户画像: { has: ["mission.md（agent 职责）", "user.md（用户画像声明）"] },
	文件: { has: ["点击左侧目录展开，点文件查看或编辑"] },
	Prompts: { has: ["点击左侧浏览 agent 的各份 prompt 配置"] },
};

/** 打开详情页的一个 tab：点击 → 等渲染稳定 → 断言 → 截图 → 记文本与 console error。 */
async function openTab(page: Page, label: string, observations: TabObservation[], errors: string[]): Promise<void> {
	const before = errors.length;
	await page
		.getByRole("button", { name: new RegExp(`^${label}`) })
		.first()
		.click();
	// 等到骨架屏幕消失（空态也是稳定态）
	await page
		.waitForFunction(() => document.querySelectorAll(".skeleton").length === 0, undefined, { timeout: 20_000 })
		.catch(() => undefined);
	await page.waitForTimeout(400);
	const text = await page.evaluate(() => (document.querySelector("main") ?? document.body).innerText.slice(0, 6000));
	const expect_ = TAB_EXPECT[label];
	for (const frag of expect_.has) expect(text, `${label} tab 正文应包含「${frag}」`).toContain(frag);
	for (const frag of expect_.hasNot ?? []) expect(text, `${label} tab 正文不应包含「${frag}」`).not.toContain(frag);
	const shot = path.join(SHOT_DIR, `${label}.png`);
	await page.screenshot({ path: shot, fullPage: true });
	observations.push({ tab: label, text, errors: errors.slice(before), screenshot: shot });
}

/** 读「工具开关」tab 里所有开关的（工具名, aria-checked）——按 DOM 顺序，与 TOOL_SWITCH_DEFS 一致。 */
async function readToolSwitches(page: Page): Promise<Array<{ label: string; checked: string | null }>> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll('button[role="switch"]')).map(b => ({
			label: b.closest("div")?.querySelector("span.font-mono")?.textContent ?? "",
			checked: b.getAttribute("aria-checked"),
		})),
	);
}

test.use({ viewport: { width: 1600, height: 1100 } });

test.describe("Agent 看板（真实 serve + 真实前端）", () => {
	test("新增 agent 可见 + 详情 7 个 tab 逐个打开", async ({ page }) => {
		const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-dash-home-"));
		const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-dash-proj-"));
		execFileSync("git", ["init", "-q"], { cwd: projectDir });
		await fsp.mkdir(SHOT_DIR, { recursive: true });

		const env = { ...process.env, HOME: homeDir, PI_NO_TITLE: "1" };
		// ── 第一部分：真 CLI 建 agent（隔离 HOME）──
		const initOut = execFileSync("bun", [CLI, "agent", "init", AGENT], {
			cwd: projectDir,
			env,
			encoding: "utf8",
		});
		const agentDir = path.join(homeDir, ".cornfield", "agents", AGENT);
		// 预置两份 config.yml，把「作用域」变成可观测事实：
		//  - <agentDir>/config.yml（verify-bot 自己）    : glob.enabled=false
		//  - <HOME>/.cornfield/agent/config.yml（default）: disabledProviders=[narwal-plan]
		// 然后看：工具开关读的是哪一份（应=自己那份）；模型下拉里的 narwal-plan 会不会
		// 因为**别的 agent** 的停用名单而消失（消失 = 模型可见性是全局的，跨 agent 泄漏）。
		const perAgentConfig = path.join(agentDir, "config.yml");
		await fsp.writeFile(perAgentConfig, "glob:\n  enabled: false\n");
		const defaultAgentConfig = path.join(homeDir, ".cornfield", "agent", "config.yml");
		await fsp.mkdir(path.dirname(defaultAgentConfig), { recursive: true });
		await fsp.writeFile(defaultAgentConfig, "disabledProviders:\n  - narwal-plan\n");

		const servePort = await freePort();
		const appPort = await freePort();
		const serveUrl = `ws://127.0.0.1:${servePort}/ws`;
		const serve = spawn(
			"bun",
			[CLI, "serve", "--port", String(servePort), "--host", "127.0.0.1", "--no-extensions"],
			{ cwd: projectDir, env },
		);
		const preview = spawn(
			"bun",
			["x", "vite", "preview", "--port", String(appPort), "--strictPort", "--host", "127.0.0.1"],
			{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
		);

		const errors: string[] = [];
		page.on("console", m => {
			if (m.type() === "error") errors.push(m.text());
		});
		page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));

		const observations: TabObservation[] = [];
		try {
			await waitForOutput(serve, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 60_000, "serve 启动");
			await waitForHttp(`http://127.0.0.1:${appPort}/`, 30_000);

			await page.addInitScript(
				(cfg: { wsUrl: string }) => {
					localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl: cfg.wsUrl, token: "" }));
				},
				{ wsUrl: serveUrl },
			);

			// ── 1. #/agents 看得到这个 agent ──
			await page.goto(`http://127.0.0.1:${appPort}/#/agents`, { waitUntil: "domcontentloaded" });
			// 就绪信号 = 注册表推送到位（该 agent 出现在列表里）
			await expect(page.getByText(AGENT, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
			await page.screenshot({ path: path.join(SHOT_DIR, "00-agents-list.png"), fullPage: true });

			// ── 2. 详情页打开（点 verify-bot 卡片自己的「详情」，不是 default 的）──
			const card = page.locator("div.rounded-xl").filter({ has: page.getByText(AGENT, { exact: true }) });
			await card.getByRole("button", { name: "详情" }).click();
			await expect(page).toHaveURL(new RegExp(`#/agents/${AGENT}$`), { timeout: 15_000 });
			await expect(page.getByRole("heading", { name: AGENT })).toBeVisible({ timeout: 15_000 });

			// ── 3. 7 个 tab 逐个打开 ──
			for (const label of TAB_LABELS) {
				await openTab(page, label, observations, errors);
			}

			// ── 4a. 模型配置读作用域（只记录，不断言）：verify-bot 自己**没有**停用 narwal-plan，
			//        而 default agent 的全局 config.yml 停用了它 —— 看下拉里还有没有 narwal-plan ──
			await page
				.getByRole("button", { name: /^模型配置/ })
				.first()
				.click();
			await page.waitForTimeout(800);
			const providerOptions = await page.locator("select").first().locator("option").allTextContents();
			// Provider 下拉的初始态：React state 写死 "anthropic"，与真实 provider 列表是否对得上
			const providerSelected = await page.evaluate(() => {
				const sels = Array.from(document.querySelectorAll("select"));
				return sels.map(s => ({
					value: (s as HTMLSelectElement).value,
					selectedIndex: (s as HTMLSelectElement).selectedIndex,
					optionCount: s.options.length,
				}));
			});
			const modelScopeProbe = {
				providerOptions,
				narwalPlanVisible: providerOptions.includes("narwal-plan"),
				selects: providerSelected,
				detailAgentConfig: await fsp.readFile(perAgentConfig, "utf8"),
				defaultAgentConfig: await fsp.readFile(defaultAgentConfig, "utf8"),
			};

			// ── 4a-2. 模型配置写作用域（只记录）：选一个真实 provider+model，看哪个文件变了；
			//         再改 Thinking，看有没有落盘（set_thinking_level 是否 persist）──
			const projectConfig = path.join(agentDir, ".cornfield", "config.yml");
			const readBoth = async (): Promise<{ detail: string; project: string }> => ({
				detail: await fsp.readFile(perAgentConfig, "utf8"),
				project: await fsp.readFile(projectConfig, "utf8"),
			});
			const beforeWrite = await readBoth();
			// Provider 初始 state 是 "anthropic"（AgentDetailView.tsx:49），但列表里没有它 ——
			// 所以这里探 DOM 里真正选中的那一项（index 0）来触发 onChange，避开名字写死的脆断。
			await page.locator("select").first().selectOption({ index: 0 }, { timeout: 15_000 });
			await page.waitForTimeout(600);
			const modelOptions = await page.locator("select").nth(1).locator("option").allTextContents();
			if (modelOptions.length > 0) {
				await page.locator("select").nth(1).selectOption({ index: 0 }, { timeout: 15_000 });
			}
			await page.waitForTimeout(2500);
			const afterModelWrite = await readBoth();
			await page.locator("select").nth(2).selectOption("high", { timeout: 15_000 });
			await page.waitForTimeout(2500);
			const afterThinkingWrite = await readBoth();
			const modelWriteProbe = { modelOptions, beforeWrite, afterModelWrite, afterThinkingWrite };
			await page.screenshot({ path: path.join(SHOT_DIR, "模型配置-after-write.png"), fullPage: true });

			// ── 4b. Prompts tab 实际打开几个源（只记录）：.omp/SYSTEM.md 预期不存在（skeleton 写的是 .cornfield/SYSTEM.md）──
			await page
				.getByRole("button", { name: /^Prompts/ })
				.first()
				.click();
			const promptProbe: Record<string, string> = {};
			for (const src of ["mission.md", "user.md", ".omp/SYSTEM.md", "prompt-includes.json"]) {
				await page
					.getByRole("button", { name: new RegExp(`^${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })
					.click();
				await page.waitForTimeout(300);
				const body = await page.evaluate(() => (document.querySelector("main") ?? document.body).innerText);
				promptProbe[src] = /该文件不存在或不可读/.test(body) ? "missing" : "opened";
			}
			await page.screenshot({ path: path.join(SHOT_DIR, "Prompts-sources.png"), fullPage: true });

			// ── 4c. 作用域证据：预置的 <agentDir>/config.yml glob.enabled=false 是否被 UI 读到 ──
			await page
				.getByRole("button", { name: /^工具开关/ })
				.first()
				.click();
			await expect.poll(async () => (await readToolSwitches(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
			const switches = await readToolSwitches(page);
			const glob = switches.find(s => s.label === "glob");
			expect(glob, "工具开关列表里应有 glob 一行的开关").toBeTruthy();
			expect(glob?.checked, "glob 的开关应反射 <agentDir>/config.yml 的 glob.enabled=false").toBe("false");

			// ── 5. 写入作用域证据：切开关 → 落盘到 <agentDir>/config.yml ──
			const globIndex = switches.findIndex(s => s.label === "glob");
			await page.locator('button[role="switch"]').nth(globIndex).click();
			await expect
				.poll(async () => fsp.readFile(perAgentConfig, "utf8"), { timeout: 15_000 })
				.toContain("enabled: true");
			await page.screenshot({ path: path.join(SHOT_DIR, "tools-after-write.png"), fullPage: true });

			// 证据落盘（供人工复核，不参与断言）
			await fsp.writeFile(
				path.join(SHOT_DIR, "observations.json"),
				JSON.stringify(
					{
						homeDir,
						projectDir,
						agentDir,
						initOut: initOut.trim(),
						perAgentConfigAfter: await fsp.readFile(perAgentConfig, "utf8"),
						modelScopeProbe,
						modelWriteProbe,
						promptProbe,
						observations,
						allConsoleErrors: errors,
					},
					null,
					2,
				),
			);
		} finally {
			kill(serve);
			kill(preview);
			await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
			await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});
});

/** 只读镜像：证明「前端根本没有新增 agent 入口」——列出页面上所有按钮文案。 */
test("只读：#/agents 页面上有没有「新增/创建」入口", async ({ page }) => {
	const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-dash-home2-"));
	const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-dash-proj2-"));
	execFileSync("git", ["init", "-q"], { cwd: projectDir });
	const env = { ...process.env, HOME: homeDir, PI_NO_TITLE: "1" };
	const servePort = await freePort();
	const appPort = await freePort();
	const serve = spawn("bun", [CLI, "serve", "--port", String(servePort), "--host", "127.0.0.1", "--no-extensions"], {
		cwd: projectDir,
		env,
	});
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
			},
			{ wsUrl: `ws://127.0.0.1:${servePort}/ws` },
		);
		await page.goto(`http://127.0.0.1:${appPort}/#/agents`, { waitUntil: "domcontentloaded" });
		// 就绪信号 = server_snapshot 到位（头行从 0 agent 变为 1 个 default agent）
		await expect(page.getByText(/1 工作区/)).toBeVisible({ timeout: 60_000 });
		await page.waitForTimeout(1000);
		const buttons = await page.evaluate(() =>
			Array.from(document.querySelectorAll("button")).map(b => (b.textContent ?? "").trim()),
		);
		await fsp.mkdir(SHOT_DIR, { recursive: true });
		await fsp.writeFile(path.join(SHOT_DIR, "agents-page-buttons.json"), JSON.stringify(buttons, null, 2));
		expect(
			buttons.some(t => /新增|创建|新建/.test(t)),
			`页面按钮：${JSON.stringify(buttons)}`,
		).toBe(false);
	} finally {
		kill(serve);
		kill(preview);
		await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
		await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
	}
});
