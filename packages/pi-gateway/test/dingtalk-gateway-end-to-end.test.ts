/**
 * End-to-end DingTalk channel + Gateway integration test.
 *
 * This test exercises the **real** `DingTalkChannel` and the **real** Gateway
 * routing pipeline using a fake DingTalk Stream SDK client as the only
 * substitute. The fake client captures the robot-callback registration so the
 * test can push a real `DWClientDownStream` envelope into the channel —
 * exactly what the live DingTalk server would do over a WebSocket.
 *
 * What's real:
 *  - `DingTalkChannel` instance, with its actual `parseRobotMessage`, dedup
 *    state, permission policy, and outbound `sendMessage` (real HTTP POST to
 *    the test's local capture server).
 *  - `ChannelRegistry` registration + routing.
 *  - `SQLiteSessionStore` session lifecycle.
 *  - `SessionManager` per-account queue.
 *  - `AgentBridge` (subprocess IPC against a tiny fake `omp --mode rpc`
 *    script that emits a deterministic JSONL response — stands in for the
 *    LLM runtime without hitting a real model).
 *  - The full inbound pipeline the Gateway uses: parse, dedup, allowlist,
 *    placeholder POST, enqueue, agent reply POST.
 *
 * What's faked, and why:
 *  - The DingTalk WebSocket transport: replaced by a tiny `EventEmitter`-based
 *    fake `DWClient` injected via the `protected createDWClient` factory seam.
 *    The channel drives the same callback path it would in production.
 *  - The `omp --mode rpc` child process: replaced by a bun script that emits
 *    a deterministic reply. The bridge is the real one — process lifecycle,
 *    JSONL framing, and session switch are all real.
 *  - The DingTalk sessionWebhook URL: points to a local `Bun.serve` capture
 *    server so we can assert on the exact POST body and order without
 *    mocking `globalThis.fetch` (which Bun's internal code paths can bypass).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import type { DWClientDownStream } from "dingtalk-stream";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import { ChannelRegistry } from "../src/channels/registry";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import { SessionManager } from "../src/session-manager";
import { SQLiteSessionStore } from "../src/session-store";
import type { ChannelConfig, DingTalkConfig, DingTalkRawMessage, InboundMessage } from "../src/types";

// ---------------------------------------------------------------------------
// Fake omp --mode rpc: deterministic JSONL echo
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
			const sid = sessionAtPrompt.split("/").pop();
			emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ack: " + frame.message + " (sid=" + sid + ")" }] } });
			emit({ type: "agent_end" });
		}, 0);
	}
	if (frame.type === "abort") {
		emit({ type: "response", id: frame.id, command: "abort", success: true });
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

// ---------------------------------------------------------------------------
// Fake DWClient: captures callback registration, mimics SDK surface
// ---------------------------------------------------------------------------

interface FakeSocket extends EventEmitter {
	readyState: number;
	ping(): void;
}

class FakeDWClient extends EventEmitter {
	connected = false;
	registered = false;
	socket: FakeSocket;
	#callbacks = new Map<string, (msg: DWClientDownStream) => void>();

	constructor(_opts: unknown) {
		super();
		const socket = new EventEmitter() as FakeSocket;
		socket.readyState = 1; // OPEN so #waitForSocketOpen returns true
		socket.ping = () => {};
		this.socket = socket;
	}

	registerCallbackListener(eventId: string, callback: (msg: DWClientDownStream) => void): this {
		this.#callbacks.set(eventId, callback);
		this.registered = true;
		return this;
	}

	async connect(): Promise<void> {
		this.connected = true;
		queueMicrotask(() => this.emit("connect"));
	}

	disconnect(): void {
		this.connected = false;
	}

	socketCallBackResponse(_messageId: string, _result: unknown): void {
		// Tests don't assert on acks.
	}

	deliverRobotMessage(downstream: DWClientDownStream): void {
		const cb = this.#callbacks.get(downstream.headers.topic);
		if (!cb) throw new Error(`callback for topic ${downstream.headers.topic} not registered`);
		cb(downstream);
	}

	static envelope(headers: Partial<DWClientDownStream["headers"]>, data: string): DWClientDownStream {
		return {
			specVersion: "1.0",
			type: "CALLBACK",
			headers: {
				appId: "test-app",
				connectionId: "conn-1",
				contentType: "application/json",
				messageId: "protocol-msg-1",
				time: String(Date.now()),
				topic: "/v1.0/im/bot/messages/get",
				...headers,
			},
			data,
		};
	}
}

class TestableDingTalkChannel extends DingTalkChannel {
	#fakeClient: FakeDWClient | null = null;
	#mediaDir: string | null = null;
	getFakeClient(): FakeDWClient {
		if (!this.#fakeClient) throw new Error("fake client not initialised — channel never connected");
		return this.#fakeClient;
	}
	protected override createDWClient(_config: DingTalkConfig): unknown {
		this.#fakeClient = new FakeDWClient({});
		return this.#fakeClient as unknown as ReturnType<DingTalkChannel["createDWClient"]>;
	}
	/**
	 * Override the media downloader so the channel can resolve
	 * `downloadCode:...` to a real local file without hitting the DingTalk
	 * OAPI. Each call writes a tiny placeholder file into `mediaDir` and
	 * returns its path. Tests can then assert that the agent received a
	 * local path instead of the raw `downloadCode:...` placeholder.
	 */
	setMediaDir(dir: string): void {
		this.#mediaDir = dir;
	}
	protected override createMediaDownloader() {
		const dir = this.#mediaDir;
		if (!dir) return undefined;
		return async (ref: string, kind: "image" | "voice" | "video" | "file") => {
			await fs.mkdir(dir, { recursive: true });
			const ext = kind === "image" ? "jpg" : kind === "video" ? "mp4" : kind === "voice" ? "ogg" : "bin";
			const id = ref.replace(/^downloadCode:/, "");
			const filePath = path.join(dir, `${id}.${ext}`);
			await Bun.write(filePath, `placeholder for ${ref}\n`);
			return { path: filePath, mimeType: "application/octet-stream", originalName: `${id}.${ext}`, size: 1 };
		};
	}
}

// ---------------------------------------------------------------------------
// Fixtures: real `DingTalkRawMessage` shapes
// ---------------------------------------------------------------------------

function makeDmText(overrides: Partial<DingTalkRawMessage> = {}): DingTalkRawMessage {
	return {
		conversationId: "conv-dm-001",
		atUsers: [],
		chatbotCorpId: "corp-001",
		chatbotUserId: "bot-001",
		msgId: "msg-dm-001",
		senderNick: "测试用户",
		isAdmin: false,
		senderStaffId: "user-allowed",
		sessionWebhookExpiredTime: Date.now() + 3600_000,
		createAt: Date.now(),
		senderCorpId: "corp-001",
		conversationType: "1",
		senderId: "user-allowed",
		conversationTitle: "DM",
		isInAtList: false,
		sessionWebhook: "PLACEHOLDER_WEBHOOK",
		text: { content: "你好，介绍一下你自己" },
		msgtype: "text",
		robotCode: "robot-code-001",
		...overrides,
	};
}

function makeGroupText(overrides: Partial<DingTalkRawMessage> = {}): DingTalkRawMessage {
	return makeDmText({
		conversationId: "conv-group-001",
		conversationType: "2",
		conversationTitle: "工程组",
		isInAtList: true,
		atUsers: [{ dingtalkId: "user-allowed" }],
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface OutboundCapture {
	url: string;
	body: string;
}

interface Harness {
	rootDir: string;
	rpcPath: string;
	channel: TestableDingTalkChannel;
	registry: ChannelRegistry;
	store: SQLiteSessionStore;
	manager: SessionManager;
	bridge: AgentBridge;
	agentDir: string;
	schedulerStorage: SchedulerDbStorage;
	outbound: OutboundCapture[];
	webhookBase: string;
	deliver(raw: DingTalkRawMessage, protocolMessageId?: string): Promise<void>;
	buildDm(overrides?: Partial<DingTalkRawMessage>): DingTalkRawMessage;
	buildGroup(overrides?: Partial<DingTalkRawMessage>): DingTalkRawMessage;
	dispose(): Promise<void>;
}

async function createHarness(options?: {
	allowedUsers?: string[];
	allowedGroups?: string[];
	groupPolicy?: "open" | "allowlist" | "closed";
	dmPolicy?: "open" | "allowlist" | "closed";
}): Promise<Harness> {
	const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gw-dingtalk-e2e-"));
	const rpcPath = path.join(rootDir, "fake-rpc");
	await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
	await fs.chmod(rpcPath, 0o755);

	const accountId = "hr";
	const agentDir = path.join(rootDir, "agents", accountId);
	await ensureAgentDir(agentDir);

	const bridge = new AgentBridge({ ompPath: rpcPath, cwd: agentDir, timeoutMs: 2_000 });
	await bridge.start();

	const store = new SQLiteSessionStore(path.join(rootDir, "sessions.db"));
	const manager = new SessionManager({ bridges: new Map([[accountId, bridge]]) });

	const outbound: OutboundCapture[] = [];
	// Local capture server: every POST lands here. This is more reliable
	// than mocking `globalThis.fetch` because Bun's internal code paths can
	// sometimes bypass the mock descriptor.
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			outbound.push({ url: req.url, body: await req.text() });
			return new Response('{"errcode":0,"errmsg":"ok"}', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	const webhookBase = `http://127.0.0.1:${server.port}/webhook`;

	const channel = new TestableDingTalkChannel();
	channel.setAccountId(accountId);
	channel.setMediaDir(path.join(rootDir, "media"));

	const registry = new ChannelRegistry();
	const dtConfig: DingTalkConfig = {
		enabled: true,
		appKey: "test-app-key",
		appSecret: "test-app-secret",
		robotCode: "robot-code-001",
		dmPolicy: options?.dmPolicy ?? "allowlist",
		groupPolicy: options?.groupPolicy ?? "allowlist",
		allowedUsers: options?.allowedUsers ?? ["user-allowed"],
		allowedGroups: options?.allowedGroups ?? ["conv-group-001"],
	};
	registry.register(channel, dtConfig as unknown as ChannelConfig, `dingtalk:${accountId}`);

	// Wire the same inbound handler the Gateway uses: load/create session,
	// send "thinking..." placeholder, enqueue, send agent reply.
	registry.connectAll(async (msg: InboundMessage) => {
		const acc = msg.accountId ?? "__default__";
		let session = await store.getSession(msg.channelId, acc, msg.conversationId);
		if (!session) {
			session = await store.createSession({
				channelId: msg.channelId,
				accountId: acc,
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

	// `connectAll` strips DingTalk-specific fields via `channelConfigSchema`.
	// Reconnect with the full DingTalk config so `onConnect` sees
	// `appKey`/`appSecret` (so it builds the SDK client) and
	// `#checkPermission` sees `dmPolicy`/`allowedUsers`/`allowedGroups`.
	await channel.connect(dtConfig as unknown as ChannelConfig);

	const schedulerStorage = new SchedulerDbStorage(path.join(rootDir, "scheduler.db"));

	const harness: Harness = {
		rootDir,
		rpcPath,
		channel,
		registry,
		store,
		manager,
		bridge,
		agentDir,
		schedulerStorage,
		outbound,
		webhookBase,
		deliver: async (raw, protocolMessageId) => {
			const pid = protocolMessageId ?? `proto-${raw.msgId}`;
			const envelope = FakeDWClient.envelope({ messageId: pid }, JSON.stringify(raw));
			channel.getFakeClient().deliverRobotMessage(envelope);
		},
		buildDm: overrides => makeDmText({ ...overrides, sessionWebhook: `${webhookBase}/conv-dm-001` }),
		buildGroup: overrides => makeGroupText({ ...overrides, sessionWebhook: `${webhookBase}/conv-group-001` }),
		dispose: async () => {
			server.stop(true);
			schedulerStorage.close();
			store.close();
			await registry.disconnectAll();
			bridge.stop();
			await fs.rm(rootDir, { recursive: true, force: true });
		},
	};
	return harness;
}

/**
 * Wait for `harness.outbound` to reach at least `atLeast` entries.
 *
 * The full message-processing chain is async (placeholder → bridge →
 * reply) and runs after `deliver()` returns. The bridge's `waitForIdle`
 * isn't a reliable join point because the handler awaits the placeholder
 * before calling the bridge. Polling outbound is the simplest correct
 * join.
 */
async function waitForOutbound(harness: Harness, atLeast: number, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (harness.outbound.length < atLeast) {
		if (Date.now() - start > timeoutMs) break;
		await Bun.sleep(10);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DingTalk channel + gateway end-to-end", () => {
	let harness: Harness | undefined;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(async () => {
		if (!harness) return;
		await harness.dispose();
		harness = undefined;
	});

	test("DM text flows through real channel -> gateway -> bridge -> real sendMessage", async () => {
		if (!harness) throw new Error("missing harness");
		const initial = harness.outbound.length;
		await harness.deliver(harness.buildDm({ text: { content: "ping" }, msgId: "msg-dm-ping" }));
		await waitForOutbound(harness, initial + 2);

		const posts = harness.outbound.slice(initial);
		expect(posts.length).toBe(2);
		expect(posts[0]?.url).toBe(`${harness.webhookBase}/conv-dm-001`);
		const placeholderBody = JSON.parse(posts[0]!.body);
		expect(placeholderBody.msgtype).toBe("markdown");
		expect(placeholderBody.markdown.text).toBe("thinking...");

		const replyBody = JSON.parse(posts[1]!.body);
		expect(replyBody.msgtype).toBe("text");
		expect(replyBody.text.content).toContain("ack: ping");
		expect(replyBody.text.content).toContain("sid=conv-dm-001.jsonl");

		const session = await harness.store.getSession("dingtalk", "hr", "conv-dm-001");
		expect(session).not.toBeNull();
		expect(session?.ompSessionPath).toBe(path.join(harness.agentDir, "sessions", "conv-dm-001.jsonl"));
	});

	test("duplicate msgId is dropped by the channel's real dedup before reaching the gateway", async () => {
		if (!harness) throw new Error("missing harness");
		const raw = harness.buildDm({ text: { content: "first" }, msgId: "msg-dup" });
		await harness.deliver(raw, "proto-A");
		await waitForOutbound(harness, 2);
		const baseline = harness.outbound.length;
		expect(baseline).toBe(2);

		// Same business msgId via a different protocol messageId (DingTalk
		// retransmit). Should be deduped at the business-layer check inside
		// the channel.
		await harness.deliver({ ...raw, text: { content: "second" } }, "proto-B");
		await Bun.sleep(100);

		expect(harness.outbound.length).toBe(baseline);
	});

	test("group @mention is routed to the bridge when group policy allows", async () => {
		if (!harness) throw new Error("missing harness");
		const initial = harness.outbound.length;
		const raw = harness.buildGroup({
			text: { content: "@机器人 总结一下今天的需求" },
			msgId: "msg-group-1",
		});
		await harness.deliver(raw);
		await waitForOutbound(harness, initial + 2);

		const posts = harness.outbound.slice(initial);
		expect(posts.length).toBe(2);
		const reply = JSON.parse(posts[1]!.body);
		expect(reply.text.content).toContain("ack: @机器人 总结一下今天的需求");

		const session = await harness.store.getSession("dingtalk", "hr", "conv-group-001");
		expect(session?.conversationId).toBe("conv-group-001");
	});

	test("DM from a user outside the allowlist is blocked; no bridge call, no agent reply", async () => {
		if (!harness) throw new Error("missing harness");
		const initial = harness.outbound.length;
		// user-blocked is not in the allowlist `["user-allowed"]`.
		const raw = harness.buildDm({
			senderStaffId: "user-blocked",
			senderId: "user-blocked",
			text: { content: "should not reach agent" },
			msgId: "msg-blocked",
		});
		await harness.deliver(raw);
		await Bun.sleep(100);

		// Channel's #checkPermission rejects the message before it ever
		// hits BaseChannel.handleInbound -> the gateway. The channel posts
		// a "you don't have permission" denial via sessionWebhook, but
		// no agent call happens and no agent reply is generated.
		expect(harness.outbound.length).toBe(initial + 1);
		const denial = JSON.parse(harness.outbound[initial]!.body);
		expect(denial.msgtype).toBe("text");
		expect(denial.text.content).toContain("permission");
		const session = await harness.store.getSession("dingtalk", "hr", "conv-dm-001");
		expect(session).toBeNull();
	});

	test("richText message is split into ordered text+image blocks, each routed to the bridge", async () => {
		if (!harness) throw new Error("missing harness");
		const initial = harness.outbound.length;
		const raw: DingTalkRawMessage = {
			conversationId: "conv-rich-001",
			atUsers: [],
			chatbotCorpId: "corp-001",
			chatbotUserId: "bot-001",
			msgId: "msg-rich-001",
			senderNick: "rich user",
			isAdmin: false,
			senderStaffId: "user-allowed",
			sessionWebhookExpiredTime: Date.now() + 3600_000,
			createAt: Date.now(),
			senderCorpId: "corp-001",
			conversationType: "1",
			senderId: "user-allowed",
			conversationTitle: "DM",
			isInAtList: false,
			sessionWebhook: `${harness.webhookBase}/conv-rich-001`,
			msgtype: "richText",
			robotCode: "robot-code-001",
			content: JSON.stringify({
				richText: [
					{ type: "text", text: "看图" },
					{ type: "picture", downloadCode: "img-A", pictureUrl: "https://example.com/a.jpg" },
					{ type: "text", text: "再看一张" },
					{ type: "picture", downloadCode: "img-B" },
				],
			}),
		};
		await harness.deliver(raw);

		// 4 blocks: each placeholder + each reply = 8 outbound POSTs.
		await waitForOutbound(harness, initial + 8);
		const posts = harness.outbound.slice(initial);
		expect(posts.length).toBe(8);

		// Each block's reply text from the fake RPC is `ack: <prompt>` where
		// <prompt> is the rendered text the bridge saw. Text blocks render
		// as plain text; image blocks render as `[image: <path>]`.
		const replies = [] as string[];
		for (let i = 1; i < 8; i += 2) {
			const body = JSON.parse(posts[i]!.body);
			replies.push(body.text.content);
		}
		expect(replies[0]).toContain("ack: 看图");
		expect(replies[1]).toMatch(/\[image \(a\.jpg\): .*img-A\.jpg\]/);
		expect(replies[2]).toContain("ack: 再看一张");
		expect(replies[3]).toMatch(/\[image \(image\.jpg\): .*img-B\.jpg\]/);

		// Pictures should have been downloaded to local paths, not the
		// `downloadCode:...` placeholder.
		expect(replies[1]).not.toContain("downloadCode:");
		expect(replies[3]).not.toContain("downloadCode:");
	});
});
