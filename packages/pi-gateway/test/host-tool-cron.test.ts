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
