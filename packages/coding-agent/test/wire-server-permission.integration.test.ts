import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PiClient } from "@cornfield/client";
import type { WireServerEvent } from "@cornfield/wire";
import { type IsolatedServeHandle, startIsolatedServe } from "./wait-for-serve";

/**
 * 审批 shell e2e — 真 serve 子进程 + pi-client（P2-W1-4 的 inject 触发路径）。
 * 不触发 LLM：inject_permission 是 mock 审批源（测试通道），只验
 *   inject → permission_request push（广播）→ permission_respond → inject response 回 choice。
 *
 * serve 走夹具的隔离 HOME（`startIsolatedServe`）：真 HOME 的 registry.json 里有 `default` 时
 * 工作根会被换掉。cwd 与改动前一致（仍是进程 cwd），改的只有 HOME。
 */

let served: IsolatedServeHandle | undefined;
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
	served = await startIsolatedServe({ cwd: process.cwd() });
	serveInfo.url = served.url;
	serveInfo.token = served.token;
}, 90_000);

afterAll(async () => {
	await served?.stop();
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
