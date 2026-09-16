/**
 * wire serve 只读协议 e2e 合流（真实 serve 子进程 + bun WS 客户端）。
 *
 * 覆盖命令（全部只读/无副作用路径）：
 *   - get_state / get_stats（含 period 窗口 + priceCatalog）/ list_commands / list_sessions / get_skills
 *   - steer（B-1 事件回显）+ cancel_queued（B-2 队列完整态）
 *   - 错误码枚举：response error 升级 { code, message }，旧 string error 向后兼容
 *
 * 单一 serve 子进程 + 隔离 HOME（不触发 LLM 计费）：HOME 预置 default CLI 会话 + hr registry
 * agent 会话（list_sessions source 断言依赖 registry 启动时加载，必须 spawn 前 seed）。
 * 帧收集器：push 与 response 统一队列/等待者——杜绝「等 response 期间 push 被丢」。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; [k: string]: unknown };

let isolatedHome: string;
let savedHome: string | undefined;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let url = "";

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
async function rawRequest(
	ws: WebSocket,
	frames: FrameSource,
	command: Record<string, unknown>,
	timeoutMs = 30_000,
): Promise<Frame> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await frames.next(fr => fr.type === "response" && fr.id === id, timeoutMs);
	if (!f) throw new Error(`timeout: ${JSON.stringify(command.type)}`);
	return f;
}

/** 单次命令往返（每条命令一条新连接，保证测试隔离）。 */
async function sendCommand(command: object, timeoutMs = 30_000): Promise<Frame> {
	const { ws, frames } = await connect(url);
	try {
		return await rawRequest(ws, frames, command as Record<string, unknown>, timeoutMs);
	} finally {
		ws.close();
	}
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

describe("协议批 B-2 — queue 完整态", () => {
	test("get_state 带排队文本；cancel_queued 取消并清空（LIFO）", async () => {
		const { ws, frames } = await connect(url);
		try {
			// 排空此前测试残留的排队（B-1 steer 未消费会留在队列里），直到 cancelled:false
			for (;;) {
				const drain = (await rawRequest(ws, frames, { type: "cancel_queued" })) as Frame;
				expect(drain.ok).toBe(true);
				if (!(drain.result as { cancelled: boolean }).cancelled) break;
			}

			// steer（idle）→ 入队 #steeringMessages
			await request(ws, frames, { type: "steer", message: "排队一号：换个角度" });
			const state = (await request(ws, frames, { type: "get_state" })) as {
				queued?: { steering?: string[]; followUp?: string[] };
				queuedMessageCount?: number;
			};
			expect(state.queued?.steering).toContain("排队一号：换个角度");
			expect(state.queuedMessageCount).toBeGreaterThanOrEqual(1);

			// cancel_queued → 取消最近一条（LIFO），返回被取消文本
			const cancelled = (await rawRequest(ws, frames, { type: "cancel_queued" })) as Frame;
			expect(cancelled.ok).toBe(true);
			const res = cancelled.result as { cancelled: boolean; text?: string };
			expect(res.cancelled).toBe(true);
			expect(res.text).toBe("排队一号：换个角度");

			// 取消后队列清空
			const after = (await request(ws, frames, { type: "get_state" })) as {
				queued?: { steering?: string[] };
			};
			expect(after.queued?.steering?.length ?? 0).toBe(0);
		} finally {
			ws.close();
		}
	});
});

describe("协议批 B-3 — list_commands 命令表", () => {
	test("返回 TUI 命令表：≥ W1 硬编码 6 个 + name/description 字段", async () => {
		const { ws, frames } = await connect(url);
		try {
			const result = (await request(ws, frames, { type: "list_commands" })) as {
				commands: { name: string; description: string }[];
			};
			expect(Array.isArray(result.commands)).toBe(true);
			expect(result.commands.length).toBeGreaterThanOrEqual(6);

			const names = new Set(result.commands.map(c => c.name));
			// W1 SlashPalette DEFAULT_COMMANDS 的 6 个必须全覆盖（名称带前导 /）
			for (const expectName of ["/compact", "/undo", "/model", "/yolo", "/retry", "/usage"]) {
				expect(names.has(expectName)).toBe(true);
			}
			// 内置/虚拟命令带前导 /；extra（hook/custom/skill:）形态各异——
			// 只断言描述非空（前导 / 断言只对内置命令成立，见上面 6 个全覆盖）。
			for (const c of result.commands) {
				expect(c.description.length).toBeGreaterThan(0);
			}
		} finally {
			ws.close();
		}
	});
});

describe("协议批 B-4 — 错误码枚举", () => {
	test("未知命令：response error 升级为 { code, message }（not_implemented）", async () => {
		const { ws, frames } = await connect(url);
		try {
			const resp = (await rawRequest(ws, frames, { type: "no_such_command_xyz" })) as Frame;
			expect(resp.ok).toBe(false);
			const err = resp.error as { code?: string; message?: string };
			expect(typeof err).toBe("object");
			expect(err.code).toBe("not_implemented");
			expect(typeof err.message).toBe("string");
		} finally {
			ws.close();
		}
	});

	test("旧调用方兼容：已知命令的 string error 仍可用（如未知 agent 定向）", async () => {
		const { ws, frames } = await connect(url);
		try {
			const resp = (await rawRequest(ws, frames, { type: "get_skills", sessionId: "no-such-agent" })) as Frame;
			expect(resp.ok).toBe(false);
			// 未升级路径仍为 string——向后兼容契约
			expect(typeof resp.error).toBe("string");
			expect(String(resp.error)).toMatch(/unknown agent/);
		} finally {
			ws.close();
		}
	});
});

describe("W3 D1 — serve get_stats 只读命令", () => {
	test("get_stats: 返回 DashboardStats 完整形状（隔离 HOME 下全零/空数组不崩）", async () => {
		const r = await sendCommand({ type: "get_stats" }, 90_000);
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
		const again = await sendCommand({ type: "get_stats" }, 90_000);
		expect(again.ok).toBe(true);
	});

	test("get_stats: optional period 时间窗口 + priceCatalog 单价目录（W3 D2）", async () => {
		// period "7d"：形状与全量一致，附 priceCatalog（隔离 HOME 无会话 → 空数组）
		const r = await sendCommand({ type: "get_stats", period: "7d" }, 90_000);
		expect(r.ok).toBe(true);
		const stats = r.result as Record<string, unknown>;
		expect(Array.isArray(stats.priceCatalog)).toBe(true);
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
		// 其余 period 值不崩（1d/30d/90d/all 与未知值都容忍）
		for (const periodVal of ["1d", "30d", "90d", "all", "bogus"]) {
			const rr = await sendCommand({ type: "get_stats", period: periodVal }, 90_000);
			expect(rr.ok).toBe(true);
		}
	});

	test("list_sessions: 每条带 source 字段（cli=default 根 / agent=registry agent）", async () => {
		// 预置会话在 beforeAll 里 seed（registry 启动时加载，不能中途写）
		const res = await sendCommand({ type: "list_sessions" }, 90_000);
		expect(res.ok).toBe(true);
		const sessions = ((res.result ?? {}) as { sessions?: { agentId: string; source: string }[] }).sessions ?? [];
		const cliEntry = sessions.find(s => s.agentId === "default");
		expect(cliEntry?.source).toBe("cli");
		const hrEntry = sessions.find(s => s.agentId === "hr");
		expect(hrEntry?.source).toBe("agent");
	});
});

beforeAll(async () => {
	isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-proto-"));
	savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	// W3 D2：预置 default 根 CLI 会话 + hr registry agent 会话（serve 启动时加载 registry，必须在此 seed）
	const home = isolatedHome;
	const cliDir = path.join(home, ".cornfield", "agent", "sessions", "--work--demo--", "by-date", "2026-08-18");
	await fs.mkdir(cliDir, { recursive: true });
	await Bun.write(
		path.join(cliDir, "000001__cli00001.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "cli-0000-7000-0000-000000000001",
			timestamp: "2026-08-18T09:00:00.000Z",
			cwd: "/work/demo",
			title: "cli session",
		})}\n`,
	);
	const hrDir = path.join(home, "agents", "hr");
	const hrSessions = path.join(hrDir, "sessions", "by-date", "2026-08-18");
	await fs.mkdir(hrSessions, { recursive: true });
	await fs.mkdir(path.join(hrDir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(hrDir, ".cornfield", "workspace.json"),
		JSON.stringify({ schemaVersion: 2, id: "hr", name: "hr-agent", type: "agent", root: ".", projectRoot: "." }),
	);
	await Bun.write(
		path.join(home, ".cornfield", "agent", "registry.json"),
		JSON.stringify({
			version: 2,
			agents: { hr: { path: hrDir, registeredAt: new Date().toISOString(), template: "default" } },
		}),
	);
	await Bun.write(
		path.join(hrSessions, "000002__hr000001.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "hr-0000-7000-0000-000000000001",
			timestamp: "2026-08-18T10:00:00.000Z",
			cwd: hrDir,
			title: "hr session",
		})}\n`,
	);

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
	url = (await waitForServe(proc, port, 60_000)).url;
}, 90_000);

afterAll(async () => {
	if (proc) {
		proc.kill();
		await proc.exited;
	}
	if (savedHome !== undefined) process.env.HOME = savedHome;
	await fs.rm(isolatedHome, { recursive: true, force: true });
});
