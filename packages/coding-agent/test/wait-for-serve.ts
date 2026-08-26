/**
 * 共享 serve 就绪等待：轮询 /health，替代 stdout 扫 URL。
 *
 * 为什么不用 stdout：子进程 stdout 接管道时 Bun 完全缓冲 console 输出
 * （winston Console transport 的行在进程退出前不刷出），父进程 30s 内
 * 等不到 `serve:listening` 行——serve 本身早已监听。/health 端点
 * （wire-server.ts fetch handler）是就绪的权威信号，与缓冲无关。
 *
 * 崩溃诊断保留：轮询间隙检测子进程退出，退出时把 stderr 全量带进报错
 * （stderr 在进程退出时会 flush，能拿到真实死因）。
 */

export interface ServeHandle {
	/** 就绪的 WS URL（无 token 形态；测试均以 --token 缺省启动） */
	url: string;
	/** 恒为 ""（与旧 waitForServe 返回结构兼容，listen 系测试仍读此字段） */
	token: string;
}

export async function waitForServe(
	proc: ReturnType<typeof Bun.spawn>,
	port: number,
	timeoutMs = 30_000,
): Promise<ServeHandle> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			let stderrText = "";
			try {
				stderrText = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
			} catch {
				/* stderr 已关闭 */
			}
			throw new Error(`serve exited code=${proc.exitCode}; stderr:\n${stderrText.slice(-2000)}`);
		}
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
			if (res.ok) return { url: `ws://127.0.0.1:${port}/ws`, token: "" };
		} catch {
			/* 端口尚未监听 */
		}
		await Bun.sleep(200);
	}
	throw new Error(`serve not ready on port ${port} after ${timeoutMs}ms`);
}
