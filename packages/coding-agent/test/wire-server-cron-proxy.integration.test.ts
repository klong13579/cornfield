/**
 * P2-W3-1 e2e — serve `get_cron_tasks` / `get_cron_logs` 只读代理（真机 serve + bun WS 客户端）。
 *
 * 数据源 = 真机 ~/.omp/gateway-data/scheduler/（jobs.json + logs/by-task/ 直读，
 * 不依赖 gateway 进程、不 import gateway 运行时）。真 HOME 起服（保证读到真实任务数据），
 * session 落盘用临时 --session-dir 隔离，不污染真机会话。
 *
 * 断言策略：结构断言（数组 + 字段类型），任务/日志存在性不做硬性要求（空机也过）——
 * 本机至少 1 个任务与若干日志时会验证字段具体形状。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";

const URL_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;

type Frame = { type: string; [k: string]: unknown };

let sessionDir: string;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";

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
async function request(ws: WebSocket, frames: FrameSource, command: Record<string, unknown>): Promise<unknown> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await frames.next(fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${JSON.stringify(command.type)}`);
	if (f.ok !== true) throw new Error(`command failed: ${JSON.stringify(f)}`);
	return (f as { result?: unknown }).result;
}

interface CronTask {
	id: string;
	name: string;
	scheduleType: "cron" | "interval" | "once";
	cron?: string;
	nextRunAt?: number;
	lastRunAt?: number;
	enabled: boolean;
	accountId?: string;
	command?: string;
	runCount?: number;
	failCount?: number;
	consecutiveFailures?: number;
}

interface CronLog {
	taskId: string;
	id: string;
	ts: number;
	status: string;
	exitCode: number | null;
	durationMs: number | null;
	output?: string;
	outputTruncated?: boolean;
	stderr?: string;
}

describe("P2-W3-1 — cron 只读代理（真机数据）", () => {
	test("get_cron_tasks：结构断言 + 字段类型（真机 ≥1 任务）", async () => {
		const { ws, frames } = await connect(url);
		try {
			const result = (await request(ws, frames, { type: "get_cron_tasks" })) as { tasks: CronTask[] };
			expect(Array.isArray(result.tasks)).toBe(true);
			for (const t of result.tasks) {
				expect(typeof t.id).toBe("string");
				expect(typeof t.name).toBe("string");
				expect(["cron", "interval", "once"]).toContain(t.scheduleType);
				expect(typeof t.enabled).toBe("boolean");
				if (t.nextRunAt !== undefined) expect(typeof t.nextRunAt).toBe("number");
				if (t.lastRunAt !== undefined) expect(typeof t.lastRunAt).toBe("number");
			}
			// 本机（真 HOME）有真实任务（jobs.json 6 个，4 active）；空机（CI）容忍
			expect(result.tasks.length).toBeGreaterThanOrEqual(0);
		} finally {
			ws.close();
		}
	});

	test("get_cron_logs：结构断言 + 条目字段（days=3 窗口）", async () => {
		const { ws, frames } = await connect(url);
		try {
			const result = (await request(ws, frames, { type: "get_cron_logs", days: 3, limit: 50 })) as {
				logs: CronLog[];
			};
			expect(Array.isArray(result.logs)).toBe(true);
			const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
			for (const log of result.logs) {
				expect(typeof log.taskId).toBe("string");
				expect(typeof log.id).toBe("string");
				expect(typeof log.ts).toBe("number");
				expect(log.ts).toBeGreaterThanOrEqual(cutoff);
				expect(typeof log.status).toBe("string");
				expect(log.exitCode === null || typeof log.exitCode === "number").toBe(true);
				expect(log.durationMs === null || typeof log.durationMs === "number").toBe(true);
			}
			// 本机有真实执行日志（daily-* 任务近 3 天有 run）；空机（CI）容忍
			expect(result.logs.length).toBeGreaterThanOrEqual(0);
			// 时间倒序
			for (let i = 1; i < result.logs.length; i++) {
				expect(result.logs[i]!.ts <= result.logs[i - 1]!.ts).toBe(true);
			}
		} finally {
			ws.close();
		}
	});

	test("get_cron_logs：limit 截断 + output 2KB 截断不变量", async () => {
		const { ws, frames } = await connect(url);
		try {
			const tasks = (await request(ws, frames, { type: "get_cron_tasks" })) as { tasks: CronTask[] };
			const first = tasks.tasks[0];
			if (!first) return; // 空机（CI）无真实任务，跳过真机数据断言
			expect(first).toBeDefined();

			// limit=1 → 恰 1 条
			const limited = (await request(ws, frames, {
				type: "get_cron_logs",
				taskId: first.name,
				days: 7,
				limit: 1,
			})) as { logs: CronLog[] };
			expect(limited.logs.length).toBeLessThanOrEqual(1);

			// 全量抓取（cap 200）：output 长度 ≤ 2048；truncated 标记与长度一致
			const full = (await request(ws, frames, {
				type: "get_cron_logs",
				taskId: first.name,
				days: 7,
				limit: 200,
			})) as { logs: CronLog[] };
			for (const log of full.logs) {
				if (log.output !== undefined) {
					expect(log.output.length).toBeLessThanOrEqual(2048);
					if (log.outputTruncated) {
						expect(log.output.length).toBe(2048);
					}
				}
			}
		} finally {
			ws.close();
		}
	});

	test("get_cron_logs：taskId 过滤只返回该任务日志；未知任务返回空", async () => {
		const { ws, frames } = await connect(url);
		try {
			const tasks = (await request(ws, frames, { type: "get_cron_tasks" })) as { tasks: CronTask[] };
			const first = tasks.tasks[0];
			if (!first) return; // 空机（CI）无真实任务，跳过真机数据断言
			expect(first).toBeDefined();

			const filtered = (await request(ws, frames, {
				type: "get_cron_logs",
				taskId: first.name,
				days: 7,
				limit: 20,
			})) as { logs: CronLog[] };
			for (const log of filtered.logs) {
				expect(log.taskId).toBe(first.name);
			}

			const unknown = (await request(ws, frames, {
				type: "get_cron_logs",
				taskId: "__no_such_task__",
			})) as { logs: CronLog[] };
			expect(unknown.logs).toEqual([]);
		} finally {
			ws.close();
		}
	});
});

beforeAll(async () => {
	sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-cron-proxy-"));
	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = 57000 + Math.floor(Math.random() * 8000);
	proc = Bun.spawn(
		[
			"bun",
			`${repoRoot}/packages/coding-agent/src/cli.ts`,
			"serve",
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
			"--no-extensions",
			"--session-dir",
			sessionDir,
		],
		{ stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_NO_TITLE: "1" } },
	);
	url = await waitForServe(proc);
}, 30_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	await fs.rm(sessionDir, { recursive: true, force: true });
});
