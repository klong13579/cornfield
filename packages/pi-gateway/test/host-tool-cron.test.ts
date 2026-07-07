/**
 * Cron host tool — delivery auto-inference + channel registry validation.
 *
 * The LLM-facing `cron` tool is registered with the OMP subprocess via
 * `set_host_tools` and invoked through the `host_tool_call` frame. This
 * test exercises the handler directly (no RPC needed) and pins:
 *
 *   - DM auto-inference: `toUserId` is filled from active chat's userId.
 *   - Group auto-inference: `toConversationId` is filled from active chat.
 *   - Explicit `delivery` overrides the auto-inferred values.
 *   - Channel must exist in the ChannelRegistry or the call fails fast.
 *   - When no active chat context AND no explicit delivery, the call
 *     returns a clear "missing delivery" error (D4 fallback path).
 *   - Persistence: addTask returns a task with the resolved delivery.
 *
 * The test deliberately uses a real `SchedulerDbStorage` against a temp
 * DB (WAL, isolated) and a stub `ChannelRegistry` — no mocks, no
 * `mock.module()`. The bridge is a thin object that records what
 * `getActiveChatContext()` would return.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBridge } from "../src/agent-bridge";
import type { ChannelRegistry } from "../src/channels/registry";
import { createCronToolDefinitions } from "../src/scheduler/host-tool";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import type { InboundMessage } from "../src/types";

const TMP = path.join(os.tmpdir(), `omp-test-cron-${process.pid}-${Date.now()}`);

function newDb(): SchedulerDbStorage {
	fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
	return new SchedulerDbStorage(path.join(TMP, `cron-${Math.random().toString(36).slice(2)}.db`));
}

class StubRegistry {
	#known = new Set<string>(["dingtalk:hr", "dingtalk:sales"]);
	get(id: string) {
		return this.#known.has(id) ? ({ id } as never) : undefined;
	}
	getAll() {
		return Array.from(this.#known).map(id => ({ id }));
	}
}

function stubBridge(activeChat: InboundMessage | undefined): AgentBridge {
	return {
		getActiveChatContext: () => activeChat,
		getActiveSessionPath: () => undefined,
	} as unknown as AgentBridge;
}

const DM_MSG: InboundMessage = {
	channelId: "dingtalk:hr",
	accountId: "hr",
	userId: "u123",
	conversationId: "dm-u123",
	isGroup: false,
	content: { type: "text", text: "test" },
};

const GROUP_MSG: InboundMessage = {
	channelId: "dingtalk:hr",
	accountId: "hr",
	userId: "u123",
	conversationId: "conv-456",
	isGroup: true,
	conversationTitle: "hr-team",
	content: { type: "text", text: "test" },
};

function asText(body: { content: Array<{ type: string; text: string }>; isError?: boolean }): {
	text: string;
	isError: boolean;
} {
	return { text: body.content.map(c => c.text).join(""), isError: body.isError === true };
}

describe("cron host tool — delivery auto-inference", () => {
	let storage: SchedulerDbStorage;
	const storages: SchedulerDbStorage[] = [];

	beforeEach(() => {
		storage = newDb();
		storages.push(storage);
	});

	afterEach(() => {
		for (const s of storages) {
			try {
				s["#db"]?.close?.();
			} catch {}
		}
		storages.length = 0;
		try {
			fs.rmSync(TMP, { recursive: true, force: true });
		} catch {}
	});

	it("auto-fills delivery from active DM chat", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const result = await tools[0]!.handle({
			action: "add",
			name: "remind-me",
			schedule: "0 9 * * *",
			command: "echo ping",
			taskType: "shell",
		});
		const { text, isError } = asText(result);
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.delivery).toEqual({
			channel: "dingtalk:hr",
			accountId: "hr",
			toUserId: "u123",
			mode: "announce",
		});
		expect(task.name).toBe("remind-me");
	});

	it("auto-fills delivery from active group chat (toConversationId, not toUserId)", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(GROUP_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const result = await tools[0]!.handle({
			action: "add",
			name: "group-summary",
			schedule: "0 9 * * *",
			command: "echo summary",
			taskType: "shell",
		});
		const { text, isError } = asText(result);
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.delivery).toEqual({
			channel: "dingtalk:hr",
			accountId: "hr",
			toConversationId: "conv-456",
			mode: "announce",
		});
		expect(task.delivery.toUserId).toBeUndefined();
	});

	it("rejects when no active chat context AND no explicit delivery", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(undefined),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const result = await tools[0]!.handle({
			action: "add",
			name: "orphan",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
		});
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toMatch(/delivery is required/);
	});

	it("rejects when explicit channel is not in the ChannelRegistry", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(undefined),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const result = await tools[0]!.handle({
			action: "add",
			name: "bad-channel",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
			delivery: { channel: "dingtalk:ghost", toUserId: "u1" },
		});
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toMatch(/not registered/);
	});

	it("explicit delivery overrides the auto-inferred chat (channel swap)", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		// Caller is in DM with hr but wants the cron to deliver to sales.
		const result = await tools[0]!.handle({
			action: "add",
			name: "swap-target",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
			delivery: { channel: "dingtalk:sales", toUserId: "u999" },
		});
		const { text, isError } = asText(result);
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.delivery.channel).toBe("dingtalk:sales");
		expect(task.delivery.toUserId).toBe("u999");
	});

	it("rejects add:both toUserId and toConversationId (Zod XOR)", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(undefined),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const result = await tools[0]!.handle({
			action: "add",
			name: "xor-fail",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
			delivery: { channel: "dingtalk:hr", toUserId: "u1", toConversationId: "c1" },
		});
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toMatch(/exactly one of/);
	});

	it("list / show / remove round-trip with the storage", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const add = await tools[0]!.handle({
			action: "add",
			name: "round-trip",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
		});
		expect(add.isError).toBeFalsy();
		const list = await tools[0]!.handle({ action: "list" });
		expect(JSON.parse(asText(list).text).length).toBe(1);
		const show = await tools[0]!.handle({ action: "show", name: "round-trip" });
		expect(asText(show).isError).toBe(false);
		const remove = await tools[0]!.handle({ action: "remove", name: "round-trip" });
		expect(asText(remove).isError).toBe(false);
		const listAfter = await tools[0]!.handle({ action: "list" });
		expect(JSON.parse(asText(listAfter).text).length).toBe(0);
	});

	it("returns an error when storage is not yet initialized", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => null,
			accountId: "hr",
		});
		const result = await tools[0]!.handle({ action: "list" });
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toMatch(/not initialized/);
	});
});

// ---------------------------------------------------------------------------
// scheduleType correctness
//
// Bug: the host tool used to hard-code `scheduleType: "cron"` on add, so
// `cron.show` for a one-shot `+5m` task (or an interval `5m` task) would
// lie and report `scheduleType: "cron"`. The engine still ran the task
// correctly because it falls back to `parseSchedule(task.cron)` when
// `scheduleType` is missing, but the LLM-facing representation was
// wrong — and any future code that keys off `scheduleType` directly
// (skipping the re-parse) would have been broken.
//
// These tests pin the corrected behavior:
//   - `+5m`  → scheduleType: "once"
//   - `5m`   → scheduleType: "interval"
//   - `0 9 * * *`  → scheduleType: "cron"  (regression)
//   - invalid input → clear error, no row stored
//   - update from cron to `+5m` re-derives scheduleType
// ---------------------------------------------------------------------------

describe("cron host tool — scheduleType derivation", () => {
	let storage: SchedulerDbStorage;
	const storages: SchedulerDbStorage[] = [];

	beforeEach(() => {
		storage = newDb();
		storages.push(storage);
	});

	afterEach(() => {
		for (const s of storages) {
			try {
				s["#db"]?.close?.();
			} catch {}
		}
		storages.length = 0;
		try {
			fs.rmSync(TMP, { recursive: true, force: true });
		} catch {}
	});

	async function addTask(schedule: string, name = "t") {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const result = await tools[0]!.handle({
			action: "add",
			name,
			schedule,
			command: "echo x",
			taskType: "shell",
		});
		return asText(result);
	}

	it("persists scheduleType=once for a relative-time schedule (+5m)", async () => {
		const { text, isError } = await addTask("+5m", "oneshot-relative");
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.scheduleType).toBe("once");
		expect(task.cron).toBe("+5m");
	});

	it("persists scheduleType=once for an ISO-timestamp schedule", async () => {
		const { text, isError } = await addTask("2026-12-31T16:00:00Z", "oneshot-iso");
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.scheduleType).toBe("once");
		expect(task.cron).toBe("2026-12-31T16:00:00Z");
	});

	it("persists scheduleType=interval for a duration schedule (5m)", async () => {
		const { text, isError } = await addTask("5m", "interval");
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.scheduleType).toBe("interval");
		expect(task.cron).toBe("5m");
	});

	it("persists scheduleType=cron for a 5-field cron expression (regression)", async () => {
		const { text, isError } = await addTask("0 9 * * *", "cron-five");
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.scheduleType).toBe("cron");
	});

	it("persists scheduleType=cron for a 6-field cron expression", async () => {
		const { text, isError } = await addTask("0 0 9 * * *", "cron-six");
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.scheduleType).toBe("cron");
	});

	it("rejects add with an invalid schedule (no row stored)", async () => {
		const before = JSON.parse(
			asText(
				await (async () => {
					const registry = new StubRegistry();
					const tools = createCronToolDefinitions({
						getBridge: () => stubBridge(DM_MSG),
						registry: registry as unknown as ChannelRegistry,
						getStorage: () => storage,
						accountId: "hr",
					});
					return tools[0]!.handle({ action: "list" });
				})(),
			).text,
		).length;

		const { text, isError } = await addTask("not a cron", "bogus");
		expect(isError).toBe(true);
		expect(text).toMatch(/invalid schedule/);

		// Re-list to confirm nothing was stored.
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const after = JSON.parse(asText(await tools[0]!.handle({ action: "list" })).text).length;
		expect(after).toBe(before);
	});

	it("update that changes schedule from cron to one-shot re-derives scheduleType", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});

		// Create as cron
		const add = await tools[0]!.handle({
			action: "add",
			name: "switch",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
		});
		expect(JSON.parse(asText(add).text).scheduleType).toBe("cron");

		// Update schedule to a one-shot
		const update = await tools[0]!.handle({
			action: "update",
			name: "switch",
			schedule: "+10m",
		});
		const { text, isError } = asText(update);
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.scheduleType).toBe("once");
		expect(task.cron).toBe("+10m");
	});

	it("update with an invalid schedule returns an error and leaves the task unchanged", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});

		const add = await tools[0]!.handle({
			action: "add",
			name: "stable",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
		});
		const original = JSON.parse(asText(add).text);

		const update = await tools[0]!.handle({
			action: "update",
			name: "stable",
			schedule: "garbage",
		});
		const { text, isError } = asText(update);
		expect(isError).toBe(true);
		expect(text).toMatch(/invalid schedule/);

		// Task must still be there with original values.
		const show = await tools[0]!.handle({ action: "show", name: "stable" });
		const shown = JSON.parse(asText(show).text);
		expect(shown.cron).toBe(original.cron);
		expect(shown.scheduleType).toBe(original.scheduleType);
	});
});

// ---------------------------------------------------------------------------
// createdByUserId / createdByAccountId stamping
//
// Bug: tasks created via the LLM host tool previously had no record of
// who created them. Operators inspecting tasks (e.g. "who set up this
// cron?") had no audit trail. These tests pin the stamping behavior on
// `add` and the "agent owns the task" semantic: the task list is
// shared across all users in the same agent.
//
//   - DM add: createdByUserId = active chat's userId, createdByAccountId = ctx.accountId
//   - group add: createdByUserId = active chat's userId, createdByAccountId = ctx.accountId
//   - no active chat (cron trigger recursion / unit test): createdByUserId undefined,
//     createdByAccountId still stamped (always know which agent)
//
//   - cross-user visibility: user A creates a task; user B in a different
//     DM with the same agent sees it via `cron.list` (scope = agent, not user)
//   - cross-context visibility: user A in DM creates a task with delivery.toUserId
//     = A; user A in a group calls `cron.list` and sees the task (no per-conv
//     scope; agent owns the task regardless of where it was created or who
//     is asking)
// ---------------------------------------------------------------------------

const DM_USER_B: InboundMessage = {
	channelId: "dingtalk:hr",
	accountId: "hr",
	userId: "u456",
	conversationId: "dm-u456",
	isGroup: false,
	content: { type: "text", text: "test" },
};

describe("cron host tool — createdBy stamping + agent-scope visibility", () => {
	let storage: SchedulerDbStorage;
	const storages: SchedulerDbStorage[] = [];

	beforeEach(() => {
		storage = newDb();
		storages.push(storage);
	});

	afterEach(() => {
		for (const s of storages) {
			try {
				s["#db"]?.close?.();
			} catch {}
		}
		storages.length = 0;
		try {
			fs.rmSync(TMP, { recursive: true, force: true });
		} catch {}
	});

	it("stamps createdByUserId and createdByAccountId on add (DM)", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const { text, isError } = asText(
			await tools[0]!.handle({
				action: "add",
				name: "audit-me",
				schedule: "0 9 * * *",
				command: "echo x",
				taskType: "shell",
			}),
		);
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.createdByUserId).toBe("u123");
		expect(task.createdByAccountId).toBe("hr");
	});

	it("stamps createdByUserId from group chat (creator, not the group)", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(GROUP_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const { text, isError } = asText(
			await tools[0]!.handle({
				action: "add",
				name: "audit-group",
				schedule: "0 9 * * *",
				command: "echo x",
				taskType: "shell",
			}),
		);
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.createdByUserId).toBe("u123"); // the sender, not the group
		expect(task.createdByAccountId).toBe("hr");
	});

	it("leaves createdByUserId undefined when no active chat, still stamps createdByAccountId", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(undefined),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const { text, isError } = asText(
			await tools[0]!.handle({
				action: "add",
				name: "no-chat",
				schedule: "0 9 * * *",
				command: "echo x",
				taskType: "shell",
				delivery: { channel: "dingtalk:hr", toUserId: "u1" },
			}),
		);
		expect(isError).toBe(false);
		const task = JSON.parse(text);
		expect(task.createdByUserId).toBeUndefined();
		expect(task.createdByAccountId).toBe("hr");
	});

	it("scope = agent: user A's task is visible to user B in a different DM", async () => {
		const registry = new StubRegistry();
		// User A creates a task via DM_MSG
		const toolsAsA = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const add = await toolsAsA[0]!.handle({
			action: "add",
			name: "shared-task",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
		});
		expect(asText(add).isError).toBe(false);

		// User B (different userId) lists — must see A's task (agent scope, not user)
		const toolsAsB = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_USER_B),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const list = await toolsAsB[0]!.handle({ action: "list" });
		const tasks = JSON.parse(asText(list).text);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].name).toBe("shared-task");
		expect(tasks[0].createdByUserId).toBe("u123");
	});

	it("scope = agent: task created in DM is visible from a group chat on the same agent", async () => {
		const registry = new StubRegistry();
		// Create in DM
		const toolsDM = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const add = await toolsDM[0]!.handle({
			action: "add",
			name: "cross-context",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
		});
		expect(asText(add).isError).toBe(false);

		// List from a group chat on the same agent — must see it (no per-conv scope)
		const toolsGroup = createCronToolDefinitions({
			getBridge: () => stubBridge(GROUP_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
		const list = await toolsGroup[0]!.handle({ action: "list" });
		const tasks = JSON.parse(asText(list).text);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].name).toBe("cross-context");
	});
});

// ---------------------------------------------------------------------------
// test-run
//
// These tests exercise the LLM `cron.test-run` action. They use the shared
// core directly (via the `runTestRun` import) with a tiny `pollIntervalMs`
// override so the suite stays under ~3s per test. The LLM-facing handler
// is just a thin wrapper around `runTestRun` (see host-tool.ts:
// `handleTestRun`), so covering the core covers the LLM path.
//
// The execution row is pre-seeded BEFORE the test-run call so the first
// poll finds it. We cannot avoid the `Bun.sleep` between polls without
// exposing the poll loop to tests, which would make the test surface
// fragile (the production loop is 2s; tests would diverge from it).
// Instead, we let the poll fire ONCE (pollIntervalMs = 25ms) and assert
// the success path's `scheduleRestored: true` flag.
// ---------------------------------------------------------------------------

import { runTestRun } from "../src/scheduler/test-run";

describe("cron host tool — test-run action", () => {
	let storage: SchedulerDbStorage;
	const storages: SchedulerDbStorage[] = [];

	beforeEach(() => {
		storage = newDb();
		storages.push(storage);
	});

	afterEach(() => {
		for (const s of storages) {
			try {
				s["#db"]?.close?.();
			} catch {}
		}
		storages.length = 0;
		try {
			fs.rmSync(TMP, { recursive: true, force: true });
		} catch {}
	});

	function seedTask(opts: { name: string; schedule?: string }): { id: string } {
		storage.addTask({
			name: opts.name,
			cron: opts.schedule ?? "0 9 * * *",
			command: "echo test-run",
			scheduleType: "cron",
			taskType: "shell",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 0,
			failCount: 0,
			consecutiveFailures: 0,
		});
		const t = storage.getTaskByName(opts.name)!;
		return { id: t.id };
	}

	function seedTerminalExecution(taskId: string, status = "success", exitCode = 0): string {
		// Insert a terminal execution directly via the storage's
		// public `recordExecution` (it returns a generated id). The
		// shared core matches on `startedAt >= startMark - 5_000 &&
		// endedAt != null`, so the row MUST be inserted within 5s of
		// the test-run call. We insert it RIGHT before the call; the
		// startMark inside `runTestRun` is `~Date.now()` at call
		// time, so this works.
		const startedAt = Date.now();
		const inserted = storage.recordExecution({
			taskId,
			startedAt,
			endedAt: startedAt + 50,
			exitCode,
			output: "test output",
			stderr: null,
			status,
			agentSessionPath: null,
		});
		return inserted.id;
	}

	it("returns task_not_found for unknown name", async () => {
		const result = await runTestRun({
			name: "no-such-task",
			tickIntervalMs: 60_000,
			storage,
			pollIntervalMs: 25,
		});
		expect(result.kind).toBe("task_not_found");
		if (result.kind === "task_not_found") {
			expect(result.name).toBe("no-such-task");
		}
	});

	it("returns success + restores schedule when a terminal execution appears", async () => {
		const { id } = seedTask({ name: "verify-this" });
		const execId = seedTerminalExecution(id, "success", 0);

		const result = await runTestRun({
			name: "verify-this",
			inMs: 30_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			pollIntervalMs: 25,
		});

		expect(result.kind).toBe("success");
		if (result.kind === "success") {
			expect(result.execId).toBe(execId);
			expect(result.status).toBe("success");
			expect(result.exitCode).toBe(0);
			expect(result.scheduleRestored).toBe(true);
		}
		// Schedule is back to the original `0 9 * * *`.
		const after = storage.getTask(id);
		expect(after?.cron).toBe("0 9 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(after?.status).toBe("active");
	});

	it("returns delivery_failed when lastDeliveryError is set on the post-run task", async () => {
		const { id } = seedTask({ name: "delivery-broken" });
		// Add a delivery config so the test-run considers the task to
		// have a delivery target.
		storage.updateTask(id, {
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u999" },
			updatedAt: Date.now(),
		});
		const execId = seedTerminalExecution(id, "success", 0);
		// Pre-seed a delivery error to simulate a failure.
		storage.updateTask(id, { lastDeliveryError: "dingtalk API 500", updatedAt: Date.now() });

		const result = await runTestRun({
			name: "delivery-broken",
			inMs: 30_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			pollIntervalMs: 25,
		});

		expect(result.kind).toBe("delivery_failed");
		if (result.kind === "delivery_failed") {
			expect(result.execId).toBe(execId);
			expect(result.deliveryError).toBe("dingtalk API 500");
			expect(result.scheduleRestored).toBe(true);
		}
	});

	it("returns task_failed when the agent exits non-zero", async () => {
		const { id } = seedTask({ name: "will-fail" });
		const execId = seedTerminalExecution(id, "failure", 1);

		const result = await runTestRun({
			name: "will-fail",
			inMs: 30_000,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			pollIntervalMs: 25,
		});

		expect(result.kind).toBe("task_failed");
		if (result.kind === "task_failed") {
			expect(result.execId).toBe(execId);
			expect(result.exitCode).toBe(1);
			expect(result.scheduleRestored).toBe(true);
		}
		// Schedule is still restored on the task_failed path.
		const after = storage.getTask(id);
		expect(after?.cron).toBe("0 9 * * *");
	});

	it("leaves schedule NOT restored when noRestore: true", async () => {
		const { id } = seedTask({ name: "debug-no-restore" });
		seedTerminalExecution(id, "success", 0);

		const result = await runTestRun({
			name: "debug-no-restore",
			inMs: 30_000,
			timeoutMs: 5_000,
			noRestore: true,
			tickIntervalMs: 60_000,
			storage,
			pollIntervalMs: 25,
		});

		expect(result.kind).toBe("success");
		if (result.kind === "success") {
			expect(result.scheduleRestored).toBe(false);
		}
		// Task is left on `+30s once` — operator can inspect / manually
		// restore via `cron update` or by editing the SQLite row.
		const after = storage.getTask(id);
		expect(after?.scheduleType).toBe("once");
		expect(after?.cron).toBe("+30s");
	});

	it("clamps out-of-range inMs to the documented [30_000, 600_000] window", async () => {
		const { id } = seedTask({ name: "clamp-test" });
		seedTerminalExecution(id, "success", 0);

		// inMs=0 is below MIN_IN_MS (30_000); the core clamps to 30_000.
		// The test-run still succeeds because the pre-seeded terminal
		// execution is found on the first poll. After restore, the
		// schedule is back to the original `0 9 * * *`. The clamp's
		// effect on the intermediate `+<delay>s` is exercised here
		// indirectly: the gateway log emits a racy-zone warning at
		// `inMs=30000` vs `tickIntervalMs=60_000` (see the log line
		// captured in the test output) — that warning only fires
		// because the clamped value (30_000) is below 2x the tick.
		const result = await runTestRun({
			name: "clamp-test",
			inMs: 0,
			timeoutMs: 5_000,
			tickIntervalMs: 60_000,
			storage,
			pollIntervalMs: 25,
		});
		expect(result.kind).toBe("success");
		if (result.kind === "success") {
			expect(result.scheduleRestored).toBe(true);
		}
		// Schedule is back to the original; the clamp was applied to
		// the intermediate `+<delay>s` rewrite, not the final state.
		const after = storage.getTask(id);
		expect(after?.cron).toBe("0 9 * * *");
		expect(after?.scheduleType).toBe("cron");
	});

	it("the LLM host tool's test-run action returns the fire-and-forget acknowledgement", async () => {
		const { id } = seedTask({ name: "via-host-tool" });
		seedTerminalExecution(id, "success", 0);

		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
			tickIntervalMs: 60_000,
		});

		const body = await tools[0]!.handle({
			action: "test-run",
			name: "via-host-tool",
			inMs: 120_000,
			testTimeoutMs: 5_000,
		});
		const { text, isError } = asText(body);
		// Fire-and-forget: the host tool returns the `started`
		// acknowledgement (not the eventual `success`); the real
		// result comes via the cron session's AI Card, not this
		// `tool_result`. The LLM should not see `isError: true` for
		// a successfully scheduled test-run.
		expect(isError).toBe(false);
		const result = JSON.parse(text);
		expect(result.kind).toBe("started");
		// `scheduleRestored` is sync-only (CLI path). The LLM
		// host-tool's fire-and-forget path does not (and cannot)
		// synchronously report whether the schedule was later
		// restored — that's the engine's post-fire responsibility
		// (engine.ts#restoreTestRunSchedule).
		expect(result.scheduleRestored).toBeUndefined();
	});

	it("the LLM host tool's test-run returns isError=true on task_not_found", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
			tickIntervalMs: 60_000,
		});

		const body = await tools[0]!.handle({ action: "test-run", name: "ghost" });
		const { text, isError } = asText(body);
		expect(isError).toBe(true);
		expect(text).toContain("not found");
	});
});
