/**
 * P2-4 e2e — serve `get_cron_tasks` / `get_cron_logs` / `gateway_status` 转发 gateway 生产端点。
 *
 * P2-4 后 serve 不再直读 jobs.json/status.json——这些命令转发到 gateway 的 POST /wire
 * （127.0.0.1:OMP_GATEWAY_WIRE_PORT??7891）。本测试用封真 mock gateway 端点（进程内
 * Bun.serve）验证转发语义（确定性，不依赖机器真实 gateway）：
 *
 * - 转发成功：canned 形状原样穿透（TaskRowDto / CronLogEntryDto / GatewayStatusDto），
 *   且收到 gateway 的请求携带正确参数（taskId/days/limit）。
 * - gateway 端点不可用：返回明确错误（gateway unreachable）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; [k: string]: unknown };

let sessionDir: string;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";
/** gateway 不可用场景：指向从不绑定的死端口。 */
let downProc: ReturnType<typeof Bun.spawn> | undefined;
let downUrl = "";
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

/** 起一个 serve（OMP_GATEWAY_WIRE_PORT 定向到给定端口）。 */
async function spawnServe(wirePortOverride: number): Promise<{ proc: ReturnType<typeof Bun.spawn>; url: string }> {
	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const servePort = 57000 + Math.floor(Math.random() * 8000);
	const proc = Bun.spawn(
		[
			"bun",
			`${repoRoot}/packages/coding-agent/src/cli.ts`,
			"serve",
			"--port",
			String(servePort),
			"--host",
			"127.0.0.1",
			"--no-extensions",
			"--session-dir",
			sessionDir,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_NO_TITLE: "1", OMP_GATEWAY_WIRE_PORT: String(wirePortOverride) },
		},
	);
	const url = await waitForServe(proc, servePort);
	return { proc: proc as ReturnType<typeof Bun.spawn>, url: url.url };
}

beforeAll(async () => {
	startMockWire();
	sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-cron-proxy-"));
	// 主实例：mock gateway 可达 → 转发穿透用例
	const main = await spawnServe(wirePort);
	proc = main.proc;
	url = main.url;
	// down 实例：定向到从不绑定的死端口 → gateway unreachable 用例
	deadPort = 58000 + Math.floor(Math.random() * 8000);
	const down = await spawnServe(deadPort);
	downProc = down.proc;
	downUrl = down.url;
}, 45_000);

afterAll(async () => {
	if (mockWire) mockWire.stop();
	if (downProc) {
		downProc.kill();
		await downProc.exited;
	}
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	await fs.rm(sessionDir, { recursive: true, force: true });
});

describe("P2-4 — cron/gateway 命令经 serve 转发 gateway 端点", () => {
	test("get_cron_tasks：canned 任务形状原样穿透", async () => {
		const { ws, frames } = await connect(url);
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
	});

	test("get_cron_logs：taskId/days/limit 参数原样转发 + canned 日志穿透", async () => {
		const { ws, frames } = await connect(url);
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
	});

	test("gateway_status：pid/stale/accounts 形状穿透", async () => {
		const { ws, frames } = await connect(url);
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
	});

	test("gateway 端点不可用：返回明确 gateway 错误", async () => {
		const { ws, frames } = await connect(downUrl);
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
	});
});
