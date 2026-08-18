import { defineConfig } from "@playwright/test";

/**
 * F2 冒烟（W3 收尾）—— web-app Playwright 配置。
 *
 * - 浏览器：系统 Google Chrome（channel: "chrome"，不下载 Playwright 自带 chromium）
 * - 服务编排在 spec 内自管：真实 serve（bun src/cli.ts，源码新鲜构建）+ vite preview
 * - 语义：真实连接 → 真实 prompt → 流式断言。需要真实 LLM 鉴权（E2E=1 显式开启；CI 缺 key 时 skip）
 */
export default defineConfig({
	testDir: "./test/e2e",
	timeout: 180_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [["list"]],
	outputDir: "test-results/artifacts",
	use: {
		baseURL: "http://127.0.0.1:4173",
		channel: "chrome",
		headless: true,
		viewport: { width: 1440, height: 900 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
});
