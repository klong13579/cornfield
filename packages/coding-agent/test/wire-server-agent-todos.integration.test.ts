/**
 * T10A e2e — Agent Todo 板走真机 serve（bun WS 客户端）。
 *
 * 单测已经证明存储层与桥的行为；这条链路要证明的是**它们真的挂在命令面上**：
 * 三条命令（list / set / delete）从 WS 一直走到 `<agentDir>/.cornfield/agent-todos.json`，
 * 并且失败的那几种情况回的是 ok:false（不是一份看起来成功的空结果）。
 *
 * 只读/只写 agentDir，不 lazy attach：列一块板不该把 agent 拉起来，所以这里从头到尾
 * 没有 attach 过 hr。
 *
 * 另一半是**错误响应路径**：桥里的错（owner / Project / 声明读不出来 / 存储坏了）必须变成
 * 一个带同一个请求 id 的 ok:false frame —— 不是让 promise 拒掉、让客户端干等到超时。
 * 所以每个失败都用 `raw:true` 拿原始帧来断言，而不是只看 throw。
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MULTIDEVICE_PROTOCOL_VERSION } from "@cornfield/wire";
import { waitForServe } from "./wait-for-serve";

type Frame = { type: string; [k: string]: unknown };

interface AgentTodoDto {
	id: string;
	agentId: string;
	projectId?: string;
	title: string;
	status: string;
	priority: string;
	source: string;
	sessionRefs: string[];
	createdAt: number;
	updatedAt: number;
}

test("agent todo：命令面 → 落盘 → owner/Project 边界", async () => {
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-serve-t10a-"));
	const savedHome = process.env.HOME;
	process.env.HOME = isolatedHome;

	const hrDir = path.join(isolatedHome, "agents", "hr");
	await fs.mkdir(path.join(hrDir, ".cornfield"), { recursive: true });
	await Bun.write(
		path.join(hrDir, ".cornfield", "workspace.json"),
		JSON.stringify({ schemaVersion: 2, id: "hr", name: "hr-agent", type: "agent", root: ".", projectRoot: "." }),
	);
	// 声明读不出内容的 agent：它的 Project 绑定上限**无法确定**，所以 list 与 write 都必须硬报错
	// （当成「未约束」就是绕开隔离）。
	const brokenDir = path.join(isolatedHome, "agents", "broken");
	await fs.mkdir(path.join(brokenDir, ".cornfield"), { recursive: true });
	await Bun.write(path.join(brokenDir, ".cornfield", "workspace.json"), "{ not json");

	const registryDir = path.join(isolatedHome, ".cornfield", "agent");
	await fs.mkdir(registryDir, { recursive: true });
	await Bun.write(
		path.join(registryDir, "registry.json"),
		JSON.stringify({
			version: 2,
			agents: {
				hr: { path: hrDir, registeredAt: new Date().toISOString(), template: "default" },
				broken: { path: brokenDir, registeredAt: new Date().toISOString(), template: "default" },
			},
		}),
	);
	// 只声明一个 Project：绑定范围之外的 Project 必须被拒，而不是被当成本地随便写的字符串。
	await Bun.write(
		path.join(registryDir, "projects.json"),
		JSON.stringify({
			version: 1,
			projects: {
				cornfield: { projectId: "cornfield", root: path.join(isolatedHome, "cornfield"), name: "CornField" },
			},
		}),
	);

	const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
	const port = 57000 + Math.floor(Math.random() * 8000);
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

		// 空板：还没记过，是明确的事实（不是「读不到」）
		expect(await request(ws, { type: "list_agent_todos", sessionId: "hr" })).toEqual({ agentId: "hr", todos: [] });

		const todo: AgentTodoDto = {
			id: "todo-1",
			agentId: "hr",
			projectId: "cornfield",
			title: "把 VLA 候选人面试排期定了",
			status: "open",
			priority: "high",
			source: "user",
			sessionRefs: [],
			createdAt: 0,
			updatedAt: 0,
		};
		const written = (await request(ws, { type: "set_agent_todo", sessionId: "hr", todo })) as { todo: AgentTodoDto };
		// createdAt/updatedAt 由存储盖章 —— 发 0 进去，出来的是真时间戳
		expect(written.todo.createdAt).toBeGreaterThan(0);
		expect(written.todo.updatedAt).toBe(written.todo.createdAt);
		expect(written.todo.title).toBe(todo.title);

		const onDisk = JSON.parse(await Bun.file(path.join(hrDir, ".cornfield", "agent-todos.json")).text()) as {
			version: number;
			todos: Record<string, AgentTodoDto>;
		};
		expect(onDisk.version).toBe(1);
		expect(onDisk.todos["todo-1"]?.projectId).toBe("cornfield");

		const listed = (await request(ws, { type: "list_agent_todos", sessionId: "hr" })) as { todos: AgentTodoDto[] };
		expect(listed.todos.map(t => t.id)).toEqual(["todo-1"]);

		// owner 边界：另一个 Agent 的 id 不许写进 hr 的板子
		const foreign = (await request(
			ws,
			{ type: "set_agent_todo", sessionId: "hr", todo: { ...todo, id: "todo-2", agentId: "algorithm" } },
			true,
		)) as Frame;
		expect(foreign.ok).toBe(false);
		expect(String(foreign.error)).toMatch(/not the target Agent/);

		// Project 边界：没声明过的 projectId 不许落盘
		const ghost = (await request(
			ws,
			{ type: "set_agent_todo", sessionId: "hr", todo: { ...todo, id: "todo-3", projectId: "ghost" } },
			true,
		)) as Frame;
		expect(ghost.ok).toBe(false);
		expect(String(ghost.error)).toMatch(/todo\.project-missing/);

		// 未知 agent：回 ok:false，不拿别的 agent 的板子冒充
		const unknown = (await request(ws, { type: "list_agent_todos", sessionId: "nope" }, true)) as Frame;
		expect(unknown.ok).toBe(false);
		expect(String(unknown.error)).toMatch(/unknown agent/);

		// 删除幂等
		expect(await request(ws, { type: "delete_agent_todo", sessionId: "hr", todoId: "todo-1" })).toEqual({
			deleted: true,
		});
		expect(await request(ws, { type: "delete_agent_todo", sessionId: "hr", todoId: "todo-1" })).toEqual({
			deleted: false,
		});
		expect(await request(ws, { type: "list_agent_todos", sessionId: "hr" })).toEqual({ agentId: "hr", todos: [] });

		// ── 错误响应路径：声明读不出来的 agent，list 与 write 都是 ok:false 且不写盘 ──
		const badList = (await request(ws, { type: "list_agent_todos", sessionId: "broken" }, true)) as Frame;
		expect(badList.ok).toBe(false);
		expect(String(badList.error)).toMatch(/not valid JSON/);

		const badWrite = (await request(
			ws,
			{ type: "set_agent_todo", sessionId: "broken", todo: { ...todo, id: "todo-broken", agentId: "broken" } },
			true,
		)) as Frame;
		expect(badWrite.ok).toBe(false);
		expect(String(badWrite.error)).toMatch(/not valid JSON/);
		// 报错就是真的没写：板子文件不该被建出来
		expect(await Bun.file(path.join(brokenDir, ".cornfield", "agent-todos.json")).exists()).toBe(false);

		// 存储坏了也是 ok:false（不是空板）
		await Bun.write(path.join(hrDir, ".cornfield", "agent-todos.json"), "{ not json");
		const badStore = (await request(ws, { type: "list_agent_todos", sessionId: "hr" }, true)) as Frame;
		expect(badStore.ok).toBe(false);
		expect(String(badStore.error)).toMatch(/not valid JSON/);

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
async function request(ws: WebSocket, command: Record<string, unknown>, raw = false): Promise<unknown> {
	const id = `q${++seq}`;
	ws.send(JSON.stringify({ type: "request", id, command: { ...command, id } }));
	const f = await nextFrame(ws, fr => fr.type === "response" && fr.id === id, 30_000);
	if (!f) throw new Error(`timeout: ${command.type}`);
	if (raw) return f;
	if (f.ok !== true) throw new Error(`command failed: ${JSON.stringify(f)}`);
	return (f as { result?: unknown }).result;
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
