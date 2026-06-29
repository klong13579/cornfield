/**
 * Restart sentinel e2e test — production-like simulation.
 *
 * Tests the full restart recovery flow through the real gateway pipeline:
 * 1. Start gateway with SessionManager + ChannelRegistry + AgentBridge
 * 2. Send a message through fake channel → MessageHandler → AgentBridge
 * 3. While agent is processing, call gateway.stop() → drain timeout → sentinel written
 * 4. Start new gateway → resumeFromSentinel() → agent receives continuation
 * 5. Verify agent sees full history and responds
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
import { Gateway } from "../src/gateway";
import { readRestartSentinel } from "../src/restart-sentinel";
import { SQLiteSessionStore } from "../src/session-store";
import type {
	Channel,
	ChannelCapabilities,
	InboundMessage,
	OutboundMessage,
} from "../src/types";
import { sampleTextMessage } from "./fixtures/sample-messages";

/**
 * Fake RPC script that simulates an omp --mode rpc process.
 * - Writes session entries to disk (like real omp does)
 * - Supports slow prompts (for testing drain timeout)
 * - Tracks session history across restarts
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
    // Simulate slow processing for drain timeout testing
    const delay = frame.message.includes("slow-prompt") ? 5000 : 50;
    setTimeout(() => {
      appendToSession(currentSession, "assistant", responseText);
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: responseText }] } });
      emit({ type: "agent_end" });
    }, delay);
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

/**
 * Fake channel that simulates DingTalk for testing.
 * Captures sent messages and allows simulating inbound messages.
 */
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
	async simulateInbound(msg: InboundMessage): Promise<void> {
		if (!this.#handler) throw new Error("Channel not connected");
		await this.#handler(msg);
	}
}

describe("restart sentinel e2e — production simulation", () => {
	let tmpDir: string;
	let fakeScriptPath: string;
	let dataDir: string;
	let agentDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-restart-e2e-"));
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

	test("gateway.stop() writes sentinel on drain timeout, gateway.resumeFromSentinel() recovers", async () => {
		const conversationId = "restart-e2e-conv";
		const sessionPath = buildAgentSessionPath(agentDir, conversationId);

		// === Phase 1: First gateway instance ===
		const store1 = new SQLiteSessionStore(path.join(dataDir, "sessions.db"));
		const bridge1 = new AgentBridge({
			ompPath: fakeScriptPath,
			cwd: agentDir,
			timeoutMs: 30_000,
		});

		// Use short drain timeout for fast test
		const gateway1 = new Gateway(
			{
				dataDir,
				drainTimeoutMs: 100, // 100ms for fast test
				channels: {}, // No real channels
				agent: { ompPath: fakeScriptPath, timeoutMs: 30_000 },
			},
			{ bridge: bridge1, store: store1 },
		);

		// Start the gateway (this sets #running = true)
		await gateway1.start();

		// Get the session manager from the gateway
		const sessionManager1 = gateway1.getSessionManager();
		if (!sessionManager1) throw new Error("Session manager not initialized");

		// Manually wire a fake channel for testing
		const channel1 = new FakeChannel("__default__");
		await channel1.connect(async (msg) => {
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
			// Forward through session manager (like real gateway does)
			await sessionManager1.enqueue(msg, {
				id: "session-1",
				channelId: "dingtalk",
				accountId: "__default__",
				userId: msg.userId,
				conversationId: msg.conversationId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				ompSessionPath: sessionPath,
				status: "active",
			});
		});

		// Send a slow message that will still be processing when we call stop()
		const rawMsg = sampleTextMessage({
			conversationId,
			msgId: "msg-1",
			senderStaffId: "user-1",
			senderId: "user-1",
			senderNick: "Test User",
			text: { content: "slow-prompt: Hello from first gateway" },
		});
		const inbound1 = parseRobotMessage(rawMsg, "dingtalk", "__default__", rawMsg.msgId);
		if (!inbound1) throw new Error("Failed to parse message");

		// Start the message processing (don't await — we want it in-flight)
		const processingPromise = channel1.simulateInbound(inbound1);

		// Wait a bit for the message to enter the queue and bridge to become busy
		await Bun.sleep(100);

		// Verify the bridge is busy
		const snapshot = bridge1.getSnapshot();
		expect(snapshot.state).toBe("busy");
		expect(snapshot.activeSessionPath).toBe(sessionPath);

		// === Phase 2: Call gateway.stop() — should trigger drain timeout ===
		// The drain timeout is 100ms, but the agent is processing a slow prompt (5000ms)
		// So drain will timeout and sentinel should be written
		await gateway1.stop();

		// Wait for the processing to complete (it will, eventually)
		await processingPromise;

		// === Phase 3: Verify sentinel was written ===
		const sentinelPath = path.join(dataDir, "restart-pending.json");
		expect(await fs.exists(sentinelPath)).toBe(true);

		const sentinel = await readRestartSentinel({ dataDir } as any);
		expect(sentinel).not.toBeNull();
		expect(sentinel!.conversationId).toBe(conversationId);
		expect(sentinel!.accountId).toBe("__default__");
		expect(sentinel!.ompSessionPath).toBe(sessionPath);
		expect(sentinel!.continuationMessage).toContain("restarted");

		// Verify the session file was created with the user message
		expect(await fs.exists(sessionPath)).toBe(true);
		const sessionContent1 = await Bun.file(sessionPath).text();
		expect(sessionContent1).toContain("slow-prompt: Hello from first gateway");

		// Cleanup first gateway
		store1.close();

		// === Phase 4: Second gateway instance (restart recovery) ===
		const bridge2 = new AgentBridge({
			ompPath: fakeScriptPath,
			cwd: agentDir,
			timeoutMs: 30_000,
		});
		const store2 = new SQLiteSessionStore(path.join(dataDir, "sessions.db"));

		const gateway2 = new Gateway(
			{
				dataDir,
				drainTimeoutMs: 100,
				channels: {},
				agent: { ompPath: fakeScriptPath, timeoutMs: 30_000 },
			},
			{ bridge: bridge2, store: store2 },
		);

		await gateway2.start();

		// === Phase 5: Resume from sentinel ===
		const resumed = await gateway2.resumeFromSentinel();
		expect(resumed).toBe(true);

		// === Phase 6: Verify sentinel was cleared ===
		const sentinelAfter = await readRestartSentinel({ dataDir } as any);
		expect(sentinelAfter).toBeNull();

		// === Phase 7: Verify session file contains continuation message ===
		const sessionContent2 = await Bun.file(sessionPath).text();
		expect(sessionContent2).toContain("slow-prompt: Hello from first gateway"); // Original
		expect(sessionContent2).toContain("restarted"); // Continuation message

		// Cleanup
		await gateway2.stop();
		store2.close();
	}, 30_000);

	test("no sentinel written when drain succeeds (no active session)", async () => {
		const conversationId = "no-restart-conv";
		const sessionPath = buildAgentSessionPath(agentDir, conversationId);

		const store = new SQLiteSessionStore(path.join(dataDir, "sessions.db"));
		const bridge = new AgentBridge({
			ompPath: fakeScriptPath,
			cwd: agentDir,
			timeoutMs: 30_000,
		});

		const gateway = new Gateway(
			{
				dataDir,
				drainTimeoutMs: 100,
				channels: {},
				agent: { ompPath: fakeScriptPath, timeoutMs: 30_000 },
			},
			{ bridge, store },
		);

		await gateway.start();
		const sessionManager = gateway.getSessionManager();
		if (!sessionManager) throw new Error("Session manager not initialized");

		const channel = new FakeChannel("__default__");
		await channel.connect(async (msg) => {
			const session = await store.getSession("dingtalk", "__default__", msg.conversationId);
			if (!session) {
				await store.createSession({
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
			await sessionManager.enqueue(msg, {
				id: "session-1",
				channelId: "dingtalk",
				accountId: "__default__",
				userId: msg.userId,
				conversationId: msg.conversationId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				ompSessionPath: sessionPath,
				status: "active",
			});
		});

		// Send a fast message that completes before stop()
		const rawMsg = sampleTextMessage({
			conversationId,
			msgId: "msg-1",
			senderStaffId: "user-1",
			senderId: "user-1",
			senderNick: "Test User",
			text: { content: "fast message" },
		});
		const inbound = parseRobotMessage(rawMsg, "dingtalk", "__default__", rawMsg.msgId);
		if (!inbound) throw new Error("Failed to parse message");

		// Wait for message to complete
		await channel.simulateInbound(inbound);
		await Bun.sleep(200); // Let it fully complete

		// Stop gateway — drain should succeed (no active session)
		await gateway.stop();

		// Verify NO sentinel was written
		const sentinelPath = path.join(dataDir, "restart-pending.json");
		expect(await fs.exists(sentinelPath)).toBe(false);

		store.close();
	}, 10_000);
});
