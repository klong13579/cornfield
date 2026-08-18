import { defineConfig } from "@playwright/test";

/**
 * web-app E2E 冒烟（F2 骨架）。
 * 不接真实 serve——先 vite build + python http.server 静态伺服 dist，
 * 断言 Home 渲染 + rail panel 切换（纯前端路由，无 WS 数据流）。
 * 真实 serve 起服的 prompt 流式断言之类由此骨架延伸（归主线）。
 */
export default defineConfig({
	testDir: "./test/e2e",
	timeout: 30_000,
	use: {
		baseURL: "http://127.0.0.1:4173",
	},
	webServer: {
		command: "bun run build && python3 -m http.server 4173 --directory dist --bind 127.0.0.1",
		url: "http://127.0.0.1:4173",
		reuseExistingServer: true,
		timeout: 60_000,
	},
});
