/**
 * 协议批 B 案 wire e2e（真实 serve 子进程 + bun WS 客户端）。
 *
 * 各项独立提交、独立 describe：
 *   B-1 steer 事件回显：steer 命令后 serve 推 progress 帧（steer 标记 + 文本）
 *   B-2 queue 完整态：get_state 带排队文本 + cancel_queued 命令
 *   B-3 list_commands：TUI 命令表（≥ W1 硬编码 6 个）
 *   B-4 错误码枚举：response error 升级 { code, message }（兼容 string）
 *
 * 隔离 HOME（不触发 LLM 计费；steer/队列操作不依赖模型鉴权）。
 * 帧收集器：push 与 response 统一队列/等待者——杜绝「等 response 期间 push 被丢」。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";

const URL_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;

type Frame = { type: string; [k: string]: unknown };

let isolatedHome: string;
let savedHome: string | undefined;
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
	/** 按谓词取下一帧（先查队列，再注册等待者）；超时返回 undefined。 */
	next(pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined>;
}

/** 持久帧收集器：无匹配监听器的帧进队列，绝不丢弃。 */
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

/** 发送命令并取 response（ok 非真抛错）。 */
async function request(ws: WebSocket, frames: FrameSource, command: Record<string, unknown>): Promise<unknown> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await frames.next(fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${JSON.stringify(command.type)}`);
	if (f.ok !== true) throw new Error(`command failed: ${JSON.stringify(f)}`);
	return (f as { result?: unknown }).result;
}

/** 发送命令并取原始 response 帧（断言 ok:false / error 形状用）。 */
async function rawRequest(ws: WebSocket, frames: FrameSource, command: Record<string, unknown>): Promise<Frame> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await frames.next(fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${JSON.stringify(command.type)}`);
	return f;
}

/** 断言 push 帧事件（progress/steer 等异步推送）。 */
async function waitPushEvent(
	frames: FrameSource,
	pred: (event: unknown) => boolean,
	timeoutMs = 15_000,
): Promise<unknown> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const frame = await frames.next(f => f.type === "push", Math.min(1500, deadline - Date.now() + 500));
		if (!frame) break;
		const event = (frame as { event?: unknown }).event;
		if (pred(event)) return event;
	}
	throw new Error(`push 未在 ${timeoutMs}ms 内匹配`);
}

describe("协议批 B-1 — steer 事件回显", () => {
	test("steer 命令后 serve 推 progress 帧（steer 标记 + 文本），且命令成功", async () => {
		const { ws, frames } = await connect(url);
		try {
			await request(ws, frames, { type: "steer", message: "转向测试：换个角度回答" });

			// 回显 push：progress 帧带 steer 标记 + 文本摘要
			const push = (await waitPushEvent(
				frames,
				ev => {
					const p = ev as { type?: string; event?: { type?: string; text?: string } };
					return p.type === "progress" && p.event?.type === "steer";
				},
				15_000,
			)) as { sessionId?: string; event?: { type?: string; text?: string } };
			expect(push.event?.text).toBe("转向测试：换个角度回答");
			expect(typeof push.sessionId).toBe("string");
		} finally {
			ws.close();
		}
	});
});

// ── B-2 queue / B-3 list_commands / B-4 error codes 的 describe 随各自提交追加 ──

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-proto-b-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

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
		],
		{ stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" } },
	);
	url = await waitForServe(proc);
}, 30_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});
