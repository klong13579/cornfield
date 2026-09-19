/**
 * UI 回归：输入框粘贴图片 → 显示缩略图 → 可单张移除。
 *
 * 单测（`src/pages/workspace/ComposerBar.attachment-thumb.render.test.ts`）只把组件喂了 props 静态渲染，
 * 盖不到真正的链路：`onPaste` 取 `clipboardData.files` → `FileReader.readAsDataURL` → state →
 * 输入区出现小图。这条链路只有真浏览器能证，所以在这里用合成的 paste 事件走一遍。
 *
 * **不需要 serve / LLM 鉴权**：连接被指到一个死端口（不注入时页面会去连真实桌面 sidecar），
 * 本用例只断言前端状态，不发送、不落库。与其它 e2e 共用 E2E 门（`bun run test:ci` 前置已完成
 * build，本文件起 vite preview 吃 dist）：
 *   1. 粘一张图 → 输入区出现 1 张缩略图（src 是内联 data URL）+ 1 个「移除附件 1」
 *   2. 再粘一张 → 2 张，序号 1 / 2，且两张不是同一张图
 *   3. 移除第 1 张 → 只剩第 2 张（删对了那一张，不是随手删尾）
 *
 * 图在浏览器里现画（两张不同颜色），不写死 base64：这样断言的 src 是「这一张」的事实，
 * 而不是我抄进来的一串常量。
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const APP_PORT = 4175;
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

/** 画一张纯色 PNG 并返回裸 base64（与浏览器真实粘贴的字节形态一致）。 */
async function drawPng(page: Page, color: string): Promise<string> {
	return await page.evaluate(async fill => {
		const canvas = document.createElement("canvas");
		canvas.width = 8;
		canvas.height = 8;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		ctx.fillStyle = fill;
		ctx.fillRect(0, 0, 8, 8);
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
		if (!blob) throw new Error("toBlob returned null");
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	}, color);
}

/** 往输入区派发一次含图片文件的合成 paste（浏览器默认粘贴只处理文本，图片必须自己接）。 */
async function pasteImage(page: Page, base64: string): Promise<void> {
	await page.evaluate(b64 => {
		const binary = atob(b64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		const file = new File([bytes], "paste.png", { type: "image/png" });
		const data = new DataTransfer();
		data.items.add(file);
		const textarea = document.querySelector("textarea");
		if (!textarea) throw new Error("no textarea");
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: data, configurable: true });
		textarea.dispatchEvent(event);
	}, base64);
}

test.setTimeout(90_000);
test.skip(!process.env.E2E, "web-app UI 回归在 E2E 门后执行（bun run test:ci）");

test("粘贴图片 → 缩略图 → 单张移除", async ({ page }) => {
	// 阻断默认连接（ws://127.0.0.1:7891 = 真实桌面 sidecar）：本用例不发消息，但页面未连上时
	// 的渲染路径才是这里要断言的那条（输入区在未连接时同样可用）。
	await page.addInitScript(() => {
		localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl: "ws://127.0.0.1:9/ws", token: "" }));
	});

	const preview = spawn(
		"bun",
		["x", "vite", "preview", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"],
		{ cwd: path.join(repoRoot, "packages/web-app"), env: process.env },
	);
	try {
		await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, 30_000);
		await page.goto(`http://127.0.0.1:${APP_PORT}/#/workspace`, { waitUntil: "domcontentloaded" });
		await page.getByPlaceholder(/发消息，或直接提问/).waitFor({ state: "visible", timeout: 15_000 });

		// 缩略图 = 输入区里 alt 以「附件」开头的 <img>
		const thumbs = page.locator('img[alt^="附件"]');
		// 没贴之前一条都不该有（贴了才出现的行，不是常驻空行）
		await expect(thumbs).toHaveCount(0);

		// 1. 粘第一张
		const first = await drawPng(page, "#ff0000");
		await pasteImage(page, first);
		await expect(thumbs).toHaveCount(1, { timeout: 10_000 });
		expect(await thumbs.first().getAttribute("src")).toBe(`data:image/png;base64,${first}`);
		await expect(page.getByTitle("移除附件 1")).toBeVisible();

		// 2. 再粘一张 → 两张，序号 1/2，且是两张不同的图（否则「删对了哪一张」无从判定）
		const second = await drawPng(page, "#0000ff");
		expect(second).not.toBe(first);
		await pasteImage(page, second);
		await expect(thumbs).toHaveCount(2, { timeout: 10_000 });
		expect(await thumbs.nth(1).getAttribute("src")).toBe(`data:image/png;base64,${second}`);
		await expect(page.getByTitle("移除附件 2")).toBeVisible();

		// 3. 删第 1 张 → 剩下的必须是第 2 张
		await page.getByTitle("移除附件 1").click();
		await expect(thumbs).toHaveCount(1, { timeout: 10_000 });
		expect(await thumbs.first().getAttribute("src")).toBe(`data:image/png;base64,${second}`);
		await expect(page.getByTitle("移除附件 2")).toHaveCount(0);

		// 「小图」是尺寸断言，不是「有个 img 就算」：48×48 的框，移除按钮压在右上角（看得见、点得到）。
		const thumbBox = await thumbs.first().boundingBox();
		expect(thumbBox).not.toBeNull();
		expect(Math.round(thumbBox!.width)).toBe(48);
		expect(Math.round(thumbBox!.height)).toBe(48);
		const removeBox = await page.getByTitle("移除附件 1").boundingBox();
		expect(removeBox).not.toBeNull();
		// 压在右上角（±12px 内）——按钮不盖在图上就说明布局跑掉了
		const removeCenter = { x: removeBox!.x + removeBox!.width / 2, y: removeBox!.y + removeBox!.height / 2 };
		expect(Math.abs(removeCenter.x - (thumbBox!.x + thumbBox!.width))).toBeLessThan(12);
		expect(Math.abs(removeCenter.y - thumbBox!.y)).toBeLessThan(12);

		// 留一张图给人工看（test-results/ 已 gitignore）
		await page.screenshot({ path: "test-results/paste-thumbnail.png" });
	} finally {
		kill(preview);
	}
});
