/**
 * Channel infrastructure tests.
 *
 *   - `channel-registry.test.ts` — ChannelRegistry routing, multi-account
 *     same-channel keys, per-account outbound dispatch.
 *   - `action-registry.test.ts` — ActionRegistry for AI Card action
 *     callbacks: register/lookup/expiry/unregister, re-register preserves
 *     createdAt.
 *   - `send-direct-message.test.ts` — Gateway.sendDirectMessage
 *     resolveDirectBridge routing across account / default bridges.
 *   - `dingtalk-permission-failopen.test.ts` — DingTalk permission policy
 *     fail-open regression: empty allowlist must deny, not allow.
 *
 * All four describe the channel/account boundary: how messages are
 * routed to the right account, what an empty allowlist means, and
 * how to recover the right bridge / session for an action.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { ActionRegistry } from "../src/action-registry";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import { ChannelRegistry } from "../src/channels/registry";
import type {
	Channel,
	ChannelCapabilities,
	ChannelConfig,
	InboundMessage as ChannelInboundMessage,
	DingTalkConfig,
	InboundMessage,
	OutboundMessage,
} from "../src/types";

// ---------------------------------------------------------------------------
// ChannelRegistry routing
// ---------------------------------------------------------------------------

class FakeChannel implements Channel {
	readonly name: string;
	readonly capabilities: ChannelCapabilities = {
		inbound: true,
		outbound: true,
		richContent: false,
		groups: true,
		mentions: false,
		voice: false,
	};
	connected = false;
	sent: OutboundMessage[] = [];
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: written by onMessage; tests don't currently invoke it but the field is part of the Channel contract
	#handler?: (msg: ChannelInboundMessage) => Promise<void>;

	constructor(
		readonly id: string,
		name?: string,
	) {
		this.name = name ?? id;
	}

	async connect(_config: ChannelConfig): Promise<void> {
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	isConnected(): boolean {
		return this.connected;
	}

	onMessage(handler: (msg: ChannelInboundMessage) => Promise<void>): void {
		this.#handler = handler;
	}

	async sendMessage(msg: OutboundMessage): Promise<void> {
		this.sent.push(msg);
	}
}

describe("ChannelRegistry", () => {
	test("keeps account-specific channels with the same channel id", async () => {
		const registry = new ChannelRegistry();
		const ops = new FakeChannel("dingtalk", "ops");
		const hr = new FakeChannel("dingtalk", "hr");

		registry.register(ops, { enabled: true }, "dingtalk:ops");
		registry.register(hr, { enabled: true }, "dingtalk:hr");

		expect(registry.getAll()).toHaveLength(2);
		await registry.connectAll(async () => {});
		expect(ops.connected).toBe(true);
		expect(hr.connected).toBe(true);
	});

	test("routes outbound messages to the matching account channel", async () => {
		const registry = new ChannelRegistry();
		const ops = new FakeChannel("dingtalk", "ops");
		const hr = new FakeChannel("dingtalk", "hr");

		registry.register(ops, { enabled: true }, "dingtalk:ops");
		registry.register(hr, { enabled: true }, "dingtalk:hr");

		await registry.sendMessage({
			channelId: "dingtalk",
			accountId: "hr",
			conversationId: "conv1",
			content: { type: "text", text: "hello" },
		});

		expect(ops.sent).toHaveLength(0);
		expect(hr.sent).toHaveLength(1);
		expect(hr.sent[0]?.accountId).toBe("hr");
	});
});

// ---------------------------------------------------------------------------
// ActionRegistry (AI Card action callback routing)
// ---------------------------------------------------------------------------

describe("ActionRegistry", () => {
	test("register + lookup returns the registered info", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		const info = reg.lookup("card_1");
		expect(info).toBeDefined();
		expect(info?.accountId).toBe("hr");
		expect(info?.sessionId).toBe("conv-1");
		expect(info?.toolName).toBeUndefined();
		expect(typeof info?.createdAt).toBe("number");
	});

	test("register accepts and stores toolName", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1", toolName: "bash" });
		const info = reg.lookup("card_1");
		expect(info?.toolName).toBe("bash");
	});

	test("lookup returns undefined for missing card", () => {
		const reg = new ActionRegistry(60_000);
		expect(reg.lookup("nope")).toBeUndefined();
	});

	test("lookup returns undefined and prunes expired entries", () => {
		// 1ms expiry is effectively "expired by the time we look"
		const reg = new ActionRegistry(1);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		// Wait for the entry to be past expiry. We use 10ms to give
		// the timer a generous margin on slow runners.
		return new Promise<void>(resolve =>
			setTimeout(() => {
				expect(reg.lookup("card_1")).toBeUndefined();
				expect(reg.size).toBe(0);
				resolve();
			}, 10),
		);
	});

	test("expire() prunes all expired entries and returns the count", () => {
		const reg = new ActionRegistry(1);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		reg.register("card_2", { accountId: "ops", sessionId: "conv-2" });
		reg.register("card_3", { accountId: "opencode", sessionId: "conv-3" });
		expect(reg.size).toBe(3);
		return new Promise<void>(resolve =>
			setTimeout(() => {
				const pruned = reg.expire();
				expect(pruned).toBe(3);
				expect(reg.size).toBe(0);
				resolve();
			}, 10),
		);
	});

	test("expire() does not prune entries that are still within the window", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		reg.register("card_2", { accountId: "ops", sessionId: "conv-2" });
		expect(reg.expire()).toBe(0);
		expect(reg.size).toBe(2);
	});

	test("re-registering the same cardInstanceId preserves createdAt", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		const first = reg.lookup("card_1");
		expect(first?.createdAt).toBeGreaterThan(0);
		const firstCreatedAt = first!.createdAt;
		// Wait a tick so a fresh `Date.now()` would differ
		return new Promise<void>(resolve =>
			setTimeout(() => {
				reg.register("card_1", { accountId: "hr", sessionId: "conv-1", toolName: "bash" });
				const second = reg.lookup("card_1");
				expect(second?.toolName).toBe("bash");
				expect(second?.createdAt).toBe(firstCreatedAt);
				resolve();
			}, 5),
		);
	});

	test("unregister removes a single entry and returns whether it existed", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		expect(reg.unregister("card_1")).toBe(true);
		expect(reg.size).toBe(0);
		expect(reg.lookup("card_1")).toBeUndefined();
		// Removing a non-existent entry returns false
		expect(reg.unregister("card_1")).toBe(false);
	});

	test("size reflects current entry count", () => {
		const reg = new ActionRegistry(60_000);
		expect(reg.size).toBe(0);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		expect(reg.size).toBe(1);
		reg.register("card_2", { accountId: "ops", sessionId: "conv-2" });
		expect(reg.size).toBe(2);
		reg.unregister("card_1");
		expect(reg.size).toBe(1);
	});

	test("expiryMs exposes the configured window", () => {
		expect(new ActionRegistry().expiryMs).toBe(30 * 60_000);
		expect(new ActionRegistry(123_456).expiryMs).toBe(123_456);
	});
});

// ---------------------------------------------------------------------------
// sendDirectMessage multi-account routing
// ---------------------------------------------------------------------------

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    currentSession = frame.sessionPath;
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    const sessionAtPrompt = currentSession;
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "echo:" + sessionAtPrompt + "::" + frame.message }] } });
      emit({ type: "agent_end" });
    }, 0);
  }
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) await handleFrame(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
}
`;

async function createFakeRpcBinary(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-direct-msg-"));
	const scriptPath = path.join(dir, "fake-rpc");
	await Bun.write(scriptPath, FAKE_RPC_SCRIPT);
	await fs.chmod(scriptPath, 0o755);
	return {
		path: scriptPath,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Mirrors the routing logic from Gateway.#resolveDirectBridge.
 * This is the contract we need to verify.
 */
function resolveDirectBridge(
	accountId: string | undefined,
	accountBridges: Map<string, AgentBridge>,
	defaultBridge: AgentBridge | null,
): AgentBridge | null {
	if (accountId && accountBridges.has(accountId)) {
		return accountBridges.get(accountId)!;
	}
	if (!accountId && accountBridges.size === 0 && defaultBridge?.isRunning) {
		return defaultBridge;
	}
	return null;
}

describe("sendDirectMessage multi-account routing", () => {
	test("routes to the specified account bridge when accountId is provided", async () => {
		const fake = await createFakeRpcBinary();
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-direct-msg-routing-"));

		try {
			const opsDir = path.join(rootDir, "agents", "ops");
			const hrDir = path.join(rootDir, "agents", "hr");
			await ensureAgentDir(opsDir);
			await ensureAgentDir(hrDir);

			const opsBridge = new AgentBridge({ ompPath: fake.path, cwd: opsDir, timeoutMs: 2_000 });
			const hrBridge = new AgentBridge({ ompPath: fake.path, cwd: hrDir, timeoutMs: 2_000 });

			await opsBridge.start();
			await hrBridge.start();

			const bridges = new Map<string, AgentBridge>();
			bridges.set("ops", opsBridge);
			bridges.set("hr", hrBridge);

			// Verify resolveDirectBridge contract
			const resolved = resolveDirectBridge("ops", bridges, null);
			expect(resolved).toBe(opsBridge);

			const resolvedHr = resolveDirectBridge("hr", bridges, null);
			expect(resolvedHr).toBe(hrBridge);

			// Verify the bridge actually forwards correctly with account context
			const opsSession = {
				id: "test-session-ops",
				channelId: "cli",
				accountId: "ops",
				userId: "cli-user",
				conversationId: "cli-conv-ops",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active" as const,
			};
			const opsMessage = {
				channelId: "cli",
				userId: "cli-user",
				userName: "CLI User",
				conversationId: "cli-conv-ops",
				isGroup: false,
				content: { type: "text" as const, text: "hello ops" },
				timestamp: new Date(),
			};
			const opsResponse = await opsBridge.forward(opsMessage, opsSession);
			expect(opsResponse).toContain("hello ops");

			const hrSession = {
				id: "test-session-hr",
				channelId: "cli",
				accountId: "hr",
				userId: "cli-user",
				conversationId: "cli-conv-hr",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active" as const,
			};
			const hrMessage = {
				channelId: "cli",
				userId: "cli-user",
				userName: "CLI User",
				conversationId: "cli-conv-hr",
				isGroup: false,
				content: { type: "text" as const, text: "hello hr" },
				timestamp: new Date(),
			};
			const hrResponse = await hrBridge.forward(hrMessage, hrSession);
			expect(hrResponse).toContain("hello hr");
		} finally {
			await fs.rm(rootDir, { recursive: true, force: true });
			await fake.cleanup();
		}
	});

	test("returns null when accountId is omitted in multi-account mode", () => {
		const bridges = new Map<string, AgentBridge>();
		// Don't need real bridges for routing logic test
		const result = resolveDirectBridge(undefined, bridges, null);
		expect(result).toBeNull();
	});

	test("returns default bridge when accountId is omitted in single-account mode", async () => {
		const fake = await createFakeRpcBinary();
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-direct-msg-single-"));

		try {
			const agentDir = path.join(rootDir, "agents", "default");
			await ensureAgentDir(agentDir);
			const defaultBridge = new AgentBridge({ ompPath: fake.path, cwd: agentDir, timeoutMs: 2_000 });
			await defaultBridge.start();

			const bridges = new Map<string, AgentBridge>(); // empty = single-account mode
			const result = resolveDirectBridge(undefined, bridges, defaultBridge);
			expect(result).toBe(defaultBridge);

			// Verify default bridge still works
			const session = {
				id: "cli-session-__default__",
				channelId: "cli",
				accountId: "__default__",
				userId: "cli-user",
				conversationId: "cli-conv-__default__",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				status: "active" as const,
			};
			const message = {
				channelId: "cli",
				userId: "cli-user",
				userName: "CLI User",
				conversationId: "cli-conv-__default__",
				isGroup: false,
				content: { type: "text" as const, text: "hello default" },
				timestamp: new Date(),
			};
			const response = await defaultBridge.forward(message, session);
			expect(response).toContain("hello default");
		} finally {
			await fs.rm(rootDir, { recursive: true, force: true });
			await fake.cleanup();
		}
	});

	test("returns null for unknown accountId", () => {
		const bridges = new Map<string, AgentBridge>();
		const result = resolveDirectBridge("nonexistent", bridges, null);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// DingTalk permission policy — fail-open regression
//
// Contract: When dmPolicy is "allowlist" and allowedUsers is empty,
// the channel MUST deny all DM messages. An empty allowlist means
// "nobody is allowed", not "everybody is allowed". Same for groups.
// ---------------------------------------------------------------------------

function makeDM(userId: string): InboundMessage {
	return {
		userId,
		conversationId: "cid001",
		messageId: "msg001",
		isGroup: false,
		content: { type: "text", text: "hello" },
		raw: {},
		channel: "dingtalk",
		accountId: "__default__",
	};
}

function makeGroup(userId: string, conversationId: string): InboundMessage {
	return {
		userId,
		conversationId,
		messageId: "msg002",
		isGroup: true,
		content: { type: "text", text: "hello" },
		raw: {},
		channel: "dingtalk",
		accountId: "__default__",
	};
}

describe("DingTalk permission policy — fail-open fix", () => {
	test("DM allowlist with empty allowedUsers denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "allowlist",
			allowedUsers: [],
		} as DingTalkConfig);

		// Bug: empty allowlist returned true (open). Fix: return false.
		expect(channel.__testCheckPermission(makeDM("user1"))).toBe(false);
	});

	test("DM allowlist with no allowedUsers field denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "allowlist",
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("user1"))).toBe(false);
	});

	test("DM allowlist with populated allowedUsers allows listed user", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "allowlist",
			allowedUsers: ["user1", "user2"],
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("user1"))).toBe(true);
	});

	test("DM allowlist with populated allowedUsers denies unlisted user", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "allowlist",
			allowedUsers: ["user1"],
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("attacker"))).toBe(false);
	});

	test("group allowlist with empty allowedGroups denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			groupPolicy: "allowlist",
			allowedGroups: [],
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeGroup("user1", "grp001"))).toBe(false);
	});

	test("group allowlist with no allowedGroups field denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			groupPolicy: "allowlist",
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeGroup("user1", "grp001"))).toBe(false);
	});

	test("DM open policy allows all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "open",
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("anyone"))).toBe(true);
	});

	test("DM closed policy denies all", () => {
		const channel = new DingTalkChannel();
		channel.__testSetConfig({
			enabled: true,
			dmPolicy: "closed",
		} as DingTalkConfig);

		expect(channel.__testCheckPermission(makeDM("anyone"))).toBe(false);
	});
});

// keep the `beforeEach`/`afterEach` import live for future tests in this file
void beforeEach;
void afterEach;
void spyOn;
