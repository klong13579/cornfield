/**
 * Gateway pipeline tests.
 *
 *   - gateway-message-pipeline.test.ts     (DM flows through real Gateway)
 *   - gateway-slash-command-pipeline.test.ts (/new archives, RPC driven, fallback)
 *
 * Both wire a real Gateway with a fake DingTalk channel + fake RPC
 * bridge, inject inbound messages, and assert on outbound replies.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { DingTalkChannel, parseRobotMessage } from "../src/channels/dingtalk";
import { Gateway } from "../src/gateway";
import type { DingTalkRawMessage } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Fake RPC scripts
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

const FAKE_SLASH_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let sessionIdCounter = 0;
let buffer = "";
function emit(v) { process.stdout.write(JSON.stringify(v) + "\\n"); }
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    currentSession = frame.sessionPath;
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "new_session") {
    sessionIdCounter += 1;
    emit({ type: "response", id: frame.id, command: "new_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "get_state") {
    emit({ type: "response", id: frame.id, command: "get_state", success: true, data: { sessionId: "sess-" + sessionIdCounter, sessionFile: currentSession, messageCount: 0 } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "echo: " + frame.message }] } });
      emit({ type: "agent_end" });
    }, 5);
    return;
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
// Fake DWClient + FakeDingTalkChannel
// ═══════════════════════════════════════════════════════════════════════

class FakeDWClient extends EventEmitter {
	socketCallBackResponse(_messageId: string, _result: { success: boolean }): void {}
	async connect(): Promise<void> {
		(this as any).socket = new EventEmitter();
		(this as any).socket.readyState = 1;
		this.emit("connect");
	}
	disconnect(): void {
		(this as any).socket = null;
		this.emit("disconnect");
	}
	registerCallbackListener(_topic: string, _handler: (msg: unknown) => void): void {
		// Sink — handled by FakeDingTalkChannel override
	}
}

class FakeDingTalkChannel extends DingTalkChannel {
	#messageCallback: ((msg: unknown) => void) | null = null;
	#robotMessages: DingTalkRawMessage[] = [];
	sentOutbound: unknown[] = [];

	protected override createDWClient(_opts: {
		clientId: string;
		clientSecret: string;
		ua?: string;
		debug?: boolean;
		autoReconnect?: boolean;
	}): FakeDWClient {
		const client = new FakeDWClient();
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

	async injectDingTalkMessage(raw: DingTalkRawMessage, messageId: string): Promise<void> {
		if (!this.#messageCallback) {
			throw new Error("FakeDingTalkChannel: message callback not registered");
		}
		this.#robotMessages.push(raw);
		await this.#messageCallback({
			headers: { messageId },
			data: JSON.stringify(raw),
		});
	}

	override async sendMessage(msg: unknown): Promise<void> {
		this.sentOutbound.push(msg);
	}

	getLastParsedInbound(): ReturnType<typeof parseRobotMessage> | undefined {
		const last = this.#robotMessages[this.#robotMessages.length - 1];
		return last ? parseRobotMessage(last) : undefined;
	}
}

function makeChannelFactory(channels: Map<string, FakeDingTalkChannel>): (accountId?: string) => DingTalkChannel {
	return (accountId?: string) => {
		const ch = new FakeDingTalkChannel();
		if (accountId) channels.set(accountId, ch);
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

function installFetchSpy() {
	return spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL) => {
		const u = typeof url === "string" ? url : url.toString();
		if (u.includes("card/instances")) {
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
		return new Response("ok");
	});
}

// ═══════════════════════════════════════════════════════════════════════
// Tests: message pipeline
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
			agent: { ompPath: rpcPath },
			session: { resetPolicy: "none" as const },
			dataDir: rootDir,
		};

		const fetchSpy = installFetchSpy();

		const gateway = new Gateway(config, {
			channelFactory: makeChannelFactory(fakeChannels),
		});

		try {
			await gateway.start();
			const channel = fakeChannels.get("hr");
			expect(channel).toBeDefined();
			if (!channel) throw new Error("channel not created");

			const conversationId = "conv-test-001";
			await channel.injectDingTalkMessage(makeRobotMessage("hr", conversationId, "hello gateway"), "msg-test-001");

			await Bun.sleep(500);

			expect(channel.sentOutbound.length).toBeGreaterThanOrEqual(1);

			// The v1 markdown fallback path now sends a best-effort
			// "⏳ 正在处理…" placeholder via OAuth DM before the real
			// response (gateway-response.ts:sendAgentResponseViaV1Markdown).
			// The actual response is therefore not necessarily at index 0 —
			// search all outbounds for the agent's reply.
			const sentTexts = channel.sentOutbound
				.map((m: any) => m?.content)
				.filter(Boolean)
				.map((c: any) => (c.type === "text" ? c.text : (c.markdown ?? "")))
				.join(" ");
			expect(sentTexts).toContain("hello gateway");
			expect(sentTexts).not.toContain("系统繁忙");
			expect(sentTexts).not.toContain("Failed to");
		} finally {
			fetchSpy.mockRestore();
			await gateway.stop();
		}
	});

	test("DM without permission policy is rejected with no response", async () => {
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
			agent: { ompPath: rpcPath },
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

			expect(channel.sentOutbound.length).toBe(0);
		} finally {
			await gateway.stop();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Tests: slash command pipeline
// ═══════════════════════════════════════════════════════════════════════

describe("Gateway slash command pipeline", () => {
	let rootDir: string;
	let rpcPath: string;
	let fakeChannels: Map<string, FakeDingTalkChannel>;
	let fetchSpy: ReturnType<typeof spyOn> | undefined;

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gw-slash-"));
		rpcPath = path.join(rootDir, "fake-rpc");
		await Bun.write(rpcPath, FAKE_SLASH_RPC_SCRIPT);
		await fs.chmod(rpcPath, 0o755);
		fakeChannels = new Map();
		fetchSpy = installFetchSpy();
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
	});

	test("/new archives old file, drives RPC, refreshes SQLite, sends confirmation", async () => {
		const config = {
			channels: {
				dingtalk: {
					enabled: true,
					dmPolicy: "open" as const,
					groupPolicy: "open" as const,
					accounts: {
						algorithm: {
							appKey: "test-key",
							appSecret: "test-secret",
							robotCode: "test-robot",
							agentDir: path.join(rootDir, "agents", "algorithm"),
						},
					},
				},
			},
			agent: { ompPath: rpcPath },
			session: { resetPolicy: "none" as const },
			dataDir: rootDir,
		};

		const gateway = new Gateway(config, {
			channelFactory: makeChannelFactory(fakeChannels),
		});

		try {
			await gateway.start();
			const channel = fakeChannels.get("algorithm");
			if (!channel) throw new Error("channel not created");

			const conversationId = "conv-e2e-new-001";
			const convDir = path.join(rootDir, "agents", "algorithm", "sessions");
			await ensureAgentDir(path.join(rootDir, "agents", "algorithm"));
			const sessionPath = buildAgentSessionPath(path.join(rootDir, "agents", "algorithm"), conversationId);
			await fs.mkdir(path.dirname(sessionPath), { recursive: true });

			const seededLines = [
				{ type: "session_start", id: "sess-seed-1", timestamp: "2026-06-29T00:00:00.000Z" },
				{
					type: "message",
					id: "m-seed-1",
					parentId: "sess-seed-1",
					timestamp: "2026-06-29T00:00:01.000Z",
					message: { role: "user", content: [{ type: "text", text: "你好" }] },
				},
				{
					type: "message",
					id: "m-seed-2",
					parentId: "m-seed-1",
					timestamp: "2026-06-29T00:00:02.000Z",
					message: { role: "assistant", content: [{ type: "text", text: "你好，有什么可以帮你的？" }] },
				},
				{
					type: "message",
					id: "m-seed-3",
					parentId: "m-seed-2",
					timestamp: "2026-06-29T00:00:03.000Z",
					message: { role: "user", content: [{ type: "text", text: "今天东京天气怎样？" }] },
				},
			];
			await Bun.write(sessionPath, `${seededLines.map(o => JSON.stringify(o)).join("\n")}\n`);

			const seededContent = await fs.readFile(sessionPath, "utf8");
			expect(seededContent.split("\n").filter(l => l.trim()).length).toBe(4);

			await channel.injectDingTalkMessage(
				makeRobotMessage("algorithm", conversationId, "first message"),
				"msg-e2e-new-pre-001",
			);
			await Bun.sleep(800);

			channel.sentOutbound = [];

			await channel.injectDingTalkMessage(makeRobotMessage("algorithm", conversationId, "/new"), "msg-e2e-new-001");

			await Bun.sleep(500);

			const originalExists = await fs
				.access(sessionPath)
				.then(() => true)
				.catch(() => false);
			expect(originalExists).toBe(false);

			const baseName = path.basename(sessionPath, ".jsonl");
			const files = await fs.readdir(convDir);
			const archived = files.filter(f => f.startsWith(`${baseName}.`) && f !== `${baseName}.jsonl`);
			expect(archived.length).toBe(1);
			const archivePath = path.join(convDir, archived[0]!);

			const archiveContent = await fs.readFile(archivePath, "utf8");
			const archiveLines = archiveContent.split("\n").filter(l => l.trim());
			expect(archiveLines.length).toBe(4);
			for (let i = 0; i < seededLines.length; i++) {
				const parsed = JSON.parse(archiveLines[i]!);
				expect(parsed.id).toBe(seededLines[i]!.id);
				expect(parsed.type).toBe(seededLines[i]!.type);
			}

			const newFileContent = await fs.readFile(sessionPath, "utf8").catch(() => "");
			const newFileLines = newFileContent.split("\n").filter(l => l.trim());
			expect(newFileLines.length).toBe(0);

			expect(channel.sentOutbound.length).toBeGreaterThanOrEqual(1);
			const texts = channel.sentOutbound
				.map((m: any) => m?.content)
				.filter(Boolean)
				.map((c: any) => (c.type === "text" ? c.text : (c.markdown ?? "")))
				.join(" ");
			expect(texts).toContain("已开启新会话");
		} finally {
			await gateway.stop();
		}
	});

	test("/new does NOT fall through to the agent", async () => {
		const config = {
			channels: {
				dingtalk: {
					enabled: true,
					dmPolicy: "open" as const,
					groupPolicy: "open" as const,
					accounts: {
						algorithm: {
							appKey: "test-key",
							appSecret: "test-secret",
							robotCode: "test-robot",
							agentDir: path.join(rootDir, "agents", "algorithm"),
						},
					},
				},
			},
			agent: { ompPath: rpcPath },
			session: { resetPolicy: "none" as const },
			dataDir: rootDir,
		};

		const gateway = new Gateway(config, {
			channelFactory: makeChannelFactory(fakeChannels),
		});

		try {
			await gateway.start();
			const channel = fakeChannels.get("algorithm");
			if (!channel) throw new Error("channel not created");

			const conversationId = "conv-e2e-new-002";
			await ensureAgentDir(path.join(rootDir, "agents", "algorithm"));

			await channel.injectDingTalkMessage(
				makeRobotMessage("algorithm", conversationId, "first message"),
				"msg-e2e-new-pre-002",
			);
			await Bun.sleep(800);
			channel.sentOutbound = [];

			await channel.injectDingTalkMessage(makeRobotMessage("algorithm", conversationId, "/new"), "msg-e2e-new-002");
			await Bun.sleep(500);

			const allText = channel.sentOutbound
				.map((m: any) => m?.content)
				.filter(Boolean)
				.map((c: any) => (c.type === "text" ? c.text : (c.markdown ?? "")))
				.join(" ");
			expect(allText).not.toContain("echo: /new");
			expect(allText).toContain("已开启新会话");
		} finally {
			await gateway.stop();
		}
	});

	test("non-slash messages still fall through to the agent", async () => {
		const config = {
			channels: {
				dingtalk: {
					enabled: true,
					dmPolicy: "open" as const,
					groupPolicy: "open" as const,
					accounts: {
						algorithm: {
							appKey: "test-key",
							appSecret: "test-secret",
							robotCode: "test-robot",
							agentDir: path.join(rootDir, "agents", "algorithm"),
						},
					},
				},
			},
			agent: { ompPath: rpcPath },
			session: { resetPolicy: "none" as const },
			dataDir: rootDir,
		};

		const gateway = new Gateway(config, {
			channelFactory: makeChannelFactory(fakeChannels),
		});

		try {
			await gateway.start();
			const channel = fakeChannels.get("algorithm");
			if (!channel) throw new Error("channel not created");

			const conversationId = "conv-e2e-fallthrough-001";
			await channel.injectDingTalkMessage(
				makeRobotMessage("algorithm", conversationId, "hello world"),
				"msg-e2e-fallthrough-001",
			);
			await Bun.sleep(500);

			const allText = channel.sentOutbound
				.map((m: any) => m?.content)
				.filter(Boolean)
				.map((c: any) => (c.type === "text" ? c.text : (c.markdown ?? "")))
				.join(" ");
			expect(allText).toContain("echo: hello world");
		} finally {
			await gateway.stop();
		}
	});
});
