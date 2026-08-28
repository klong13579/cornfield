/**
 * per-agent 配置 e2e — 工具开关显示/写回与 .omp 配置文件双向一致（P3 多 Agent）。
 *
 * 隔离 HOME + registry.json 预置 2 个 agent（hr / ops，指向独立 agentDir）。
 * 覆盖：
 *   1. get_tool_switches：按 agent 返回工具开关语义视图（文件优先 + 内核默认回落）
 *   2. set_config(sessionId) → 写该 agent 的 <agentDir>/config.yml（文件级验证）
 *   3. 隔离：hr 的开关修改不影响 ops；ops 的 config.yml 不被污染
 *   4. get_tool_switches 反映 set_config 后的文件值（显示 = 文件）
 *   5. python.toolMode 枚举读写
 *   6. default agent 的 set_config 落 ~/.omp/agent/config.yml（全局 agent 目录）
 *
 * 不发 prompt（不触发计费）。
 */

import { expect, test } from "bun:test";
import { YAML } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@oh-my-pi/pi-wire";
import { waitForServe } from "./wait-for-serve";

const TOKEN_RE = /ws:\/\/127\.0\.0\.1:(\d+)\/ws(\?token=([a-zA-Z0-9]+))?/;

type Frame = { type: string; [k: string]: unknown };

async function setupAgents(isolatedHome: string): Promise<void> {
	for (const name of ["hr", "ops"]) {
		const agentDir = path.join(isolatedHome, "agents", name);
		await fs.mkdir(path.join(agentDir, ".omp"), { recursive: true });
		await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true });
		await Bun.write(
			path.join(agentDir, ".omp", "workspace.json"),
			JSON.stringify({
				schemaVersion: 2,
				id: name,
				name: `${name}-agent`,
				type: "agent",
				root: ".",
				projectRoot: ".",
				skillsDir: ".omp/skills/",
				sessionsDir: "sessions/",
			}),
		);
	}
	const registryDir = path.join(isolatedHome, ".omp", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: {
				hr: {
					path: path.join(isolatedHome, "agents", "hr"),
					registeredAt: new Date().toISOString(),
					template: "default",
				},
				ops: {
					path: path.join(isolatedHome, "agents", "ops"),
					registeredAt: new Date().toISOString(),
					template: "default",
				},
			},
		}),
	);
}

test("serve per-agent 配置：get_tool_switches + set_config 定向写各自 config.yml", async () => {
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-settings-"));
	const savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;
	await setupAgents(isolatedHome);

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const cliPath = `${repoRoot}/packages/coding-agent/src/cli.ts`;
	const port = 56000 + Math.floor(Math.random() * 8000);
	const proc = Bun.spawn(["bun", cliPath, "serve", "--port", String(port), "--host", "127.0.0.1", "--no-extensions"], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" },
	});

	const hrConfigPath = path.join(isolatedHome, "agents", "hr", "config.yml");
	const opsConfigPath = path.join(isolatedHome, "agents", "ops", "config.yml");

	try {
		const url = (await waitForServe(proc, port)).url;
		const token = url.match(TOKEN_RE)?.[2] ?? "";
		const conn = await WireConn.connect(url, token);
		// hello 自动推送先消费掉（server_snapshot + session_snapshot）
		await conn.nextPush("server_snapshot");
		await conn.nextPush("session_snapshot");

		// ── 1. get_tool_switches：hr 的默认开关视图（未配置 → 内核默认）──
		const swResp = await conn.request({ type: "get_tool_switches", sessionId: "hr" });
		expect(swResp.ok).toBe(true);
		const sw = swResp.result as { tools: Array<{ tool: string; label: string; path: string; enabled: boolean }>; pythonToolMode: string };
		expect(Array.isArray(sw.tools)).toBe(true);
		expect(sw.tools.length).toBeGreaterThan(10);
		const searchSwitch = sw.tools.find(t => t.tool === "search");
		expect(searchSwitch).toBeDefined();
		expect(searchSwitch?.path).toBe("search.enabled");
		expect(searchSwitch?.enabled).toBe(true); // 默认开启
		expect(sw.pythonToolMode).toBe("both");
		// 每项都带可写回路径
		for (const t of sw.tools) expect(t.path.length).toBeGreaterThan(0);

		// ── 2. set_config(sessionId) 定向写 hr 的 config.yml（文件级验证）──
		const setResp = await conn.request({ type: "set_config", sessionId: "hr", key: "search.enabled", value: false });
		expect(setResp.ok).toBe(true);
		const hrFile = YAML.parse(await Bun.file(hrConfigPath).text()) as Record<string, unknown>;
		expect(hrFile.search).toEqual({ enabled: false });

		// ── 3. get_config / get_tool_switches 反映文件值（显示 = 文件）──
		const getResp = await conn.request({ type: "get_config", sessionId: "hr", key: "search.enabled" });
		expect(getResp.ok).toBe(true);
		expect((getResp.result as { config: unknown }).config).toBe(false);
		const swAfter = await conn.request({ type: "get_tool_switches", sessionId: "hr" });
		const searchAfter = ((swAfter.result as { tools: Array<{ tool: string; enabled: boolean }> }).tools ?? []).find(
			t => t.tool === "search",
		);
		expect(searchAfter?.enabled).toBe(false);

		// ── 4. 隔离：ops 的开关不受 hr 影响，且文件不被污染 ──
		const opsSw = await conn.request({ type: "get_tool_switches", sessionId: "ops" });
		const opsSearch = ((opsSw.result as { tools: Array<{ tool: string; enabled: boolean }> }).tools ?? []).find(
			t => t.tool === "search",
		);
		expect(opsSearch?.enabled).toBe(true);
		await expect(Bun.file(opsConfigPath).exists()).resolves.toBe(false); // ops 的 config.yml 未被创建

		// ── 5. python.toolMode 枚举读写 ──
		const pyResp = await conn.request({ type: "set_config", sessionId: "hr", key: "python.toolMode", value: "bash-only" });
		expect(pyResp.ok).toBe(true);
		const pyAfter = await conn.request({ type: "get_tool_switches", sessionId: "hr" });
		expect((pyAfter.result as { pythonToolMode: string }).pythonToolMode).toBe("bash-only");

		// ── 6. default agent：set_config 落 ~/.omp/agent/config.yml（非 cwd）──
		const defSet = await conn.request({ type: "set_config", key: "custom.perAgentProbe", value: 7 });
		expect(defSet.ok).toBe(true);
		const defGet = await conn.request({ type: "get_config", key: "custom.perAgentProbe" });
		expect((defGet.result as { config: unknown }).config).toBe(7);
		const globalConfigPath = path.join(isolatedHome, ".omp", "agent", "config.yml");
		const globalConfig = YAML.parse(await Bun.file(globalConfigPath).text()) as Record<string, unknown>;
		expect(globalConfig.custom).toEqual({ perAgentProbe: 7 });

		conn.close();
	} finally {
		proc.kill();
		await proc.exited;
		process.env.HOME = savedHome;
		await fs.rm(isolatedHome, { recursive: true, force: true });
	}
}, 60_000);

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

	constructor(ws: WebSocket) {
		this.#ws = ws;
		this.#ws.onmessage = ev => {
			const frame = JSON.parse(String(ev.data)) as Frame;
			const idx = this.#waiters.findIndex(w => w.pred(frame));
			if (idx >= 0) {
				const [waiter] = this.#waiters.splice(idx, 1);
				waiter.resolve(frame);
			} else {
				this.#frames.push(frame);
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
		if (!f) throw new Error(`timeout waiting push ${eventType}`);
		return { event: f.event as Record<string, unknown> & { sessionId: string } };
	}

	async request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Frame> {
		const id = `r${++this.#seq}`;
		this.#ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
		const f = await this.next(fr => fr.type === "response" && fr.id === id, timeoutMs);
		if (!f) throw new Error(`request timeout: ${command.type}`);
		return f;
	}

	#seq = 0;

	close(): void {
		this.#ws.close();
	}
}