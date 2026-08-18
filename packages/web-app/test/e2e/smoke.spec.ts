import { expect, test } from "@playwright/test";

/**
 * F2 冒烟（骨架版）：静态前端可用性。
 * - vite build + vite preview 静态伺服（不接真实 serve，无 WS 数据流）
 * - 断言 Home 渲染（问候语 h1）
 * - 断言 rail panel 切换（Home → Agents 标题变化）
 *
 * 真实 serve 起服 + prompt 流式断言由主线在骨架基础上延伸。
 */

test("Home 渲染 + rail panel 切换", async ({ page }) => {
	// Home：问候语 h1 渲染（未连接状态也渲染问候语）
	await page.goto("/");
	await expect(page.locator("h1").first()).toBeVisible();

	// panel 切换：点 Agents rail → 路由到 /agents，标题变 Agent
	await page.click('a[aria-label="Agent 管理"]');
	await expect(page).toHaveURL(/\/agents$/);
	await expect(page.locator("h1").first()).toHaveText("Agent");
});
