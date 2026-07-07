/**
 * Host tools — `bridge.status` (read-only diagnostic) and `cron`
 * (delivery auto-inference, channel registry, scheduleType derivation,
 * audit stamping, agent-scope visibility, test-run fire-and-forget).
 *
 * Merged:
 *   - host-tool-bridge-status.test.ts
 *   - host-tool-cron.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBridge, AgentBridgeSnapshot } from "../src/agent-bridge";
import { createBridgeStatusToolDefinitions } from "../src/bridge-status-tool";
import type { ChannelRegistry } from "../src/channels/registry";
import { createCronToolDefinitions } from "../src/scheduler/host-tool";
import { JsonFileStorage } from "../src/scheduler/json-file-storage";
import { runTestRun } from "../src/scheduler/test-run";
import { clearTestRunMarker, hasTestRunMarker, readTestRunMarker } from "../src/scheduler/test-run-marker";
import type { ScheduledTask } from "../src/scheduler/types";
import type { InboundMessage } from "../src/types";

// ===========================================================================
// bridge.status host tool
// ===========================================================================

function stubBridge(snapshot: AgentBridgeSnapshot): AgentBridge {
	return {
		getSnapshot: () => snapshot,
	} as unknown as AgentBridge;
}

const IDLE_SNAPSHOT: AgentBridgeSnapshot = {
	state: "idle",
	running: true,
	ready: true,
	pid: 12345,
	pendingPrompts: 0,
	pendingCommands: 0,
	circuitState: "closed",
	circuitFailures: 0,
	crashCount: 0,
	crashWindowCount: 0,
	crashSuppressed: false,
	reconnecting: false,
};

function asText(body: { content: Array<{ type: string; text: string }>; isError?: boolean }): {
	text: string;
	isError: boolean;
} {
	return { text: body.content.map(c => c.text).join(""), isError: body.isError === true };
}

describe("bridge.status host tool — factory", () => {
	it("registers exactly one tool named 'bridge.status'", () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		expect(tools).toHaveLength(1);
		expect(tools[0]!.definition.name).toBe("bridge.status");
	});

	it("definition has empty parameters (no LLM-supplied input)", () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		expect(tools[0]!.definition.parameters).toBeDefined();
	});

	it("description mentions each lifecycle state", () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		const desc = tools[0]!.definition.description;
		for (const s of ["stopped", "starting", "idle", "busy", "restarting", "degraded", "error"]) {
			expect(desc).toContain(`\`${s}\``);
		}
	});
});

describe("bridge.status host tool — bridge not initialized", () => {
	it("returns errResult when getBridge() returns null", async () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => null });
		const result = await tools[0]!.handle({});
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toContain("bridge not initialized");
	});
});

describe("bridge.status host tool — each lifecycle state", () => {
	const cases: Array<{
		name: string;
		snap: AgentBridgeSnapshot;
		summaryContains: string;
		stateExpect: string;
	}> = [
		{
			name: "idle — healthy",
			snap: IDLE_SNAPSHOT,
			summaryContains: "healthy and ready",
			stateExpect: "idle",
		},
		{
			name: "busy — processing a prompt with one queued",
			snap: {
				...IDLE_SNAPSHOT,
				state: "busy",
				activePromptId: "p-42",
				activeSessionPath: "/tmp/sess.jsonl",
				pendingPrompts: 1,
			},
			summaryContains: "promptId=p-42",
			stateExpect: "busy",
		},
		{
			name: "busy — processing a prompt, nothing queued",
			snap: {
				...IDLE_SNAPSHOT,
				state: "busy",
				activePromptId: "p-7",
				pendingPrompts: 0,
			},
			summaryContains: "Wait for it to finish",
			stateExpect: "busy",
		},
		{
			name: "stopped — OMP down",
			snap: {
				...IDLE_SNAPSHOT,
				state: "stopped",
				running: false,
				ready: false,
				pid: undefined,
			},
			summaryContains: "not running",
			stateExpect: "stopped",
		},
		{
			name: "starting — waiting for first ready",
			snap: {
				...IDLE_SNAPSHOT,
				state: "starting",
				running: false,
				ready: false,
				pid: undefined,
			},
			summaryContains: "starting up",
			stateExpect: "starting",
		},
		{
			name: "restarting — OMP crashed, backoff",
			snap: {
				...IDLE_SNAPSHOT,
				state: "restarting",
				reconnecting: true,
				crashCount: 2,
				crashWindowCount: 2,
			},
			summaryContains: "crashCount=2",
			stateExpect: "restarting",
		},
		{
			name: "degraded — circuit open with 10 failures",
			snap: {
				...IDLE_SNAPSHOT,
				state: "degraded",
				circuitState: "open",
				circuitFailures: 10,
				circuitOpenedAt: Date.now() - 5_000,
			},
			summaryContains: "10 consecutive failures",
			stateExpect: "degraded",
		},
		{
			name: "error — suppressed after too many crashes",
			snap: {
				...IDLE_SNAPSHOT,
				state: "error",
				crashSuppressed: true,
				crashCount: 5,
				crashWindowCount: 5,
				running: false,
				ready: false,
				lastError: "process exited before ready",
			},
			summaryContains: "suppressed state",
			stateExpect: "error",
		},
	];

	for (const c of cases) {
		it(`${c.name}: returns state=${c.stateExpect} + summary mentioning "${c.summaryContains}"`, async () => {
			const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(c.snap) });
			const result = await tools[0]!.handle({});
			const { text, isError } = asText(result);
			expect(isError).toBe(false);
			const payload = JSON.parse(text) as AgentBridgeSnapshot & { summary: string };
			expect(payload.state).toBe(c.stateExpect);
			expect(payload.summary).toContain(c.summaryContains);
		});

		it(`${c.name}: full snapshot is returned (not a stripped subset)`, async () => {
			const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(c.snap) });
			const result = await tools[0]!.handle({});
			const payload = JSON.parse(asText(result).text) as Record<string, unknown>;
			for (const [key, value] of Object.entries(c.snap)) {
				if (value !== undefined) {
					expect(payload).toHaveProperty(key);
				}
			}
			expect(payload).toHaveProperty("summary");
		});
	}
});

describe("bridge.status host tool — input tolerance", () => {
	it("ignores extra arguments without error", async () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		const result = await tools[0]!.handle({ junk: "ignored", n: 42 } as unknown as Record<string, unknown>);
		const { isError } = asText(result);
		expect(isError).toBe(false);
	});

	it("works when called with empty args", async () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		const result = await tools[0]!.handle({});
		const { isError } = asText(result);
		expect(isError).toBe(false);
	});
});

describe("bridge.status host tool — summary phrasing", () => {
	it("idle summary says 'no prompts in flight'", async () => {
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(IDLE_SNAPSHOT) });
		const result = await tools[0]!.handle({});
		const payload = JSON.parse(asText(result).text) as { summary: string };
		expect(payload.summary.toLowerCase()).toContain("no prompts in flight");
	});

	it("degraded summary tells the LLM when retries may be accepted", async () => {
		const snap: AgentBridgeSnapshot = {
			...IDLE_SNAPSHOT,
			state: "degraded",
			circuitState: "open",
			circuitFailures: 10,
			circuitOpenedAt: Date.now() - 12_000,
		};
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(snap) });
		const result = await tools[0]!.handle({});
		const payload = JSON.parse(asText(result).text) as { summary: string };
		expect(payload.summary).toContain("12s ago");
		expect(payload.summary).toContain("cooldown");
	});

	it("error summary tells the LLM to escalate to operator", async () => {
		const snap: AgentBridgeSnapshot = {
			...IDLE_SNAPSHOT,
			state: "error",
			crashSuppressed: true,
			crashWindowCount: 5,
		};
		const tools = createBridgeStatusToolDefinitions({ getBridge: () => stubBridge(snap) });
		const result = await tools[0]!.handle({});
		const payload = JSON.parse(asText(result).text) as { summary: string };
		expect(payload.summary.toLowerCase()).toContain("operator");
	});
});

// ===========================================================================
// cron host tool
// ===========================================================================

const TMP = path.join(os.tmpdir(), `omp-test-cron-${process.pid}-${Date.now()}`);

function newDb(): JsonFileStorage {
	fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
	return new JsonFileStorage(path.join(TMP, `cron-${Math.random().toString(36).slice(2)}.json`));
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

function stubCronBridge(activeChat: InboundMessage | undefined): AgentBridge {
	return {
		getActiveChatContext: () => activeChat,
		// No active session path in tests — the LLM host tool stamps
		// `origin` only when this returns a path. Leaving it undefined
		// means tests exercise the no-origin path (no notification).
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

const DM_USER_B: InboundMessage = {
	channelId: "dingtalk:hr",
	accountId: "hr",
	userId: "u456",
	conversationId: "dm-u456",
	isGroup: false,
	content: { type: "text", text: "test" },
};

// ---------------------------------------------------------------------------
// delivery auto-inference
// ---------------------------------------------------------------------------

describe("cron host tool — delivery auto-inference", () => {
	let storage: JsonFileStorage;
	const storages: JsonFileStorage[] = [];

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
			getBridge: () => stubCronBridge(DM_MSG),
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
			getBridge: () => stubCronBridge(GROUP_MSG),
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
			getBridge: () => stubCronBridge(undefined),
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
			getBridge: () => stubCronBridge(undefined),
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
			getBridge: () => stubCronBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});
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
			getBridge: () => stubCronBridge(undefined),
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
			getBridge: () => stubCronBridge(DM_MSG),
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
			getBridge: () => stubCronBridge(DM_MSG),
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
// scheduleType derivation
// ---------------------------------------------------------------------------

describe("cron host tool — scheduleType derivation", () => {
	let storage: JsonFileStorage;
	const storages: JsonFileStorage[] = [];

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
			getBridge: () => stubCronBridge(DM_MSG),
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
						getBridge: () => stubCronBridge(DM_MSG),
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

		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubCronBridge(DM_MSG),
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
			getBridge: () => stubCronBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
		});

		const add = await tools[0]!.handle({
			action: "add",
			name: "switch",
			schedule: "0 9 * * *",
			command: "echo x",
			taskType: "shell",
		});
		expect(JSON.parse(asText(add).text).scheduleType).toBe("cron");

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
			getBridge: () => stubCronBridge(DM_MSG),
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

		const show = await tools[0]!.handle({ action: "show", name: "stable" });
		const shown = JSON.parse(asText(show).text);
		expect(shown.cron).toBe(original.cron);
		expect(shown.scheduleType).toBe(original.scheduleType);
	});
});

// ---------------------------------------------------------------------------
// createdBy stamping + agent-scope visibility
// ---------------------------------------------------------------------------

describe("cron host tool — createdBy stamping + agent-scope visibility", () => {
	let storage: JsonFileStorage;
	const storages: JsonFileStorage[] = [];

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
			getBridge: () => stubCronBridge(DM_MSG),
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
			getBridge: () => stubCronBridge(GROUP_MSG),
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
		expect(task.createdByUserId).toBe("u123");
		expect(task.createdByAccountId).toBe("hr");
	});

	it("leaves createdByUserId undefined when no active chat, still stamps createdByAccountId", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubCronBridge(undefined),
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
		const toolsAsA = createCronToolDefinitions({
			getBridge: () => stubCronBridge(DM_MSG),
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

		const toolsAsB = createCronToolDefinitions({
			getBridge: () => stubCronBridge(DM_USER_B),
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
		const toolsDM = createCronToolDefinitions({
			getBridge: () => stubCronBridge(DM_MSG),
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

		const toolsGroup = createCronToolDefinitions({
			getBridge: () => stubCronBridge(GROUP_MSG),
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
// test-run (runTestRun core + LLM host tool wrapper)
// ---------------------------------------------------------------------------

describe("cron host tool — test-run action", () => {
	let storage: JsonFileStorage;
	const storages: JsonFileStorage[] = [];

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
		const after = storage.getTask(id);
		expect(after?.cron).toBe("0 9 * * *");
		expect(after?.scheduleType).toBe("cron");
		expect(after?.status).toBe("active");
	});

	it("returns delivery_failed when lastDeliveryError is set on the post-run task", async () => {
		const { id } = seedTask({ name: "delivery-broken" });
		storage.updateTask(id, {
			delivery: { channel: "dingtalk", accountId: "hr", toUserId: "u999", mode: "announce" },
			updatedAt: Date.now(),
		});
		const execId = seedTerminalExecution(id, "success", 0);
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
		const after = storage.getTask(id);
		expect(after?.scheduleType).toBe("once");
		expect(after?.cron).toBe("+30s");
	});

	it("clamps out-of-range inMs to the documented [30_000, 600_000] window", async () => {
		const { id } = seedTask({ name: "clamp-test" });
		seedTerminalExecution(id, "success", 0);

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
		const after = storage.getTask(id);
		expect(after?.cron).toBe("0 9 * * *");
		expect(after?.scheduleType).toBe("cron");
	});

	it("the LLM host tool's test-run action returns fire-and-forget { kind: 'started' } in milliseconds", async () => {
		const { id } = seedTask({ name: "via-host-tool" });
		seedTerminalExecution(id, "success", 0);

		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubCronBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
			tickIntervalMs: 60_000,
		});

		const before = Date.now();
		const body = await tools[0]!.handle({
			action: "test-run",
			name: "via-host-tool",
			inMs: 120_000,
			testTimeoutMs: 5_000,
		});
		const elapsed = Date.now() - before;
		const { text, isError } = asText(body);
		expect(isError).toBe(false);
		const result = JSON.parse(text);
		expect(result.kind).toBe("started");
		expect(result.name).toBe("via-host-tool");
		expect(result.inMs).toBe(120_000);
		expect(result.timeoutMs).toBe(5_000);
		expect(result.expiresAt).toBeGreaterThan(Date.now());
		expect(typeof result.startedAt).toBe("number");
		expect(elapsed).toBeLessThan(1_500);
		const after = storage.getTask(id);
		expect(after?.cron).toMatch(/^\+\d+s$/);
		expect(after?.scheduleType).toBe("once");
	});

	it("the LLM host tool's test-run returns isError=true on task_not_found", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubCronBridge(DM_MSG),
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

	it("the LLM host tool's test-run hard-rejects sub-tick inMs", async () => {
		const registry = new StubRegistry();
		const tools = createCronToolDefinitions({
			getBridge: () => stubCronBridge(DM_MSG),
			registry: registry as unknown as ChannelRegistry,
			getStorage: () => storage,
			accountId: "hr",
			tickIntervalMs: 60_000,
		});

		const body = await tools[0]!.handle({
			action: "test-run",
			name: "anything",
			inMs: 30_000,
		});
		const { text, isError } = asText(body);
		expect(isError).toBe(true);
		expect(text).toContain("below the gateway tick");
		expect(text).toContain("120000");
	});

	it("the LLM host tool's test-run default inMs is 120_000 (2x tick)", async () => {
		const { DEFAULT_IN_MS } = await import("../src/scheduler/test-run");
		expect(DEFAULT_IN_MS).toBe(120_000);
	});
});

// ---------------------------------------------------------------------------
// Fire-and-forget (awaitResult: false)
// ---------------------------------------------------------------------------

describe("runTestRun — fire-and-forget (awaitResult: false)", () => {
	let tempDir: string;
	let storage: JsonFileStorage;

	function seedTask(overrides: Partial<ScheduledTask> = {}): { id: string; originalCron: string } {
		const created = storage.addTask({
			name: "fire-and-forget",
			cron: "0 9 * * *",
			command: "echo x",
			scheduleType: "cron",
			status: "active",
			taskType: "shell",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			runCount: 3,
			failCount: 0,
			consecutiveFailures: 0,
			...overrides,
		});
		return { id: created.id, originalCron: created.cron };
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-run-fireforget-"));
		storage = new JsonFileStorage(path.join(tempDir, "jobs.json"));
	});

	afterEach(() => {
		storage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns { kind: 'started' } in milliseconds without polling", async () => {
		const { id } = seedTask();

		const before = Date.now();
		const result = await runTestRun({
			name: "fire-and-forget",
			inMs: 120_000,
			timeoutMs: 30_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir: tempDir,
			awaitResult: false,
		});
		const elapsed = Date.now() - before;

		expect(result.kind).toBe("started");
		if (result.kind === "started") {
			expect(result.name).toBe("fire-and-forget");
			expect(result.inMs).toBe(120_000);
			expect(result.timeoutMs).toBe(30_000);
			expect(result.expiresAt).toBe(result.startedAt + 120_000 + 90_000);
		}
		expect(elapsed).toBeLessThan(1_500);
		const after = storage.getTask(id);
		expect(after?.cron).toMatch(/^\+\d+s$/);
		expect(after?.scheduleType).toBe("once");
		expect(after?.runCount).toBe(3);
		expect(hasTestRunMarker(tempDir)).toBe(true);
		const marker = readTestRunMarker(tempDir);
		expect(marker?.awaitingFire).toBe(true);
		expect(marker?.expiresAt).toBeGreaterThan(Date.now());
	});

	it("does NOT clear the marker on return (engine post-fire owns cleanup)", async () => {
		seedTask();

		await runTestRun({
			name: "fire-and-forget",
			inMs: 60_000,
			timeoutMs: 10_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir: tempDir,
			awaitResult: false,
		});
		expect(hasTestRunMarker(tempDir)).toBe(true);
	});

	it("preserves the snapshot in the marker so the engine can restore stats", async () => {
		const pastTime = Date.now() - 86_400_000;
		seedTask({
			runCount: 7,
			failCount: 2,
			consecutiveFailures: 1,
			lastRunAt: pastTime,
			lastDeliveryError: "stale delivery error",
		});

		await runTestRun({
			name: "fire-and-forget",
			inMs: 60_000,
			timeoutMs: 10_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir: tempDir,
			awaitResult: false,
		});
		const marker = readTestRunMarker(tempDir);
		expect(marker).not.toBeNull();
		expect(marker?.snapshot.runCount).toBe(7);
		expect(marker?.snapshot.failCount).toBe(2);
		expect(marker?.snapshot.consecutiveFailures).toBe(1);
		expect(marker?.snapshot.lastRunAt).toBe(pastTime);
		expect(marker?.snapshot.lastDeliveryError).toBe("stale delivery error");
		expect(marker?.snapshot.cron).toBe("0 9 * * *");
	});

	it("clearTestRunMarker is the engine's job, not the host tool's", async () => {
		seedTask();
		await runTestRun({
			name: "fire-and-forget",
			inMs: 60_000,
			timeoutMs: 10_000,
			tickIntervalMs: 60_000,
			storage,
			markerBaseDir: tempDir,
			awaitResult: false,
		});
		clearTestRunMarker(tempDir);
		expect(hasTestRunMarker(tempDir)).toBe(false);
	});

	it("returns task_not_found for unknown name (no marker written)", async () => {
		const result = await runTestRun({
			name: "does-not-exist",
			inMs: 60_000,
			timeoutMs: 10_000,
			tickIntervalMs: 60_000,
			storage,
			awaitResult: false,
		});
		expect(result.kind).toBe("task_not_found");
		expect(hasTestRunMarker(tempDir)).toBe(false);
	});
});
