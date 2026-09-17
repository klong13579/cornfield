/**
 * F1 — 前端建 agent 的服务端那一段：`create_agent` 从 WS 一直走到**真磁盘**。
 *
 * 这条链要证明的是「点下去真的成立」这件事在服务端的一半：
 *   1. 答复里的 `agentDir` 是盘上真的存在的那一个（骨架文件 + workspace 声明都在）；
 *   2. 它真的进了 `~/.cornfield/agent/registry.json`，并且**同一个进程**的 `list_agents`
 *      立刻看得见它（注册表的权威是磁盘，进程内那份是缓存，不刷新就会「建好了但没身份证」）；
 *   3. 错误路径是 `ok:false` 且带**请求 id**、`error` 是服务端自己的话（名字非法 / template
 *      不认识 / mission 文件不存在），并且**报错就是真的没写**；
 *   4. 同名再来一次是 `created:false` 的**成功**（增量补齐），不是错误 —— 前端的面板文案就是
 *      按这一位分开的，改了这里就得改那边。
 *
 * 隔离：HOME 是临时目录，且**故意不预置 registry.json** —— 「真的写进 registry」是这条测试的
 * 主张之一，预置一份就把要证的结论当成前提了。
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentCreateDto, MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import type { InitResult } from "../src/cli/agent-cli";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; id?: string; ok?: boolean; error?: string; result?: unknown; [k: string]: unknown };

// 形状锁（编译期）：`create_agent` 的答复就是 coding-agent 的 `InitResult`，两个包不许漂移。
type _InitResultIsAgentCreateDto = InitResult extends AgentCreateDto ? true : never;
const _initResultShape: _InitResultIsAgentCreateDto = true;

test("create_agent：命令面 → 真写 agentDir + 真进 registry；同名是增量补齐；错误即 ok:false", async () => {
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-create-agent-"));
	const serveCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-create-agent-cwd-"));
	const savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	const agentsRoot = path.join(isolatedHome, ".cornfield", "agents");
	const registryFile = path.join(isolatedHome, ".cornfield", "agent", "registry.json");
	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

	const port = await freePort();
	const proc = Bun.spawn(
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
		{ cwd: serveCwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" } },
	);

	try {
		const handle = await waitForServe(proc, port);
		const ws = await connect(handle.url);

		// 基线：盘上没有 registry（本条测试没有预置它），列表里也就只有 default
		expect(await fileExists(registryFile)).toBe(false);
		expect(agentIds(await request(ws, { type: "list_agents" }))).toEqual(["default"]);

		// ── 建：答复是盘上真的那一份 ──
		const created = (await request(ws, { type: "create_agent", name: "hr-bot" })) as AgentCreateDto;
		const expectedDir = path.join(agentsRoot, "hr-bot");
		expect(created).toMatchObject({ name: "hr-bot", agentDir: expectedDir, created: true });
		// `filesWritten` 是「真写了几份骨架文件」的读数：新建就不会是 0（0 是增量补齐的读数，见下）
		expect(created.filesWritten).toBeGreaterThan(0);
		expect(created.attachedRoots).toBeUndefined();

		// 骨架真的在盘上（mission.md 是 ensureAgentDir 判定「新建 vs 增量」的那个文件）
		expect(await fileExists(path.join(expectedDir, "mission.md"))).toBe(true);
		expect(await fileExists(path.join(expectedDir, "AGENTS.md"))).toBe(true);
		const declaration = JSON.parse(await Bun.file(path.join(expectedDir, ".cornfield", "workspace.json")).text()) as {
			name?: string;
		};
		expect(declaration.name).toBe("hr-bot");

		// 真进 registry（本进程没预置过它，这份文件是这次调用写出来的）
		const registry = JSON.parse(await Bun.file(registryFile).text()) as {
			agents: Record<string, { path: string }>;
		};
		expect(registry.agents["hr-bot"]?.path).toBe(expectedDir);

		// 同一个 serve 进程立刻看得见它（进程内注册表已按磁盘刷新）
		expect(agentIds(await request(ws, { type: "list_agents" }))).toEqual(["default", "hr-bot"]);

		// 「进 registry」不只是列表上多一行：lazy attach 也按注册表找得到它
		const attached = (await request(ws, { type: "attach", sessionId: "hr-bot" })) as { sessionId: string };
		expect(attached.sessionId).toBe("hr-bot");

		// ── 同名再来一次：成功且是增量补齐，不是错误、也不多出一份 ──
		const again = (await request(ws, { type: "create_agent", name: "hr-bot" })) as AgentCreateDto;
		expect(again).toEqual({ name: "hr-bot", agentDir: expectedDir, created: false, filesWritten: 0 });
		expect(agentIds(await request(ws, { type: "list_agents" }))).toEqual(["default", "hr-bot"]);

		// ── `dir` 是路径语义：已存在的目录当父目录 ──
		const parent = path.join(isolatedHome, "custom-agents");
		await fs.mkdir(parent, { recursive: true });
		const nested = (await request(ws, { type: "create_agent", name: "ops", dir: parent })) as AgentCreateDto;
		expect(nested.agentDir).toBe(path.join(parent, "ops"));
		expect(await fileExists(path.join(nested.agentDir, "mission.md"))).toBe(true);

		// ── 错误路径：ok:false + 请求 id 原样回来 + 服务端原文 + 真的没写 ──
		const before = await Bun.file(registryFile).text();
		const listedBefore = agentIds(await request(ws, { type: "list_agents" }));

		for (const [label, command, matcher] of [
			["名字含 '..'", { name: "../escape" }, /Names cannot contain '\.\.'/],
			["名字为空", { name: "" }, /Invalid agent name/],
			["未知 template", { name: "tpl", template: "fancy" }, /Unknown template/],
			["mission 文件不存在", { name: "mis", mission: path.join(isolatedHome, "nope.md") }, /Mission file not found/],
		] as const) {
			const sent = await send(ws, { type: "create_agent", ...command });
			const frame = responded(sent);
			expect(`${label}: ${String(frame.ok)}`).toBe(`${label}: false`);
			expect(String(frame.error)).toMatch(matcher);
		}

		// 报错就是真的没写：registry 逐字节没变，列表也没变，坏名字的目录一个都没多出来
		expect(await Bun.file(registryFile).text()).toBe(before);
		expect(agentIds(await request(ws, { type: "list_agents" }))).toEqual(listedBefore);
		expect(await fileExists(path.join(agentsRoot, "escape"))).toBe(false);
		expect(await fileExists(path.join(agentsRoot, "mis"))).toBe(false);

		// 失败之后仍然建得成（上面那几次拒绝没有把进程搞成半坏状态）
		const afterErrors = (await request(ws, { type: "create_agent", name: "still-works" })) as AgentCreateDto;
		expect(afterErrors.created).toBe(true);
		expect(await fileExists(path.join(afterErrors.agentDir, "mission.md"))).toBe(true);

		// ── 并发：两个连接同时建，两个都得在 registry 里（一个条都不能少）──
		// registry.json 是 read-modify-write，而 serve 逐帧并发处理命令：没有串行化时两次读取都
		// 先于任何一次写入，后写的那次把先写的条目从 registry.json 里抹掉 —— 但两条命令都回
		// ok:true（agentDir 两份都在盘上，列表里少一个）。同一个连接上发的两帧会分开成两个事件循环
		// 回合、踩不到那个窗口，所以这里用**两个连接**（真并发），它就是那个回归的别据。
		const wsB = await connect(handle.url);
		const [raceA, raceB] = await Promise.all([
			send(ws, { type: "create_agent", name: "race-a" }),
			send(wsB, { type: "create_agent", name: "race-b" }),
		]);
		expect(responded(raceA).ok).toBe(true);
		expect(responded(raceB).ok).toBe(true);
		const afterRace = JSON.parse(await Bun.file(registryFile).text()) as { agents: Record<string, unknown> };
		expect(Object.keys(afterRace.agents).sort()).toEqual(["hr-bot", "ops", "race-a", "race-b", "still-works"]);
		expect(agentIds(await request(ws, { type: "list_agents" })).sort()).toEqual([
			"default",
			"hr-bot",
			"ops",
			"race-a",
			"race-b",
			"still-works",
		]);
		wsB.close();

		ws.close();
	} finally {
		proc.kill();
		await proc.exited;
		process.env.HOME = savedHome;
		await fs.rm(isolatedHome, { recursive: true, force: true });
		await fs.rm(serveCwd, { recursive: true, force: true });
	}
}, 120_000);

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

/** `list_agents` 答复 → 有序 agent 名（顺序由注册表灌入顺序决定，用作「没多也没少」的判据）。 */
function agentIds(result: unknown): string[] {
	const list = (result as { agents?: Array<{ id?: string }> }).agents ?? [];
	return list.map(a => String(a.id));
}

function freePort(): Promise<number> {
	return new Promise(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(p));
		});
	});
}

async function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = e => reject(new Error(`ws error: ${String(e)}`));
	});
	const token = url.match(/token=([a-zA-Z0-9]+)/)?.[1] ?? "";
	ws.send(JSON.stringify({ type: "hello", version: MULTIDEVICE_PROTOCOL_VERSION, token }));
	const ack = await nextFrame(ws, f => f.type === "hello_ack", 10_000);
	if (!ack) throw new Error("no hello_ack");
	return ws;
}

let seq = 0;

/** 发一条命令并等它的响应帧；**不做 ok 检查**（错误路径要看原始帧）。 */
async function send(ws: WebSocket, command: Record<string, unknown>): Promise<{ id: string; frame?: Frame }> {
	const id = `mk${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	return { id, frame: await nextFrame(ws, f => f.type === "response" && f.id === id, 60_000) };
}

/** 成功路径：拿到结果，失败直接抛（含服务端原文）。 */
async function request(ws: WebSocket, command: Record<string, unknown>): Promise<unknown> {
	const { frame } = await send(ws, command);
	if (!frame) throw new Error(`timeout: ${String(command.type)}`);
	if (frame.ok !== true) throw new Error(`command failed: ${JSON.stringify(frame)}`);
	return frame.result;
}

/** 错误路径的断言入口：既要求帧到了，也要求请求 id 原样回来（id 丢了客户端只能等超时）。 */
function responded(sent: { id: string; frame?: Frame }): Frame {
	if (!sent.frame) throw new Error(`no response frame for ${sent.id}`);
	expect(sent.frame.id).toBe(sent.id);
	return sent.frame;
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
