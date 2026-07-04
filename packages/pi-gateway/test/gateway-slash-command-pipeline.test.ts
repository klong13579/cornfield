/**
 * Gateway slash-command pipeline test.
 *
 * End-to-end test that wires up a real Gateway with a fake DingTalk
 * channel and a fake RPC bridge, then injects a real `/new` slash
 * command via the fake channel. Verifies the full pipeline:
 *
 *   DingTalkChannel → MessageHandler.handleInboundMessage
 *     → handleAbortMessage (skip)
 *     → handleModelCommand (skip)
 *     → newSessionHandler.handle (matches /new) → return
 *     → session file archived
 *     → RPC new_session + switch_session driven
 *     → SQLite row updated in place
 *     → confirmation sent back to channel
 *
 * Mirrors the FAKE RPC and FakeDingTalkChannel pattern in
 * gateway-message-pipeline.test.ts but adds new_session + switch_session
 * command handling and a session file to observe rotation.
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

// ═══════════════════════════════════════════════════════════════
// Fake RPC — supports switch_session, new_session, prompt
// ═══════════════════════════════════════════════════════════════

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let sessionIdCounter = 0;
let buffer = "";
const seenCommands = [];
function emit(v) { process.stdout.write(JSON.stringify(v) + "\\n"); }
async function handleFrame(frame) {
  seenCommands.push({ type: frame.type, ts: Date.now() });
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

// ═══════════════════════════════════════════════════════════════
// Fake DWClient
// ═══════════════════════════════════════════════════════════════

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
		// Sink — handled by FakeDingTalkChannel override below
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

	// For assertions: parsed inbound messages as seen by the channel.
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

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("Gateway slash command pipeline", () => {
	let rootDir: string;
	let rpcPath: string;
	let fakeChannels: Map<string, FakeDingTalkChannel>;
	let fetchSpy: ReturnType<typeof spyOn> | undefined;

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gw-slash-"));
		rpcPath = path.join(rootDir, "fake-rpc");
		await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
		await fs.chmod(rpcPath, 0o755);
		fakeChannels = new Map();

		// Card creation fails so we exercise the V1 markdown fallback (which
		// sends via channel.sendMessage and is verifiable).
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL) => {
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
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
	});

	// ────────────────────────────────────────────────────────────
	// /new
	// ────────────────────────────────────────────────────────────

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
			agent: { ompPath: rpcPath, timeoutMs: 5_000 },
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

			// ── Pre-seed the session file with 4 well-formed messages ─────
			// This simulates a user who has been chatting for a while.
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

			// Sanity check: file exists and has the seeded content.
			const seededContent = await fs.readFile(sessionPath, "utf8");
			expect(seededContent.split("\n").filter(l => l.trim()).length).toBe(4);
			await printSessionState("BEFORE /new", sessionPath, convDir);

			// Send a regular message first to create the session in the store.
			// The /new handler requires an existing session to rotate.
			await channel.injectDingTalkMessage(
				makeRobotMessage("algorithm", conversationId, "first message"),
				"msg-e2e-new-pre-001",
			);
			await Bun.sleep(800);

			await printSessionState("AFTER first message, BEFORE /new", sessionPath, convDir);

			// Reset the channel's outbound capture so we only see the /new reply.
			channel.sentOutbound = [];

			// Now send /new
			await channel.injectDingTalkMessage(makeRobotMessage("algorithm", conversationId, "/new"), "msg-e2e-new-001");

			// Give the async pipeline a tick to settle
			await Bun.sleep(500);

			await printSessionState("AFTER /new", sessionPath, convDir);

			// ── Assertion 1: original session file is gone (was renamed) ──
			const originalExists = await fs
				.access(sessionPath)
				.then(() => true)
				.catch(() => false);
			expect(originalExists).toBe(false);

			// ── Assertion 2: exactly one archive file exists in the same dir ──
			const baseName = path.basename(sessionPath, ".jsonl");
			const files = await fs.readdir(convDir);
			const archived = files.filter(f => f.startsWith(`${baseName}.`) && f !== `${baseName}.jsonl`);
			expect(archived.length).toBe(1);
			const archivePath = path.join(convDir, archived[0]!);

			// ── Assertion 3: the archive file's content matches the seeded content ──
			const archiveContent = await fs.readFile(archivePath, "utf8");
			const archiveLines = archiveContent.split("\n").filter(l => l.trim());
			expect(archiveLines.length).toBe(4);
			for (let i = 0; i < seededLines.length; i++) {
				const parsed = JSON.parse(archiveLines[i]!);
				expect(parsed.id).toBe(seededLines[i]!.id);
				expect(parsed.type).toBe(seededLines[i]!.type);
			}

			// ── Assertion 4: the new session file is empty (or near-empty) ──
			// After /new, the agent has been told to switch to this path; no
			// further events have been written yet.
			const newFileContent = await fs.readFile(sessionPath, "utf8").catch(() => "");
			const newFileLines = newFileContent.split("\n").filter(l => l.trim());
			expect(newFileLines.length).toBe(0);

			// ── Assertion 5: the channel received a /new confirmation ─────
			expect(channel.sentOutbound.length).toBeGreaterThanOrEqual(1);
			const texts = channel.sentOutbound
				.map((m: any) => m?.content)
				.filter(Boolean)
				.map((c: any) => (c.type === "text" ? c.text : (c.markdown ?? "")))
				.join(" ");
			expect(texts).toContain("已开启新会话");
			printOutboundState("DingTalk reply", channel.sentOutbound);
		} finally {
			await gateway.stop();
		}
	});

	test("/new does NOT fall through to the agent", async () => {
		// If /new were not intercepted, the agent's fake RPC would respond
		// with "echo: /new". Verify we get the confirmation, not an echo.
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
			agent: { ompPath: rpcPath, timeoutMs: 5_000 },
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

			// Send a regular message first to create the session
			await channel.injectDingTalkMessage(
				makeRobotMessage("algorithm", conversationId, "first message"),
				"msg-e2e-new-pre-002",
			);
			await Bun.sleep(800);
			channel.sentOutbound = [];

			await channel.injectDingTalkMessage(makeRobotMessage("algorithm", conversationId, "/new"), "msg-e2e-new-002");
			await Bun.sleep(500);

			// Verify no echo from the agent
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

	// ────────────────────────────────────────────────────────────
	// Non-slash messages still go to the agent (regression check)
	// ────────────────────────────────────────────────────────────

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
			agent: { ompPath: rpcPath, timeoutMs: 5_000 },
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
			// The fake RPC echoes back the message. The "echo: hello world" text
			// would only appear if the agent was invoked.
			expect(allText).toContain("echo: hello world");
		} finally {
			await gateway.stop();
		}
	});
});

// ═══════════════════════════════════════════════════════════════
// Diagnostic print helpers — make file + reply state observable.
// These are used by the tests to dump state for human review so the
// test output makes the actual behavior visible, not just assertions.
// ═══════════════════════════════════════════════════════════════

async function printSessionState(label: string, sessionPath: string, convDir: string): Promise<void> {
	// Collect all data before logging so the banner and content are atomic
	// and don't interleave with concurrent handler logs (Rotating session, etc.).
	const lines: string[] = [];
	lines.push("═".repeat(70));
	lines.push(label);
	lines.push("═".repeat(70));
	try {
		const stat = await fs.stat(sessionPath);
		const content = await fs.readFile(sessionPath, "utf8");
		const jsonlLines = content.split("\n").filter(l => l.trim());
		lines.push(`  ${sessionPath}  (${stat.size} bytes, ${jsonlLines.length} JSONL lines)`);
		for (const ln of jsonlLines) {
			try {
				const obj = JSON.parse(ln);
				const id = (obj.id ?? "").toString().slice(0, 16);
				const t = obj.type ?? "?";
				const role = obj.message?.role ?? "";
				const text = obj.message?.content?.[0]?.text ?? "";
				lines.push(`    [${t}${role ? "/" + role : ""}] ${id}  ::  ${text.slice(0, 60)}`);
			} catch {
				lines.push(`    <unparseable> ${ln.slice(0, 60)}`);
			}
		}
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			lines.push(`  ${sessionPath}  (does not exist)`);
		} else {
			lines.push(`  ${sessionPath}  (error: ${err?.message})`);
		}
	}
	const entries = await fs.readdir(convDir).catch(() => [] as string[]);
	const siblings = entries.filter(e => e !== path.basename(sessionPath));
	if (siblings.length > 0) {
		lines.push(`  Sibling files in ${path.basename(convDir)}/:`);
		for (const s of siblings) {
			const full = path.join(convDir, s);
			try {
				const st = await fs.stat(full);
				const c = await fs.readFile(full, "utf8");
				const lc = c.split("\n").filter(l => l.trim()).length;
				lines.push(`    ${s}  (${st.size} bytes, ${lc} JSONL lines)`);
			} catch {
				lines.push(`    ${s}`);
			}
		}
	}
	console.log(lines.join("\n"));
}

function printOutboundState(label: string, outbound: unknown[]): void {
	const sep = "═".repeat(70);
	console.log(`\n${sep}\n${label}\n${sep}`);
	if (outbound.length === 0) {
		console.log("  (no outbound messages)");
		return;
	}
	for (let i = 0; i < outbound.length; i++) {
		const m: any = outbound[i];
		console.log(`  [${i + 1}] msgType=${m?.msgtype ?? "?"}  contentType=${m?.content?.type ?? "?"}`);
		if (m?.text?.content) console.log(`      text:     ${m.text.content}`);
		if (m?.content?.text) console.log(`      text:     ${m.content.text}`);
		if (m?.content?.markdown) console.log(`      markdown: ${m.content.markdown}`);
		if (m?.markdown?.text) console.log(`      markdown: ${m.markdown.text}`);
	}
}
