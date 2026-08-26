/**
 * OMP.app 静态 web-app server —— serve packages/web-app/dist 产物，SPA fallback。
 *
 * 编译为独立二进制（bun build --compile），运行时零依赖。
 * 用法: serve-webapp <distDir> [port]
 */
const DIST = Bun.argv[2] ?? "./dist";
const PORT = Number.parseInt(Bun.argv[3] ?? "5180", 10);

const server = Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		let pathname = decodeURIComponent(url.pathname);
		if (pathname === "/") pathname = "/index.html";

		const file = Bun.file(`${DIST}${pathname}`);
		if (await file.exists()) {
			return new Response(file);
		}
		// SPA fallback: 未知路径回退 index.html（前端路由由 React Router 处理）
		const index = Bun.file(`${DIST}/index.html`);
		if (await index.exists()) {
			return new Response(index);
		}
		return new Response("not found", { status: 404 });
	},
});

console.log(`[serve-webapp] listening on http://127.0.0.1:${PORT} (${DIST})`);
// Bun.serve keeps the event loop alive; exit only on signal.
process.on("SIGTERM", () => server.stop());
process.on("SIGINT", () => server.stop());