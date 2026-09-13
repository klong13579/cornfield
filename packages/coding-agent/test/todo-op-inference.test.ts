import { describe, expect, it } from "bun:test";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@cornfield/coding-agent/tools";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

async function captureError(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected promise to reject");
}

describe("todo op inference", () => {
	it("infers init from a list-shaped entry", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [{ list: [{ phase: "Foundation", items: ["Scaffold", "Wire"] }] }],
		});
		const names = result.details?.phases.flatMap(phase => phase.tasks.map(task => task.content)) ?? [];
		expect(names).toEqual(["Scaffold", "Wire"]);
	});

	it("infers append from an items-shaped entry", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });
		const result = await tool.execute("append", { ops: [{ phase: "Work", items: ["Second"] }] });
		const contents = result.details?.phases[0]?.tasks.map(task => task.content) ?? [];
		expect(contents).toEqual(["First", "Second"]);
	});

	it("infers note from a text-shaped entry", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });
		const result = await tool.execute("note", { ops: [{ task: "First", text: "add more detail" }] });
		expect(result.details?.phases[0]?.tasks[0]?.notes).toEqual(["add more detail"]);
	});

	it("infers start for a pending task", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second"] }] }] });
		const result = await tool.execute("start", { ops: [{ task: "Second" }] });
		const statuses = result.details?.phases[0]?.tasks.map(task => task.status) ?? [];
		expect(statuses).toEqual(["pending", "in_progress"]);
	});

	it("infers done for an in_progress task", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second"] }] }] });
		const result = await tool.execute("done", { ops: [{ task: "First" }] });
		const statuses = result.details?.phases[0]?.tasks.map(task => task.status) ?? [];
		expect(statuses).toEqual(["completed", "in_progress"]);
	});

	it("throws an executable error listing allowed ops with ops/N when inference is impossible", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });
		const message = await captureError(tool.execute("bad", { ops: [{ task: "does-not-exist" }] }));
		expect(message).toContain("ops/1");
		expect(message).toContain("init, start, done, rm, drop, append, note");
		expect(message).toContain('{"op": "done", "task": "Run tests"}');
	});

	it("throws for a phase-only entry because done/drop/rm are ambiguous", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });
		const message = await captureError(tool.execute("bad", { ops: [{ phase: "Work" }] }));
		expect(message).toContain("ops/1");
	});

	it("reports the failing entry index across a multi-entry batch", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });
		const message = await captureError(
			tool.execute("bad", { ops: [{ op: "done", task: "First" }, { task: "missing" }] }),
		);
		expect(message).toContain("ops/2");
	});
});
