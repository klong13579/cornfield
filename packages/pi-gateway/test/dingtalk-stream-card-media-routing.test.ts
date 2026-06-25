/**
 * End-to-end test for the streamCard media routing pipeline.
 *
 * The card body + standalone message pipeline must, for every media
 * token in agent reply text, pick the right deliverable:
 *   - image (supported)        → in-card type-3 block
 *   - video (supported)        → standalone sampleVideo message
 *   - audio (supported)        → standalone sampleAudio message
 *   - document (supported)     → standalone sampleFile message
 *   - unsupported (any kind)   → clickable fallback link in the answer
 *
 * What's real: `DingTalkChannel.streamCard`, the card module,
 * uploadMedia, the formatter, the OAuth helpers.
 *
 * What's faked: a small `Bun.serve` capture server that mimics the
 * DingTalk card API + the OAPI media upload API + the OAuth token
 * endpoint, and the agent RPC (a tiny bun script that emits a fixed
 * reply containing one of each kind of media token).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import type { DingTalkConfig, InboundMessage, SessionRecord } from "../src/types";

/**
 * Fake RPC that emits a deterministic reply containing one of each
 * media kind the pipeline routes:
 *   - supported image (jpg) — should land as a type-3 card block
 *   - supported audio (mp3) — should land as a standalone sampleAudio
 *   - supported document (pdf) — should land as a standalone sampleFile
 *   - supported video (mp4) — should land as a standalone sampleVideo
 *   - unsupported image (webp) — should become a fallback link
 *
 * The reply text is delivered as a single text_delta so we don't have
 * to think about throttle / segment boundaries here.
 */
const REPLY_WITH_MIXED_MEDIA = `Here is the analysis:

![chart](/tmp/chart.jpg)

![voice memo](https://example.invalid/voice.mp3)

![quarterly report](/tmp/q4.pdf)

![screen recording](/tmp/session.mp4)

![svg logo](/tmp/logo.webp)

That's the lot.`;

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
const reply = ${JSON.stringify(REPLY_WITH_MIXED_MEDIA)};
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let idx = buffer.indexOf("\\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) { idx = buffer.indexOf("\\n"); continue; }
    const frame = JSON.parse(line);
    if (frame.type === "switch_session") {
      emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    } else if (frame.type === "prompt") {
      emit({ type: "response", id: frame.id, command: "prompt", success: true });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply, contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: reply }],
          model: "test-model",
          provider: "test",
          usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
          duration: 50,
        },
      });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
    }
    idx = buffer.indexOf("\\n");
  }
}
`;

interface FakeRpc {
	path: string;
	cleanup: () => Promise<void>;
}

async function createFakeRpcBinary(): Promise<FakeRpc> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-media-routing-rpc-"));
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

interface CapturedCall {
	method: string;
	path: string;
	body: unknown;
	contentType: string | null;
}

interface FakeServer {
	host: string;
	port: number;
	calls: CapturedCall[];
	stop: () => void;
}

/**
 * Capture every card / OAPI / OAuth request the gateway makes so the
 * test can assert on the body of the FINISHED card PUT and on the
 * standalone sampleAudio / sampleFile / sampleVideo sends.
 */
async function startFakeDingTalkServer(): Promise<FakeServer> {
	const calls: CapturedCall[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			let body: unknown = null;
			if (req.method !== "GET" && req.method !== "HEAD") {
				const ct = req.headers.get("content-type") ?? "";
				if (ct.includes("application/json")) {
					body = await req.json().catch(() => null);
				} else if (ct.includes("multipart/form-data") || ct.includes("application/octet-stream")) {
					body = "[binary]";
				} else {
					body = await req.text().catch(() => null);
				}
			}
			calls.push({
				method: req.method,
				path: url.pathname,
				body,
				contentType: req.headers.get("content-type"),
			});

			// OAuth — both the v1.0 token (used by card calls) and the
			// oapi.dingtalk.com gettoken (used by media upload).
			if (url.pathname === "/v1.0/oauth2/accessToken") {
				return Response.json({ accessToken: "test-token", expireIn: 7200 });
			}
			if (url.pathname === "/gettoken") {
				return Response.json({ errcode: 0, access_token: "test-oapi-token" });
			}

			// Card lifecycle
			if (url.pathname === "/v1.0/card/instances" && req.method === "POST") {
				return Response.json({ cardInstanceId: "ignored" });
			}
			if (url.pathname === "/v1.0/card/instances/deliver") {
				return Response.json({});
			}
			if (url.pathname === "/v1.0/card/streaming" && req.method === "PUT") {
				return Response.json({});
			}
			if (url.pathname === "/v1.0/card/instances" && req.method === "PUT") {
				return Response.json({});
			}

			// Media upload — return a distinct media_id so the test can
			// confirm uploads happened for the expected kinds.
			if (url.pathname === "/media/upload") {
				return Response.json({ errcode: 0, media_id: `media-${calls.length}` });
			}

			// Standalone message sends (DM + group)
			if (
				url.pathname === "/v1.0/robot/oToMessages/batchSend" ||
				url.pathname === "/v1.0/robot/groupMessages/send"
			) {
				return Response.json({});
			}

			// File download (remote URL image / video / audio) — return a
			// tiny valid PNG body. The pipeline uploads whatever bytes
			// we send; the API only checks size + format, not the actual
			// image content. For the test, this just needs to be a 200.
			// The content type for /voice.mp3 is `audio/mpeg` (the
			// canonical type for .mp3) so the downloaded temp file gets
			// a `.mpeg` extension — the URL extension is what the pipeline
			// actually classifies, and `m.url` is `voice.mp3` so the
			// audio path is taken.
			if (url.pathname === "/__remote_image") {
				const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
				return new Response(png, { headers: { "Content-Type": "image/png" } });
			}
			if (url.pathname === "/voice.mp3") {
				// Minimal MP3 sync bytes — enough for the download to
				// succeed and the upload to accept the file.
				const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
				return new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } });
			}

			return new Response(`not found: ${url.pathname}`, { status: 404 });
		},
	});
	return {
		host: server.hostname,
		port: server.port,
		calls,
		stop: () => server.stop(true),
	};
}

function makeMessage(text: string, conversationId: string): InboundMessage {
	return {
		channelId: "dingtalk",
		accountId: "ops",
		userId: "u1",
		userName: "Alice",
		conversationId,
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
		sessionWebhook: "https://example.com/hook",
	};
}

function makeSession(sessionPath: string, conversationId: string): SessionRecord {
	return {
		id: conversationId,
		channelId: "dingtalk",
		accountId: "ops",
		userId: "u1",
		conversationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: sessionPath,
		status: "active",
	};
}

function makeDingTalkConfig(): DingTalkConfig {
	return {
		enabled: true,
		appKey: "test-key",
		appSecret: "test-secret",
		robotCode: "test-robot",
	};
}

/**
 * Patch globalThis.fetch so the channel's hard-coded
 * `https://api.dingtalk.com/*`, `https://oapi.dingtalk.com/*`, and
 * remote media URLs all hit the local fake server. Returns a restore
 * function for afterEach.
 */
async function installFetchOverride(host: string, port: number): Promise<() => void> {
	const realFetch = globalThis.fetch;
	const base = `http://${host}:${port}`;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		let rewritten = url;
		if (url.startsWith("https://api.dingtalk.com/")) {
			rewritten = base + url.slice("https://api.dingtalk.com".length);
		} else if (url.startsWith("https://oapi.dingtalk.com/")) {
			rewritten = base + url.slice("https://oapi.dingtalk.com".length);
		} else if (url.startsWith("https://example.invalid/")) {
			// remote media URL → fake server download endpoint
			rewritten = `${base}/${url.slice("https://example.invalid/".length)}`;
		}
		return realFetch(rewritten, init);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = realFetch;
	};
}

/**
 * Pre-stage the local files referenced by the agent reply so the
 * pipeline's `fs.promises.access(path)` check passes. The actual
 * contents don't matter — the fake server returns success for all
 * media uploads regardless of bytes.
 */
async function precreateLocalMediaFiles(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-media-routing-files-"));
	const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const _mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
	const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
	const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
	const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
	for (const [name, bytes] of [
		["chart.jpg", pngBytes], // jpg extension but valid PNG bytes — fine for upload test
		["q4.pdf", pdfBytes],
		["session.mp4", mp4Bytes],
		["logo.webp", webpBytes],
	] as const) {
		await fs.writeFile(path.join(dir, name), bytes);
	}
	return {
		dir,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Rewrite the agent reply's local paths to point at the per-test temp
 * dir. We can't precompute the path because it's created in beforeEach
 * with a random name.
 */
function rewriteReplyPaths(reply: string, dir: string): string {
	const mappings: Array<[string, string]> = [
		["/tmp/chart.jpg", path.join(dir, "chart.jpg")],
		["/tmp/q4.pdf", path.join(dir, "q4.pdf")],
		["/tmp/session.mp4", path.join(dir, "session.mp4")],
		["/tmp/logo.webp", path.join(dir, "logo.webp")],
	];
	let out = reply;
	for (const [from, to] of mappings) {
		out = out.split(from).join(to);
	}
	return out;
}

describe("DingTalkChannel.streamCard media routing pipeline", () => {
	let rpc: FakeRpc;
	let server: FakeServer;
	let restoreFetch: () => void;
	let files: { dir: string; cleanup: () => Promise<void> };
	let bridge: AgentBridge;

	beforeEach(async () => {
		rpc = await createFakeRpcBinary();
		server = await startFakeDingTalkServer();
		restoreFetch = await installFetchOverride(server.host, server.port);
		files = await precreateLocalMediaFiles();
		// The FAKE_RPC_SCRIPT captures the reply text at script-write
		// time, but we want the local paths to point at our temp dir.
		// We instead override the captured reply by writing a fresh
		// script that uses the rewritten paths.
		await fs.writeFile(
			rpc.path,
			FAKE_RPC_SCRIPT.replace(
				JSON.stringify(REPLY_WITH_MIXED_MEDIA),
				JSON.stringify(rewriteReplyPaths(REPLY_WITH_MIXED_MEDIA, files.dir)),
			),
		);
		bridge = new AgentBridge({ ompPath: rpc.path, timeoutMs: 5_000 });
		await bridge.start();
	});

	afterEach(async () => {
		bridge.stop();
		restoreFetch();
		server.stop();
		await rpc.cleanup();
		await files.cleanup();
	});

	test("routes each media kind correctly and degrades unsupported images to a link", async () => {
		const channel = new DingTalkChannel();
		channel.setAccountId("ops");
		channel.setConfig(makeDingTalkConfig());

		const inbound = makeMessage("analyze", "conv-media-routing-1");
		const session = makeSession("/tmp/media-routing-1.jsonl", "conv-media-routing-1");

		const submit = (handlers?: Parameters<typeof channel.streamCard>[3]): ReturnType<typeof bridge.forwardWithMeta> =>
			bridge.forwardWithMeta(inbound, session, handlers);

		const outbound = await channel.streamCard(
			inbound,
			session,
			{ accountId: "ops", agentName: "ops-bot", dapiCalls: 0 },
			submit,
		);

		expect(outbound).not.toBeNull();

		// 1. Card was created and finished.
		const paths = server.calls.map(c => `${c.method} ${c.path}`);
		expect(paths).toContain("POST /v1.0/card/instances");
		expect(paths).toContain("POST /v1.0/card/instances/deliver");
		const finishPut = server.calls.find(
			c =>
				c.method === "PUT" &&
				c.path === "/v1.0/card/instances" &&
				(c.body as { cardData?: { cardParamMap?: { flowStatus?: string } } })?.cardData?.cardParamMap
					?.flowStatus === "3",
		);
		expect(finishPut, "FINISHED card PUT should be sent").toBeTruthy();

		// 2. The card body should contain a fallback link for the webp
		//    (unsupported) image, and should NOT contain the raw webp
		//    markdown.
		const finishedMap = (
			finishPut as { body: { cardData: { cardParamMap: { content: string; blockList: string } } } }
		).body.cardData.cardParamMap;
		const cardContent = finishedMap.content;
		expect(cardContent).toContain("logo.webp");
		expect(cardContent).toContain("格式不支持");
		// The card should NOT have raw markdown image tokens for any
		// of the five media references — the supported ones became
		// blocks / standalone messages, the unsupported one became a
		// link.
		expect(cardContent).not.toContain("![chart]");
		expect(cardContent).not.toContain("![voice memo]");
		expect(cardContent).not.toContain("![quarterly report]");
		expect(cardContent).not.toContain("![screen recording]");
		expect(cardContent).not.toContain("![svg logo]");

		// 3. The supported image (jpg) was uploaded and pushed onto
		//    the blockList as a type-3 block.
		const blockList = JSON.parse(finishedMap.blockList) as Array<{
			type: number;
			mediaId?: string;
			text?: string;
		}>;
		const imageBlocks = blockList.filter(b => b.type === 3);
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0].text).toBe("chart");

		// 4. One media upload per supported media. The webp was
		//    unsupported so it was NOT uploaded. ffmpeg cover-frame
		//    extraction on the 4-byte stub MP4 fails, so no separate
		//    cover upload. Total = 4: image / video / audio /
		//    document.
		const uploads = server.calls.filter(c => c.path === "/media/upload");
		expect(uploads.length).toBe(4);

		// 5. Standalone sampleAudio + sampleFile + sampleVideo sends.
		const standaloneSends = server.calls.filter(
			c => c.path === "/v1.0/robot/oToMessages/batchSend" || c.path === "/v1.0/robot/groupMessages/send",
		);
		// (DingTalk's path is the same for both kinds; we filter by
		// body shape.)
		const byMsgKey = new Map<string, { count: number; sample: unknown }>();
		for (const call of standaloneSends) {
			const body = call.body as { msgKey?: string; msgParam?: string };
			if (!body.msgKey) continue;
			const entry = byMsgKey.get(body.msgKey) ?? { count: 0, sample: body };
			entry.count += 1;
			entry.sample = body;
			byMsgKey.set(body.msgKey, entry);
		}
		expect(byMsgKey.get("sampleAudio")?.count, "expected one sampleAudio send").toBe(1);
		expect(byMsgKey.get("sampleFile")?.count, "expected one sampleFile send").toBe(1);
		expect(byMsgKey.get("sampleVideo")?.count, "expected one sampleVideo send").toBe(1);

		// 6. sampleFile msgParam must carry the file name + extension.
		const fileBody = byMsgKey.get("sampleFile")?.sample as { msgParam: string };
		const fileParam = JSON.parse(fileBody.msgParam);
		expect(fileParam.fileName).toBe("q4.pdf");
		expect(fileParam.fileType).toBe("pdf");
		expect(typeof fileParam.mediaId).toBe("string");

		// 7. sampleAudio msgParam must carry mediaId + duration.
		const audioBody = byMsgKey.get("sampleAudio")?.sample as { msgParam: string };
		const audioParam = JSON.parse(audioBody.msgParam);
		expect(typeof audioParam.mediaId).toBe("string");
		expect(typeof audioParam.duration).toBe("string");

		// 8. sampleVideo msgParam must carry videoMediaId + videoType.
		const videoBody = byMsgKey.get("sampleVideo")?.sample as { msgParam: string };
		const videoParam = JSON.parse(videoBody.msgParam);
		expect(typeof videoParam.videoMediaId).toBe("string");
		expect(videoParam.videoType).toBe("mp4");
	});

	test("returns null when card creation fails (gateway falls back to v1)", async () => {
		const broken = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/v1.0/oauth2/accessToken") {
					return Response.json({ accessToken: "t", expireIn: 7200 });
				}
				return new Response("boom", { status: 500 });
			},
		});
		const restore = await installFetchOverride(broken.hostname, broken.port);
		try {
			const channel = new DingTalkChannel();
			channel.setAccountId("ops");
			channel.setConfig(makeDingTalkConfig());

			const inbound = makeMessage("hi", "conv-media-routing-2");
			const session = makeSession("/tmp/media-routing-2.jsonl", "conv-media-routing-2");
			const submit = (
				handlers?: Parameters<typeof channel.streamCard>[3],
			): ReturnType<typeof bridge.forwardWithMeta> => bridge.forwardWithMeta(inbound, session, handlers);

			const outbound = await channel.streamCard(
				inbound,
				session,
				{ accountId: "ops", agentName: null, dapiCalls: 0 },
				submit,
			);
			expect(outbound).toBeNull();
		} finally {
			restore();
			broken.stop(true);
		}
	});
});
