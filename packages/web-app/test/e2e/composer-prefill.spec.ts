/**
 * UI 回归：/workspace?q= 直达种子（Home Composer 跳转带话；FR-1 ?q=）。
 *
 * 历史 bug：ComposerBar 的 `value = ui.draft || autoFocusDraft` 使 ?q= 文本成为
 * 永久 fallback——用户清空输入后文本立即恢复（删不掉）；且 ?q= 从未从 URL 消费，
 * 刷新/回退会重复触发自动发送+清空，文本反复复活。
 *
 * 修复 = 工作台把种子写入草稿 store（一次）、自动发送（仅当用户未改动）后清空草稿，
 * 并 consume URL 的 q 参数（replaceState）。输入区唯一事实源 = ui.draft。
 *
 * 本测试无需 serve/LLM 鉴权（纯前端状态断言），与 smoke 共用 E2E 门（`bun run
 * test:ci` 前置已完成 build，vite preview 起 dist）：
 *   1. 带 ?q= 打开 → 输入区显示种子文本
 *   2. 自动发送窗口过后 URL 不再含 q 参数（已消费）
 *   3. 手动清空输入 → 文本不再恢复
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const APP_PORT = 4174;
const SEED = "你当前是在哪个目录？";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

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

test.setTimeout(60_000);
test.skip(!process.env.E2E, "web-app UI 回归在 E2E 门后执行（bun run test:ci）");

test("composer 种子：显示 → 消费 URL → 清空不再恢复", async ({ page }) => {
	const preview = spawn(
		"bun",
		["x", "vite", "preview", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"],
		{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
	);
	try {
		await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, 30_000);
		// 路由是 hash 模式（createHashRouter）——workspace 页在 /#/workspace
		await page.goto(`http://127.0.0.1:${APP_PORT}/#/workspace?q=${encodeURIComponent(SEED)}`, {
			waitUntil: "domcontentloaded",
		});

		const composer = page.getByPlaceholder(/发消息，或直接提问/);
		await composer.waitFor({ state: "visible", timeout: 15_000 });

		// 1. 种子文本进入输入区（挂载后一次写入草稿 store）
		await expect(composer).toHaveValue(SEED);

		// 2. 自动发送窗口（400ms）过后，q 参数必须从 URL 消费（replace，hash 模式下在 hash 内）
		//    （serve 未启动时 prompt 会以 commandError 落条纹横幅，不影响本断言）
		await page.waitForFunction(() => !location.hash.includes("q="), undefined, {
			timeout: 10_000,
		});

		// 3. 手动清空 → 文本不得恢复（修复前清空立即回填种子）
		await composer.fill("");
		await expect(composer).toHaveValue("");
		await page.waitForTimeout(1_500);
		expect(await composer.inputValue()).toBe("");
	} finally {
		kill(preview);
	}
});
