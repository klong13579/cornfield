/**
 * T8 写面 e2e — Project 声明/删除走真机 serve（bun WS 客户端）。
 *
 * 单测与桥测试已经各自证明存储层与桥的行为（test/server/projects-wire.test.ts 用真文件对账）；
 * 这条链路要证明的是**它们真的挂在命令面上**，而且是最后一段：
 *   `set_project` / `delete_project` 从 WS 一直走到 `~/.cornfield/agent/projects.json`，
 *   写面不 attach 任何 agent（声明一个 Project 与哪个 agent 附着无关）。
 *
 * 另一半是**错误响应路径**：桥里的错（相对 root / 空 projectId / root 被占用 / 存储坏了）必须变成
 * 一个 `ok:false` 且**带同一个请求 id** 的帧 —— 不是让 promise 拒掉、让客户端干等到超时。
 * 所以每个失败都用 `raw:true` 拿原始帧断言，并且回读真文件确认「报错就是真的没写」。
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; id?: string; ok?: boolean; error?: string; result?: unknown; [k: string]: unknown };

test("project：命令面 → 落盘 → 失败即 ok:false 且请求 id 不丢", async () => {
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-project-write-"));
	const savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	const registryDir = path.join(isolatedHome, ".cornfield", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(path.join(registryDir, "registry.json"), JSON.stringify({ version: 2, agents: {} }));
	const storeFile = path.join(registryDir, "projects.json");
	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const rootA = path.join(isolatedHome, "repos", "dtc");

	const port = await new Promise<number>(resolve => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(p));
		});
	});
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
		{ stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: isolatedHome, PI_NO_TITLE: "1" } },
	);

	try {
		const handle = await waitForServe(proc, port);
		const ws = await connect(handle.url);

		// 还没声明过 = 明确空集（不是「读不到」）。`currentProjectSource` 是 T27 加的权威归属来源字段，
		// 这里一并钉住它：空集时必须明说「没有来源」，而不是缺字段。
		expect(await request(ws, { type: "list_projects" })).toEqual({ projects: [], currentProjectSource: "none" });

		// 声明：答复是存储里那一份（root 归一），并且真的落了盘
		const created = (await request(ws, {
			type: "set_project",
			projectId: "dtc",
			name: "米克原子 DTC",
			root: path.join(isolatedHome, "repos", "..", "repos", "dtc"),
			defaultAgentId: "hr",
		})) as { project: Record<string, unknown> };
		expect(created.project).toEqual({
			projectId: "dtc",
			name: "米克原子 DTC",
			root: rootA,
			defaultAgentId: "hr",
		});

		const onDisk = JSON.parse(await Bun.file(storeFile).text()) as {
			version: number;
			projects: Record<string, { root: string; defaultAgentId?: string }>;
		};
		expect(onDisk.version).toBe(1);
		expect(onDisk.projects.dtc?.root).toBe(rootA);
		expect(onDisk.projects.dtc?.defaultAgentId).toBe("hr");

		// 读面看得见它（写面与读面是同一份事实）
		expect(await request(ws, { type: "list_projects" })).toEqual({
			projects: [{ projectId: "dtc", root: rootA, name: "米克原子 DTC", defaultAgentId: "hr" }],
			currentProjectSource: "none",
		});

		// 更新同一条（换 root、去掉 defaultAgentId）：答复里不该再带那个键
		const updated = (await request(ws, {
			type: "set_project",
			projectId: "dtc",
			name: "DTC",
			root: path.join(isolatedHome, "repos", "dtc-2"),
		})) as { project: Record<string, unknown> };
		expect(updated.project).toEqual({
			projectId: "dtc",
			name: "DTC",
			root: path.join(isolatedHome, "repos", "dtc-2"),
		});
		expect("defaultAgentId" in updated.project).toBe(false);

		// ── 错误路径：都是 ok:false，且请求 id 原样回来 ──
		const before = await Bun.file(storeFile).text();
		const relative = await send(ws, { type: "set_project", projectId: "x", name: "X", root: "repos/x" });
		expect(responded(relative).ok).toBe(false);
		expect(String(responded(relative).error)).toMatch(/absolute path/);

		const emptyId = await send(ws, {
			type: "set_project",
			projectId: "  ",
			name: "X",
			root: path.join(isolatedHome, "x"),
		});
		expect(responded(emptyId).ok).toBe(false);
		expect(String(responded(emptyId).error)).toMatch(/projectId/);

		// root 被别的 Project 占用：不许悄悄接管
		const clash = await send(ws, {
			type: "set_project",
			projectId: "other",
			name: "Other",
			root: path.join(isolatedHome, "repos", "dtc-2"),
		});
		expect(responded(clash).ok).toBe(false);
		expect(String(responded(clash).error)).toMatch(/already declared by project "dtc"/);

		// 报错就是真的没写：存储文件逐字节没变，也没有多出别的 Project
		expect(await Bun.file(storeFile).text()).toBe(before);
		expect((await request(ws, { type: "list_projects" })) as unknown).toEqual({
			projects: [{ projectId: "dtc", root: path.join(isolatedHome, "repos", "dtc-2"), name: "DTC" }],
			currentProjectSource: "none",
		});

		// 删一个本来就不在的 Project = 错误（不是一次成功的空删除）
		const ghost = await send(ws, { type: "delete_project", projectId: "nope" });
		expect(responded(ghost).ok).toBe(false);
		expect(String(responded(ghost).error)).toMatch(/nothing was removed/);
		expect(await Bun.file(storeFile).text()).toBe(before);

		// 真删：答复 projectId，盘上不再有它
		expect(await request(ws, { type: "delete_project", projectId: "dtc" })).toEqual({ projectId: "dtc" });
		expect(await request(ws, { type: "list_projects" })).toEqual({ projects: [], currentProjectSource: "none" });
		expect(await Bun.file(storeFile).text()).not.toContain("dtc");

		// 存储坏了：读面与写面都 ok:false（不当成「没声明过」）
		await Bun.write(storeFile, "{ not json");
		const badList = await send(ws, { type: "list_projects" });
		expect(responded(badList).ok).toBe(false);
		expect(String(responded(badList).error)).toMatch(/not valid JSON/);

		const badWrite = await send(ws, {
			type: "set_project",
			projectId: "a",
			name: "A",
			root: path.join(isolatedHome, "a"),
		});
		expect(responded(badWrite).ok).toBe(false);
		expect(String(responded(badWrite).error)).toMatch(/not valid JSON/);

		ws.close();
	} finally {
		proc.kill();
		await proc.exited;
		process.env.HOME = savedHome;
		await fs.rm(isolatedHome, { recursive: true, force: true });
	}
}, 60_000);

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
	const id = `proj${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	return { id, frame: await nextFrame(ws, f => f.type === "response" && f.id === id, 30_000) };
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
