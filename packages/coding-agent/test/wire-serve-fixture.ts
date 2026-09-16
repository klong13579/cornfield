/**
 * 起一个真 `serve` 子进程的共享夹具。
 *
 * 14 个 `wire-server-*.integration.test.ts` 原本各自抄一份 spawn 块（隔离 HOME、端口、
 * flags、等待），于是同一套策略散落成多份、每一份都可能与别处不一致：
 *
 * - **端口**：新写的文件用 `net.createServer().listen(0)` 探测，老写的用
 *   `NNNNN + Math.floor(Math.random() * N)`——后者会落在 macOS 的 ephemeral 段
 *   (49152–65535)，撞上机器上任何进程（含并发测试自己的 serve 子进程）时 `Bun.serve`
 *   绑定失败、serve 以 code=1 退出（2026-09-16 用占住端口的方法受控复现过）。
 * - **预算**：`waitForServe` 的等待与 `beforeAll` 预算必须前者小于后者，散落成多份时
 *   出现了 60–70s 预算包着 60s 等待的反向配置——失败时 bun 先掐断，丢掉真实原因。
 * - **隔离**：HOME 不隔离时子进程会加载运行者的真实配置与会话（已经因此踩过两次：
 *   permission 的 cwd 错位、git 的 `not a git repository`）。
 *
 * 这里把它们收敛成一处。**静默停摆**（子进程活着、零输出、不监听）已定位到 bun 运行时层
 * ——连 `serve:boot:start` 都没打出来，产品侧无从修——所以按仓库自己的先例
 * （`live-controller` 的 `makeHarness` 对握手 infra flake 重试一次）重试一次；
 * 重试**留痕**，不静默吞掉一次真实失败。
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@cornfield/utils";
import { ServeReadyTimeoutError, waitForServe } from "./wait-for-serve";

const CLI_PATH = new URL("../src/cli.ts", import.meta.url).pathname;

export { SERVE_BOOT_BUDGET_MS, SERVE_READY_TIMEOUT_MS } from "./wait-for-serve";

/** 探测一个当时空闲的端口（比随机数安全：随机可能命中已被占用的端口）。 */
export async function pickPort(): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const srv = net.createServer();
	srv.listen(0, "127.0.0.1", () => {
		const port = (srv.address() as net.AddressInfo).port;
		srv.close(() => resolve(port));
	});
	return await promise;
}

export interface ServeFixture {
	proc: ReturnType<typeof Bun.spawn>;
	/** 就绪的 WS URL（无 token 形态；测试均以 --token 缺省启动）。 */
	url: string;
	/** 恒为 ""（waitForServe 的返回结构）。 */
	token: string;
	/** 隔离 HOME 的路径（预置 fixtures 用）。 */
	home: string;
	/** 端口（诊断用）。 */
	port: number;
	/** 杀掉子进程并清理临时 HOME；afterAll 里调用。 */
	dispose(): Promise<void>;
}

export interface SpawnServeOptions {
	/** 隔离 HOME 的 mkdtemp 前缀（默认 omp-serve-）。 */
	homePrefix?: string;
	/** 子进程 cwd（默认不指定，继承测试进程；git 系用例传自己的仓库）。 */
	cwd?: string;
	/** 额外的 serve 参数，追加在 --port/--host/--no-extensions 之后。 */
	extraArgs?: string[];
	/** 额外环境变量（HOME / PI_NO_TITLE 由夹具负责）；传函数时入参是夹具创建的隔离 HOME（用 CORNFIELD_CONFIG_DIR 之类的用例需要）。 */
	env?: Record<string, string> | ((home: string) => Record<string, string>);
	/** 静默停摆时是否重试一次（默认 true）。 */
	retryOnSilentStall?: boolean;
}

/**
 * 起一个 serve，等它就绪。
 *
 * 失败时按 `ServeReadyTimeoutError` 的字段判断是不是「静默停摆」：是则换一个端口重来一次
 * （并留一行 warn），不是则原样抛出——把「慢」和「真没起来」分开，不把真实回归伪装成 flake。
 */
export async function spawnServeFixture(options: SpawnServeOptions = {}): Promise<ServeFixture> {
	const attempts = options.retryOnSilentStall === false ? 1 : 2;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), options.homePrefix ?? "omp-serve-"));
		const port = await pickPort();
		const proc = Bun.spawn(
			[
				"bun",
				CLI_PATH,
				"serve",
				"--port",
				String(port),
				"--host",
				"127.0.0.1",
				"--no-extensions",
				...(options.extraArgs ?? []),
			],
			{
				...(options.cwd ? { cwd: options.cwd } : {}),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: home,
					PI_NO_TITLE: "1",
					...(typeof options.env === "function" ? options.env(home) : (options.env ?? {})),
				},
			},
		);
		try {
			const handle = await waitForServe(proc, port);
			return {
				proc,
				url: handle.url,
				token: handle.token,
				home,
				port,
				dispose: async () => {
					proc.kill();
					await proc.exited;
					await fs.rm(home, { recursive: true, force: true });
				},
			};
		} catch (err) {
			proc.kill();
			await proc.exited;
			await fs.rm(home, { recursive: true, force: true });
			lastError = err;
			const silent = err instanceof ServeReadyTimeoutError && err.isSilentStall();
			if (silent && attempt < attempts) {
				// 留痕：重试会掩盖一次真实失败，所以即使重试成功也要能在输出里看见这件事。
				logger.warn("spawnServeFixture: serve 静默停摆，重试一次", { attempt, port });
				continue;
			}
			throw err;
		}
	}
	throw lastError;
}
