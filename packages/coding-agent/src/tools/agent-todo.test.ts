import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_TODO_STORE_VERSION, agentTodosFilePath } from "../agent-domain/agent-todo-store";
import type { AgentTodo } from "../agent-domain/types";
import type { ToolSession } from ".";
import { AgentTodoTool } from "./agent-todo";
import { ToolError } from "./tool-errors";

/**
 * `agent_todo` 工具 —— agent 侧读写自己那块板子。
 *
 * 真盘、真存储层、真注册表（HOME 隔离到临时目录），不 mock：这条链路的风险全在「说的是什么、
 * 存的又是什么」上，所以每条都同时断言**返回值**与**盘上的那一份**。
 *
 * 盯四件事：
 *   - 身份：agentId 从注册表按 agentDir 反查（猜错就是往别人的板子上写）；
 *   - 生命周期：completed / cancelled 是终态，回退要被存储层拒掉（工具不得自己放宽）；
 *   - 字段口径：`dueAt` 认本地墙钟、不存在的日期报错而不是替用户改；空串是**清空**；
 *   - 错误一律是响的：未知 id / 空 title / 没注册的 agentDir 都抛，不静默变成「没有任务」。
 */

let root: string;
let home: string;
let agentDir: string;
let savedHome: string | undefined;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-todo-tool-"));
	home = path.join(root, "home");
	agentDir = path.join(root, "agents", "hr");
	await fs.mkdir(path.join(home, ".cornfield", "agent"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(
		path.join(home, ".cornfield", "agent", "registry.json"),
		JSON.stringify({
			version: 2,
			agents: { hr: { path: agentDir, registeredAt: new Date().toISOString(), template: "default" } },
		}),
	);
	savedHome = process.env.HOME;
	process.env.HOME = home;
});

afterEach(async () => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	await fs.rm(root, { recursive: true, force: true });
});

function toolFor(dir: string = agentDir): AgentTodoTool {
	return new AgentTodoTool({ settings: { getAgentDir: () => dir } } as unknown as ToolSession);
}

/**
 * 拿一次调用抛出来的那个错误。
 *
 * 不用 `promise.catch(e => e)`：那个类型是「成功值 ∪ 错误」，断言时两个分支都在，读 `message`
 * 就得先收窄。这里明确「必须失败」，成功反而是测试自己写错了。
 */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (err) {
		return err;
	}
	throw new Error("这一步本应失败，但它成功了");
}

/** 盘上的那一份（每次现读，不缓存）。 */
async function onDisk(): Promise<AgentTodo[]> {
	const file = agentTodosFilePath(agentDir);
	const parsed = JSON.parse(await Bun.file(file).text()) as {
		version: number;
		todos: Record<string, AgentTodo>;
	};
	expect(parsed.version).toBe(AGENT_TODO_STORE_VERSION);
	return Object.values(parsed.todos);
}

describe("agent_todo：读", () => {
	test("空板说空，不编任务", async () => {
		const result = await toolFor().execute("c1", { action: "list" });
		expect((result.content[0] as { text: string }).text).toBe("这块板子是空的。");
		expect(result.details?.todos).toEqual([]);
		expect(result.details?.agentId).toBe("hr");
	});

	test("板上有任务时逐条列出，id 原样带回", async () => {
		const tool = toolFor();
		await tool.execute("c1", { action: "add", title: "定转正答辩" });
		const list = await tool.execute("c2", { action: "list" });
		const todos = list.details?.todos ?? [];
		expect(todos).toHaveLength(1);
		expect(todos[0]?.title).toBe("定转正答辩");
		expect((list.content[0] as { text: string }).text).toContain(todos[0]!.id);
	});
});

describe("agent_todo：写", () => {
	test("add 落盘的是存储盖章的那一份：owner = 注册表反查的 agentId", async () => {
		const result = await toolFor().execute("c1", { action: "add", title: "  定转正答辩  " });
		const stored = result.details!.todo!;
		expect(stored?.agentId).toBe("hr");
		expect(stored?.title).toBe("定转正答辩"); // 去首尾空白
		expect(stored?.status).toBe("open");
		expect(stored?.priority).toBe("medium");
		expect(stored?.source).toBe("agent");
		expect(stored?.sessionRefs).toEqual([]);
		expect(stored?.createdAt).toBeGreaterThan(0);
		expect(await onDisk()).toEqual([stored]);
	});

	test("空 title 被拒（不建一条没有名字的任务）", async () => {
		await expect(toolFor().execute("c1", { action: "add", title: "   " })).rejects.toThrow(/title 不能为空/);
		await expect(toolFor().execute("c2", { action: "add" })).rejects.toThrow(/title 不能为空/);
		expect(await fs.readdir(path.join(agentDir, ".cornfield")).catch(() => [])).toEqual([]);
	});

	test("update 只动点名的字段，其余照原样", async () => {
		const tool = toolFor();
		const added = await tool.execute("c1", { action: "add", title: "定转正答辩", priority: "high" });
		const id = added.details!.todo!.id;
		const updated = await tool.execute("c2", {
			action: "update",
			id,
			status: "in_progress",
			notes: "等王总回复时间",
		});
		const stored = updated.details?.todo;
		expect(stored?.id).toBe(id);
		expect(stored?.status).toBe("in_progress");
		expect(stored?.notes).toBe("等王总回复时间");
		expect(stored?.priority).toBe("high"); // 没点名 → 不动
		expect(stored?.title).toBe("定转正答辩");
		expect(stored?.createdAt).toBe(added.details!.todo!.createdAt); // 存储保留创建时间
	});

	test("终态不可回退：completed → open 由存储层拒掉，板子不变", async () => {
		const tool = toolFor();
		const id = (await tool.execute("c1", { action: "add", title: "定转正答辩" })).details!.todo!.id;
		await tool.execute("c2", { action: "update", id, status: "completed" });
		await expect(tool.execute("c3", { action: "update", id, status: "open" })).rejects.toThrow();
		expect((await onDisk())[0]?.status).toBe("completed");
	});

	test("delete 之后板上没有它；再删一次是「找不到」，不是静默成功", async () => {
		const tool = toolFor();
		const id = (await tool.execute("c1", { action: "add", title: "定转正答辩" })).details!.todo!.id;
		const removed = await tool.execute("c2", { action: "delete", id });
		expect(removed.details?.action).toBe("delete");
		expect(await onDisk()).toEqual([]);
		await expect(tool.execute("c3", { action: "delete", id })).rejects.toThrow(/板上没有 id/);
	});

	test("未知 id 的 update 报「板上没有」，并给出已知 id 供改正", async () => {
		const error = await captureError(() => toolFor().execute("c1", { action: "update", id: "nope" }));
		expect(error).toBeInstanceOf(ToolError);
		expect((error as Error).message).toMatch(/板上没有 id/);
		expect((error as ToolError).context?.knownIds).toEqual([]);
	});
});

describe("agent_todo：dueAt 的口径", () => {
	test("YYYY-MM-DD 落在当日结束（人说的「9 月 30 日截止」是那一天结束）", async () => {
		const stored = (await toolFor().execute("c1", { action: "add", title: "定转正答辩", dueAt: "2026-09-30" }))
			.details!.todo!;
		expect(stored.dueAt).toBe(new Date(2026, 8, 30, 23, 59, 59, 999).getTime());
	});

	test("YYYY-MM-DD HH:mm 按本地墙钟存", async () => {
		const stored = (await toolFor().execute("c1", { action: "add", title: "定转正答辩", dueAt: "2026-09-30 18:00" }))
			.details!.todo!;
		expect(stored.dueAt).toBe(new Date(2026, 8, 30, 18, 0, 0, 0).getTime());
	});

	test("不存在的日期报错，不替用户滚成下一个月", async () => {
		await expect(
			toolFor().execute("c1", { action: "add", title: "定转正答辩", dueAt: "2026-02-30" }),
		).rejects.toThrow(/不是真实存在的日期/);
	});

	test("空串是清空，不是「存一个空字符串」", async () => {
		const tool = toolFor();
		const id = (await tool.execute("c1", { action: "add", title: "定转正答辩", dueAt: "2026-09-30", notes: "x" }))
			.details!.todo!.id;
		const stored = (await tool.execute("c2", { action: "update", id, dueAt: "", notes: "" })).details!.todo!;
		expect("dueAt" in stored).toBe(false);
		expect("notes" in stored).toBe(false);
		expect(await onDisk()).toEqual([stored]);
	});
});

describe("agent_todo：边界", () => {
	test("绑一个没声明过的 Project 被拒（Project 必须真的存在）", async () => {
		await expect(
			toolFor().execute("c1", { action: "add", title: "定转正答辩", projectId: "no-such-project" }),
		).rejects.toThrow(/project-missing/);
		await expect(onDisk()).rejects.toThrow(); // 拒绝就是真的没写盘
	});

	test("agentDir 不在注册表里：明说定位不到，不往别处写", async () => {
		const orphan = path.join(root, "agents", "nobody");
		await fs.mkdir(orphan, { recursive: true });
		await expect(toolFor(orphan).execute("c1", { action: "list" })).rejects.toThrow(/没有已注册的 Agent/);
	});
});
