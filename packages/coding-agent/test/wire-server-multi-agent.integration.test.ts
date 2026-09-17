/**
 * P3 多 Agent e2e — serve 子进程 + bun WS 客户端（真机）。
 *
 * 隔离环境：临时 HOME，registry.json 里预置 2 个 agent（hr / ops，指向临时 agentDir）。
 * 覆盖：
 *   1. server_snapshot 列表（default + hr + ops，未 attach 元数据可见）
 *   2. attach lazy 建 session（sessionFile 落 <agentDir>/sessions/）
 *   3. switch_session 切焦点 → 推送 session_snapshot 切到对应 agent
 *   4. 推送隔离：A 连接切到 hr 后，default 的事件不再推给它
 *   5. 定向命令：sessionId 参数直接指定 hr（无需 switch）
 *   6. get_available_models 真实现（协议结构验证；列表非空依赖环境配置的 key）
 *   7. ping/pong 心跳
 *   8. host_tool 双向闭环：set_host_tools 注册 → 触发调用（用 get_state 后的 prompt 不可行，
 *      改用直接校验 host_tools_changed push + 注册回执；调用闭环需 LLM，留 fe 联调）
 *
 * 不发 prompt（不触发计费）。set_todos 等本地命令验证定向路由。
 *
 * 另含 B1/B8 回归：get_state env 环境摘要 + branch 命令（预置历史会话文件
 * --resume，branch 面向真实 user entry，不打 LLM）。
 *
 * 隔离 HOME / 端口 / 预算 / 停摆重试都在 `spawnServeFixture` 里（见该文件的说明）。
 * registry/workspace 预置走夹具的 `seed` 钩子（serve 启动即读，必须在 spawn 前落盘）；
 * `--resume` 的 seed 会话文件因路径要先于 spawn 定下，自建一个临时目录（见第三个 describe）。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

type Frame = { type: string; [k: string]: unknown };

/** 预置 2 个 agent 的 agentDir + workspace.json + registry.json（serve 启动即读）。 */
async function seedAgentRegistry(home: string): Promise<void> {
	for (const name of ["hr", "ops"]) {
		const agentDir = path.join(home, "agents", name);
		await fs.mkdir(path.join(agentDir, ".cornfield"), { recursive: true });
		await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true });
		await Bun.write(
			path.join(agentDir, ".cornfield", "workspace.json"),
			JSON.stringify({
				schemaVersion: 2,
				id: name,
				name: `${name}-agent`,
				type: "agent",
				root: ".",
				projectRoot: ".",
				skillsDir: ".cornfield/skills/",
				sessionsDir: "sessions/",
			}),
		);
	}
	const registryDir = path.join(home, ".cornfield", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: {
				hr: {
					path: path.join(home, "agents", "hr"),
					registeredAt: new Date().toISOString(),
					template: "default",
				},
				ops: {
					path: path.join(home, "agents", "ops"),
					registeredAt: new Date().toISOString(),
					template: "default",
				},
			},
		}),
	);
}

describe("多 Agent 注册表与推送隔离", () => {
	let fixture: ServeFixture | undefined;

	beforeAll(async () => {
		fixture = await spawnServeFixture({ homePrefix: "omp-serve-p3-", seed: seedAgentRegistry });
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
	});

	test("serve 多 Agent：注册表 + attach + switch + 隔离 + 心跳", async () => {
		const url = fixture!.url;
		const token = fixture!.token;

		// ── 连接 A：默认 focus=default ──
		const connA = await WireConn.connect(url, token);
		const helloPush = await connA.nextPush("server_snapshot");
		const sessions = (helloPush.event as unknown as { sessions: Array<{ id: string; attached: boolean }> }).sessions;
		expect(sessions.map(s => s.id).sort()).toEqual(["default", "hr", "ops"]);
		// 基线对齐（c481a2a214 preload）：serve 启动即预挂载所有注册 agent，hr 已 attached
		expect(sessions.find(s => s.id === "hr")?.attached).toBe(true);
		expect(sessions.find(s => s.id === "default")?.attached).toBe(true);
		// hello 后自动推 default 的 session_snapshot
		const snap = await connA.nextPush("session_snapshot");
		expect(snap.event.sessionId).toBe("default");

		// ── attach hr（lazy 建 session）──
		const attachResp = await connA.request({ type: "attach", sessionId: "hr" });
		expect(attachResp.ok).toBe(true);
		const sessionFile = (attachResp.result as { sessionFile?: string }).sessionFile;
		expect(sessionFile).toContain(path.join("agents", "hr", "sessions"));

		// ── switch 到 hr：焦点切换 + 快照切到 hr ──
		const switchResp = await connA.request({ type: "switch_session", sessionId: "hr" });
		expect(switchResp.ok).toBe(true);
		const hrSnap = await connA.nextPush("session_snapshot");
		expect(hrSnap.event.sessionId).toBe("hr");

		// ── 定向命令：set_todos 定到 hr（无需 switch）──
		const todosResp = await connA.request({
			type: "set_todos",
			sessionId: "hr",
			phases: [{ name: "P3", tasks: [{ content: "x", status: "pending" }] }],
		});
		expect(todosResp.ok).toBe(true);

		// ── 隔离：B 连接 focus=default，hr 的事件不推 B ──
		const connB = await WireConn.connect(url, token);
		const bSnap = await connB.nextPush("session_snapshot");
		expect(bSnap.event.sessionId).toBe("default");
		// A（focus=hr）写 todos 产生 hr 快照推送——只给 A，不给 B
		await connA.request({
			type: "set_todos",
			sessionId: "hr",
			phases: [{ name: "P3b", tasks: [] }],
		});
		const aPush2 = await connA.nextPush("session_snapshot");
		expect(aPush2.event.sessionId).toBe("hr");
		// B 不该收到 hr 的推送——等 300ms 验证静默
		let bGotForeign = false;
		connB.onPush(ev => {
			if (ev.type === "session_snapshot" && ev.sessionId === "hr") bGotForeign = true;
		});
		await connA.request({ type: "set_todos", sessionId: "hr", phases: [] });
		await new Promise(r => setTimeout(r, 300));
		expect(bGotForeign).toBe(false);

		// ── get_available_models 真实现 —— 协议结构验证 ──
		// 模型列表依赖运行环境配置的 provider/key（auth.db）；隔离 HOME 下
		// 无 key 时返回空是正确行为，不能断言非空。协议契约：ok + models
		// 数组 + 停用名单结构正确。非空断言留给有 key 的 E2E（E2E=1）。
		const modelsResp = await connA.request({ type: "get_available_models", sessionId: "hr" });
		expect(modelsResp.ok).toBe(true);
		const models = (modelsResp.result as { models: unknown[] }).models;
		expect(Array.isArray(models)).toBe(true);
		if (models.length > 0) {
			const first = models[0] as Record<string, unknown>;
			expect(first.provider).toBeTruthy();
			expect(first.id).toBeTruthy();
		}

		// ── 未 attach 的 agent 定向命令 → 显式报错（preload 后需先 detach）──
		const detachResp = await connA.request({ type: "detach", sessionId: "ops" });
		expect(detachResp.ok).toBe(true);
		const notAttached = await connA.request({ type: "get_state", sessionId: "ops" });
		expect(notAttached.ok).toBe(false);
		expect(String(notAttached.error)).toMatch(/not attached/);

		// ── ping/pong ──
		const pong = await connA.ping();
		expect(pong.type).toBe("pong");

		// ── host_tools 注册（P3 双向帧）──
		const htResp = await connA.request({
			type: "set_host_tools",
			sessionId: "hr",
			tools: [{ name: "cron", description: "cron tool", parameters: { type: "object" } }],
		});
		expect(htResp.ok).toBe(true);
		expect((htResp.result as { toolNames: string[] }).toolNames).toEqual(["cron"]);
		const htPush = await connA.nextPush("host_tools_changed");
		expect(htPush.event.sessionId).toBe("hr");

		connA.close();
		connB.close();
	}, 60_000);
});

describe("default agent 根不随启动目录（从包目录启动）", () => {
	let fixture: ServeFixture | undefined;
	let repoRoot: string;

	beforeAll(async () => {
		repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
		// 在仓库子目录（包目录）里启动 serve。
		fixture = await spawnServeFixture({
			homePrefix: "omp-serve-root-",
			cwd: path.join(repoRoot, "packages", "coding-agent"),
		});
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
	});

	test("default agent 根 = 官方默认家；启动目录的 git 仓库根归位只作用于会话工作根", async () => {
		const conn = await WireConn.connect(fixture!.url, fixture!.token);
		const helloPush = await conn.nextPush("server_snapshot");
		const sessions = (
			helloPush.event as unknown as {
				sessions: Array<{ id: string; agentDir: string }>;
			}
		).sessions;
		const def = sessions.find(s => s.id === "default");
		// 身份根 = 官方默认家（`getDefaultAgentHome()`）：与「你在哪个目录起了 serve」无关。
		// 旧语义（内建兜底 = `process.cwd()`）下这里会是 repoRoot —— serve 启动时
		// `setProjectDir` 会 chdir 到启动目录的 git 仓库根，「根归位」就是那条链路的产物；
		// 票 28 下半把兜底换成默认家后，这条链路不再碰身份根（下面的工作根断言仍是真的）。
		expect(path.resolve(def?.agentDir ?? "")).toBe(path.join(fixture!.home, ".cornfield", "agents", "default"));
		expect(path.resolve(def?.agentDir ?? "")).not.toBe(repoRoot);

		// 归位那条语义本身仍然成立，只是不再作用于身份根：从包目录启动时，serve 的
		// 进程 / 会话工作根仍是启动目录的 git 仓库根（`serve.ts` 的 `setProjectDir(projectRoot)`），
		// `get_state.env.repos` 读的就是这个 cwd 的 basename。
		// （fs / git 命令面在新语义下的根部断言在 `wire-server-workspace-boundary` 的 C 组与
		// `wire-server-fs` —— 那里才是它们唯一该被钉住的地方。）
		const state = await conn.request({ type: "get_state" });
		expect(state.ok).toBe(true);
		const env = (state.result as { env?: { repos?: string } }).env;
		expect(env?.repos).toBe(path.basename(repoRoot));
		conn.close();
	}, 60_000);
});

describe("B1/B8 回归（get_state env + branch）", () => {
	let fixture: ServeFixture | undefined;
	let seedDir: string;

	beforeAll(async () => {
		// 预置含 user message 的历史会话文件——branch 需要真实 user entry，不打 LLM。
		// `--resume` 的路径必须在 spawn 时就已存在，所以 seed 文件放在自己的临时目录里，
		// 会话内的 cwd 与该目录一致（与迁移前「seed 文件就放在它自己的 cwd 下」同形）。
		seedDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-b1b8-seed-"));
		const now = new Date().toISOString();
		await Bun.write(
			path.join(seedDir, "seed-session.jsonl"),
			`${[
				JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: seedDir }),
				JSON.stringify({
					type: "model_change",
					id: "seedmodel",
					parentId: null,
					timestamp: now,
					model: "narwal-plan/deepseek-v4-flash",
				}),
				JSON.stringify({
					type: "message",
					id: "seed-user-1",
					parentId: "seedmodel",
					timestamp: now,
					message: {
						role: "user",
						content: [{ type: "text", text: "branch e2e seed message" }],
						attribution: "user",
						timestamp: Date.now(),
					},
				}),
			].join("\n")}\n`,
		);

		fixture = await spawnServeFixture({
			homePrefix: "omp-serve-b1b8-",
			extraArgs: ["--resume", path.join(seedDir, "seed-session.jsonl")],
		});
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
		await fs.rm(seedDir, { recursive: true, force: true });
	});

	test("serve B1/B8：get_state env 环境摘要 + branch 命令（快照推送）", async () => {
		const conn = await WireConn.connect(fixture!.url, fixture!.token);
		// hello 自动推送先消费掉（server_snapshot + session_snapshot）
		await conn.nextPush("server_snapshot");
		await conn.nextPush("session_snapshot");

		// ── B1：get_state env 摘要（repos/branch/activeAgentCount；pendingCronCount 缺省不崩）──
		const stateResp = await conn.request({ type: "get_state" });
		expect(stateResp.ok).toBe(true);
		const env = (stateResp.result as { env?: Record<string, unknown> }).env;
		expect(env).toBeDefined();
		const repos = env?.repos;
		expect(typeof repos).toBe("string");
		expect((repos as string).length).toBeGreaterThan(0);
		// branch 字段必须在（非 git 环境可为 null，但键不缺失）
		expect(Object.hasOwn(env ?? {}, "branch")).toBe(true);
		expect(env?.activeAgentCount).toBe(1); // 仅 default attached（隔离 HOME 无注册 agent）
		expect(Object.hasOwn(env ?? {}, "pendingCronCount")).toBe(false); // wire 面无 cron 数据源，省略

		// ── B8：branch 命令（语义对齐 rpc-mode）──
		const bmResp = await conn.request({ type: "get_branch_messages" });
		expect(bmResp.ok).toBe(true);
		const messages = (bmResp.result as { messages: Array<{ entryId: string; text: string }> }).messages;
		const seed = messages.find(m => m.text.includes("branch e2e seed message"));
		expect(seed).toBeDefined();

		const branchResp = await conn.request({ type: "branch", entryId: seed?.entryId ?? "" });
		expect(branchResp.ok).toBe(true);
		const branchResult = branchResp.result as { text: string; cancelled: boolean };
		expect(branchResult.cancelled).toBe(false);
		expect(branchResult.text).toContain("branch e2e seed message");

		// branch 后推权威快照（MUTATING_NO_EVENT）
		const snap = await conn.nextPush("session_snapshot");
		expect(snap.event.sessionId).toBe("default");
		conn.close();
	}, 60_000);
});

class WireConn {
	static async connect(url: string, token: string): Promise<WireConn> {
		const ws = new WebSocket(url);
		const conn = new WireConn(ws);
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
		});
		ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token }));
		const ack = await conn.next(f => f.type === "hello_ack", 10_000);
		if (ack === undefined) throw new Error("no hello_ack");
		return conn;
	}

	readonly #ws: WebSocket;
	readonly #frames: Frame[] = [];
	readonly #waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
	readonly #pushListeners = new Set<(ev: Record<string, unknown>) => void>();
	#seq = 0;

	constructor(ws: WebSocket) {
		this.#ws = ws;
		this.#ws.onmessage = ev => {
			const frame = JSON.parse(String(ev.data)) as Frame;
			const waiter = this.#waiters.find(w => w.pred(frame));
			if (waiter) {
				this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
				waiter.resolve(frame);
			} else {
				this.#frames.push(frame);
			}
			if (frame.type === "push") {
				for (const l of this.#pushListeners) l(frame.event as Record<string, unknown>);
			}
		};
	}

	async next(pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined> {
		const idx = this.#frames.findIndex(pred);
		if (idx >= 0) return this.#frames.splice(idx, 1)[0];
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				const i = this.#waiters.indexOf(waiter);
				if (i >= 0) this.#waiters.splice(i, 1);
				resolve(undefined);
			}, timeoutMs);
			const waiter = {
				pred: (f: Frame) => {
					if (!pred(f)) return false;
					clearTimeout(timer);
					return true;
				},
				resolve,
			};
			this.#waiters.push(waiter);
		});
	}

	async nextPush(
		eventType: string,
		timeoutMs = 15_000,
	): Promise<{ event: Record<string, unknown> & { sessionId: string } }> {
		const f = await this.next(
			fr => fr.type === "push" && (fr.event as { type: string }).type === eventType,
			timeoutMs,
		);
		if (!f) throw new Error(`timeout waiting push ${eventType}; got: ${JSON.stringify(this.#frames.slice(-3))}`);
		return { event: f.event as Record<string, unknown> & { sessionId: string } };
	}

	onPush(l: (ev: Record<string, unknown>) => void): void {
		this.#pushListeners.add(l);
	}

	async request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Frame> {
		const id = `r${++this.#seq}`;
		this.#ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
		const f = await this.next(fr => fr.type === "response" && fr.id === id, timeoutMs);
		if (!f) throw new Error(`request timeout: ${command.type}`);
		return f;
	}

	async ping(): Promise<Frame> {
		this.#ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
		const f = await this.next(fr => fr.type === "pong", 10_000);
		if (!f) throw new Error("pong timeout");
		return f;
	}

	close(): void {
		this.#ws.close();
	}
}
