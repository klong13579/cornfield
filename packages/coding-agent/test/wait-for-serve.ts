/**
 * 共享 serve 就绪等待：轮询 /health，替代 stdout 扫 URL。
 *
 * 为什么不用 stdout：子进程 stdout 接管道时 Bun 完全缓冲 console 输出
 * （winston Console transport 的行在进程退出前不刷出），父进程 30s 内
 * 等不到 `serve:listening` 行——serve 本身早已监听。/health 端点
 * （wire-server.ts fetch handler）是就绪的权威信号，与缓冲无关。
 *
 * 输出捕获：从启动起就把 stdout/stderr 排进一个有界缓冲（最近 200 行），失败时随错误带出。
 * 两个理由：
 *   1. 失败必须能说出子进程最后说了什么。超时路径原先什么都不带——2026-09-16 排查
 *      `serve not ready on port … after 150000ms` 时，子进程输出全被丢掉，只能靠猜。
 *   2. 不排空的管道写满（64KB）会阻塞子进程。serve 正常只写几行，但这个口子不该留着。
 *
 * 崩溃诊断保留：轮询间隙检测子进程退出，退出时把捕获到的输出带进报错
 * （stderr 在进程退出时会 flush，能拿到真实死因）。
 */

/** 捕获缓冲保留的行数：够覆盖启动日志 + 崩溃栈，又不会把内存拖到无界。 */
const CAPTURE_LINES = 200;

export type ServeProc = ReturnType<typeof Bun.spawn>;

/**
 * 排空子进程的 stdout/stderr，返回读取当前捕获内容的函数 + 排空结束的信号。
 * 调用方在超时/退出路径上用它报出真实原因。
 */
function captureServeOutput(proc: ServeProc): { read: () => string; settled: Promise<void> } {
	const lines: string[] = [];
	const pump = async (stream: unknown): Promise<void> => {
		if (!stream || typeof (stream as ReadableStream<Uint8Array>)[Symbol.asyncIterator] !== "function") return;
		const decoder = new TextDecoder();
		try {
			for await (const chunk of stream as ReadableStream<Uint8Array>) {
				for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
					if (!line.trim()) continue;
					lines.push(line);
					if (lines.length > CAPTURE_LINES) lines.splice(0, lines.length - CAPTURE_LINES);
				}
			}
		} catch {
			/* 流已关闭 */
		}
	};
	const settled = Promise.allSettled([pump(proc.stdout), pump(proc.stderr)]).then(() => undefined);
	return { read: () => lines.join("\n"), settled };
}

export interface ServeHandle {
	/** 就绪的 WS URL（无 token 形态；测试均以 --token 缺省启动） */
	url: string;
	/** 恒为 ""（与旧 waitForServe 返回结构兼容，listen 系测试仍读此字段） */
	token: string;
}

export async function waitForServe(proc: ServeProc, port: number, timeoutMs = 60_000): Promise<ServeHandle> {
	const capture = captureServeOutput(proc);
	const tail = (): string => capture.read().slice(-2000) || "(子进程没有输出)";
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			// 退出时管道里可能还有没被读走的行：给排空一点时间再取，否则会把真实死因报成
			// 「没有输出」（2026-09-16 实测：exit code=1 却带不出任何原因）。
			await Promise.race([capture.settled, Bun.sleep(300)]);
			throw new Error(`serve exited code=${proc.exitCode}; output:\n${tail()}`);
		}
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
			if (res.ok) return { url: `ws://127.0.0.1:${port}/ws`, token: "" };
		} catch {
			/* 端口尚未监听 */
		}
		await Bun.sleep(200);
	}
	throw new Error(
		`serve not ready on port ${port} after ${timeoutMs}ms; child alive=${proc.exitCode === null}; last output:\n${tail()}`,
	);
}
