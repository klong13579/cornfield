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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentBridge } from "../src/agent-bridge";
import type { ChannelRegistry } from "../src/channels/registry";
import type { InboundMessage } from "../src/types";
import { createCronToolDefinitions } from "../src/scheduler/host-tool";
import { SchedulerDbStorage } from "../src/scheduler/storage";

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

function asText(body: { content: Array<{ type: string; text: string }>; isError?: boolean }): { text: string; isError: boolean } {
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
		});
		const result = await tools[0]!.handle({ action: "list" });
		const { text, isError } = asText(result);
		expect(isError).toBe(true);
		expect(text).toMatch(/not initialized/);
	});
});
