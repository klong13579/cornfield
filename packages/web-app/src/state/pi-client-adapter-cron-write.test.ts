/**
 * T10C · 调度写面的客户端契约（PiClientAdapter → gateway POST /wire）。
 *
 * 锁的是**发出去的形状**：命令名、`taskId`（不是关联 id `id`）、入参靠什么字段传到网关。
 * 网关侧对同名命令做收窄与校验（`packages/gateway/src/wire-endpoint.ts`），两边一旦漂移，
 * 前端只会看到「创建失败」而不知道原因 —— 所以这里按 wire 契约断言，而不是断言返回值。
 *
 * 失败路径同样重要：网关的 `ok:false`（agentId 未注册 / Agent home 不在 / 重名 / 未知 taskId）
 * 必须原样抛出给 UI 渲染，不得吞成 `false` 或空对象。
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PiClientAdapter } from "./pi-client-adapter";

const WIRE_URL = "http://127.0.0.1:7892/wire";

function newAdapter(): PiClientAdapter {
	return new PiClientAdapter({ wsUrl: "ws://127.0.0.1:1/ws", token: "" });
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
});

describe("cron 写面（直连 gateway /wire）", () => {
	test("cron_create 透传入参并回写解析后的行", async () => {
		const { requests, urls } = mockFetch({
			task: { id: "t1", name: "daily", agentId: "hr", agentResolution: "registered" },
		});
		const result = await newAdapter().cronCreate({
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
		await newAdapter().cronUpdate("t1", { status: "paused" });
		expect(requests[0]).toEqual({ type: "cron_update", taskId: "t1", status: "paused" });
	});

	test("cron_remove 用 taskId 并回写被删掉的任务名", async () => {
		const { requests } = mockFetch({ removed: "daily" });
		const result = await newAdapter().cronRemove("t1");
		expect(result.removed).toBe("daily");
		expect(requests[0]).toEqual({ type: "cron_remove", taskId: "t1" });
	});

	test("cron_test_run 带 name；inMs 缺省时不塞空值", async () => {
		const { requests } = mockFetch({ kind: "started", name: "daily", inMs: 120_000, expiresAt: 1, startedAt: 2 });
		await newAdapter().cronTestRun("daily");
		await newAdapter().cronTestRun("daily", 5_000);
		expect(requests[0]).toEqual({ type: "cron_test_run", name: "daily" });
		expect(requests[1]).toEqual({ type: "cron_test_run", name: "daily", inMs: 5_000 });
	});

	test("网关拒绝（如 agentId 未注册）→ 原样抛错，不吞成空结果", async () => {
		mockFetch(null, false, "agentId「ghost」未注册，无法绑定（先用 cornfield agent 注册它）。");
		await expect(
			newAdapter().cronCreate({ name: "x", cron: "* * * * *", command: "echo 1", agentId: "ghost" }),
		).rejects.toThrow("ghost");
	});
});
