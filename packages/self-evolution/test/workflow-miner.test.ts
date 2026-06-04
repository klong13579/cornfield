import { describe, expect, test } from "bun:test";
import type { SessionTrace } from "../src/types";
import { WorkflowMiner, extractCommandName } from "../src/workflow-miner";

function makeTrace(entries: Array<{ toolName: string; args?: Record<string, unknown> }>): SessionTrace {
	return {
		sessionId: "test",
		cwd: "/tmp",
		userPrompt: "test",
		startTime: Date.now(),
		endTime: Date.now(),
		toolCallCount: entries.length,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		entries: entries.map((e, i) => ({
			type: "tool_call" as const,
			timestamp: Date.now() + i,
			toolName: e.toolName,
			args: e.args ?? {},
		})),
	};
}

describe("WorkflowMiner", () => {
	test("extracts deduplicated tool sequence", () => {
		const miner = new WorkflowMiner();
		const trace = makeTrace([
			{ toolName: "read" },
			{ toolName: "read" },
			{ toolName: "edit" },
			{ toolName: "edit" },
			{ toolName: "test" },
		]);
		const pattern = miner.mine(trace, "refactoring");
		expect(pattern).toBeDefined();
		expect(pattern!.toolSequence).toEqual(["read", "edit", "test"]);
	});

	test("returns undefined for empty tool sequence", () => {
		const miner = new WorkflowMiner();
		const trace = makeTrace([]);
		const pattern = miner.mine(trace, "exploration");
		expect(pattern).toBeUndefined();
	});

	test("pattern id is deterministic for same sequence", () => {
		const miner = new WorkflowMiner();
		const trace1 = makeTrace([{ toolName: "read" }, { toolName: "edit" }]);
		const trace2 = makeTrace([{ toolName: "read" }, { toolName: "edit" }]);
		const p1 = miner.mine(trace1, "refactoring");
		const p2 = miner.mine(trace2, "refactoring");
		expect(p1!.id).toBe(p2!.id);
	});

	test("includes intent in pattern", () => {
		const miner = new WorkflowMiner();
		const trace = makeTrace([{ toolName: "read" }, { toolName: "edit" }]);
		const pattern = miner.mine(trace, "bugfix");
		expect(pattern!.intent).toBe("bugfix");
	});

	test("extracts command sequence from bash args", () => {
		const miner = new WorkflowMiner();
		const trace = makeTrace([
			{ toolName: "bash", args: { command: "which dws" } },
			{ toolName: "bash", args: { command: "dws doc read --node X" } },
			{ toolName: "bash", args: { command: "dws aitable base get --base-id X" } },
			{ toolName: "bash", args: { command: "dws aitable record query --table-id Y" } },
		]);
		const pattern = miner.mine(trace, "exploration");
		expect(pattern).toBeDefined();
		expect(pattern!.commandSequence).toEqual([
			"bash:which",
			"bash:dws",
		]);
		expect(pattern!.id).toContain("cmd:");
	});

	test("non-bash tools use plain toolName as command name", () => {
		const miner = new WorkflowMiner();
		const trace = makeTrace([
			{ toolName: "bash", args: { command: "dws base get" } },
			{ toolName: "search" },
			{ toolName: "bash", args: { command: "dws record query" } },
		]);
		const pattern = miner.mine(trace, "exploration");
		expect(pattern).toBeDefined();
		expect(pattern!.commandSequence).toContain("search");
	});

	test("extractCommandName parses first word from bash command", () => {
		expect(extractCommandName({ toolName: "bash", args: { command: "dws aitable base get" } })).toBe("bash:dws");
		expect(extractCommandName({ toolName: "bash", args: { command: "git status" } })).toBe("bash:git");
		expect(extractCommandName({ toolName: "bash", args: { command: "" } })).toBe("bash");
		expect(extractCommandName({ toolName: "read", args: { path: "foo.ts" } })).toBe("read");
	});
});
