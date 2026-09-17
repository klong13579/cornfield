/**
 * gateway 命令直连 gateway 生产端点（POST /wire）。
 *
 * 不再经 serve 中转。**端口由 serve 给**（hello_ack.gatewayWirePort）—— 浏览器没有
 * process.env，以前这里写死 7892，于是隔离 HOME 跑 e2e 时前端仍然连着本机真实运营中的
 * gateway（页面上出现的是别的进程的 pid）。所以本文件的每个用例都先握手拿到端口，
 * 「还没拿到」的那几个只证明它**就地报错**，而不是回落到 7892。
 *
 * 解析统一 {ok, result} 响应：gateway 未运行 / 返回 ok:false → 明确抛错。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { PiWebSocketCtor, PiWebSocketLike } from "@cornfield/client";
import { PiClientAdapter } from "../src/state/pi-client-adapter";

/** 测试用的 gateway 端口（由假 hello_ack 上报）= 这批用例该打的端口。 */
const TEST_GATEWAY_PORT = 48017;
const WIRE_URL = `http://127.0.0.1:${TEST_GATEWAY_PORT}/wire`;

/** fetch mock：返回固定 result，记录收到的请求。 */
function mockFetch(result: unknown, status = 200, error?: string): { requests: RequestInit[] } {
	const requests: RequestInit[] = [];
	spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const req = { url: typeof input === "string" ? input : String(input), ...(init ?? {}) };
		requests.push(req);
		if (status !== 200 || error !== undefined) {
			return new Response(JSON.stringify({ ok: false, error }), { status });
		}
		return new Response(JSON.stringify({ ok: true, result }), { status });
	});
	return { requests };
}

function lastRequest(requests: RequestInit[]): { url: string; body: Record<string, unknown> } {
	const r = requests.at(-1)!;
	return { url: r.url, body: JSON.parse(String(r.body)) as Record<string, unknown> };
}

/** 假 socket：用真帧驱动 adapter（hello_ack 里带不带 gatewayWirePort 由用例决定）。 */
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

/** 刚创建的那个假 socket（connect() 里同步产生）。拿不到 = 用例自己的前提坏了，别静默跳过握手。 */
function currentSocket(): FakeSocket {
	if (!lastSocket) throw new Error("FakeSocket 未被创建：connect() 没走到 new WebSocket");
	return lastSocket;
}

function newSocketAdapter(): PiClientAdapter {
	lastSocket = undefined;
	const adapter = new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" }, fakeCtor);
	opened.push(adapter);
	return adapter;
}

/** 起一个**已握手**的 adapter；ack 缺省 = serve 上报 TEST_GATEWAY_PORT。 */
async function openAdapter(
	ack: Record<string, unknown> = { gatewayWirePort: TEST_GATEWAY_PORT },
): Promise<PiClientAdapter> {
	const adapter = newSocketAdapter();
	const pending = adapter.connect();
	const socket = currentSocket();
	socket.onopen?.({});
	socket.receive(JSON.stringify({ type: "hello_ack", connectionId: "c1", protocolVersion: 1, ...ack }));
	await pending;
	return adapter;
}

afterEach(() => {
	spyOn(globalThis, "fetch").mockRestore();
	for (const adapter of opened.splice(0)) adapter.disconnect();
});

describe("PiClientAdapter gateway wire 直连", () => {
	test("getCronTasks POST /wire 并解析 result 形状", async () => {
		const { requests } = mockFetch({
			tasks: [{ id: "t1", name: "daily-report", scheduleType: "cron", enabled: true }],
		});
		const adapter = await openAdapter();
		const res = await adapter.getCronTasks();

		expect(res.tasks).toHaveLength(1);
		expect(res.tasks[0]).toMatchObject({ name: "daily-report", enabled: true });
		const req = lastRequest(requests);
		expect(req.url).toBe(WIRE_URL);
		expect(req.body.type).toBe("get_cron_tasks");
	});

	test("getCronLogs 透传 taskId/days/limit；缺省不带空参数", async () => {
		const { requests } = mockFetch({ logs: [{ taskId: "t1", id: "e1", ts: 1, status: "success" }] });
		const adapter = await openAdapter();

		const full = await adapter.getCronLogs({ taskId: "t1", days: 3, limit: 50 });
		expect(full.logs).toHaveLength(1);
		let req = lastRequest(requests);
		expect(req.url).toBe(WIRE_URL);
		expect(req.body).toMatchObject({ type: "get_cron_logs", taskId: "t1", days: 3, limit: 50 });

		await adapter.getCronLogs();
		req = lastRequest(requests);
		expect(req.body).toEqual({ type: "get_cron_logs" });
	});

	test("gatewayStatus 直连并解析 GatewayStatusDto", async () => {
		const { requests } = mockFetch({
			pid: 4242,
			statusWrittenAt: Date.now(),
			stale: false,
			accounts: [{ accountId: "hr", bridgeRunning: true }],
			scheduler: { running: true, taskCount: 1 },
		});
		const adapter = await openAdapter();
		const res = await adapter.gatewayStatus();

		expect(res.pid).toBe(4242);
		expect(res.stale).toBe(false);
		expect(res.accounts).toHaveLength(1);
		expect(lastRequest(requests).body.type).toBe("gateway_status");
	});

	test("gateway 返回 ok:false → 抛出明确错误", async () => {
		mockFetch(undefined, 400, "scheduler not started");
		const adapter = await openAdapter();
		await expect(adapter.getCronTasks()).rejects.toThrow("scheduler not started");
	});

	test("setGatewayAccount 发白名单 patch 并返回 { ok: true }（契约回归）", async () => {
		const { requests } = mockFetch({ accountId: "mcode", account: { enabled: false } });
		const adapter = await openAdapter();

		const res = await adapter.setGatewayAccount("mcode", { enabled: false });

		// 回归锁定：契约要求 { ok: boolean }，不得把 wire result（{accountId, account}）直接透传
		expect(res).toEqual({ ok: true });
		const req = lastRequest(requests);
		expect(req.url).toBe(WIRE_URL);
		expect(req.body).toMatchObject({ type: "set_gateway_account", accountId: "mcode", patch: { enabled: false } });
	});

	test("setGatewayAccount 收到 unknown account 抛错而非静默成功", async () => {
		mockFetch(undefined, 400, "unknown account: nope");
		const adapter = await openAdapter();
		await expect(adapter.setGatewayAccount("nope", { enabled: true })).rejects.toThrow("unknown account: nope");
	});

	test("reloadGateway 返回 { ok: true }（契约回归）", async () => {
		const { requests } = mockFetch({ reloaded: true });
		const adapter = await openAdapter();

		const res = await adapter.reloadGateway();
		expect(res).toEqual({ ok: true });
		expect(lastRequest(requests).body.type).toBe("reload_gateway");
	});

	test("gateway 端点不可达（fetch reject）→ 抛出错误", async () => {
		spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
		const adapter = await openAdapter();
		await expect(adapter.getCronLogs()).rejects.toThrow();
	});
});

/**
 * 端口是**serve 报的事实**，不是浏览器自己猜的常量（F7）：
 * 拿到就打到那个端口；没拿到就明说没拿到 —— 两条路都不许通向 7892。
 */
describe("PiClientAdapter gateway 端口（F7：不再写死 7892）", () => {
	test("打到 hello_ack 报的那个端口（不是 7892 常量）", async () => {
		const { requests } = mockFetch({ tasks: [] });
		const adapter = await openAdapter({ gatewayWirePort: 48018 });

		await adapter.getCronTasks();
		expect(lastRequest(requests).url).toBe("http://127.0.0.1:48018/wire");
	});

	test("尚未握手 → 就地报错，一个请求都不发（不回落到 7892）", async () => {
		const { requests } = mockFetch({ tasks: [] });
		const adapter = newSocketAdapter();

		await expect(adapter.getCronTasks()).rejects.toThrow("待 serve 上报 gateway 端口");
		expect(requests).toEqual([]);
	});

	test("hello_ack 里没有端口字段 → 报「待 serve 上报」，不打 7892", async () => {
		const { requests } = mockFetch({ tasks: [] });
		const adapter = await openAdapter({});

		await expect(adapter.getCronTasks()).rejects.toThrow("待 serve 上报 gateway 端口");
		expect(requests).toEqual([]);
	});

	test("端口不是正经端口号（字符串 / 0）→ 同样当作没上报", async () => {
		const { requests } = mockFetch({ tasks: [] });
		const asString = await openAdapter({ gatewayWirePort: "48018" });
		await expect(asString.getCronTasks()).rejects.toThrow("待 serve 上报 gateway 端口");

		const zero = await openAdapter({ gatewayWirePort: 0 });
		await expect(zero.getCronTasks()).rejects.toThrow("待 serve 上报 gateway 端口");

		expect(requests).toEqual([]);
	});

	test("断开之后旧端口作废（端口是当前这条连接的事实）", async () => {
		const { requests } = mockFetch({ tasks: [] });
		const adapter = await openAdapter({ gatewayWirePort: 48019 });
		await adapter.getCronTasks();
		expect(lastRequest(requests).url).toBe("http://127.0.0.1:48019/wire");

		adapter.disconnect();
		await expect(adapter.getCronTasks()).rejects.toThrow("待 serve 上报 gateway 端口");
		expect(requests).toHaveLength(1);
	});
});
