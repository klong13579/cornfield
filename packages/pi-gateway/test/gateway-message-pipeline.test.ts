/**
 * Gateway message pipeline test.
 *
 * Constructs a real Gateway with a fake DingTalk channel + fake RPC bridge,
 * sends an inbound DM, and verifies the full pipeline:
 *   DingTalkChannel → MessageHandler → ResponseHandler → SessionManager → AgentBridge
 *
 * This is the test that would have caught the three construction-time reference
 * capture bugs (store null, sessionManager undefined, cronLifecycle as sessionManager).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { Gateway } from "../src/gateway";
import { DingTalkChannel, parseRobotMessage } from "../src/channels/dingtalk";
import type { DingTalkRawMessage } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Fake RPC — minimal agent bridge
// ═══════════════════════════════════════════════════════════════════════

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
function emit(v) { process.stdout.write(JSON.stringify(v) + "\\n"); }
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ack-" + frame.message.slice(0, 20) }] } });
      emit({ type: "agent_end" });
    }, 5);
  }
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let i = buffer.indexOf("\\n");
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) await handleFrame(JSON.parse(line));
    i = buffer.indexOf("\\n");
  }
}
`;

// ═══════════════════════════════════════════════════════════════════════
// Fake DWClient — does not connect to real DingTalk
// ═══════════════════════════════════════════════════════════════════════

class FakeDWClient extends EventEmitter {
	socketCallBackResponse(_messageId: string, _result: { success: boolean }): void {}
	async connect(): Promise<void> {
		// Simulate successful connection
		(this as any).socket = new EventEmitter();
		(this as any).socket.readyState = 1; // WebSocket.OPEN
		this.emit("connect");
	}
	disconnect(): void {
		(this as any).socket = null;
		this.emit("disconnect");
	}
	registerCallbackListener(_topic: string, _handler: (msg: unknown) => void): void {
		// Sink — real DWClient registers with the Stream SDK's internal router
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Fake DingTalkChannel — replaces createDWClient with FakeDWClient
// ═══════════════════════════════════════════════════════════════════════

class FakeDingTalkChannel extends DingTalkChannel {
	/** Store the callback so test can simulate inbound messages. */
	#messageCallback: ((msg: unknown) => void) | null = null;
	/** Expose sent outbound messages for assertion. */
	sentOutbound: unknown[] = [];

	protected override createDWClient(_opts: {
		clientId: string;
		clientSecret: string;
		ua?: string;
		debug?: boolean;
		autoReconnect?: boolean;
	}): FakeDWClient {
		const client = new FakeDWClient();

		// Capture the REAL TOPIC_ROBOT callback that DingTalkChannel.onConnect
		// registers, so our test can call it with fake messages.
		const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
		const origRegister = client.registerCallbackListener.bind(client);
		client.registerCallbackListener = (topic: string, handler: (msg: unknown) => void) => {
			if (topic === TOPIC_ROBOT) {
				this.#messageCallback = handler;
			}
			origRegister(topic, handler);
		};

		return client;
	}

	/** Test seam: inject a fake inbound message as if from DingTalk Stream. */
	async injectDingTalkMessage(raw: DingTalkRawMessage, messageId: string): Promise<void> {
		if (!this.#messageCallback) {
			throw new Error("FakeDingTalkChannel: message callback not registered (call connect() first)");
		}
		await this.#messageCallback({
			headers: { messageId },
			data: JSON.stringify(raw),
		});
	}

	/** Capture outbound messages sent via this channel. */
	override async sendMessage(msg: unknown): Promise<void> {
		this.sentOutbound.push(msg);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Factory & Helpers
// ═══════════════════════════════════════════════════════════════════════

function makeChannelFactory(channels: Map<string, FakeDingTalkChannel>): (accountId?: string) => DingTalkChannel {
	return (accountId?: string) => {
		const ch = new FakeDingTalkChannel();
		if (accountId) {
			channels.set(accountId, ch);
		}
		return ch;
	};
}

function makeRobotMessage(accountId: string, conversationId: string, text: string, msgId?: string): DingTalkRawMessage {
	return {
		conversationId,
		atUsers: [],
		chatbotCorpId: "corp001",
		chatbotUserId: "bot001",
		msgId: msgId ?? `${accountId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		senderNick: "测试用户",
		isAdmin: false,
		senderStaffId: "staff001",
		sessionWebhookExpiredTime: Date.now() + 3600_000,
		createAt: Date.now(),
		senderCorpId: "corp001",
		conversationType: "1",
		senderId: "staff001",
		conversationTitle: "测试会话",
		isInAtList: false,
		sessionWebhook: `https://example.com/webhook/${accountId}/${conversationId}`,
		msgtype: "text",
		robotCode: "robot001",
		text: { content: text },
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Test
// ═══════════════════════════════════════════════════════════════════════

describe("Gateway message pipeline", () => {
	let rootDir: string;
	let rpcPath: string;
	let fakeChannels: Map<string, FakeDingTalkChannel>;

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gw-pipeline-"));
		rpcPath = path.join(rootDir, "fake-rpc");
		await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
		await fs.chmod(rpcPath, 0o755);
		fakeChannels = new Map();
	});

	afterEach(async () => {
		await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
	});

	test("DM flows through real Gateway: session created → bridge invoked → response sent", async () => {
		const config = {
			channels: {
				dingtalk: {
					enabled: true,
					dmPolicy: "open" as const,
					groupPolicy: "open" as const,
					accounts: {
						hr: {
							appKey: "test-key",
							appSecret: "test-secret",
							robotCode: "test-robot",
							agentDir: path.join(rootDir, "agents", "hr"),
						},
					},
				},
			},
			agent: { ompPath: rpcPath, timeoutMs: 5_000 },
			session: { resetPolicy: "none" as const },
			dataDir: rootDir,
		};

		// Mock fetch so we never hit real DingTalk API.
		// Make card creation fail so we exercise the V1 markdown fallback path
		// (which sends messages through channel.sendMessage and is verifiable).
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL) => {
			const u = typeof url === "string" ? url : url.toString();
			if (u.includes("card/instances")) {
				// Fail card creation to force V1 fallback, which sends messages
				// through channel.sendMessage and is verifiable in tests.
				return new Response(JSON.stringify({ success: false, errmsg: "simulated-failure" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (u.includes("oauth2/accessToken")) {
				return new Response(JSON.stringify({ accessToken: "fake-token", expireIn: 7200 }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			// Everything else: session webhooks, robot DMs
			return new Response("ok");
		});

		const gateway = new Gateway(config, {
			channelFactory: makeChannelFactory(fakeChannels),
		});

		try {
			await gateway.start();

			const channel = fakeChannels.get("hr");
			expect(channel).toBeDefined();
			if (!channel) throw new Error("channel not created");

			// Send a DM through the fake DingTalk channel
			const conversationId = "conv-test-001";
			await channel.injectDingTalkMessage(makeRobotMessage("hr", conversationId, "hello gateway"), "msg-test-001");

			// Give the async pipeline a tick to settle
			await Bun.sleep(500);

			// 1. The fake channel should have received outbound messages,
			// proving the pipeline delivered a placeholder and then ran the agent.
			expect(channel.sentOutbound.length).toBeGreaterThanOrEqual(1);

			// The single message should be the agent's reply (placeholder was removed
			// because DingTalk's sessionWebhook is single-use).
			const first = channel.sentOutbound[0] as Record<string, unknown> | undefined;
			if (first) {
				const content = first.content as Record<string, unknown>;
				if (content.type === "text" || content.type === "markdown") {
					const text = (content as Record<string, string>)[content.type as string] ?? "";
					expect(text).toContain("hello gateway");
				}
			}

			// 2. Verify no "Failed to create session" or "Failed to handle message"
			// occurred (these would appear if the store/sessionManager bugs exist)
			const sentTexts = channel.sentOutbound
				.map((m: any) => m?.content)
				.filter(Boolean)
				.map((c: any) => (c.type === "text" ? c.text : (c.markdown ?? "")))
				.join(" ");
			expect(sentTexts).not.toContain("系统繁忙");
			expect(sentTexts).not.toContain("Failed to");
		} finally {
			fetchSpy.mockRestore();
			await gateway.stop();
		}
	});

	test("DM without permission policy is rejected with no response", async () => {
		// HR account has dmPolicy: "allowlist" (default) and no allowedUsers,
		// so all DMs should be silently dropped.
		const config = {
			channels: {
				dingtalk: {
					enabled: true,
					accounts: {
						hr: {
							appKey: "test-key",
							appSecret: "test-secret",
							robotCode: "test-robot",
							agentDir: path.join(rootDir, "agents", "hr"),
						},
					},
				},
			},
			agent: { ompPath: rpcPath, timeoutMs: 5_000 },
			session: { resetPolicy: "none" as const },
			dataDir: rootDir,
		};

		const gateway = new Gateway(config, {
			channelFactory: makeChannelFactory(fakeChannels),
		});

		try {
			await gateway.start();
			const channel = fakeChannels.get("hr");
			expect(channel).toBeDefined();
			if (!channel) throw new Error("channel not created");

			await channel.injectDingTalkMessage(makeRobotMessage("hr", "conv-blocked-001", "hello"), "msg-blocked-001");

			await Bun.sleep(200);

			// No outbound messages — message blocked before any session/agent work
			expect(channel.sentOutbound.length).toBe(0);
		} finally {
			await gateway.stop();
		}
	});
});
