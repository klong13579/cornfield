/**
 * W3 D1 e2e — serve `get_stats` 只读命令（真实 serve 子进程 + bun WS 客户端）。
 *
 * 验证：
 *   1. get_stats 返回 DashboardStats 形状（overall/byModel/byFolder/timeSeries 等键齐全）
 *   2. 不依赖任何 attached session（不定向，直接 registry 级可得）
 *   3. 与 `omp stats --json` 同源：内部 syncAllSessions 后聚合，失败时 ok:false 不崩
 *
 * 隔离 HOME：避免写坏真实 ~/.omp/stats.db。不触发 LLM 计费。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";

const TOKEN_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;

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
		const m = buf.match(TOKEN_RE);
		if (m) {
			reader.releaseLock();
			return m[0];
		}
	}
	reader.releaseLock();
	throw new Error(`serve not ready; log:\n${buf.slice(-1500)}`);
}

/** 封装单次命令往返（不多路复用，保证测试隔离）。 */
async function sendCommand(command: object, timeoutMs = 30_000): Promise<Frame> {
	const ws = new WebSocket(url);
	const { promise: opened, resolve: resolveOpened, reject: rejectOpened } = Promise.withResolvers<void>();
	ws.onopen = () => resolveOpened();
	ws.onerror = ev => rejectOpened(new Error(`ws error: ${String(ev)}`));
	await opened;

	const { promise: ackDone, resolve: ackResolve } = Promise.withResolvers<void>();
	const { promise: respDone, resolve: respResolve, reject: respReject } = Promise.withResolvers<Frame>();
	const timer = setTimeout(() => respReject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);

	ws.onmessage = ev => {
		const frame = JSON.parse(String(ev.data)) as Frame;
		if (frame.type === "hello_ack") {
			ackResolve();
			return;
		}
		if (frame.type === "hello_error") {
			respReject(new Error(`hello_error: ${String(frame.error)}`));
			return;
		}
		if (frame.type === "response") {
			clearTimeout(timer);
			respResolve(frame);
		}
	};

	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: "" }));
	await ackDone;
	ws.send(JSON.stringify({ type: "request", id: "e2e", command: { id: "e2e", ...command } }));
	try {
		return await respDone;
	} finally {
		clearTimeout(timer);
		ws.close();
	}
}

describe("W3 D1 — serve get_stats 只读命令", () => {
	test("get_stats: 返回 DashboardStats 完整形状（隔离 HOME 下全零/空数组不崩）", async () => {
		const r = await sendCommand({ type: "get_stats" }, 30_000);
		expect(r.ok).toBe(true);
		const stats = r.result as Record<string, unknown>;
		// 顶层键齐全（与 packages/stats/src/types.ts DashboardStats 对齐）
		expect(typeof stats).toBe("object");
		for (const key of [
			"overall",
			"byModel",
			"byFolder",
			"timeSeries",
			"modelSeries",
			"modelPerformanceSeries",
			"costSeries",
		]) {
			expect(Object.hasOwn(stats, key)).toBe(true);
		}
		// overall 含聚合字段（隔离 HOME 无会话 → 全零，类型仍是数字）
		const overall = stats.overall as Record<string, unknown>;
		expect(typeof overall.totalRequests).toBe("number");
		expect(typeof overall.errorRate).toBe("number");
		expect(typeof overall.totalCost).toBe("number");
		// 数组键至少是数组
		for (const key of ["byModel", "byFolder", "timeSeries", "modelSeries", "modelPerformanceSeries", "costSeries"]) {
			expect(Array.isArray(stats[key])).toBe(true);
		}
	});

	test("get_stats: 不在 attached session 定向里（registry 级命令可直接调）", async () => {
		// 不依赖 default attached——先验证一个纯状态命令可用（探测 wire 连接没坏）
		const state = await sendCommand({ type: "get_state" });
		expect(state.ok).toBe(true);
		// get_stats 再调用一次，确保重复调用幂等（sync 增量无副作用）
		const again = await sendCommand({ type: "get_stats" }, 30_000);
		expect(again.ok).toBe(true);
	});
});

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-stats-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const cliPath = `${repoRoot}/packages/coding-agent/src/cli.ts`;
	const port = 57000 + Math.floor(Math.random() * 8000);
	proc = Bun.spawn(["bun", cliPath, "serve", "--port", String(port), "--host", "127.0.0.1", "--no-extensions"], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
	});
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
