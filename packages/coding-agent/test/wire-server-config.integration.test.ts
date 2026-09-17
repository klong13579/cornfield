import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PiClient } from "@cornfield/client";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

/**
 * 票 03 e2e — serve 配置命令（get_config / set_config）。
 * 隔离 HOME：config.yml 落在 <fixture.home>/.cornfield/agent/config.yml，不污染真实配置。
 * 验证：set→get 往返一致、嵌套 key 往返、与 set_model_disabled 同文件共存不冲突。
 *
 * 隔离 HOME / 端口 / 预算 / 停摆重试都在 `spawnServeFixture` 里（见该文件的说明）。
 * serve 的 cwd 取 <fixture.home>/project（空目录）：三条用例只读写全局 agent 配置，
 * 落仓库里会让 serve 的启动上下文带上仓库自己的项目级 .cornfield。
 */
let fixture: ServeFixture | undefined;

/** serve 的 cwd：隔离 HOME 下的空项目目录（与迁移前的 <isolatedHome>/project 同义）。 */
const projectDir = (home: string): string => path.join(home, "project");

beforeAll(async () => {
	fixture = await spawnServeFixture({
		homePrefix: "omp-serve-config-",
		cwd: projectDir,
		seed: async home => {
			await fs.mkdir(projectDir(home), { recursive: true });
		},
	});
}, SERVE_BOOT_BUDGET_MS);

afterAll(async () => {
	await fixture?.dispose();
});

describe("配置命令（get_config / set_config）", () => {
	test("set_config → get_config 往返一致（标量）", async () => {
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
		const client = new PiClient({ url: fixture!.url, token: fixture!.token, autoReconnect: false });
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
