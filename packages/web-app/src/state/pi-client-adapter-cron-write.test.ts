/**
 * T10C · 调度写面的客户端契约（PiClientAdapter → gateway POST /wire）。
 *
 * 锁的是**发出去的形状**：命令名、`taskId`（不是关联 id `id`）、入参靠什么字段传到网关。
 * 网关侧对同名命令做收窄与校验（`packages/gateway/src/wire-endpoint.ts`），两边一旦漂移，
 * 前端只会看到「创建失败」而不知道原因 —— 所以这里按 wire 契约断言，而不是断言返回值。
 *
 * 失败路径同样重要：网关的 `ok:false`（agentId 未注册 / Agent home 不在 / 重名 / 未知 taskId）
 * 必须原样抛出给 UI 渲染，不得吞成 `false` 或空对象。
 *
 * 打哪个端口由 serve 给（hello_ack.gatewayWirePort，F7）—— 所以每个用例都先握手，不再有
 * 「浏览器自己猜 7892」这条路。
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { PiClientAdapter } from "./pi-client-adapter";

/** 测试用的 gateway 端口（由假 hello_ack 上报）。 */
const TEST_GATEWAY_PORT = 48017;
const WIRE_URL = `http://127.0.0.1:${TEST_GATEWAY_PORT}/wire`;

let lastSocket: FakeSocket | undefined;
const opened: PiClientAdapter[] = [];

class FakeSocket implements PiWebSocketLike {
	readyState = 1;
	sent: string[] = [];
	onopen: PiWebSocketLike["onopen"] = null;
	onmessage: PiWebSocketLike["onmessage"] = null;
	onclose: PiWebSocketLike["onclose"] = null;
	onerror: PiWebSocketLike["onerror"] = null;

	constructor(_url: string) {
		lastSocket = this;
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {}

	receive(data: string): void {
		this.onmessage?.({ data });
	}
}

const fakeCtor: PiWebSocketCtor = FakeSocket;

/** 刚创建的那个假 socket（connect() 里同步产生）。拿不到 = 用例自己的前提坏了，别静默跳过。 */
function currentSocket(): FakeSocket {
	if (!lastSocket) throw new Error("FakeSocket 未被创建：connect() 没走到 new WebSocket");
	return lastSocket;
}

/** 起一个**已握手**的 adapter（端口已由 serve 上报）。 */
async function newAdapter(): Promise<PiClientAdapter> {
	lastSocket = undefined;
	const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
	opened.push(adapter);
	const pending = adapter.connect();
	const socket = currentSocket();
	socket.onopen?.({});
	socket.receive(
		JSON.stringify({
			type: "hello_ack",
			connectionId: "c1",
			protocolVersion: 1,
			gatewayWirePort: TEST_GATEWAY_PORT,
		}),
	);
	await pending;
	return adapter;
}

function mockFetch(
	result: unknown,
	ok = true,
	error?: string,
): { requests: Record<string, unknown>[]; urls: string[] } {
	const requests: Record<string, unknown>[] = [];
	const urls: string[] = [];
	// 只实现调用路径（`fetch(url, init)`）：`typeof fetch` 还带 `preconnect` 等静态成员，
	// 被测代码不会碰，所以这里显式 cast 成 fetch 而不是补一堆用不上的成员。
	const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		urls.push(String(_input));
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return ok
			? new Response(JSON.stringify({ ok: true, result }))
			: new Response(JSON.stringify({ ok: false, error: error ?? "gateway error" }));
	}) as typeof fetch;
	spyOn(globalThis, "fetch").mockImplementation(impl);
	return { requests, urls };
}

afterEach(() => {
	spyOn(globalThis, "fetch").mockRestore();
	for (const adapter of opened.splice(0)) adapter.disconnect();
});

describe("cron 写面（直连 gateway /wire）", () => {
	test("cron_create 透传入参并回写解析后的行", async () => {
		const { requests, urls } = mockFetch({
			task: { id: "t1", name: "daily", agentId: "hr", agentResolution: "registered" },
		});
		const adapter = await newAdapter();
		const result = await adapter.cronCreate({
			name: "daily",
			cron: "0 9 * * *",
			command: "汇总假勤",
			taskType: "agent",
			agentId: "hr",
		});

		expect(result.task.agentId).toBe("hr");
		expect(urls[0]).toBe(WIRE_URL);
		expect(requests[0]).toEqual({
			type: "cron_create",
			name: "daily",
			cron: "0 9 * * *",
			command: "汇总假勤",
			taskType: "agent",
			agentId: "hr",
		});
	});

	test("cron_update 用 taskId（wire 的 id 是关联 id，不是调度 id）", async () => {
		const { requests } = mockFetch({ task: { id: "t1", name: "daily" } });
		const adapter = await newAdapter();
		await adapter.cronUpdate("t1", { status: "paused" });
		expect(requests[0]).toEqual({ type: "cron_update", taskId: "t1", status: "paused" });
	});

	test("cron_remove 用 taskId 并回写被删掉的任务名", async () => {
		const { requests } = mockFetch({ removed: "daily" });
		const adapter = await newAdapter();
		const result = await adapter.cronRemove("t1");
		expect(result.removed).toBe("daily");
		expect(requests[0]).toEqual({ type: "cron_remove", taskId: "t1" });
	});

	test("cron_test_run 带 name；inMs 缺省时不塞空值", async () => {
		const { requests } = mockFetch({ kind: "started", name: "daily", inMs: 120_000, expiresAt: 1, startedAt: 2 });
		const adapter = await newAdapter();
		await adapter.cronTestRun("daily");
		await adapter.cronTestRun("daily", 5_000);
		expect(requests[0]).toEqual({ type: "cron_test_run", name: "daily" });
		expect(requests[1]).toEqual({ type: "cron_test_run", name: "daily", inMs: 5_000 });
	});

	test("网关拒绝（如 agentId 未注册）→ 原样抛错，不吞成空结果", async () => {
		mockFetch(null, false, "agentId「ghost」未注册，无法绑定（先用 cornfield agent 注册它）。");
		const adapter = await newAdapter();
		await expect(
			adapter.cronCreate({ name: "x", cron: "* * * * *", command: "echo 1", agentId: "ghost" }),
		).rejects.toThrow("ghost");
	});
});
