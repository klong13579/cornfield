/**
 * P2-4 — PiClientAdapter cron/gateway 命令直连 gateway 生产端点（POST /wire）。
 *
 * 不再经 serve 中转：#gatewayWire fetch `http://127.0.0.1:7892/wire`，解析统一
 * {ok, result} 响应。gateway 未运行 / 返回 ok:false → 明确抛错。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PiClientAdapter } from "../src/state/pi-client-adapter";

const WIRE_URL = "http://127.0.0.1:7892/wire";

function newAdapter(): PiClientAdapter {
	return new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" });
}

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

afterEach(() => {
	spyOn(globalThis, "fetch").mockRestore();
});

describe("PiClientAdapter gateway wire 直连", () => {
	test("getCronTasks POST /wire 并解析 result 形状", async () => {
		const { requests } = mockFetch({
			tasks: [{ id: "t1", name: "daily-report", scheduleType: "cron", enabled: true }],
		});
		const adapter = newAdapter();
		const res = await adapter.getCronTasks();

		expect(res.tasks).toHaveLength(1);
		expect(res.tasks[0]).toMatchObject({ name: "daily-report", enabled: true });
		const req = lastRequest(requests);
		expect(req.url).toBe(WIRE_URL);
		expect(req.body.type).toBe("get_cron_tasks");
	});

	test("getCronLogs 透传 taskId/days/limit；缺省不带空参数", async () => {
		const { requests } = mockFetch({ logs: [{ taskId: "t1", id: "e1", ts: 1, status: "success" }] });
		const adapter = newAdapter();

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
		const adapter = newAdapter();
		const res = await adapter.gatewayStatus();

		expect(res.pid).toBe(4242);
		expect(res.stale).toBe(false);
		expect(res.accounts).toHaveLength(1);
		expect(lastRequest(requests).body.type).toBe("gateway_status");
	});

	test("gateway 返回 ok:false → 抛出明确错误", async () => {
		mockFetch(undefined, 400, "scheduler not started");
		const adapter = newAdapter();
		await expect(adapter.getCronTasks()).rejects.toThrow("scheduler not started");
	});

	test("gateway 端点不可达（fetch reject）→ 抛出错误", async () => {
		spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
		const adapter = newAdapter();
		await expect(adapter.getCronLogs()).rejects.toThrow();
	});
});
