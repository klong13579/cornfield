/**
 * P2-4 e2e — serve `get_cron_tasks` / `get_cron_logs` / `gateway_status` 转发 gateway 生产端点。
 *
 * P2-4 后 serve 不再直读 jobs.json/status.json——这些命令转发到 gateway 的 POST /wire
 * （127.0.0.1:OMP_GATEWAY_WIRE_PORT??7891）。本测试验证转发语义：
 *
 * - gateway 端点可用（真机 gateway 跑新二进制）→ 数据形状断言（cron 任务/日志/状态）
 * - gateway 端点不可用（隔离环境/旧 gateway）→ 断言明确错误（gateway unreachable）
 *
 * 两种环境都通过（测试反映当前环境的事实）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";

const URL_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;
const WIRE_PORT = Number.parseInt(process.env.OMP_GATEWAY_WIRE_PORT ?? "7891", 10);

type Frame = { type: string; [k: string]: unknown };

let sessionDir: string;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";
/** gateway 生产端点是否可达（新二进制 gateway 才开 7891）；beforeAll 探测。 */
let gatewayUp = false;

async function waitForServe(p: ReturnType<typeof Bun.spawn>): Promise<string> {
	const deadline = Date.now() + 30_000;
	const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`serve exited; log:\n${buf.slice(-1500)}`);
		buf += dec.decode(value);
		const m = buf.match(URL_RE);
		if (m) {
			reader.releaseLock();
			return m[0];
		}
	}
	reader.releaseLock();
	throw new Error(`serve not ready; log:\n${buf.slice(-1500)}`);
}

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
/** 发送命令；ok:false 时返回 { error } 而非抛错（P2-4 转发语义：gateway 不可达是预期分支）。 */
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

/** gateway 生产端点是否可达（新二进制 gateway 才开 7891）。 */
async function gatewayWireAvailable(): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${WIRE_PORT}/wire`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "get_cron_tasks" }),
		});
		return res.ok;
	} catch {
		return false;
	}
}

beforeAll(async () => {
	sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-proxy-"));
	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const servePort = 57000 + Math.floor(Math.random() * 8000);
	proc = Bun.spawn(
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
			cwd: `${repoRoot}/packages/coding-agent`,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_NO_TITLE: "1", OMP_GATEWAY_WIRE_PORT: String(WIRE_PORT) },
		},
	);
	url = await waitForServe(proc);
	gatewayUp = await gatewayWireAvailable();
}, 45_000);

afterAll(async () => {
	proc?.kill();
	if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true });
});

describe("P2-4 — cron/gateway 命令经 serve 转发 gateway 端点", () => {
	test("get_cron_tasks：gateway 可用时返回任务数组；不可用时返回明确错误", async () => {
		const { ws, frames } = await connect(url);
		try {
			const res = await requestRaw(ws, frames, { type: "get_cron_tasks" });
			if (gatewayUp) {
				expect(res.ok).toBe(true);
				if (res.ok) {
					const tasks = (res.result as { tasks: unknown[] }).tasks;
					expect(Array.isArray(tasks)).toBe(true);
				}
			} else {
				expect(res.ok).toBe(false);
				if (!res.ok) expect(res.error).toContain("gateway");
			}
		} finally {
			ws.close();
		}
	});

	test("get_cron_logs：gateway 可用时返回日志数组；不可用时返回明确错误", async () => {
		const { ws, frames } = await connect(url);
		try {
			const res = await requestRaw(ws, frames, { type: "get_cron_logs", days: 3, limit: 50 });
			if (gatewayUp) {
				expect(res.ok).toBe(true);
				if (res.ok) expect(Array.isArray((res.result as { logs: unknown[] }).logs)).toBe(true);
			} else {
				expect(res.ok).toBe(false);
				if (!res.ok) expect(res.error).toContain("gateway");
			}
		} finally {
			ws.close();
		}
	});

	test("gateway_status：gateway 可用时返回状态；不可用时返回明确错误", async () => {
		const { ws, frames } = await connect(url);
		try {
			const res = await requestRaw(ws, frames, { type: "gateway_status" });
			if (gatewayUp) {
				expect(res.ok).toBe(true);
				if (res.ok) {
					const status = res.result as { pid?: number; scheduler?: unknown };
					expect(typeof status.pid).toBe("number");
				}
			} else {
				expect(res.ok).toBe(false);
				if (!res.ok) expect(res.error).toContain("gateway");
			}
		} finally {
			ws.close();
		}
	});
});
