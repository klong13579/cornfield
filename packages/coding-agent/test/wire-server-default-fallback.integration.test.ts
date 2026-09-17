/**
 * 回归：serve 内建 default meta 的兜底 agentDir。
 *
 * 受这条改动影响：在 `createWireCore`（src/server/wire-server.ts）里，内建 meta
 * 的兜底 `agentDir` 从 `process.cwd()` 改成 `getDefaultAgentHome()`。
 * - **没有声明**（registry.json 里没有 default 条目）：落到
 *   `<HOME>/.cornfield/agents/default`，与「default Agent 的家」同一条路径，而不是
 *   「你碰巧在哪个目录起了 serve」。
 * - **有声明**（registry.json 里有 default 条目，指向 default home）：
 *   `loadMetasSafe()` 之后的 `registerMeta(meta)` 会**覆盖**内建那条，agentDir 仍
 *   是 default home。
 *
 * 两条都断言：只测兜底会把「注册表赢」这条不变式测丢 —— 注册表赢是历史成立的行为，
 * 回归锁住「内建 → loadMetasSafe 后的 for 覆盖」这一**调用顺序**不能颠倒。
 *
 * 为什么 (B) 不让注册表条目指向**第三方路径**：serve 启动时 `assertDefaultAgentHome`
 * 会主动比对注册表条目 vs `getDefaultAgentHome()`，不一致直接 refuse 启动 —— 这是
 * 「default Agent 必须只有一个家」的既定契约。注册表赢的有效形态**就是**指向官方
 * default home。区分「覆盖发生 vs 没发生」靠「列表里出现来自注册表的另一条 meta
 * （hr）」这条物理证据：loadMetasSafe 的循环必须真的遍历，registerMeta 才有机会跑
 * —— 列表里没 hr ⇒ 循环被绕过 ⇒ 旧实现（process.cwd 兜底单独写一次）也会让
 * sessions 出现 default 但没 hr，覆盖不变式得在这里被锁住。
 *
 * 借助 `wire-serve-fixture` 的隔离 HOME 启动真 serve 子进程，从 `server_snapshot` 推帧
 * 里读 `sessions[i].agentDir`（= `meta.agentDir`，见 `SessionRegistry.buildSessionList`）。
 * 两条用例各自一个 `describe` + 各自一个 `ServeFixture`，互不污染。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

type SessionListEntry = { id: string; agentDir?: string };

class WireConn {
	static async connect(url: string, token: string): Promise<WireConn> {
		const ws = new WebSocket(url);
		const conn = new WireConn(ws);
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
		});
		ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token }));
		const ack = await conn.next(f => (f as { type: string }).type === "hello_ack", 10_000);
		if (ack === undefined) throw new Error("no hello_ack");
		return conn;
	}

	readonly #ws: WebSocket;
	readonly #frames: unknown[] = [];
	readonly #waiters: Array<{ pred: (f: unknown) => boolean; resolve: (f: unknown) => void }> = [];

	constructor(ws: WebSocket) {
		this.#ws = ws;
		this.#ws.onmessage = ev => {
			const frame = JSON.parse(String(ev.data)) as { type: string };
			const waiter = this.#waiters.find(w => w.pred(frame));
			if (waiter) {
				this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
				waiter.resolve(frame);
			} else {
				this.#frames.push(frame);
			}
		};
	}

	async next(pred: (f: unknown) => boolean, timeoutMs: number): Promise<unknown | undefined> {
		const idx = this.#frames.findIndex(pred);
		if (idx >= 0) return this.#frames.splice(idx, 1)[0];
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				const i = this.#waiters.indexOf(waiter);
				if (i >= 0) this.#waiters.splice(i, 1);
				resolve(undefined);
			}, timeoutMs);
			const waiter = {
				pred: (f: unknown) => {
					if (!pred(f)) return false;
					clearTimeout(timer);
					return true;
				},
				resolve,
			};
			this.#waiters.push(waiter);
		});
	}

	async nextPush(eventType: string, timeoutMs = 15_000): Promise<{ event: unknown }> {
		const f = await this.next(
			fr => (fr as { type: string }).type === "push" && (fr as { event: { type: string } }).event.type === eventType,
			timeoutMs,
		);
		if (!f) throw new Error(`timeout waiting push ${eventType}`);
		return { event: (f as { event: unknown }).event };
	}

	close(): void {
		this.#ws.close();
	}
}

async function readServerList(fixture: ServeFixture): Promise<SessionListEntry[]> {
	const conn = await WireConn.connect(fixture.url, fixture.token);
	try {
		const hello = await conn.nextPush("server_snapshot");
		return (hello.event as { sessions: SessionListEntry[] }).sessions;
	} finally {
		conn.close();
	}
}

/**
 * 写一份 registry.json 声明 default（指向隔离 HOME 下的 default home） + hr（指向
 * 临时 hr 目录）；default 必须 mkdir（assertDefaultAgentHome 不要求，但
 * `loadWorkspace` 在 home 之外 skip —— 我们这里不需要走 workspace，只是把
 * agentDir 元数据灌进去）。
 */
async function seedRegistryWithDefaultAndHr(home: string, hrDir: string): Promise<void> {
	const registryDir = path.join(home, ".cornfield", "agent");
	const defaultHome = path.join(home, ".cornfield", "agents", "default");
	await fs.mkdir(registryDir, { recursive: true });
	await fs.mkdir(defaultHome, { recursive: true });
	await fs.mkdir(hrDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: {
				default: {
					path: defaultHome,
					registeredAt: new Date().toISOString(),
					template: "default",
				},
				hr: {
					path: hrDir,
					registeredAt: new Date().toISOString(),
					template: "default",
				},
			},
		}),
	);
}

describe("default meta 兜底 agentDir = 官方默认家（无注册条目时）", () => {
	let fixture: ServeFixture | undefined;

	beforeAll(async () => {
		// 不 seed —— 隔离 HOME 下 registry.json 不存在（loadRegistry 返回空 registry）。
		fixture = await spawnServeFixture({ homePrefix: "omp-serve-default-fallback-" });
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
	});

	test("空注册表：default.agentDir === <HOME>/.cornfield/agents/default（不是 process.cwd）", async () => {
		const list = await readServerList(fixture!);
		const def = list.find(s => s.id === "default");
		expect(def?.agentDir).toBeDefined();
		// paths 归一化：可能两端对 tmpdir 的解析差出 /private/... 前缀
		const got = path.resolve(def?.agentDir ?? "");
		const want = path.join(fixture!.home, ".cornfield", "agents", "default");
		// 强断言 1：落到 getDefaultAgentHome()，且 process.cwd() ≠ 它
		expect(got).toBe(want);
		// 强断言 2：兜底值与 serve 进程 cwd 不同（这条是回归锚：旧实现是 process.cwd()，
		// 而 serve 进程 cwd 在 fixture 里是仓库根 —— 不可能等于 .cornfield/agents/default，
		// 因此只要旧实现还残留，这条就会假红）。
		expect(got).not.toBe(path.resolve(process.cwd()));
		// 强断言 3：空注册表场景下 server_snapshot 里只应有 default 一条
		expect(list.map(s => s.id).sort()).toEqual(["default"]);
	}, 30_000);
});

describe("default meta 仍以注册表条目为准（有 default 条目时）", () => {
	let fixture: ServeFixture | undefined;
	const hrDir = path.join("/tmp", `omp-default-registry-hr-${Date.now()}`);

	beforeAll(async () => {
		fixture = await spawnServeFixture({
			homePrefix: "omp-serve-default-registry-wins-",
			seed: h => seedRegistryWithDefaultAndHr(h, hrDir),
		});
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
		await fs.rm(hrDir, { recursive: true, force: true });
	});

	test("注册表声明 win：default.agentDir 落官方默认家，列表里出现 hr（覆盖代码路径被走过）", async () => {
		const list = await readServerList(fixture!);
		const def = list.find(s => s.id === "default");
		const hr = list.find(s => s.id === "hr");
		// 1) 注册表声明的 default agentDir = getDefaultAgentHome() —— 这是注册表赢的物理结果
		expect(def?.agentDir).toBeDefined();
		expect(path.resolve(def?.agentDir ?? "")).toBe(path.join(fixture!.home, ".cornfield", "agents", "default"));
		// 2) 列表里有 hr —— loadMetasSafe() 的循环确实遍历了 registry.json，registerMeta 真的被
		//    调用过；如果那条 for 循环被绕过，list 里只剩 default，不会出现 hr（这条覆盖不变式）。
		expect(hr).toBeDefined();
		expect(hr?.agentDir).toBeDefined();
		// 3) hr.agentDir = 注册表条目 path（同上：win path 的物理结果）
		expect(path.resolve(hr?.agentDir ?? "")).toBe(path.resolve(hrDir));
	}, 30_000);
});
