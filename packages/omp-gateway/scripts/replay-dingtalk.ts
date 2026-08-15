/**
 * Replay captured DingTalk messages through the parser + bridge pipeline.
 *
 * Reads a JSONL capture file produced by `capture-dingtalk.ts` and runs each
 * captured `DingTalkRawMessage` through the real `DingTalkChannel` parser
 * + a fake `omp --mode rpc` (deterministic echo) so you can verify:
 *   - the real `downloadCode` you captured gets resolved to a local path
 *   - the parsed content matches the wire format the production parser expects
 *   - the agent prompt the downstream LLM would receive is correctly rendered
 *
 * The real `downloadMedia` (OAPI call) is invoked, which DOES hit the
 * real DingTalk servers with your real credentials. If you do not want that,
 * use `--fake-download` to substitute a placeholder instead.
 *
 * Usage:
 *   bun run scripts/replay-dingtalk.ts /tmp/dingtalk-capture.jsonl
 *   bun run scripts/replay-dingtalk.ts /tmp/cap.jsonl --only picture,video
 *   bun run scripts/replay-dingtalk.ts /tmp/cap.jsonl --fake-download
 *   bun run scripts/replay-dingtalk.ts /tmp/cap.jsonl --limit 5
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentSessionPath, ensureAgentDir } from "@oh-my-pi/pi-coding-agent/skeleton";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import { downloadMedia as realDownloadMedia } from "../src/channels/dingtalk-media";
import { ChannelRegistry } from "../src/channels/registry";
import { getDingTalkConfig, loadConfig } from "../src/config";
import { SessionManager } from "../src/session-manager";
import { SQLiteSessionStore } from "../src/session-store";
import type { ChannelConfig, DingTalkConfig, DingTalkRawMessage, InboundMessage } from "../src/types";

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let currentSession = "";
let buffer = "";
function emit(v) { process.stdout.write(JSON.stringify(v) + "\\n"); }
async function handleFrame(frame) {
	if (frame.type === "switch_session") {
		currentSession = frame.sessionPath;
		emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
		return;
	}
	if (frame.type === "prompt") {
		const sid = currentSession.split("/").pop();
		emit({ type: "response", id: frame.id, command: "prompt", success: true });
		setTimeout(() => {
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

function parseArgs() {
	const argv = process.argv.slice(2);
	const capturePath = argv[0];
	if (!capturePath) {
		console.error(
			"usage: bun run scripts/replay-dingtalk.ts <capture.jsonl> [--only a,b,c] [--fake-download] [--limit N] [--account <id>]",
		);
		process.exit(1);
	}
	let only: Set<string> | null = null;
	let fakeDownload = false;
	let limit = 0;
	let accountId = "default";
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--only") {
			only = new Set(
				(argv[++i] ?? "")
					.split(",")
					.map(s => s.trim())
					.filter(Boolean),
			);
			continue;
		}
		if (a === "--fake-download") {
			fakeDownload = true;
			continue;
		}
		if (a === "--limit") {
			limit = Number(argv[++i] ?? 0);
			continue;
		}
		if (a === "--account") {
			accountId = argv[++i] ?? accountId;
		}
	}
	return { capturePath, only, fakeDownload, limit, accountId };
}

async function loadCapture(p: string): Promise<DingTalkRawMessage[]> {
	const text = await Bun.file(p).text();
	const lines = text.split("\n").filter(Boolean);
	const out: DingTalkRawMessage[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			out.push(JSON.parse(lines[i]!));
		} catch (err) {
			console.warn(`skipping line ${i + 1}: ${String(err)}`);
		}
	}
	return out;
}

class TestableDingTalkChannel extends DingTalkChannel {
	#mediaDir: string | null = null;
	setMediaDir(dir: string) {
		this.#mediaDir = dir;
	}
	/** Public alias for the protected factory so the replay harness can use it. */
	getMediaDownloader() {
		return this.createMediaDownloader();
	}
	protected override createMediaDownloader() {
		if (this.#mediaDir) {
			const dir = this.#mediaDir;
			return async (ref: string, kind: "image" | "voice" | "video" | "file") => {
				await fs.mkdir(dir, { recursive: true });
				const ext = kind === "image" ? "jpg" : kind === "video" ? "mp4" : kind === "voice" ? "ogg" : "bin";
				const id = ref.replace(/^downloadCode:/, "").replace(/[^A-Za-z0-9._-]/g, "_");
				const filePath = path.join(dir, `${id}.${ext}`);
				await Bun.write(filePath, `placeholder for ${ref}\n`);
				return { path: filePath, mimeType: "application/octet-stream", originalName: `${id}.${ext}`, size: 1 };
			};
		}
		// No mediaDir set: use the real downloader (will hit OAPI)
		if (!this.#config) return undefined;
		const config = this.#config;
		return async (ref, _kind) => realDownloadMedia(ref, config);
	}
}

async function main() {
	const args = parseArgs();
	const capture = await loadCapture(args.capturePath);
	console.log(`loaded ${capture.length} messages from ${args.capturePath}`);

	let filtered = capture;
	if (args.only) filtered = filtered.filter(r => args.only!.has(r.msgtype ?? ""));
	if (args.limit > 0) filtered = filtered.slice(0, args.limit);

	if (filtered.length === 0) {
		console.log("no messages to replay (after filter).");
		return;
	}

	const cfg = await loadConfig();
	const dt = getDingTalkConfig(cfg);
	const account = dt?.accounts?.[args.accountId];
	if (args.fakeDownload) {
		// nothing — we'll set mediaDir on channel
	} else if (!account) {
		console.error(`error: --fake-download not set and account "${args.accountId}" not found in gateway.json.`);
		console.error("Either pass --fake-download or use a real --account <id>.");
		process.exit(1);
	}

	// Build harness
	const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dt-replay-"));
	const rpcPath = path.join(rootDir, "fake-rpc");
	await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
	await fs.chmod(rpcPath, 0o755);

	const acct = account ? args.accountId : "replay";
	const agentDir = path.join(rootDir, "agents", acct);
	await ensureAgentDir(agentDir);

	const bridge = new AgentBridge({ ompPath: rpcPath, cwd: agentDir, timeoutMs: 5_000 });
	await bridge.start();

	const store = new SQLiteSessionStore(path.join(rootDir, "sessions.db"));
	const manager = new SessionManager({ bridges: new Map([[acct, bridge]]) });

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
	channel.setAccountId(acct);
	if (args.fakeDownload) channel.setMediaDir(path.join(rootDir, "media"));

	const registry = new ChannelRegistry();
	const dtConfig: DingTalkConfig = {
		enabled: true,
		appKey: account?.appKey ?? "fake-key",
		appSecret: account?.appSecret ?? "fake-secret",
		robotCode: account?.robotCode,
		dmPolicy: "open",
		groupPolicy: "open",
	};
	registry.register(channel, dtConfig as unknown as ChannelConfig, `dingtalk:${acct}`);

	const prompts: string[] = [];
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
		prompts.push(response ?? "");
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

	// Replay each captured message by directly invoking the parser + channel
	// pipeline. We use `parseRobotMessage` (the same function the channel
	// uses internally) to keep the path identical to production.
	const { parseRobotMessage } = await import("../src/channels/dingtalk");
	const downloader = channel.getMediaDownloader();

	for (let i = 0; i < filtered.length; i++) {
		const raw = filtered[i]!;
		// Override sessionWebhook to point at our capture server, but keep
		// everything else as captured.
		const convId = `replay-${i}-${raw.conversationId?.slice(0, 16) ?? "x"}`;
		const replayRaw: DingTalkRawMessage = {
			...raw,
			conversationId: convId,
			sessionWebhook: `${webhookBase}/${convId}`,
		};

		const before = outbound.length;
		const beforePrompts = prompts.length;
		const inbounds = await parseRobotMessage(replayRaw, "dingtalk", acct, raw.msgId, downloader);

		console.log(`\n${"━".repeat(72)}`);
		console.log(
			`# ${i + 1}/${filtered.length}  msgtype=${replayRaw.msgtype}  msgId=${replayRaw.msgId}  sender=${replayRaw.senderNick} (${replayRaw.senderStaffId})`,
		);
		console.log("━".repeat(72));
		console.log("RAW (as captured):");
		console.log(`  ${JSON.stringify(replayRaw, null, 2).split("\n").join("\n  ")}`);
		console.log(`\nPARSED → ${inbounds.length} block(s):`);
		for (let k = 0; k < inbounds.length; k++) {
			const c = inbounds[k]!.content;
			const summary =
				c.type === "text"
					? `text="${c.text}"`
					: c.type === "markdown"
						? `markdown="${c.markdown}"`
						: c.type === "image"
							? `image url=${c.url} filename=${c.filename ?? "(none)"}`
							: c.type === "voice"
								? `voice url=${c.url} text="${c.text ?? ""}" duration=${c.duration ?? "?"}`
								: c.type === "file"
									? `file filename=${c.filename} size=${c.size ?? "?"} url=${c.url}`
									: c.type === "video"
										? `video filename=${c.filename} type=${c.videoType ?? "?"} duration=${c.duration ?? "?"} url=${c.url}`
										: JSON.stringify(c);
			console.log(`  [block ${k + 1}/${inbounds.length}] ${summary}`);
		}

		// Now actually drive the channel pipeline (placeholder + bridge call) for each block
		for (const ib of inbounds) {
			await registry.sendMessage({
				channelId: ib.channelId,
				accountId: ib.accountId,
				conversationId: ib.conversationId,
				sessionWebhook: ib.sessionWebhook,
				content: { type: "markdown", markdown: "thinking..." },
			});
			let session = await store.getSession(ib.channelId, acct, ib.conversationId);
			if (!session) {
				session = await store.createSession({
					channelId: ib.channelId,
					accountId: acct,
					userId: ib.userId,
					conversationId: ib.conversationId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					ompSessionPath: buildAgentSessionPath(agentDir, ib.conversationId),
					status: "active",
				});
			}
			const response = await manager.enqueue(ib, session);
			prompts.push(response ?? "");
			if (response) {
				await registry.sendMessage({
					channelId: ib.channelId,
					accountId: ib.accountId,
					conversationId: ib.conversationId,
					sessionWebhook: ib.sessionWebhook,
					content: { type: "text", text: response },
				});
			}
		}

		// wait for outbound
		const start = Date.now();
		while (Date.now() - start < 3_000) {
			if (outbound.length - before >= inbounds.length * 2) break;
			await Bun.sleep(10);
		}

		const blockCount = inbounds.length;
		console.log(`\nWHAT THE AGENT SAW (${prompts.length - beforePrompts} block(s) sent to bridge):`);
		for (let p = beforePrompts; p < prompts.length; p++) console.log(`  → ${prompts[p]}`);

		const replies: string[] = [];
		for (let k = before + 1; k < outbound.length; k += 2) {
			const body = JSON.parse(outbound[k]!.body);
			replies.push(body.text?.content ?? body.markdown?.text ?? "");
		}
		console.log(`\nWHAT WENT OUT TO SESSIONWEBHOOK (${replies.length} reply block(s), expect ${blockCount}):`);
		for (const r of replies) console.log(`  → ${r}`);
		if (replies.length !== blockCount) {
			console.warn(`  ⚠ mismatch: parsed ${blockCount}, replied ${replies.length}`);
		}
	}

	// Cleanup
	server.stop(true);
	store.close();
	await registry.disconnectAll();
	bridge.stop();
	await fs.rm(rootDir, { recursive: true, force: true });
	console.log("\n[replay] done.");
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
