import { describe, expect, it } from "bun:test";
import type { AgentMessage, AgentToolResult } from "@cornfield/agent";
import type { TextContent } from "@cornfield/ai";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { getThemeByName } from "@cornfield/coding-agent/modes/theme/theme";
import type { SessionEntry } from "@cornfield/coding-agent/session/session-manager";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import {
	formatBlockerAnnotation,
	formatTodoLine,
	getLatestTodoPhasesFromEntries,
	isReadOnlyTodoCall,
	markdownToPhases,
	phasesToMarkdown,
	type TodoItem,
	type TodoPhase,
	TodoWriteTool,
	type TodoWriteToolDetails,
	todoWriteToolRenderer,
} from "@cornfield/coding-agent/tools";
import { replaceTabs, TRUNCATE_LENGTHS } from "@cornfield/coding-agent/tools/render-utils";
import { sanitizeText } from "@cornfield/natives";

// =============================================================================
// Fixtures
// =============================================================================

interface Harness {
	session: ToolSession;
	/** Every list handed to `setTodoPhases`, in order — a read-only call adds none. */
	setCalls: TodoPhase[][];
	phases: () => TodoPhase[];
}

function createHarness(initialPhases: TodoPhase[] = []): Harness {
	let phases = initialPhases;
	const setCalls: TodoPhase[][] = [];
	return {
		session: {
			cwd: "/tmp/test",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				setCalls.push(next);
				phases = next;
			},
		},
		setCalls,
		phases: () => phases,
	};
}

function taskNamed(phases: TodoPhase[], content: string): TodoItem {
	for (const phase of phases) {
		const task = phase.tasks.find(candidate => candidate.content === content);
		if (task) return task;
	}
	throw new Error(`no task named "${content}"`);
}

function statuses(phases: TodoPhase[]): string[] {
	return phases.flatMap(phase => phase.tasks.map(task => `${task.content}=${task.status}`));
}

function summaryOf(result: AgentToolResult<TodoWriteToolDetails>): string {
	const part = result.content.find((block): block is TextContent => block.type === "text");
	return part?.text ?? "";
}

function todoToolResultEntry(
	phases: TodoPhase[],
	ops: string[] | undefined,
	options: { isError?: boolean } = {},
): SessionEntry {
	return {
		type: "message",
		id: crypto.randomUUID().slice(-8),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolName: "todo",
			toolCallId: "call",
			timestamp: Date.now(),
			content: [],
			details: { phases, ops },
			isError: options.isError ?? false,
		} as AgentMessage,
	};
}

const firstEscape = (line: string): string | undefined => /\u001b\[[0-9;]*m/.exec(line)?.[0];

// =============================================================================
// Semantics
// =============================================================================

describe("todo blocked status", () => {
	it("blocks a task with a reason and reports the reason as text", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second"] }] }] });

		const result = await tool.execute("block", {
			ops: [{ op: "block", task: "First", reason: "waiting on the staging API key" }],
		});

		const first = taskNamed(result.details?.phases ?? [], "First");
		expect(first.status).toBe("blocked");
		expect(first.blocker).toBe("waiting on the staging API key");
		expect(harness.phases()[0]?.tasks[0]?.status).toBe("blocked");

		const summary = summaryOf(result);
		expect(summary).toContain("Blocked (1):");
		expect(summary).toContain("waiting on the staging API key");
	});

	it("collapses a multi-line reason to one line and drops a blank one", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });

		const withReason = await tool.execute("block", {
			ops: [{ op: "block", task: "First", reason: "  multi\nline\t\nreason  " }],
		});
		expect(taskNamed(withReason.details?.phases ?? [], "First").blocker).toBe("multi line reason");

		// A later block with no reason is authoritative: it clears the stale one.
		const withoutReason = await tool.execute("block", { ops: [{ op: "block", task: "First" }] });
		expect(taskNamed(withoutReason.details?.phases ?? [], "First").status).toBe("blocked");
		expect(taskNamed(withoutReason.details?.phases ?? [], "First").blocker).toBeUndefined();
		expect(summaryOf(withoutReason)).toContain("(blocked)");
	});

	it("auto-promotes the next pending task when the active task is blocked, never the blocked one", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second", "Third"] }] }],
		});
		expect(statuses(harness.phases())).toEqual(["First=in_progress", "Second=pending", "Third=pending"]);

		const blockedActive = await tool.execute("block", { ops: [{ op: "block", task: "First" }] });
		expect(statuses(blockedActive.details?.phases ?? [])).toEqual([
			"First=blocked",
			"Second=in_progress",
			"Third=pending",
		]);

		// Blocking the rest leaves nothing to promote — a blocked task is never
		// promoted back into in_progress by the single-in_progress rule.
		const allBlocked = await tool.execute("block", { ops: [{ op: "block", phase: "Work" }] });
		expect(statuses(allBlocked.details?.phases ?? [])).toEqual(["First=blocked", "Second=blocked", "Third=blocked"]);
	});

	it("keeps exactly one in_progress task when a non-active task is blocked", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second", "Third"] }] }],
		});

		const result = await tool.execute("block", {
			ops: [{ op: "block", task: "Third", reason: "needs a decision" }],
		});
		expect(statuses(result.details?.phases ?? [])).toEqual(["First=in_progress", "Second=pending", "Third=blocked"]);
	});

	it("unblocks back to pending, hands it in_progress only by the usual rule, and clears the reason", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second"] }] }] });
		await tool.execute("block", { ops: [{ op: "block", task: "First", reason: "waiting" }] });
		expect(statuses(harness.phases())).toEqual(["First=blocked", "Second=in_progress"]);

		const result = await tool.execute("unblock", { ops: [{ op: "unblock", task: "First" }] });
		const first = taskNamed(result.details?.phases ?? [], "First");
		expect(first.status).toBe("pending");
		expect(first.blocker).toBeUndefined();
		// "Second" already holds in_progress, so the single-in_progress rule is intact.
		expect(statuses(result.details?.phases ?? [])).toEqual(["First=pending", "Second=in_progress"]);
	});

	it("does not reopen finished work when a whole phase is blocked", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["Done", "Dropped", "Open"] }] }],
		});
		await tool.execute("done", { ops: [{ op: "done", task: "Done" }] });
		await tool.execute("drop", { ops: [{ op: "drop", task: "Dropped" }] });

		const result = await tool.execute("block", { ops: [{ op: "block", phase: "Work" }] });
		expect(statuses(result.details?.phases ?? [])).toEqual(["Done=completed", "Dropped=abandoned", "Open=blocked"]);
	});

	it("requires a target for block and unblock", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });

		const blockError = await tool.execute("block", { ops: [{ op: "block", reason: "no target" }] });
		expect(summaryOf(blockError)).toContain("block requires a task or phase target");

		const unblockError = await tool.execute("unblock", { ops: [{ op: "unblock" }] });
		expect(summaryOf(unblockError)).toContain("unblock requires a task or phase target");
	});

	it("leaves the list untouched for a view and marks the call read-only", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second"] }] }] });
		const before = harness.phases();
		const setCallsBefore = harness.setCalls.length;

		const result = await tool.execute("view", { ops: [{ op: "view" }] });

		expect(result.details?.ops).toEqual(["view"]);
		expect(isReadOnlyTodoCall(result.details?.ops)).toBe(true);
		expect(summaryOf(result)).toContain("First");
		// A pure read must not republish state: that would restart the auto-clear
		// grace period for finished tasks.
		expect(harness.setCalls.length).toBe(setCallsBefore);
		expect(harness.phases()).toBe(before);
	});

	it("treats a batch that also mutates as state-changing", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });

		const result = await tool.execute("mixed", { ops: [{ op: "view" }, { op: "done", task: "First" }] });

		expect(result.details?.ops).toEqual(["view", "done"]);
		expect(isReadOnlyTodoCall(result.details?.ops)).toBe(false);
		expect(taskNamed(harness.phases(), "First").status).toBe("completed");
	});

	it("ignores a view echo when rehydrating the branch, and still honours entries written before view existed", () => {
		const blocked: TodoPhase[] = [{ name: "Work", tasks: [{ content: "First", status: "blocked", blocker: "why" }] }];
		const later: TodoPhase[] = [{ name: "Work", tasks: [{ content: "First", status: "pending" }] }];

		// view echo last: the snapshot is the last state-changing call.
		expect(
			getLatestTodoPhasesFromEntries([
				todoToolResultEntry(blocked, ["block"]),
				todoToolResultEntry(blocked, ["view"]),
			]),
		).toEqual(blocked);

		// Legacy entry (no `ops`): committed, so the newest one wins.
		expect(
			getLatestTodoPhasesFromEntries([
				todoToolResultEntry(blocked, ["block"]),
				todoToolResultEntry(later, undefined),
			]),
		).toEqual(later);

		// An errored call is never a snapshot, whatever its ops say.
		expect(
			getLatestTodoPhasesFromEntries([
				todoToolResultEntry(blocked, ["block"]),
				todoToolResultEntry(later, ["done"], { isError: true }),
			]),
		).toEqual(blocked);
	});
});

// =============================================================================
// Markdown round-trip
// =============================================================================

describe("todo blocker markdown round-trip", () => {
	it("carries the reason through a checklist export/import", () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "Blocked", status: "blocked", blocker: "waiting on review" },
					{ content: "Active", status: "in_progress" },
					{ content: "Finished", status: "completed" },
				],
			},
		];

		const markdown = phasesToMarkdown(phases);
		expect(markdown).toContain("- [!] Blocked <!-- blocker: waiting on review -->");
		expect(markdown).toContain("- [/] Active");

		const parsed = markdownToPhases(markdown);
		expect(parsed.errors).toEqual([]);
		expect(parsed.phases).toEqual(phases);
	});

	it("parses a blocked task with no reason and one with an empty comment identically", () => {
		const bare = markdownToPhases("# Work\n- [!] No reason\n");
		expect(bare.errors).toEqual([]);
		expect(bare.phases[0]?.tasks[0]).toEqual({ content: "No reason", status: "blocked" });

		const empty = markdownToPhases("# Work\n- [!] Empty <!-- blocker:  -->\n");
		expect(empty.phases[0]?.tasks[0]).toEqual({ content: "Empty", status: "blocked" });
	});

	it("keeps a non-blocked task's comment-like text untouched and names the new marker in its error", () => {
		const parsed = markdownToPhases("# Work\n- [ ] Keeps <!-- blocker: text -->\n- [?] Bad marker\n");
		// The comment is only special on a blocked row; here it is ordinary content.
		// `markdownToPhases` also normalises the single-in_progress rule, hence the
		// promotion of the only pending task.
		expect(parsed.phases[0]?.tasks[0]).toEqual({
			content: "Keeps <!-- blocker: text -->",
			status: "in_progress",
		});
		expect(parsed.errors[0]).toContain("[!]");
	});
});

// =============================================================================
// Panel rendering
// =============================================================================

describe("todo blocked rendering", () => {
	it("paints a blocked row in a different color than pending and shows the reason", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const blocked = formatTodoLine(
			{ content: "Deploy", status: "blocked", blocker: "waiting on the API key" },
			"",
			uiTheme,
		);
		const pending = formatTodoLine({ content: "Deploy", status: "pending" }, "", uiTheme);

		// Same content, different state: the rows must not be interchangeable.
		expect(blocked).not.toBe(pending);
		expect(firstEscape(blocked)).toBe(firstEscape(uiTheme.fg("warning", "x")));
		expect(firstEscape(pending)).not.toBe(firstEscape(blocked));

		const clean = sanitizeText(blocked);
		expect(clean).toContain("Deploy");
		expect(clean).toContain("(blocked: waiting on the API key)");

		// No reason recorded still reads as blocked, not as pending.
		const noReason = formatTodoLine({ content: "Deploy", status: "blocked" }, "", uiTheme);
		expect(sanitizeText(noReason)).toContain("(blocked)");
		expect(firstEscape(noReason)).toBe(firstEscape(uiTheme.fg("warning", "x")));
	});

	it("strips escape sequences and bounds an oversized reason on the panel line", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;
		const hostile = `\u001b[31mred\u001b[0m\t${"x".repeat(4000)}`;

		const line = formatTodoLine({ content: "Deploy", status: "blocked", blocker: hostile }, "", uiTheme);

		// Model-supplied SGR never reaches the terminal; the theme's own escapes stay.
		expect(line).not.toContain("\u001b[31m");
		expect(sanitizeText(line)).toContain("red");
		expect(line).not.toContain("\t");
		// Display is clamped; the model still gets the whole reason (see below).
		expect(formatBlockerAnnotation(hostile).length).toBeLessThanOrEqual(
			TRUNCATE_LENGTHS.CONTENT + " (blocked: )".length,
		);
		expect(line.length).toBeLessThan(hostile.length);
	});

	it("hands the model the whole reason in the summary, however long the display clamps", async () => {
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }] });
		const longReason = "x".repeat(4000);

		const result = await tool.execute("block", { ops: [{ op: "block", task: "First", reason: longReason }] });
		expect(summaryOf(result)).toContain(longReason);
		expect(formatBlockerAnnotation(longReason).length).toBeLessThan(longReason.length);
	});

	it("renders the blocked row through the tool result panel", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;
		const harness = createHarness();
		const tool = new TodoWriteTool(harness.session);
		await tool.execute("init", { ops: [{ op: "init", list: [{ phase: "Work", items: ["First", "Second"] }] }] });
		const result = await tool.execute("block", {
			ops: [{ op: "block", task: "First", reason: "waiting on the staging API key" }],
		});

		const component = todoWriteToolRenderer.renderResult(
			{ content: result.content, details: result.details },
			{ expanded: true, isPartial: false },
			uiTheme,
		);
		const raw = component.render(80).join("\n");
		const plain = sanitizeText(raw);

		// The reason reaches the panel verbatim, painted in the warning color that no
		// other status uses.
		expect(plain).toContain("First");
		expect(plain).toContain("(blocked: waiting on the staging API key)");
		expect(raw).toContain(firstEscape(uiTheme.fg("warning", "x"))!);

		// The same rows without the blocker look like ordinary pending work.
		const withoutBlock = await tool.execute("unblock", { ops: [{ op: "unblock", task: "First" }] });
		const plainWithout = sanitizeText(
			todoWriteToolRenderer
				.renderResult(
					{ content: withoutBlock.content, details: withoutBlock.details },
					{ expanded: true, isPartial: false },
					uiTheme,
				)
				.render(80)
				.map(line => replaceTabs(line))
				.join("\n"),
		);
		expect(plainWithout).not.toContain("(blocked");
	});
});
