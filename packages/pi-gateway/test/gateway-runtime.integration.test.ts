/**
 * Gateway runtime integration tests.
 *
 * These avoid external DingTalk/LLM services but wire the real gateway runtime
 * components together: SQLiteSessionStore, SessionManager, AgentBridge RPC
 * subprocesses, ChannelRegistry, and agentDir session paths.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { parseRobotMessage } from "../src/channels/dingtalk";
import { ChannelRegistry } from "../src/channels/registry";
import type { Channel, ChannelCapabilities, ChannelConfig, DingTalkRawMessage, InboundMessage, OutboundMessage } from "../src/types";
import { SessionManager } from "../src/session-manager";
import { SQLiteSessionStore } from "../src/session-store";
import { buildAgentSessionPath, ensureAgentDir } from "../src/setup";
import { sampleTextMessage } from "./fixtures/sample-messages";

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
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: sessionAtPrompt + " :: " + frame.message }] } });
      emit({ type: "agent_end" });
    }, String(frame.message).includes("slow") ? 40 : 0);
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

class FakeChannel implements Channel {
	readonly id = "dingtalk";
	readonly name: string;
	readonly capabilities: ChannelCapabilities = {
		inbound: true,
		outbound: true,
		richContent: true,
		groups: true,
		mentions: true,
		voice: false,
	};
	connected = false;
	sent: OutboundMessage[] = [];
	#handler?: (msg: InboundMessage) => Promise<void>;

	constructor(readonly accountId: string) {
		this.name = `DingTalk ${accountId}`;
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

	onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
		this.#handler = handler;
	}

	async emitInbound(msg: InboundMessage): Promise<void> {
		if (!this.#handler) throw new Error("channel handler not registered");
		await this.#handler(msg);
	}

	async emitRobotMessage(raw: DingTalkRawMessage): Promise<void> {
		const inbound = parseRobotMessage(raw, this.id, this.accountId, raw.msgId);
		if (!inbound) throw new Error("raw DingTalk message did not parse");
		await this.emitInbound(inbound);
	}

	async sendMessage(msg: OutboundMessage): Promise<void> {
		this.sent.push(msg);
	}
}

interface Harness {
	rootDir: string;
	rpcPath: string;
	store: SQLiteSessionStore;
	registry: ChannelRegistry;
	manager: SessionManager;
	bridges: Map<string, AgentBridge>;
	channels: Map<string, FakeChannel>;
}

async function createHarness(): Promise<Harness> {
	const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-runtime-"));
	const rpcPath = path.join(rootDir, "fake-rpc");
	await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
	await fs.chmod(rpcPath, 0o755);

	const store = new SQLiteSessionStore(path.join(rootDir, "sessions.db"));
	const registry = new ChannelRegistry();
	const bridges = new Map<string, AgentBridge>();
	const channels = new Map<string, FakeChannel>();

	for (const accountId of ["ops", "hr"]) {
		const agentDir = path.join(rootDir, "agents", accountId);
		await ensureAgentDir(agentDir);
		const bridge = new AgentBridge({ ompPath: rpcPath, cwd: agentDir, timeoutMs: 2_000 });
		await bridge.start();
		bridges.set(accountId, bridge);

		const channel = new FakeChannel(accountId);
		channels.set(accountId, channel);
		registry.register(channel, { enabled: true }, `dingtalk:${accountId}`);
	}

	const manager = new SessionManager({ bridges });
	await registry.connectAll(async msg => {
		const accountId = msg.accountId ?? "__default__";
		const agentDir = path.join(rootDir, "agents", accountId);
		let session = await store.getSession(msg.channelId, accountId, msg.conversationId);
		if (!session) {
			session = await store.createSession({
				channelId: msg.channelId,
				accountId,
				userId: msg.userId,
				conversationId: msg.conversationId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				ompSessionPath: buildAgentSessionPath(agentDir, msg.conversationId),
				status: "active",
			});
		}

		await registry.sendMessage({
			channelId: msg.channelId,
			accountId: msg.accountId,
			conversationId: msg.conversationId,
			sessionWebhook: msg.sessionWebhook,
			content: { type: "markdown", markdown: "thinking..." },
		});
		const response = await manager.enqueue(msg, session);
		if (response) {
			await registry.sendMessage({
				channelId: msg.channelId,
				accountId: msg.accountId,
				conversationId: msg.conversationId,
				sessionWebhook: msg.sessionWebhook,
				content: { type: "text", text: response },
			});
		}
	});

	return { rootDir, rpcPath, store, registry, manager, bridges, channels };
}

function makeRobotMessage(accountId: string, conversationId: string, text: string): DingTalkRawMessage {
	return sampleTextMessage({
		conversationId,
		msgId: `${accountId}-${conversationId}-${text.replace(/\s+/g, "-")}`,
		senderStaffId: `${accountId}-user`,
		senderId: `${accountId}-user`,
		senderNick: `${accountId} user`,
		sessionWebhook: `https://example.com/${accountId}`,
		text: { content: text },
	});
}

describe("gateway runtime integration", () => {
	let harness: Harness | undefined;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(async () => {
		if (!harness) return;
		await harness.registry.disconnectAll();
		for (const bridge of harness.bridges.values()) bridge.stop();
		harness.store.close();
		await fs.rm(harness.rootDir, { recursive: true, force: true });
		harness = undefined;
	});

	test("routes account messages through isolated agentDir sessions", async () => {
		if (!harness) throw new Error("missing harness");
		const ops = harness.channels.get("ops");
		const hr = harness.channels.get("hr");
		if (!ops || !hr) throw new Error("missing channels");

		await Promise.all([
			ops.emitRobotMessage(makeRobotMessage("ops", "shared-conv", "slow ops")),
			hr.emitRobotMessage(makeRobotMessage("hr", "shared-conv", "hello hr")),
		]);

		expect(ops.sent).toHaveLength(2);
		expect(hr.sent).toHaveLength(2);
		const opsReply = ops.sent[1]?.content;
		const hrReply = hr.sent[1]?.content;
		if (opsReply?.type !== "text") throw new Error("expected ops text reply");
		if (hrReply?.type !== "text") throw new Error("expected hr text reply");

		expect(opsReply.text).toContain(path.join(harness.rootDir, "agents", "ops", "sessions", "shared-conv.jsonl"));
		expect(hrReply.text).toContain(path.join(harness.rootDir, "agents", "hr", "sessions", "shared-conv.jsonl"));

		const opsSession = await harness.store.getSession("dingtalk", "ops", "shared-conv");
		const hrSession = await harness.store.getSession("dingtalk", "hr", "shared-conv");
		expect(opsSession?.ompSessionPath).toBe(path.join(harness.rootDir, "agents", "ops", "sessions", "shared-conv.jsonl"));
		expect(hrSession?.ompSessionPath).toBe(path.join(harness.rootDir, "agents", "hr", "sessions", "shared-conv.jsonl"));
	});
});
