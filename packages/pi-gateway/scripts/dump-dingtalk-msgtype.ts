/**
 * Interactive DingTalk message-type test bench.
 *
 * Pushes one real `DingTalkRawMessage` per supported `msgtype` through the
 * real `DingTalkChannel` -> `SessionManager` -> `AgentBridge` pipeline, and
 * prints:
 *   1. the raw JSON that the DingTalk server would have delivered
 *   2. the parsed `MessageContent` the agent sees
 *   3. the actual prompt the agent (fake RPC) receives
 *   4. the response that goes back out the sessionWebhook
 *
 * Run from the package root with:
 *   bun run scripts/dump-dingtalk-msgtype.ts                # all 7 types
 *   bun run scripts/dump-dingtalk-msgtype.ts video         # one type
 *   bun run scripts/dump-dingtalk-msgtype.ts richText      # one type
 *   bun run scripts/dump-dingtalk-msgtype.ts --json '{...}'# raw override
 *
 * The fake RPC echoes `ack: <prompt>` so the response reflects the
 * `extractText` rendering of each content type. The fake `DWClient` is a
 * local `EventEmitter` (no real WebSocket). All channel parsing, dedup,
 * permission check, and media download are the production code paths.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import type { DWClientDownStream } from "dingtalk-stream";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import { ChannelRegistry } from "../src/channels/registry";
import { SessionManager } from "../src/session-manager";
import { SQLiteSessionStore } from "../src/session-store";
import type { ChannelConfig, DingTalkConfig, DingTalkRawMessage, InboundMessage } from "../src/types";

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
async function handleFrame(frame) {
	if (frame.type === "switch_session") {
		currentSession = frame.sessionPath;
		emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
		return;
	}
	if (frame.type === "prompt") {
		const sessionAtPrompt = currentSession;
		emit({ type: "response", id: frame.id, command: "prompt", success: true });
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
	let i = buffer.indexOf("\\n");
	while (i !== -1) {
		const line = buffer.slice(0, i).trim();
		buffer = buffer.slice(i + 1);
		if (line) await handleFrame(JSON.parse(line));
		i = buffer.indexOf("\\n");
	}
}
`;

// ── fake SDK transport ──────────────────────────────────────────────────────
class FakeSocket extends EventEmitter {
	readyState = 1;
	ping() {}
}
class FakeDWClient extends EventEmitter {
	#callbacks = new Map<string, (m: DWClientDownStream) => void>();
	connected = false;
	constructor() {
		super();
		(this as unknown as { socket: FakeSocket }).socket = new FakeSocket();
	}
	registerCallbackListener(eventId: string, cb: (m: DWClientDownStream) => void) {
		this.#callbacks.set(eventId, cb);
		return this;
	}
	async connect() {
		this.connected = true;
		queueMicrotask(() => this.emit("connect"));
	}
	disconnect() {
		this.connected = false;
	}
	socketCallBackResponse() {}
	deliver(downstream: DWClientDownStream) {
		const cb = this.#callbacks.get(downstream.headers.topic);
		if (!cb) throw new Error(`no callback for ${downstream.headers.topic}`);
		cb(downstream);
	}
	static envelope(messageId: string, data: string): DWClientDownStream {
		return {
			specVersion: "1.0",
			type: "CALLBACK",
			headers: {
				appId: "test-app",
				connectionId: "conn-1",
				contentType: "application/json",
				messageId,
				time: String(Date.now()),
				topic: "/v1.0/im/bot/messages/get",
			},
			data,
		};
	}
}

class TestableDingTalkChannel extends DingTalkChannel {
	#fake: FakeDWClient | null = null;
	#mediaDir: string | null = null;
	setMediaDir(dir: string) {
		this.#mediaDir = dir;
	}
	getFake() {
		if (!this.#fake) this.#fake = new FakeDWClient();
		return this.#fake;
	}
	protected override createDWClient() {
		return this.getFake() as unknown as ReturnType<DingTalkChannel["createDWClient"]>;
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

// ── fixtures ────────────────────────────────────────────────────────────────
function makeRaw(overrides: Partial<DingTalkRawMessage>): DingTalkRawMessage {
	return {
		conversationId: "cid001",
		atUsers: [],
		chatbotCorpId: "corp001",
		chatbotUserId: "bot001",
		msgId: `msg-${Math.random().toString(36).slice(2, 10)}`,
		senderNick: "测试用户",
		isAdmin: false,
		senderStaffId: "staff001",
		sessionWebhookExpiredTime: Date.now() + 3600_000,
		createAt: Date.now(),
		senderCorpId: "corp001",
		conversationType: "1",
		senderId: "staff001",
		conversationTitle: "DM",
		isInAtList: false,
		sessionWebhook: "PLACEHOLDER", // overwritten per-conversation
		msgtype: "text",
		robotCode: "robot001",
		...overrides,
	};
}

interface Sample {
	label: string;
	raw: DingTalkRawMessage;
}

const SAMPLES: Sample[] = [
	{
		label: "text — DM text",
		raw: makeRaw({ msgtype: "text", text: { content: "你好，介绍一下你自己" } }),
	},
	{
		label: "markdown — agent reply sent as markdown",
		raw: makeRaw({
			msgtype: "markdown",
			content: JSON.stringify({ title: "hi", text: "**bold** and *italic*" }),
		}),
	},
	{
		label: "picture — image with downloadCode",
		raw: makeRaw({
			msgtype: "picture",
			content: JSON.stringify({ downloadCode: "img001", pictureUrl: "https://example.com/1.jpg" }),
		}),
	},
	{
		label: "audio — voice message with ASR recognition",
		raw: makeRaw({
			msgtype: "audio",
			content: JSON.stringify({ downloadCode: "aud001", recognition: "明天的会议改到下午三点", duration: 4500 }),
		}),
	},
	{
		label: "video — mp4 video with downloadCode",
		raw: makeRaw({
			msgtype: "video",
			content: JSON.stringify({ downloadCode: "vid001", videoType: "mp4", duration: 12000 }),
		}),
	},
	{
		label: "file — generic file with filename + size",
		raw: makeRaw({
			msgtype: "file",
			content: JSON.stringify({ downloadCode: "fil001", fileName: "Q3-report.pdf", size: 2048 }),
		}),
	},
	{
		label: "richText — text + 2 images in order",
		raw: makeRaw({
			msgtype: "richText",
			content: JSON.stringify({
				richText: [
					{ type: "text", text: "看这张图" },
					{ type: "picture", downloadCode: "imgA", pictureUrl: "https://example.com/a.jpg" },
					{ type: "text", text: "再看一张" },
					{ type: "picture", downloadCode: "imgB" },
				],
			}),
		}),
	},
];

// ── harness ─────────────────────────────────────────────────────────────────
async function main() {
	const args = process.argv.slice(2);
	const singleType = args.find(a => !a.startsWith("-"));
	const jsonOverride = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

	const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dt-bench-"));
	const rpcPath = path.join(rootDir, "fake-rpc");
	await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
	await fs.chmod(rpcPath, 0o755);

	const accountId = "bench";
	const agentDir = path.join(rootDir, "agents", accountId);
	await ensureAgentDir(agentDir);

	const bridge = new AgentBridge({ ompPath: rpcPath, cwd: agentDir, timeoutMs: 2_000 });
	await bridge.start();

	const store = new SQLiteSessionStore(path.join(rootDir, "sessions.db"));
	const manager = new SessionManager({ bridges: new Map([[accountId, bridge]]) });

	const outbound: { url: string; body: string }[] = [];
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
		robotCode: "robot001",
		dmPolicy: "open", // open so we don't get blocked
		groupPolicy: "open",
	};
	registry.register(channel, dtConfig as unknown as ChannelConfig, `dingtalk:${accountId}`);

	const capturedPrompts: string[] = [];
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
		capturedPrompts.push((response ?? "").toString());
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
	await channel.connect(dtConfig as unknown as ChannelConfig);

	// ── run samples ────────────────────────────────────────────────────────
	const samples: Sample[] = jsonOverride
		? [{ label: "from --json", raw: JSON.parse(jsonOverride) as DingTalkRawMessage }]
		: singleType
			? SAMPLES.filter(s => s.raw.msgtype === singleType)
			: SAMPLES;

	if (samples.length === 0) {
		console.error(
			`no sample found for msgtype="${singleType}". Available: ${SAMPLES.map(s => s.raw.msgtype).join(", ")}`,
		);
		process.exit(1);
	}

	for (let i = 0; i < samples.length; i++) {
		const s = samples[i]!;
		const convId = `conv-${i}`;
		const raw = { ...s.raw, conversationId: convId, sessionWebhook: `${webhookBase}/${convId}` };
		const before = outbound.length;
		const beforePrompts = capturedPrompts.length;

		channel.getFake().deliver(FakeDWClient.envelope(`proto-${raw.msgId}`, JSON.stringify(raw)));

		// wait for: at least 2 outbound (placeholder + reply) per parsed block, and at least 1 prompt
		const expectedMin = 2;
		const start = Date.now();
		while (Date.now() - start < 2_000) {
			if (outbound.length - before >= expectedMin && capturedPrompts.length > beforePrompts) break;
			await Bun.sleep(10);
		}

		const promptCount = capturedPrompts.length - beforePrompts;
		const postCount = outbound.length - before;
		const replies = [] as string[];
		for (let k = before + 1; k < before + postCount; k += 2) {
			const body = JSON.parse(outbound[k]!.body);
			replies.push(body.text?.content ?? body.markdown?.text ?? "");
		}

		console.log(`\n${"━".repeat(72)}`);
		console.log(`# ${i + 1}. ${s.label}`);
		console.log("━".repeat(72));
		console.log("RAW JSON (data field of DWClientDownStream):");
		console.log(`  ${JSON.stringify(raw, null, 2).split("\n").join("\n  ")}`);
		console.log("\nWHAT THE AGENT SAW (extracted by agent-bridge#extractText):");
		for (let p = 0; p < promptCount; p++) {
			console.log(`  [block ${p + 1}/${promptCount}] ${capturedPrompts[beforePrompts + p]}`);
		}
		console.log("\nWHAT THE AGENT SENT BACK (via sessionWebhook):");
		for (const r of replies) console.log(`  → ${r}`);
	}

	// ── cleanup ────────────────────────────────────────────────────────────
	server.stop(true);
	store.close();
	await registry.disconnectAll();
	bridge.stop();
	await fs.rm(rootDir, { recursive: true, force: true });
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
