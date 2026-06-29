/**
 * Restart sentinel e2e test.
 *
 * Tests the full restart recovery flow:
 * 1. Start gateway, send a message, get a response (establish session)
 * 2. Write a restart sentinel (simulating a crash/interrupt)
 * 3. Stop gateway
 * 4. Start new gateway
 * 5. Verify the new gateway reads the sentinel and resumes the conversation
 * 6. Verify the agent sees the full history
 *
 * Uses a fake RPC script to avoid needing a real LLM/omp process.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { AgentBridge } from "../src/agent-bridge";
import { parseRobotMessage } from "../src/channels/dingtalk";
import { ChannelRegistry } from "../src/channels/registry";
import { Gateway } from "../src/gateway";
import { writeRestartSentinel, readRestartSentinel, clearRestartSentinel } from "../src/restart-sentinel";
import { SessionManager } from "../src/session-manager";
import { SQLiteSessionStore } from "../src/session-store";
import type {
	Channel,
	ChannelCapabilities,
	ChannelConfig,
	DingTalkRawMessage,
	InboundMessage,
	OutboundMessage,
} from "../src/types";
import { sampleTextMessage } from "./fixtures/sample-messages";

/**
 * Fake RPC script that simulates an omp --mode rpc process.
 * It tracks session history and echoes back the session path + message.
 */
const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let sessionHistory = [];
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
function appendToSession(sessionPath, role, content) {
  if (!sessionPath) return;
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const entry = { role, content, timestamp: Date.now() };
  fs.appendFileSync(sessionPath, JSON.stringify(entry) + "\\n");
}
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    currentSession = frame.sessionPath;
    if (!sessionHistory.includes(currentSession)) {
      sessionHistory.push(currentSession);
    }
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    appendToSession(currentSession, "user", frame.message);
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    const sessionAtPrompt = currentSession;
    const sessionsSeen = sessionHistory.join(",");
    const responseText = "session=" + sessionAtPrompt + " sessions=" + sessionsSeen + " msg=" + frame.message;
    appendToSession(currentSession, "assistant", responseText);
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: responseText }] } });
      emit({ type: "agent_end" });
    }, 10);
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

	async connect(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
		this.#handler = handler;
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.#handler = undefined;
	}

	async send(msg: OutboundMessage): Promise<void> {
		this.sent.push(msg);
	}

	formatReply(): OutboundMessage {
		return {
			channelId: this.id,
			conversationId: "",
			content: { type: "text", text: "" },
		};
	}

	/** Simulate receiving a message from the IM platform. */
	simulateInbound(msg: DingTalkRawMessage): Promise<void> {
		const inbound = parseRobotMessage(msg, "dingtalk", this.accountId, msg.msgId);
		if (!inbound) throw new Error("Failed to parse message");
		return this.#handler!(inbound);
	}
}

describe("restart sentinel e2e", () => {
	let tmpDir: string;
	let fakeScriptPath: string;
	let dataDir: string;
	let agentDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-restart-"));
		dataDir = path.join(tmpDir, "gateway-data");
		agentDir = path.join(tmpDir, "agent");
		await fs.mkdir(dataDir, { recursive: true });
		await ensureAgentDir(agentDir);

		// Write the fake RPC script
		fakeScriptPath = path.join(tmpDir, "fake-omp.bun");
		await Bun.write(fakeScriptPath, FAKE_RPC_SCRIPT);
		await fs.chmod(fakeScriptPath, 0o755);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("restart sentinel write/read/clear lifecycle", async () => {
		const config = { dataDir };
		const sentinel = {
			conversationId: "test-conv-123",
			accountId: "__default__",
			ompSessionPath: buildAgentSessionPath(agentDir, "test-conv-123"),
			continuationMessage: "Test continuation",
		};

		// Write
		await writeRestartSentinel(sentinel, config as any);
		const sentinelPath = path.join(dataDir, "restart-pending.json");
		expect(await fs.exists(sentinelPath)).toBe(true);

		// Read
		const read = await readRestartSentinel(config as any);
		expect(read).not.toBeNull();
		expect(read!.conversationId).toBe("test-conv-123");
		expect(read!.accountId).toBe("__default__");
		expect(read!.ompSessionPath).toBe(sentinel.ompSessionPath);
		expect(read!.continuationMessage).toBe("Test continuation");
		expect(read!.timestamp).toBeGreaterThan(0);

		// Clear
		await clearRestartSentinel(config as any);
		expect(await fs.exists(sentinelPath)).toBe(false);

		// Read after clear
		const readAfterClear = await readRestartSentinel(config as any);
		expect(readAfterClear).toBeNull();
	});

	test("stale sentinel (>1 hour) is cleared on read", async () => {
		const config = { dataDir };
		const sentinelPath = path.join(dataDir, "restart-pending.json");

		// Write a sentinel with an old timestamp
		const oldSentinel = {
			conversationId: "old-conv",
			accountId: "__default__",
			ompSessionPath: buildAgentSessionPath(agentDir, "old-conv"),
			continuationMessage: "Old continuation",
			timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
		};
		await Bun.write(sentinelPath, JSON.stringify(oldSentinel));

		// Read should return null and clear the file
		const read = await readRestartSentinel(config as any);
		expect(read).toBeNull();
		expect(await fs.exists(sentinelPath)).toBe(false);
	});

	test("full restart recovery flow with fake RPC", async () => {
		const conversationId = "restart-test-conv";
		const sessionPath = buildAgentSessionPath(agentDir, conversationId);

		// === Phase 1: First gateway instance ===
		const channel1 = new FakeChannel("__default__");
		const registry1 = new ChannelRegistry();
		registry1.register(channel1);

		const store1 = new SQLiteSessionStore(path.join(dataDir, "sessions.db"));
		const bridge1 = new AgentBridge({
			ompPath: fakeScriptPath,
			cwd: agentDir,
			timeoutMs: 30_000,
		});

		const gateway1 = new Gateway(
			{ dataDir, agent: { ompPath: fakeScriptPath, timeoutMs: 30_000 } },
			{ bridge: bridge1, store: store1 },
		);

		// Manually wire the channel (since we're not using the full gateway.start())
		await channel1.connect(async (msg) => {
			// Simplified message handling for test
			const session = await store1.getSession("dingtalk", "__default__", msg.conversationId);
			if (!session) {
				await store1.createSession({
					channelId: "dingtalk",
					accountId: "__default__",
					userId: msg.userId,
					conversationId: msg.conversationId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					ompSessionPath: sessionPath,
					status: "active",
				});
			}
		});

		await bridge1.start();

		// Send a message through the bridge
		const rawMsg = sampleTextMessage({
			conversationId,
			msgId: "msg-1",
			senderStaffId: "user-1",
			senderId: "user-1",
			senderNick: "Test User",
			text: { content: "Hello from first gateway" },
		});
		const inbound1 = parseRobotMessage(rawMsg, "dingtalk", "__default__", rawMsg.msgId);
		if (!inbound1) throw new Error("Failed to parse message");

		const response1 = await bridge1.forward(inbound1, {
			id: "session-1",
			channelId: "dingtalk",
			accountId: "__default__",
			userId: "user-1",
			conversationId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			ompSessionPath: sessionPath,
			status: "active",
		});

		expect(response1).toBeTruthy();
		expect(response1).toContain("session=" + sessionPath);
		expect(response1).toContain("msg=Hello from first gateway");

		// Verify the session file was created
		expect(await fs.exists(sessionPath)).toBe(true);
		const sessionContent1 = await Bun.file(sessionPath).text();
		expect(sessionContent1).toContain("Hello from first gateway");

		// === Phase 2: Write restart sentinel (simulating crash) ===
		await writeRestartSentinel(
			{
				conversationId,
				accountId: "__default__",
				ompSessionPath: sessionPath,
				continuationMessage: "[System] Gateway restarted. Please acknowledge and summarize.",
			},
			{ dataDir } as any,
		);

		// Stop the first gateway
		bridge1.stop();
		store1.close();

		// === Phase 3: Second gateway instance (restart recovery) ===
		const bridge2 = new AgentBridge({
			ompPath: fakeScriptPath,
			cwd: agentDir,
			timeoutMs: 30_000,
		});
		const store2 = new SQLiteSessionStore(path.join(dataDir, "sessions.db"));

		const gateway2 = new Gateway(
			{ dataDir, agent: { ompPath: fakeScriptPath, timeoutMs: 30_000 } },
			{ bridge: bridge2, store: store2 },
		);

		await bridge2.start();

		// Resume from sentinel
		const resumed = await gateway2.resumeFromSentinel();
		expect(resumed).toBe(true);

		// Verify the sentinel was cleared
		const sentinelAfter = await readRestartSentinel({ dataDir } as any);
		expect(sentinelAfter).toBeNull();

		// Verify the session file now contains the continuation message
		const sessionContent2 = await Bun.file(sessionPath).text();
		expect(sessionContent2).toContain("Gateway restarted");
		expect(sessionContent2).toContain("Hello from first gateway"); // Original message still there

		// Cleanup
		bridge2.stop();
		store2.close();
	});

	test("resumeFromSentinel returns false when no sentinel exists", async () => {
		const bridge = new AgentBridge({
			ompPath: fakeScriptPath,
			cwd: agentDir,
			timeoutMs: 30_000,
		});
		const store = new SQLiteSessionStore(path.join(dataDir, "sessions.db"));

		const gateway = new Gateway(
			{ dataDir, agent: { ompPath: fakeScriptPath, timeoutMs: 30_000 } },
			{ bridge, store },
		);

		await bridge.start();

		const resumed = await gateway.resumeFromSentinel();
		expect(resumed).toBe(false);

		bridge.stop();
		store.close();
	});
});
