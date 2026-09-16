/**
 * P2-4 e2e — serve `get_cron_tasks` / `get_cron_logs` / `gateway_status` 转发 gateway 生产端点。
 *
 * P2-4 后 serve 不再直读 jobs.json/status.json——这些命令转发到 gateway 的 POST /wire
 * （127.0.0.1:CORNFIELD_GATEWAY_WIRE_PORT??7892；7891 系 serve sidecar，不与 gateway 共用）。本测试用封真 mock gateway 端点（进程内
 * Bun.serve）验证转发语义（确定性，不依赖机器真实 gateway）：
 *
 * - 转发成功：canned 形状原样穿透（TaskRowDto / CronLogEntryDto / GatewayStatusDto），
 *   且收到 gateway 的请求携带正确参数（taskId/days/limit）。
 * - gateway 端点不可用：返回明确错误（gateway unreachable）。
 *
 * 隔离 HOME / 端口 / 预算 / 停摆重试都在 `spawnServeFixture` 里（见该文件的说明）。
 * 本文件的 sessionDir 与 mock gateway 端口不属于夹具职责，仍在用例内自建。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { pickPort, SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

type Frame = { type: string; [k: string]: unknown };

let sessionDir: string;
/** 主实例：mock gateway 可达 → 转发穿透用例。 */
let main: ServeFixture | undefined;
/** down 实例：CORNFIELD_GATEWAY_WIRE_PORT 指向从不绑定的死端口 → gateway unreachable 用例。 */
let down: ServeFixture | undefined;
let wirePort = 0;
let deadPort = 0;
let mockWire: ReturnType<typeof Bun.serve> | undefined;
/** mock 收到的命令（断言转发参数用）。 */
const receivedCommands: Array<Record<string, unknown>> = [];

interface FrameSource {
	next(pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined>;
}

function collect(ws: WebSocket): FrameSource {
	const queue: Frame[] = [];
	const waiters: {
		pred: (f: Frame) => boolean;
		resolve: (f: Frame | undefined) => void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];
	ws.addEventListener("message", ev => {
		let frame: Frame;
		try {
			frame = JSON.parse(String(ev.data)) as Frame;
		} catch {
			return;
		}
		const waiter = waiters.find(w => w.pred(frame));
		if (waiter) {
			clearTimeout(waiter.timer);
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(frame);
		} else {
			queue.push(frame);
		}
	});
	return {
		next(pred, timeoutMs) {
			const idx = queue.findIndex(pred);
			if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
			if (timeoutMs <= 0) return Promise.resolve(undefined);
			return new Promise(resolve => {
				const waiter = {
					pred,
					resolve: (f: Frame | undefined) => resolve(f),
					timer: setTimeout(() => {
						waiters.splice(waiters.indexOf(waiter), 1);
						resolve(undefined);
					}, timeoutMs),
				};
				waiters.push(waiter);
			});
		},
	};
}

async function connect(wsUrl: string): Promise<{ ws: WebSocket; frames: FrameSource }> {
	const ws = new WebSocket(wsUrl);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
	});
	const frames = collect(ws);
	const token = wsUrl.match(/token=([a-zA-Z0-9]+)/)?.[1] ?? "";
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token }));
	const ack = await frames.next(f => f.type === "hello_ack", 10_000);
	if (!ack) throw new Error("no hello_ack");
	return { ws, frames };
}

let seq = 0;
/** 发送命令；ok:false 时返回 { ok:false, error } 而非抛错（gateway 不可达是预期分支）。 */
async function requestRaw(
	ws: WebSocket,
	frames: FrameSource,
	command: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await frames.next(fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${JSON.stringify(command.type)}`);
	if (f.ok !== true) {
		return { ok: false, error: typeof f.error === "string" ? f.error : JSON.stringify(f.error) };
	}
	return { ok: true, result: f.result };
}

/** 封真 gateway /wire 端点：canned 形状 + 记录收到的命令。 */
function startMockWire(): void {
	mockWire = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async req => {
			const url = new URL(req.url);
			if (req.method !== "POST" || url.pathname !== "/wire") {
				return Response.json({ ok: false, error: "not_found" }, { status: 404 });
			}
			const command = (await req.json()) as { type?: string };
			receivedCommands.push(command);
			switch (command.type) {
				case "get_cron_tasks":
					return Response.json({
						ok: true,
						result: {
							tasks: [
								{
									id: "t1",
									name: "daily-report",
									scheduleType: "cron",
									cron: "0 9 * * *",
									enabled: true,
									command: "hello",
									runCount: 3,
								},
							],
						},
					});
				case "get_cron_logs":
					return Response.json({
						ok: true,
						result: {
							logs: [
								{
									taskId: "t1",
									id: "exec-1",
									ts: Date.now(),
									status: "success",
									exitCode: 0,
									durationMs: 4_000,
									output: "ok",
								},
							],
						},
					});
				case "gateway_status":
					return Response.json({
						ok: true,
						result: {
							pid: 4242,
							statusWrittenAt: Date.now(),
							stale: false,
							accounts: [{ accountId: "hr", bridgeRunning: true, agentDir: "/tmp/x" }],
							scheduler: { running: true, taskCount: 1 },
						},
					});
				default:
					return Response.json({ ok: false, error: `unknown command ${command.type}` }, { status: 400 });
			}
		},
	});
	wirePort = mockWire.port ?? 0;
}

beforeAll(async () => {
	startMockWire();
	sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-cron-proxy-"));
	// 环境变量名必须与产品侧一致（wire-server.ts 的 GATEWAY_WIRE_PORT 只认 CORNFIELD_
	// 前缀；gateway.ts #startWireEndpoint 同）。写成别的名字不会被报错，只会静默回退
	// 7892——2026-09-16 修本文件前，这里的 `OMP_GATEWAY_WIRE_PORT` 就是这种情形：
	// mock 一次都没被命中，三条转发用例恒 ok:false。
	main = await spawnServeFixture({
		homePrefix: "omp-serve-cron-proxy-",
		extraArgs: ["--session-dir", sessionDir],
		env: { CORNFIELD_GATEWAY_WIRE_PORT: String(wirePort) },
	});
	// 探测一个端口后立即释放、谁都不监听它 → 连接被拒（gateway unreachable 分支）。
	deadPort = await pickPort();
	down = await spawnServeFixture({
		homePrefix: "omp-serve-cron-proxy-down-",
		extraArgs: ["--session-dir", sessionDir],
		env: { CORNFIELD_GATEWAY_WIRE_PORT: String(deadPort) },
	});
}, SERVE_BOOT_BUDGET_MS * 2);

afterAll(async () => {
	if (mockWire) mockWire.stop();
	await down?.dispose();
	await main?.dispose();
	await fs.rm(sessionDir, { recursive: true, force: true });
});

describe("P2-4 — cron/gateway 命令经 serve 转发 gateway 端点", () => {
	// 每条用例显式预算：bun 默认 5s 低于本文件自己的等待（hello_ack 10s / 响应 30s），
	// 负载下握手稍慢就会先被 bun 掉断，丢掉真实原因。断言未改。
	test("get_cron_tasks：canned 任务形状原样穿透", async () => {
		const { ws, frames } = await connect(main!.url);
		try {
			const res = await requestRaw(ws, frames, { type: "get_cron_tasks" });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const tasks = (res.result as { tasks: Array<Record<string, unknown>> }).tasks;
			expect(tasks).toHaveLength(1);
			expect(tasks[0]).toMatchObject({ name: "daily-report", scheduleType: "cron", enabled: true });
		} finally {
			ws.close();
		}
	}, 30_000);

	test("get_cron_logs：taskId/days/limit 参数原样转发 + canned 日志穿透", async () => {
		const { ws, frames } = await connect(main!.url);
		try {
			const res = await requestRaw(ws, frames, { type: "get_cron_logs", taskId: "t1", days: 3, limit: 50 });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const logs = (res.result as { logs: Array<Record<string, unknown>> }).logs;
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({ taskId: "t1", id: "exec-1", status: "success", exitCode: 0 });

			const sent = receivedCommands.at(-1);
			expect(sent?.type).toBe("get_cron_logs");
			expect(sent?.taskId).toBe("t1");
			expect(sent?.days).toBe(3);
			expect(sent?.limit).toBe(50);
		} finally {
			ws.close();
		}
	}, 30_000);

	test("gateway_status：pid/stale/accounts 形状穿透", async () => {
		const { ws, frames } = await connect(main!.url);
		try {
			const res = await requestRaw(ws, frames, { type: "gateway_status" });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const status = res.result as { pid: number; stale: boolean; accounts: unknown[]; scheduler: unknown };
			expect(status.pid).toBe(4242);
			expect(status.stale).toBe(false);
			expect(status.accounts).toHaveLength(1);
			expect(status.scheduler).toEqual({ running: true, taskCount: 1 });
		} finally {
			ws.close();
		}
	}, 30_000);

	test("gateway 端点不可用：返回明确 gateway 错误", async () => {
		const { ws, frames } = await connect(down!.url);
		try {
			const res = await requestRaw(ws, frames, { type: "get_cron_tasks" });
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toContain("gateway");
			const st = await requestRaw(ws, frames, { type: "gateway_status" });
			expect(st.ok).toBe(false);
			if (!st.ok) expect(st.error).toContain("gateway");
		} finally {
			ws.close();
		}
	}, 30_000);
});
