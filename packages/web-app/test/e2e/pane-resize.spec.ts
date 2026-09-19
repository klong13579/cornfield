/**
 * 分栏拖拽 e2e（真实 Chrome 的指针事件）。
 *
 * 为什么非得有这一层：拖拽的**接线**（指针 → 分隔条 → CSS 变量 → 落盘）在仓库的渲染测试里
 * 碰不到 —— `renderToStaticMarkup` 只能直渲 SSR，没有指针事件。计算在 `pane-resize.test.ts`、
 * 结构在 `pane-divider.render.test.ts`，中间这段「真的会动、刷新后还在」只能在这儿验。
 *
 * 编排（同 models-control-center-e2e.spec 的起法，但不启 serve）：
 *   1. dist 由前置步骤构建（`bun --cwd=packages/web-app run build`），vite preview 起 4173
 *   2. 浏览器注入一条指向**没人监听的端口**的连接配置 —— 分栏几何是纯前端的事，会话连不上不影响
 *      它（页面显示未连接，分隔条照在），而真实端口会连上本机运营中的 serve
 * 每个用例一个新 context（localStorage 干净），所以偏好不会在用例之间串。
 *
 * 断言一律走 `expectDividerNear`（poll 到落定）：键盘一步与双击复位走的是**带过渡**的那条路
 * （`transition-[transform,width]`，会话栏折叠动画用的同一条），读一次 boundingBox 只会读到
 * 动画的第一帧。拖拽本身没有过渡（拖拽期间 `body.pane-resizing` 关掉了它），所以拖拽后的值
 * 也是立刻落定的 —— 一样用 poll 写，省得两套口径。
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const APP_PORT = 4173;
const DEAD_WS_URL = "ws://127.0.0.1:47831/ws";

/** 与 `src/lib/pane-resize.ts` 的 PANE_SPECS 对齐的默认值（改 spec 时这里也要动）。 */
const SESSION_DEFAULT_PX = 300;
const APP_SIDEBAR_DEFAULT_PX = 240;
/** 转录列下限：`CONTENT_MIN_PX`，拖任何一栏都不该把它压到这条线以下。 */
const CONTENT_MIN_PX = 320;

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

let preview: ChildProcess | null = null;

test.setTimeout(120_000);

test.beforeAll(async () => {
	preview = spawn("bun", ["x", "vite", "preview", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"], {
		cwd: path.join(repoRoot, "packages/web-app"),
		env: process.env,
	});
	await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, 30_000);
});

test.afterAll(() => {
	try {
		preview?.kill("SIGTERM");
	} catch {
		// 已退出
	}
});

/** 分隔条按 aria-label 定位：它既是读屏听到的那句话，也是屏幕上唯一的那条线。 */
function dividerOf(page: Page, label: string) {
	return page.locator(`[role="separator"][aria-label="${label}"]`);
}

/** 分隔条的横坐标（px）—— 它左边那一栏的宽度就写在它的位置上。 */
async function dividerX(page: Page, label: string): Promise<number> {
	const box = await dividerOf(page, label).boundingBox();
	if (!box) throw new Error(`分隔条不可见：${label}`);
	return box.x;
}

/** 等分隔条落定到某个横坐标（容差内）。宽度变化可能带过渡，所以 poll 而不是读一次。 */
async function expectDividerAt(page: Page, label: string, expected: number, tolerancePx = 1): Promise<void> {
	await expect
		.poll(async () => Math.round(Math.abs((await dividerX(page, label)) - expected)), { timeout: 5_000 })
		.toBeLessThanOrEqual(tolerancePx);
}

async function openWorkspace(page: Page): Promise<void> {
	await page.addInitScript((wsUrl: string) => {
		localStorage.setItem("cornfield.serve.connection", JSON.stringify({ wsUrl, token: "" }));
	}, DEAD_WS_URL);
	await page.goto("/#/workspace", { waitUntil: "domcontentloaded" });
	await expect(dividerOf(page, "调整会话栏宽度")).toBeVisible();
}

/** 沿 x 拖分隔条：按下 → 分步移动（一次跳到终点看不出「跟手」）→ 抬起。 */
async function dragDividerBy(page: Page, label: string, deltaX: number): Promise<void> {
	const box = await dividerOf(page, label).boundingBox();
	if (!box) throw new Error(`分隔条不可见：${label}`);
	const startX = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(startX, y);
	await page.mouse.down();
	await page.mouse.move(startX + deltaX, y, { steps: 10 });
	await page.mouse.up();
}

test("拖会话栏：宽度跟着指针走，刷新后还在", async ({ page }) => {
	await openWorkspace(page);
	const before = await dividerX(page, "调整会话栏宽度");

	await dragDividerBy(page, "调整会话栏宽度", 120);
	await expectDividerAt(page, "调整会话栏宽度", before + 120, 2);

	// 刷新：偏好落在 localStorage，重启页面不该丢（这是「拖了白拖」与「拖了算数」的分界）
	const settled = await dividerX(page, "调整会话栏宽度");
	await page.reload();
	await expect(dividerOf(page, "调整会话栏宽度")).toBeVisible();
	await expectDividerAt(page, "调整会话栏宽度", settled);
});

test("键盘：←→ 一步 16px，Shift 一步 64px", async ({ page }) => {
	await openWorkspace(page);
	const base = await dividerX(page, "调整会话栏宽度");

	// 用 locator.press（自己聚焦再按键，原子）：先 focus 再 keyboard.press 会被 composer 的
	// 自动聚焦抢走焦点 —— 那一下按键就落到了别处（实测）
	await dividerOf(page, "调整会话栏宽度").press("ArrowRight");
	await expectDividerAt(page, "调整会话栏宽度", base + 16);

	// Shift 一步 64：+16 之后退 64，落在 base-48（不是回到 base —— 两种步长各自生效过一次）
	await dividerOf(page, "调整会话栏宽度").press("Shift+ArrowLeft");
	await expectDividerAt(page, "调整会话栏宽度", base + 16 - 64);
});

test("双击分隔条：回到默认宽度", async ({ page }) => {
	await openWorkspace(page);
	await dragDividerBy(page, "调整会话栏宽度", 90);
	await expectDividerAt(page, "调整会话栏宽度", APP_SIDEBAR_DEFAULT_PX + SESSION_DEFAULT_PX + 90, 2);

	// 双击回的是 spec 的默认宽度，不是「回到双击前的值」：拖到 390 再双击，要回 300。
	await dividerOf(page, "调整会话栏宽度").dblclick();
	await expectDividerAt(page, "调整会话栏宽度", APP_SIDEBAR_DEFAULT_PX + SESSION_DEFAULT_PX);
});

test("拖到极限：转录列不会被压没", async ({ page }) => {
	await openWorkspace(page);
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("拿不到视口尺寸");

	// 拖一个远远超出可用空间的量：分隔条必须停在「转录列 = 下限」那条线上，而不是一路跟到底
	await dragDividerBy(page, "调整会话栏宽度", 3000);

	await expect
		.poll(async () => Math.round(viewport.width - (await dividerX(page, "调整会话栏宽度")) - 1))
		.toBeGreaterThanOrEqual(CONTENT_MIN_PX - 1);
	// 而且确实停住了（不是没生效）：它得比默认宽
	expect(await dividerX(page, "调整会话栏宽度")).toBeGreaterThan(APP_SIDEBAR_DEFAULT_PX + SESSION_DEFAULT_PX);
});

test("右栏：展开后可拖，反向拖变宽，拖到极限转录列同样有下限", async ({ page }) => {
	await openWorkspace(page);
	await page.getByRole("button", { name: "展开右栏" }).click();
	await expect(dividerOf(page, "调整右栏宽度")).toBeVisible();

	const before = await dividerX(page, "调整右栏宽度");
	// 分隔条在右栏左侧：向左拖 = 右栏变宽
	await dragDividerBy(page, "调整右栏宽度", -120);
	await expectDividerAt(page, "调整右栏宽度", before - 120, 2);

	await dragDividerBy(page, "调整右栏宽度", -3000);
	await expect
		.poll(async () =>
			Math.round((await dividerX(page, "调整右栏宽度")) - (await dividerX(page, "调整会话栏宽度")) - 1),
		)
		.toBeGreaterThanOrEqual(CONTENT_MIN_PX - 1);
});

test("主导航：可拖，且整块工作台跟着让位", async ({ page }) => {
	await openWorkspace(page);
	const navBefore = await dividerX(page, "调整主导航宽度");
	const sessionBefore = await dividerX(page, "调整会话栏宽度");

	await dragDividerBy(page, "调整主导航宽度", 60);

	await expectDividerAt(page, "调整主导航宽度", navBefore + 60, 2);
	// 导航栏变宽 = 右边的所有东西整体右移，会话栏自己没变宽
	await expectDividerAt(page, "调整会话栏宽度", sessionBefore + 60, 2);

	await page.reload();
	await expect(dividerOf(page, "调整主导航宽度")).toBeVisible();
	await expectDividerAt(page, "调整主导航宽度", navBefore + 60);
});
