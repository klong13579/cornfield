import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 共享 serve 测试夹具：**起一个 serve 子进程（隔离 HOME）并等它就绪**。
 *
 * 就绪为什么用 /health 而不是 stdout：子进程 stdout 接管道时 Bun 完全缓冲 console 输出
 * （winston Console transport 的行在进程退出前不刷出），父进程 30s 内等不到 `serve:listening`
 * 行——serve 本身早已监听。/health 端点（wire-server.ts fetch handler）是就绪的权威信号，
 * 与缓冲无关。崩溃诊断保留：轮询间隙检测子进程退出，退出时把 stderr 全量带进报错
 * （stderr 在进程退出时会 flush，能拿到真实死因）。
 *
 * 为什么 `startIsolatedServe` 要给子进程一个**空的临时 HOME**：serve 的内建 default meta
 * 兜底是 `agentDir = process.cwd()`，但启动时 `loadMetasSafe()` 会读
 * `<HOME>/.cornfield/agent/registry.json` 并在其后 registerMeta ⇒ 覆盖内建兜底。
 * 开发机的真 HOME 里存在 `default`（→ 自己的 ~/.cornfield/agents/default）时，工作根就被换成那个目录，
 * 一切以「cwd 就是工作根」为前提的用例都会假红（wire-server-git 曾 6 fail：
 * `fatal: not a git repository`）。空 HOME 让注册表从零开始、default 落回内建兜底。
 *
 * 隔离只做在**子进程的 env** 上，不改进程自己的 `process.env` —— 没有跨测试的全局状态要恢复。
 * `CORNFIELD_CONFIG_DIR` / `CORNFIELD_AGENT_DIR` 一并剔除：它们优先于 HOME，
 * 开发者 shell 里带着它们时同样会把工作根指到别处。
 *
 * 需要额外参数/环境变量的用例（如 `--session-dir`、`CORNFIELD_GATEWAY_WIRE_PORT`）用
 * `args` / `env` 两个口子传，不必自己再 spawn 一份不带隔离的 serve。
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
	timeoutMs = 60_000,
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

/** 隔离 HOME 的 serve 子进程：`proc` 与 `homeDir` 由夹具持有，`stop()` 一并收掉。 */
export interface IsolatedServeHandle extends ServeHandle {
	proc: ReturnType<typeof Bun.spawn>;
	/** 这次 serve 的 HOME（临时目录）。 */
	homeDir: string;
	/** 停子进程 + 删掉隔离 HOME。 */
	stop(): Promise<void>;
}

export interface StartIsolatedServeOptions {
	/** 子进程 cwd —— 也是内建 default meta 的工作根。 */
	cwd: string;
	/** 追加到 serve 后面的参数（如 `--session-dir <dir>`）。 */
	args?: readonly string[];
	/**
	 * 额外环境变量（如 `CORNFIELD_GATEWAY_WIRE_PORT`）。
	 * **不能覆盖 HOME / PI_NO_TITLE，也不能把 CORNFIELD_CONFIG_DIR / CORNFIELD_AGENT_DIR 塞回来**
	 * —— 那几条是夹具的隔离契约，在展开之后再强制生效。
	 */
	env?: Readonly<Record<string, string>>;
}

const CLI = `${new URL("../../..", import.meta.url).pathname.replace(/\/$/, "")}/packages/coding-agent/src/cli.ts`;

/** 拿一个当下没人在监听的端口（绑定 0 问 OS 要，拿到即释放）。 */
export async function pickFreePort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
	});
}

/** 起 serve（隔离 HOME）并等到 /health 就绪；`stop()` 收进程与临时 HOME。 */
export async function startIsolatedServe(opts: StartIsolatedServeOptions): Promise<IsolatedServeHandle> {
	const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-home-"));
	const port = await pickFreePort();
	const env: Record<string, string | undefined> = {
		...process.env,
		...opts.env,
		HOME: homeDir,
		PI_NO_TITLE: "1",
	};
	delete env.CORNFIELD_CONFIG_DIR;
	delete env.CORNFIELD_AGENT_DIR;

	const proc = Bun.spawn(
		[
			process.execPath,
			CLI,
			"serve",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
			"--no-extensions",
			...(opts.args ?? []),
		],
		{ cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env },
	);

	let info: ServeHandle;
	try {
		info = await waitForServe(proc, port);
	} catch (err) {
		// 起不来时夹具自己收尾：不留孤儿进程，也不把临时 HOME 落在 /tmp
		proc.kill();
		await proc.exited;
		await fs.rm(homeDir, { recursive: true, force: true });
		throw err;
	}

	return {
		...info,
		proc,
		homeDir,
		async stop(): Promise<void> {
			proc.kill();
			await proc.exited;
			await fs.rm(homeDir, { recursive: true, force: true });
		},
	};
}
