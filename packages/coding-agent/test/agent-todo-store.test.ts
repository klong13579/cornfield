/**
 * Agent Todo store + serve bridge (WP10 / §37 D4).
 *
 * Two layers are under test and they fail differently on purpose:
 *   - the store (`agent-domain/agent-todo-store`) owns persistence, lifecycle and the
 *     record's provenance fields;
 *   - the board API (`agent-domain/agent-todo-board`, re-exported as DTOs by
 *     `server/agent-todos-wire`) owns the relations between an Agent and a Todo —
 *     ownership and Project binding.
 *
 * The failure models the design names are the ones worth pinning: a store that cannot be
 * read must never look like an empty board, a Todo belongs to exactly one Agent, and a
 * Project binding is an upper bound rather than a suggestion.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	AGENT_TODO_STORE_VERSION,
	agentTodosFilePath,
	loadAgentTodos,
	removeAgentTodo,
	upsertAgentTodo,
} from "../src/agent-domain/agent-todo-store";
import type { AgentTodo } from "../src/agent-domain/types";
import { dropAgentTodo, listAgentTodos, writeAgentTodo } from "../src/server/agent-todos-wire";
import { workspaceFilePath } from "../src/skeleton/workspace";

interface Fixture {
	root: string;
	home: string;
	agentDir: (name: string) => string;
	cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-todo-"));
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, ".cornfield", "agent"), { recursive: true });
	return {
		root,
		home,
		agentDir: (name: string) => path.join(root, "agents", name),
		cleanup: async () => {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

function makeTodo(overrides: Partial<AgentTodo> = {}): AgentTodo {
	return {
		id: "todo-1",
		agentId: "hr",
		title: "把转正答辩排期定了",
		status: "open",
		priority: "medium",
		source: "user",
		sessionRefs: [],
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

/** Write a store file verbatim — the only way to put a record there that the API refuses. */
async function seedBoard(agentDir: string, todos: AgentTodo[]): Promise<void> {
	const file = agentTodosFilePath(agentDir);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(
		file,
		JSON.stringify(
			{ version: AGENT_TODO_STORE_VERSION, todos: Object.fromEntries(todos.map(t => [t.id, t])) },
			null,
			2,
		),
	);
}

async function writeProjects(home: string, projects: Record<string, { root: string; name?: string }>): Promise<void> {
	await Bun.write(
		path.join(home, ".cornfield", "agent", "projects.json"),
		JSON.stringify({ version: 1, projects }, null, 2),
	);
}

async function writeDeclaration(agentDir: string, projectRoot: string): Promise<void> {
	await fs.mkdir(path.dirname(workspaceFilePath(agentDir)), { recursive: true });
	await Bun.write(
		workspaceFilePath(agentDir),
		JSON.stringify({ schemaVersion: 2, id: "hr", name: "HR", type: "agent", root: ".", projectRoot }, null, 2),
	);
}

describe("agent todo store", () => {
	let fixture: Fixture;
	let savedHome: string | undefined;

	beforeEach(async () => {
		fixture = await createFixture();
		savedHome = process.env.HOME;
		process.env.HOME = fixture.home;
	});

	afterEach(async () => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		await fixture.cleanup();
	});

	test("no store file reads as an empty board", async () => {
		expect(await loadAgentTodos(fixture.agentDir("hr"))).toEqual([]);
	});

	test("a corrupt store throws instead of reading as an empty board", async () => {
		const dir = fixture.agentDir("hr");
		await fs.mkdir(path.join(dir, ".cornfield"), { recursive: true });
		await Bun.write(agentTodosFilePath(dir), "{ not json");
		await expect(loadAgentTodos(dir)).rejects.toThrow(/not valid JSON/);
	});

	test("a store written by another version is refused, not partially read", async () => {
		const dir = fixture.agentDir("hr");
		await fs.mkdir(path.join(dir, ".cornfield"), { recursive: true });
		await Bun.write(agentTodosFilePath(dir), JSON.stringify({ version: 99, todos: {} }));
		await expect(loadAgentTodos(dir)).rejects.toThrow(/version 99/);
	});

	test("a stored record that disagrees with the declared shape throws", async () => {
		const dir = fixture.agentDir("hr");
		await seedBoard(dir, [makeTodo({ status: "someday" as AgentTodo["status"] })]);
		await expect(loadAgentTodos(dir)).rejects.toThrow(/expected one of open \| in_progress/);
	});

	test("create round-trips and reads back from disk", async () => {
		const dir = fixture.agentDir("hr");
		const written = await upsertAgentTodo(dir, makeTodo({ projectId: "cornfield", notes: "先跟王总对齐" }));

		expect(written.createdAt).toBeGreaterThan(0);
		expect(written.updatedAt).toBe(written.createdAt);
		expect(written.sessionRefs).toEqual([]);
		expect(written.notes).toBe("先跟王总对齐");
		expect(await loadAgentTodos(dir)).toEqual([written]);
	});

	test("update keeps createdAt, re-stamps updatedAt, and can clear an optional binding", async () => {
		const dir = fixture.agentDir("hr");
		const created = await upsertAgentTodo(dir, makeTodo({ projectId: "cornfield" }));
		await Bun.sleep(2);
		const updated = await upsertAgentTodo(dir, {
			...created,
			title: "改过的标题",
			status: "in_progress",
			projectId: undefined,
		});

		expect(updated.createdAt).toBe(created.createdAt);
		expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
		expect(updated.projectId).toBeUndefined();
		// Clearing the binding is a fact about the record, not a missing field: it survives.
		expect(await loadAgentTodos(dir)).toEqual([updated]);
	});

	test("a caller cannot create a todo that already claims sessions", async () => {
		const dir = fixture.agentDir("hr");
		await expect(upsertAgentTodo(dir, makeTodo({ sessionRefs: ["s-1"] }))).rejects.toThrow(
			/cannot be created with sessionRefs/,
		);
	});

	test("a caller may send back the sessionRefs it read, but not change them", async () => {
		const dir = fixture.agentDir("hr");
		await seedBoard(dir, [makeTodo({ sessionRefs: ["s-1"] })]);

		const stored = await loadAgentTodos(dir);
		expect(stored[0]?.sessionRefs).toEqual(["s-1"]);
		await expect(upsertAgentTodo(dir, { ...stored[0]!, sessionRefs: [] })).rejects.toThrow(/not writable/);
		await expect(upsertAgentTodo(dir, { ...stored[0]!, title: "换个标题" })).resolves.toMatchObject({
			sessionRefs: ["s-1"],
			title: "换个标题",
		});
	});

	test("terminal statuses are terminal and same-state writes stay legal", async () => {
		const dir = fixture.agentDir("hr");
		const open = await upsertAgentTodo(dir, makeTodo());
		const done = await upsertAgentTodo(dir, { ...open, status: "completed" });

		await expect(upsertAgentTodo(dir, { ...done, status: "open" })).rejects.toThrow(/illegal AgentTodo transition/);
		await expect(upsertAgentTodo(dir, { ...done, title: "收尾备注" })).resolves.toMatchObject({
			status: "completed",
		});
	});

	test("an empty id is refused — the store does not invent identities", async () => {
		const dir = fixture.agentDir("hr");
		await expect(upsertAgentTodo(dir, makeTodo({ id: "  " }))).rejects.toThrow(/id is required/);
	});

	test("remove reports whether the todo was there", async () => {
		const dir = fixture.agentDir("hr");
		await upsertAgentTodo(dir, makeTodo());
		expect(await removeAgentTodo(dir, "todo-1")).toBe(true);
		expect(await removeAgentTodo(dir, "todo-1")).toBe(false);
		expect(await loadAgentTodos(dir)).toEqual([]);
	});

	/**
	 * 写入是读-改-写，所以要串行。
	 *
	 * 一块板子同时有两个写入者（serve 的 wire 命令 / agent 的 `agent_todo` 工具），可能还不在
	 * 同一个进程里。不加锁时它们各读一份旧内容、各写回一份：后写的把先写的整个覆盖掉 ——
	 * 用户丢掉一条看起来已经存下的任务。这条用例就是那个丢失的守门：12 条并发写，12 条都要在。
	 */
	test("concurrent writes on one board all land (no lost update)", async () => {
		const dir = fixture.agentDir("hr");
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				upsertAgentTodo(dir, makeTodo({ id: `todo-${String(i).padStart(2, "0")}`, title: `T${i}` })),
			),
		);

		const todos = await loadAgentTodos(dir);
		expect(todos).toHaveLength(12);
		expect(new Set(todos.map(todo => todo.id)).size).toBe(12);
	});

	test("two agents never share a board", async () => {
		const hr = fixture.agentDir("hr");
		const algorithm = fixture.agentDir("algorithm");
		await upsertAgentTodo(hr, makeTodo({ id: "hr-1", agentId: "hr" }));
		await upsertAgentTodo(algorithm, makeTodo({ id: "alg-1", agentId: "algorithm" }));

		expect((await loadAgentTodos(hr)).map(t => t.id)).toEqual(["hr-1"]);
		expect((await loadAgentTodos(algorithm)).map(t => t.id)).toEqual(["alg-1"]);
	});
});

describe("agent todo wire bridge", () => {
	let fixture: Fixture;
	let savedHome: string | undefined;

	beforeEach(async () => {
		fixture = await createFixture();
		savedHome = process.env.HOME;
		process.env.HOME = fixture.home;
		await writeProjects(fixture.home, {
			cornfield: { root: path.join(fixture.root, "cornfield"), name: "CornField" },
			dtc: { root: path.join(fixture.root, "dtc"), name: "DTC" },
		});
	});

	afterEach(async () => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		await fixture.cleanup();
	});

	test("one Agent cannot write another Agent's board", async () => {
		const target = { agentId: "hr", agentDir: fixture.agentDir("hr") };
		await expect(writeAgentTodo(target, makeTodo({ agentId: "algorithm" }))).rejects.toThrow(
			/is not the target Agent "hr"/,
		);
		expect(await loadAgentTodos(target.agentDir)).toEqual([]);
	});

	test("a Todo cannot bind to a Project nobody declared", async () => {
		const target = { agentId: "hr", agentDir: fixture.agentDir("hr") };
		await expect(writeAgentTodo(target, makeTodo({ projectId: "ghost" }))).rejects.toThrow(/todo\.project-missing/);
		expect(await loadAgentTodos(target.agentDir)).toEqual([]);
	});

	test("a declared Project is accepted", async () => {
		const target = { agentId: "hr", agentDir: fixture.agentDir("hr") };
		const written = await writeAgentTodo(target, makeTodo({ projectId: "dtc" }));
		expect(written.projectId).toBe("dtc");
	});

	test("an Agent bound to one Project cannot file a Todo under another", async () => {
		const dir = fixture.agentDir("hr");
		await writeProjects(fixture.home, {
			cornfield: { root: path.join(fixture.root, "cornfield"), name: "CornField" },
			dtc: { root: path.join(fixture.root, "dtc"), name: "DTC" },
		});
		await writeDeclaration(dir, path.join(fixture.root, "cornfield"));
		const target = { agentId: "hr", agentDir: dir };

		await expect(writeAgentTodo(target, makeTodo({ projectId: "dtc" }))).rejects.toThrow(
			/agent\.project-binding-violated/,
		);
		await expect(writeAgentTodo(target, makeTodo({ projectId: "cornfield" }))).resolves.toMatchObject({
			projectId: "cornfield",
		});
	});

	test("the board reports its owner and the Project binding the writer is held to", async () => {
		const bound = fixture.agentDir("bound");
		await writeDeclaration(bound, path.join(fixture.root, "cornfield"));
		const unbound = fixture.agentDir("unbound");

		await writeAgentTodo({ agentId: "bound", agentDir: bound }, makeTodo({ agentId: "bound" }));

		expect(await listAgentTodos({ agentId: "bound", agentDir: bound })).toMatchObject({
			agentId: "bound",
			projectIds: ["cornfield"],
		});
		// No declaration → unconstrained, which is not the same fact as "bound to nothing".
		expect(await listAgentTodos({ agentId: "unbound", agentDir: unbound })).toEqual({
			agentId: "unbound",
			todos: [],
		});
	});

	test("delete is idempotent but refuses a missing id", async () => {
		const target = { agentId: "hr", agentDir: fixture.agentDir("hr") };
		await writeAgentTodo(target, makeTodo());
		expect(await dropAgentTodo(target, "todo-1")).toBe(true);
		expect(await dropAgentTodo(target, "todo-1")).toBe(false);
		// 报错原文来自共享的板子 API（`agent-domain/agent-todo-board`），不再是 wire 命令专属措辞：
		// 同一份校验现在也服务 agent 的 agent_todo 工具，叫某个命令的名字在那里就不对了。
		await expect(dropAgentTodo(target, "")).rejects.toThrow(/non-empty todo id/);
	});

	/**
	 * 读不出内容的声明**不能**被当成「未约束」：它可能正在声明绑定，当成未约束就是绕开
	 * Project 隔离。两种坏法（解析不了 / 解析得出来但不是 v2 声明）在同一位置失败，
	 * 而且 list 与 write 都要硬报错 —— 读得到一半、写得进一半是最坏的结果。
	 */
	describe("a declaration that cannot be read is a hard error, not an unconstrained Agent", () => {
		async function corruptDeclaration(): Promise<{ agentId: string; agentDir: string }> {
			const dir = fixture.agentDir("hr");
			await fs.mkdir(path.join(dir, ".cornfield"), { recursive: true });
			await Bun.write(workspaceFilePath(dir), "{ not json");
			return { agentId: "hr", agentDir: dir };
		}

		test("unparseable JSON: list and write both fail, naming the declaration", async () => {
			const target = await corruptDeclaration();

			await expect(listAgentTodos(target)).rejects.toThrow(/not valid JSON/);
			await expect(writeAgentTodo(target, makeTodo())).rejects.toThrow(/not valid JSON/);
			// 写入没有被放行，板上也就不会多出一条
			expect(await loadAgentTodos(target.agentDir)).toEqual([]);
		});

		test("parseable but not a schema-v2 declaration: list and write both fail", async () => {
			const target = await corruptDeclaration();
			await Bun.write(
				workspaceFilePath(target.agentDir),
				JSON.stringify({ schemaVersion: 1, id: "hr", name: "HR", type: "agent", root: ".", projectRoot: "." }),
			);

			await expect(listAgentTodos(target)).rejects.toThrow(/not a schema-v2 declaration/);
			await expect(writeAgentTodo(target, makeTodo())).rejects.toThrow(/not a schema-v2 declaration/);
		});

		test("a missing declaration stays unconstrained — the strict path only rejects what is unreadable", async () => {
			const target = { agentId: "hr", agentDir: fixture.agentDir("nowhere") };
			await expect(listAgentTodos(target)).resolves.toEqual({ agentId: "hr", todos: [] });
		});
	});
});
