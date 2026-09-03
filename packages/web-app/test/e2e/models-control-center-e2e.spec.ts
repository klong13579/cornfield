/**
 * 模型控制中心 e2e（闭环）—— 真实 serve → 真实 web-app → 三个工作区全链路。
 *
 * 编排（同 smoke.spec：spec 内自管，双进程 + 双端口）：
 *   1. vite preview 起 dist（127.0.0.1:4173；dist 需先 `bun run build`）
 *   2. serve 以源码启动（bun packages/coding-agent/src/cli.ts，不依赖可能过期的 dist 二进制）、
 *      随机端口、隔离 CORNFIELD_AGENT_DIR（拷贝真实 agent.db 凭据库——目录状态/凭据掩码有真实数据；
 *      所有写动作落在隔离副本，不触碰真实配置）
 *   3. 浏览器（系统 Chrome）addInitScript 注入 localStorage 连接配置指向该 serve 端口
 *
 * 与 smoke 的差异：本 spec 零 LLM 调用（目录为静态数据、配置操作为本地命令），
 * 因此不需要 E2E=1 门控；唯一真实网络是 refresh_catalog 的在线目录刷新。
 *
 * 闭环断言：
 *   - /models 重定向 /models/catalog，壳层连接与状态条；
 *   - 目录：搜索过滤、临时切换（set_model_temporary 会话生效、状态条随动）、详情抽屉、
 *     连通性测试的费用确认闸门（确认即中断，不产生真实调用）；
 *   - Provider：卡片凭据掩码（无明文 key 泄漏）、API Key 保存（save_provider_api_key）、
 *     全量目录刷新（refresh_catalog online）；
 *   - 运行配置：作用域切换、角色编辑器校验闸门（目录不存在模型禁止保存）、
 *     草稿 → diff 确认弹窗 → 保存（set_config modelRoutes）→ 落盘断言（隔离 config.yml 文件内容）。
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const APP_PORT = 4173;
/** 闭环写入的模型 spec（provider 在 agent.db 副本中有真实 api-key 凭据 → 目录状态 available）。 */
const TARGET_MODEL = "narwal-plan/claude-haiku-4-5-20251001";
const TARGET_MODEL_ID = "claude-haiku-4-5-20251001";

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

async function waitForLogMatch(logPath: string, matcher: RegExp, timeoutMs: number, label: string): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const m = (await fsp.readFile(logPath, "utf8")).match(matcher);
			if (m) return m[0];
		} catch {
			// 日志尚未创建，重试
		}
		await new Promise(r => setTimeout(r, 300));
	}
	let tail = "";
	try {
		tail = (await fsp.readFile(logPath, "utf8")).slice(-2000);
	} catch {
		// 无日志
	}
	throw new Error(`${label} 超时（${timeoutMs}ms）未匹配 ${matcher}\nserve 日志末尾：\n${tail}`);
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

test.setTimeout(240_000);

test("模型控制中心闭环：目录 / Provider / 运行配置", async ({ page }) => {
	const servePort = await freePort();
	const serveUrl = `ws://127.0.0.1:${servePort}/ws`;
	// HOME 级隔离：registry/auth/config 全落在临时 HOME（拷贝真实 agent.db 凭据库到隔离位置）。
	// 不隔离 HOME 时 serve 会读真实 agents registry 并急切 attach 全部 agent（MCP 风暴），既污染又拖慢启动。
	const isoHome = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-mcc-e2e-"));
	const isoAgentDir = path.join(isoHome, ".cornfield", "agent");
	await fsp.mkdir(isoAgentDir, { recursive: true });
	await fsp
		.copyFile(path.join(os.homedir(), ".cornfield", "agent", "agent.db"), path.join(isoAgentDir, "agent.db"))
		.catch(() => {
			// agent.db 不存在（全新环境）：空库也合法，仅目录状态全为未接入
		});
	const serveLogPath = path.join(isoHome, "serve.log");
	const serveLogFile = await fsp.open(serveLogPath, "w");

	// serve cwd = 隔离目录（非 git 仓库 → 项目作用域根 = 该目录，项目配置写入 iso/.cornfield/）
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
			cwd: isoHome,
			env: { ...process.env, HOME: isoHome, PI_NO_TITLE: "1", CORNFIELD_AGENT_DIR: isoAgentDir },
			stdio: ["ignore", serveLogFile.fd, serveLogFile.fd],
		},
	);
	const preview = spawn(
		"bun",
		["x", "vite", "preview", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"],
		{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
	);

	let failed = false;
	try {
		await waitForLogMatch(serveLogPath, /ws:\/\/127\.0\.0\.1:\d+\/ws/, 30_000, "serve 启动");
		await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, 30_000);

		// WS 诊断：握手失败/close code 直接可见（连接问题不再只能靠「未连接」文案反推）
		page.on("websocket", ws => {
			console.log(`[ws] url=${ws.url()}`);
			ws.on("framesent", frame => console.log(`[ws→] ${String(frame.payload).slice(0, 200)}`));
			ws.on("framereceived", frame => console.log(`[ws←] ${String(frame.payload).slice(0, 200)}`));
			ws.on("close", () => console.log(`[ws] closed url=${ws.url()}`));
			ws.on("socketerror", err => console.log(`[ws] socketerror: ${err}`));
		});
		// 浏览器控制台错误透出（hello_error 等协议层失败走 console）
		page.on("console", msg => {
			if (msg.type() === "error") console.log(`[console] ${msg.text().slice(0, 300)}`);
		});

		// 连接配置必须在首次导航前注入（同 smoke：addInitScript 对同 URL 二次 goto 不生效）
		await page.addInitScript((wsUrl: string) => {
			localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl, token: "" }));
		}, serveUrl);

		// ── A. 壳层：/models 重定向 + 连接 + 状态条 ──
		await page.goto("/#/models", { waitUntil: "domcontentloaded" });
		await expect(page).toHaveURL(/#\/models\/catalog/);
		await expect(page.getByRole("heading", { name: "模型控制中心" })).toBeVisible();
		// 模型页连接成功 = 断连面板消失 + 目录数据渲染（「已连接」文案只存在于工作台/设置页）
		await expect(page.getByText("与 serve 未连接")).toHaveCount(0, { timeout: 30_000 });
		for (const tab of ["模型目录", "Provider", "运行时配置"]) {
			await expect(page.getByRole("link", { name: tab })).toBeVisible();
		}
		// 状态条：当前会话模型已取到（非占位 —）
		await expect(page.getByText("当前会话模型")).toBeVisible();

		// ── B. 模型目录：加载 + 搜索 + 临时切换 ──
		await page.getByText(/共 \d+ 个模型/).waitFor({ state: "visible", timeout: 30_000 });
		const search = page.getByPlaceholder("搜索名称 / 模型 ID / provider");
		await search.fill(TARGET_MODEL_ID);
		await page.getByText(/显示 \d+ 个/).waitFor({ state: "visible" });
		// 按 provider + 模型 ID 双条件定位行（切换后按钮文案临时使用→使用中，不能按按钮名过滤）
		const targetRow = page
			.locator("div.grid", { hasText: "narwal-plan" })
			.filter({ hasText: TARGET_MODEL_ID })
			.first();
		await targetRow.waitFor({ state: "visible", timeout: 15_000 });
		// 目标模型必须为 available 态（provider 已接入），否则说明目录状态推导有误
		await expect(targetRow).not.toContainText("不可切换");
		await expect(targetRow.getByRole("button", { name: "临时使用" })).toBeVisible();
		await targetRow.getByRole("button", { name: "临时使用" }).click();
		await expect(page.getByText(new RegExp(`已临时切换至 ${TARGET_MODEL}`))).toBeVisible();
		// 会话模型随动（wire-server 修复后快照推送）：行内「当前」徽章
		await expect(targetRow.getByText("当前", { exact: true })).toBeVisible({ timeout: 15_000 });

		// ── C. 详情抽屉：能力展示 + 连通性测试费用确认闸门（确认前取消，不产生真实调用） ──
		await targetRow.getByRole("button", { name: "详情" }).click();
		const drawer = page.locator("body").getByText("连通性测试").first();
		await drawer.waitFor({ state: "visible" });
		await page.getByRole("button", { name: "发起连通性测试" }).click();
		// 费用确认面板出现（真实调用与费用明示）
		await page.getByText(/真实调用/).waitFor({ state: "visible", timeout: 10_000 });
		await page.getByRole("button", { name: "取消" }).click();
		await page.getByRole("button", { name: "关闭详情" }).click();
		await search.fill("");

		// ── D. Provider 工作区：列表 + 凭据掩码 + API Key 保存 + 全量刷新 ──
		await page.getByRole("link", { name: "Provider" }).click();
		await expect(page.getByRole("heading", { name: "Provider 管理" })).toBeVisible();
		// 拷贝的 agent.db 有 kimi-code（oauth）与 narwal-plan（api-key）凭据 → 卡片出现
		await expect(page.getByText("kimi-code").first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText("narwal-plan").first()).toBeVisible();

		// 明文泄漏检查：页面任何位置不得出现完整 key 形态（掩码如 sk-1F••••xx 合法）
		const bodyText = await page.locator("body").innerText();
		expect(bodyText).not.toMatch(/sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/);

		// API Key 保存闭环（写在隔离副本上）：展开 narwal-plan 卡片 → 替换 → 保存 → 表单关闭
		const planCard = page.locator("div.overflow-hidden.rounded-xl", { hasText: "narwal-plan" }).first();
		await planCard.getByRole("button", { name: "管理" }).click();
		await planCard.getByRole("button", { name: "替换" }).click();
		const keyInput = planCard.getByPlaceholder("API Key", { exact: true });
		const keyConfirm = planCard.getByPlaceholder("再次输入确认");
		await keyInput.fill("sk-e2e-closedloop-0123456789abcdef");
		await keyConfirm.fill("sk-e2e-closedloop-0123456789abcdef");
		await planCard.locator("form").getByRole("button", { name: "保存", exact: true }).click();
		// 成功后表单关闭（输入框清空即隐藏），掩码回显
		await expect(keyInput).toHaveCount(0, { timeout: 15_000 });
		const bodyAfterKey = await page.locator("body").innerText();
		expect(bodyAfterKey).not.toMatch(/sk-e2e-closedloop-0123456789abcdef/);

		// 全量目录刷新（online；真实网络，宽超时）
		await page.getByRole("button", { name: "刷新全部目录" }).click();
		await expect(page.getByText(/全部 Provider 目录已刷新/)).toBeVisible({ timeout: 90_000 });

		// ── E. 运行配置：作用域 + 角色编辑器校验闸门 + 保存落盘 ──
		await page.getByRole("link", { name: "运行时配置" }).click();
		await expect(page.getByRole("heading", { name: "运行时配置" })).toBeVisible();
		await page.getByText("逐键配置").waitFor({ state: "visible" });
		await page.getByText("模型选择").first().waitFor({ state: "visible" });
		await page.getByText("角色配置").first().waitFor({ state: "visible" });
		// serve cwd 无项目配置 → 明确显示继承全局
		await expect(page.getByText(/项目级配置缺失/)).toBeVisible();

		// 作用域切换器：写入目标切到当前项目
		await page.getByRole("button", { name: "当前项目" }).click();
		await expect(page.getByText(/写入目标/).first()).toContainText(".cornfield/config.yml");

		// 角色编辑器：先圈定角色配置 section（避免 hasText 大小写不敏感误匹配逐键区 defaultThinkingLevel 等），
		// 再按 DEFAULT 标签定位 default 角色；行定位不绑定按钮名（展开后 编辑→收起，绑定会自失效）
		const roleSection = page.locator("section").filter({ hasText: "角色配置" }).filter({ hasText: "新增角色" });
		const defaultRow = roleSection.locator("div.px-5.py-3", { hasText: "DEFAULT" }).first();
		await defaultRow.getByRole("button", { name: "编辑", exact: true }).click();
		// combobox（ModelCombobox）以 aria-label + 显式 role="combobox" 定位；fill 输入自由文本，
		// 浮层出现不阻断后续点击（blur 先关浮层）
		const primaryInput = defaultRow.getByRole("combobox", { name: "角色主模型" }).first();

		// 校验闸门：目录不存在的模型 → error 禁止保存
		await primaryInput.fill("no-such-provider/bogus-model-xyz");
		await expect(page.getByText(/个校验错误，禁止保存/)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole("button", { name: /保存（\d+ 个角色变更）/ })).toBeDisabled();

		// 合法值：草稿 → 保存 → diff 确认弹窗
		await primaryInput.fill(TARGET_MODEL);
		await expect(page.getByText(/个校验错误，禁止保存/)).toHaveCount(0);
		await page.getByRole("button", { name: /保存（\d+ 个角色变更）/ }).click();
		const confirmDialog = page.getByRole("dialog", { name: "确认写入角色配置" });
		await expect(confirmDialog).toBeVisible();
		// diff 弹窗必须展示写入目标与主模型变更
		await expect(confirmDialog).toContainText(TARGET_MODEL);
		await confirmDialog.getByRole("button", { name: /确认写入/ }).click();
		// 成功通知：实际写入作用域 + 整键 modelRoutes
		await expect(page.getByText(/已将 \d+ 个角色的变更写入项目配置.*modelRoutes/)).toBeVisible({
			timeout: 30_000,
		});

		// 落盘断言：项目配置文件真实写入（serve cwd = isoHome → isoHome/.cornfield/config.yml）
		const projectConfig = await fsp.readFile(path.join(isoHome, ".cornfield", "config.yml"), "utf8");
		expect(projectConfig).toContain("modelRoutes");
		expect(projectConfig).toContain(TARGET_MODEL);

		// 快捷隐藏（#05 补充）：模型选择区两步确认隐藏 provider → 写全局停用名单，选择器分组消失。
		// 放在最后：隐藏后该 provider 不再可用，不影响前面的目录/角色断言
		const hiddenProvider = "alibaba-coding-plan";
		await page.getByRole("button", { name: `隐藏 ${hiddenProvider}` }).click();
		await page.getByRole("button", { name: `确认隐藏 ${hiddenProvider}？` }).click();
		await expect(page.getByText(`已隐藏 provider「${hiddenProvider}」`)).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: `隐藏 ${hiddenProvider}` })).toHaveCount(0);
		// Settings 落盘是 100ms debounce 后台写，不能读后即断言——轮询直到写盘完成
		const globalConfigPath = path.join(isoHome, ".cornfield", "agent", "config.yml");
		await expect
			.poll(async () => {
				try {
					return await fsp.readFile(globalConfigPath, "utf8");
				} catch {
					return ""; // debounce 未落盘
				}
			}, { timeout: 10_000 })
			.toContain(hiddenProvider); // disabledProviders 已落盘全局配置

		await page.screenshot({ path: "test-results/mcc-final.png", fullPage: true });
	} catch (err) {
		failed = true;
		throw err;
	} finally {
		kill(serve);
		kill(preview);
		await serveLogFile.close().catch(() => undefined);
		// 失败时保留现场供诊断：serve 日志留在 isoHome（成功则清）
		if (!failed) {
			await fsp.rm(isoHome, { recursive: true, force: true }).catch(() => undefined);
		} else {
			console.log(`[e2e] 失败现场保留：${isoHome}（serve 日志：${serveLogPath}）`);
		}
	}
});
