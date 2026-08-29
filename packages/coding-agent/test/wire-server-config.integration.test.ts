import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@cornfield/client";
import { waitForServe } from "./wait-for-serve";

/**
 * 票 03 e2e — serve 配置命令（get_config / set_config）。
 * 隔离 HOME：config.yml 落在 isolatedHome/.omp/agent/config.yml，不污染真实配置。
 * 验证：set→get 往返一致、嵌套 key 往返、与 set_model_disabled 同文件共存不冲突。
 */
let isolatedHome: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let info = { url: "", token: "" };

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-config-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	const projectCwd = path.join(isolatedHome, "project");
	await fs.mkdir(projectCwd, { recursive: true });

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = await new Promise<number>(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(p));
		});
	});
	proc = Bun.spawn(
		[
			"bun",
			`${repoRoot}/packages/coding-agent/src/cli.ts`,
			"serve",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
			"--no-extensions",
		],
		{
			cwd: projectCwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
		},
	);
	info = await waitForServe(proc, port);
}, 70_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

describe("配置命令（get_config / set_config）", () => {
	test("set_config → get_config 往返一致（标量）", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			await client.request({ type: "set_config", key: "custom.scalar", value: 123 });
			const res = await client.request<{ config: unknown }>({ type: "get_config", key: "custom.scalar" });
			expect(res.config).toBe(123);
		} finally {
			client.close();
		}
	});

	test("set_config → get_config 往返一致（嵌套 key）", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			await client.request({ type: "set_config", key: "custom.nested.deep", value: "hello" });
			const res = await client.request<{ config: unknown }>({ type: "get_config", key: "custom.nested.deep" });
			expect(res.config).toBe("hello");
		} finally {
			client.close();
		}
	});

	test("与 set_model_disabled 同文件共存不冲突", async () => {
		const client = new PiClient({ url: info.url, token: info.token, autoReconnect: false });
		await client.connect();
		try {
			// set_config 直接写 config.yml；set_model_disabled 走 Settings（debounced 保存）。
			await client.request({ type: "set_config", key: "custom.coexist", value: "kept" });
			await client.request({
				type: "set_model_disabled",
				provider: "__prov__",
				modelId: "__model__",
				disabled: true,
			});

			// 等 Settings 的 debounced 保存 flush（100ms，取 300ms 余量）。
			await Bun.sleep(300);

			const res = await client.request<{ config: Record<string, unknown> }>({ type: "get_config" });
			expect((res.config.custom as { coexist: unknown }).coexist).toBe("kept");
			expect(res.config.disabledModels).toContain("__prov__/__model__");
		} finally {
			client.close();
		}
	});
});
