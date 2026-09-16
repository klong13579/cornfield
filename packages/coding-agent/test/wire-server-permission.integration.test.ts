import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PiClient } from "@cornfield/client";
import type { WireServerEvent } from "@cornfield/wire";
import { waitForServe } from "./wait-for-serve";

/**
 * 审批 shell e2e — 真 serve 子进程 + pi-client（P2-W1-4 的 inject 触发路径）。
 * 不触发 LLM：inject_permission 是 mock 审批源（测试通道），只验
 *   inject → permission_request push（广播）→ permission_respond → inject response 回 choice。
 */

let proc: ReturnType<typeof Bun.spawn> | undefined;
let isolatedHome: string;
let savedHome: string | undefined;
const serveInfo: { url: string; token: string } = { url: "", token: "" };

function nextPermissionRequest(client: PiClient): Promise<Extract<WireServerEvent, { type: "permission_request" }>> {
	const { promise, resolve } = Promise.withResolvers<Extract<WireServerEvent, { type: "permission_request" }>>();
	const unsub = client.subscribe(ev => {
		if (ev.type === "push" && ev.event.type === "permission_request") {
			unsub();
			resolve(ev.event);
		}
	});
	return promise;
}

beforeAll(async () => {
	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const cliPath = `${repoRoot}/packages/coding-agent/src/cli.ts`;
	// 隔离 HOME：否则子进程会加载运行者机器上已配置的 MCP servers / agents / LSP，
	// 启动耗时随机器状态浮动（本机实测 10–24s，其中大半是这些无关加载）。
	// 2026-09-16 的 CI 就在这一步报 `serve not ready on port … after 60000ms`。
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-permission-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	const port = 57000 + Math.floor(Math.random() * 10_000);
	proc = Bun.spawn(["bun", cliPath, "serve", "--port", String(port), "--host", "127.0.0.1", "--no-extensions"], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
	});
	// 预算参照实测而非默认值：本文件空载启动 serve 约 9s，但子进程要跑完整个 CLI 启动
	// （原生 addon + MCP/LSP/agent attach），负载下会远远超过 waitForServe 的 60s 默认
	// ——2026-09-16 的 CI 就在这一步报 `serve not ready on port … after 60000ms`。
	// 等待放到 150s，且 beforeAll 预算高于它，失败才会以本行的文案报出（而不是被 bun
	// 的 beforeAll 预算先掉断、丢掉原因）。等待预算只是容错，断言未改动。
	const info = await waitForServe(proc, port, 150_000);
	serveInfo.url = info.url;
	serveInfo.token = info.token;
}, 180_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});

describe("审批 shell e2e（真 serve + pi-client，inject 触发）", () => {
	test("inject_permission → permission_request push → respond once → 回 choice", async () => {
		const client = new PiClient({ url: serveInfo.url, token: serveInfo.token, autoReconnect: false });
		await client.connect();

		try {
			const pendingPush = nextPermissionRequest(client);
			const injectPromise = client.request<{ requestId: string; choice: string }>({
				type: "inject_permission",
				kind: "approval",
			});

			const push = await pendingPush;
			expect(push.type).toBe("permission_request");
			if (push.kind !== "approval") throw new Error("expected approval push");
			expect(push.requestId).toBeTruthy();
			expect(push.command).toBeTruthy();

			await client.request({ type: "permission_respond", requestId: push.requestId, choice: "once" });

			const result = await injectPromise;
			expect(result.requestId).toBe(push.requestId);
			expect(result.choice).toBe("once");
		} finally {
			client.close();
		}
	});
});
