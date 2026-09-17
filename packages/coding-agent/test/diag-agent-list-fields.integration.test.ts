/**
 * T6 · Agent 列表字段补真 —— 集成测试。
 *
 * 守的判据（对应 squad 任务包的 acceptance）：
 *   1. 工作区分组：`loadAgentMetas` 把 `workspace.json domain` 读到 `AgentMeta.role`，
 *      `list_agents` 的 wire 回包里就带 `role`（web-app 用它分组，>1 个 domain 即可观察到 >1 组）。
 *   2. 卡片死字段：`cronCount` / `lastAction` 是 web-app 侧 DTO 字段，wire 的 `SessionListEntry`
 *      **没有**这两个字段 —— 下发的 wire 回包里不许出现它们（「有真值」或「不再渲染」的协议半面：
 *      这里锁「wire 不下发死字段」这一半，UI 半面在 web-app 交接说明里）。
 *   3. 状态语义：`active` / `attached` 是布尔（连接焦点 / 是否挂载），wire 面**没有** `status`
 *      这样的进程状态字段 —— 运行中/空闲的文案是 web-app 适配层从 active/attached 推导的投影。
 *
 * 隔离：一条直接测 `loadAgentMetas`（HOME + config root 隔离），一条走 `spawnServeFixture`
 * 起真 serve 子进程打 `list_agents`（隔离 HOME / 端口 / 预算都在夹具里）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setConfigRootDir } from "@cornfield/utils";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { loadAgentMetas } from "../src/server/session-registry";
import { SERVE_BOOT_BUDGET_MS, type ServeFixture, spawnServeFixture } from "./wire-serve-fixture";

type Frame = { type: string; id?: string; ok?: boolean; error?: string; result?: unknown; [k: string]: unknown };

/** 预置 3 个 agent 的 registry + workspace.json：hr/软件 有 domain，ops 没有 domain。 */
async function seedAgentRegistry(home: string): Promise<void> {
	const domains: Record<string, string | undefined> = { hr: "HR", sw: "软件", ops: undefined };
	for (const [name, domain] of Object.entries(domains)) {
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
				...(domain === undefined ? {} : { domain }),
			}),
		);
	}
	const registryDir = path.join(home, ".cornfield", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	const agents: Record<string, unknown> = {};
	for (const name of Object.keys(domains)) {
		agents[name] = {
			path: path.join(home, "agents", name),
			registeredAt: new Date().toISOString(),
			template: "default",
		};
	}
	await Bun.write(path.join(registryDir, "registry.json"), JSON.stringify({ version: 2, agents }));
}

describe("Agent 列表字段（role / 死字段 / 状态语义）", () => {
	test("loadAgentMetas：workspace.json domain → AgentMeta.role（无 domain 则 undefined）", async () => {
		const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-list-fields-meta-"));
		const savedHome = process.env.HOME;
		const savedConfigRoot = getConfigRootDir();
		process.env.HOME = isolatedHome;
		setConfigRootDir(isolatedHome);

		try {
			await seedAgentRegistry(isolatedHome);
			const metas = await loadAgentMetas();
			const byId = new Map(metas.map(m => [m.id, m]));
			expect(byId.get("hr")?.role).toBe("HR");
			expect(byId.get("sw")?.role).toBe("软件");
			// 没声明 domain 的 agent：role 缺省（web-app 回落「默认工作区」），不编一个值
			expect(byId.get("ops")?.role).toBeUndefined();
		} finally {
			process.env.HOME = savedHome;
			setConfigRootDir(savedConfigRoot);
			await fs.rm(isolatedHome, { recursive: true, force: true });
		}
	});
});

describe("list_agents wire 回包字段契约", () => {
	let fixture: ServeFixture | undefined;

	beforeAll(async () => {
		fixture = await spawnServeFixture({ homePrefix: "omp-list-fields-", seed: seedAgentRegistry });
	}, SERVE_BOOT_BUDGET_MS);

	afterAll(async () => {
		await fixture?.dispose();
	});

	test("role 真下发（>1 domain 可分组）；wire 不下发 cronCount/lastAction/status", async () => {
		const ws = await connect(fixture!.url);
		try {
			const result = await request(ws, { type: "list_agents" });
			const agents = (result as { agents?: Array<Record<string, unknown>> }).agents;
			expect(Array.isArray(agents)).toBe(true);

			const byId = new Map((agents ?? []).map(a => [String(a.id), a]));
			// role 真值下发：两个不同的 domain → web-app 侧「>1 组」可观察
			expect(byId.get("hr")?.role).toBe("HR");
			expect(byId.get("sw")?.role).toBe("软件");
			// 未声明 domain 的 agent：wire 不下发 role（web-app 回落「默认工作区」）
			expect(Object.hasOwn(byId.get("ops") ?? {}, "role")).toBe(false);

			// 死字段纪律：cronCount / lastAction 是 web-app DTO 字段，wire 回包不许出现
			for (const [id, entry] of byId) {
				expect(Object.hasOwn(entry, "cronCount"), `${id} 不该下发 cronCount`).toBe(false);
				expect(Object.hasOwn(entry, "lastAction"), `${id} 不该下发 lastAction`).toBe(false);
				expect(Object.hasOwn(entry, "status"), `${id} 不该下发 status`).toBe(false);
				expect(Object.hasOwn(entry, "workspace"), `${id} 不该下发 workspace`).toBe(false);
				// active/attached 是布尔（连接焦点 / 是否挂载），不是进程状态
				expect(typeof entry.active, `${id}.active`).toBe("boolean");
				expect(typeof entry.attached, `${id}.attached`).toBe("boolean");
			}
		} finally {
			ws.close();
		}
	}, 60_000);
});

async function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
	});
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token: "" }));
	const ack = await nextFrame(ws, f => f.type === "hello_ack", 10_000);
	if (!ack) throw new Error("no hello_ack");
	return ws;
}

let seq = 0;

async function request(ws: WebSocket, command: Record<string, unknown>): Promise<unknown> {
	const id = `t6${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const frame = await nextFrame(ws, f => f.type === "response" && f.id === id, 60_000);
	if (!frame) throw new Error(`timeout: ${String(command.type)}`);
	if (frame.ok !== true) throw new Error(`command failed: ${JSON.stringify(frame)}`);
	return frame.result;
}

function nextFrame(ws: WebSocket, pred: (f: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			ws.removeEventListener("message", onMessage as EventListener);
			resolve(undefined);
		}, timeoutMs);
		const onMessage = (ev: MessageEvent) => {
			const frame = JSON.parse(String(ev.data)) as Frame;
			if (!pred(frame)) return;
			clearTimeout(timer);
			ws.removeEventListener("message", onMessage as EventListener);
			resolve(frame);
		};
		ws.addEventListener("message", onMessage as EventListener);
	});
}
