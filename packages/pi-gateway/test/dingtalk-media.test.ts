/**
 * DingTalk media — extraction (image/video/audio/document markdown
 * parsing) + end-to-end streamCard media routing pipeline +
 * inbound image attachment pipeline.
 *
 * Merged:
 *   - dingtalk-video-extract.test.ts
 *   - dingtalk-audio-document-extract.test.ts
 *   - dingtalk-stream-card-media-routing.test.ts
 *   - inbound-image-pipeline.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import { sniffMimeFromBytes } from "../src/channels/dingtalk-media";
import {
	extractLocalFileAudios,
	extractLocalFileDocuments,
	extractLocalFileImages,
	extractLocalFileVideos,
	extractRemoteUrlAudios,
	extractRemoteUrlDocuments,
	extractRemoteUrlImages,
	extractRemoteUrlVideos,
	stripImageDirectives,
	stripNonImageMediaDirectives,
	stripVideoDirectives,
} from "../src/channels/dingtalk";
import type { DingTalkConfig, InboundAttachment, InboundMessage, SessionRecord } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Video extraction (was: dingtalk-video-extract.test.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("extractLocalFileVideos", () => {
	test("matches absolute path with .mp4 extension", () => {
		const text = "Here is the video: ![episode_85](/tmp/vid-085.mp4)";
		const result = extractLocalFileVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.path).toBe("/tmp/vid-085.mp4");
		expect(result[0]?.alt).toBe("episode_85");
	});

	test("matches file:// URI with .mp4 extension", () => {
		const text = "![demo](file:///tmp/demo.mp4)";
		const result = extractLocalFileVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.path).toBe("/tmp/demo.mp4");
		expect(result[0]?.alt).toBe("demo");
	});

	test("matches .mov, .webm, .avi, .mkv extensions", () => {
		const text = ["![a](/tmp/a.mov)", "![b](/tmp/b.webm)", "![c](/tmp/c.avi)", "![d](/tmp/d.mkv)"].join("\n");
		const result = extractLocalFileVideos(text);
		expect(result).toHaveLength(4);
		expect(result.map(v => v.path)).toEqual(["/tmp/a.mov", "/tmp/b.webm", "/tmp/c.avi", "/tmp/d.mkv"]);
	});

	test("does NOT match image extensions (png, jpg, etc.)", () => {
		const text = "![img](/tmp/screenshot.png) and ![vid](/tmp/clip.mp4)";
		const videos = extractLocalFileVideos(text);
		expect(videos).toHaveLength(1);
		expect(videos[0]?.path).toBe("/tmp/clip.mp4");
	});

	test("returns empty for text with no video markdown", () => {
		expect(extractLocalFileVideos("just plain text")).toEqual([]);
	});
});

describe("extractRemoteUrlVideos", () => {
	test("matches https URL with .mp4 extension", () => {
		const text = "![clip](https://example.com/video.mp4)";
		const result = extractRemoteUrlVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.url).toBe("https://example.com/video.mp4");
		expect(result[0]?.alt).toBe("clip");
	});

	test("matches URL with query string", () => {
		const text = "![v](https://cdn.example.com/vid.mp4?token=abc&expires=123)";
		const result = extractRemoteUrlVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.url).toBe("https://cdn.example.com/vid.mp4?token=abc&expires=123");
	});

	test("matches http:// URLs", () => {
		const text = "![v](http://example.com/clip.webm)";
		const result = extractRemoteUrlVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.url).toBe("http://example.com/clip.webm");
	});

	test("does NOT match image URLs (png, jpg, etc.)", () => {
		const text = "![img](https://example.com/pic.png) and ![vid](https://example.com/clip.mp4)";
		const videos = extractRemoteUrlVideos(text);
		expect(videos).toHaveLength(1);
		expect(videos[0]?.url).toBe("https://example.com/clip.mp4");
	});

	test("does NOT match non-video, non-image URLs", () => {
		const text = "![link](https://example.com/page.html)";
		expect(extractRemoteUrlVideos(text)).toEqual([]);
	});
});

describe("stripVideoDirectives", () => {
	test("removes local file video markdown", () => {
		const text = "Before\n![vid](/tmp/clip.mp4)\nAfter";
		expect(stripVideoDirectives(text)).toBe("Before\n\nAfter");
	});

	test("removes remote URL video markdown", () => {
		const text = "Before\n![vid](https://example.com/clip.mp4)\nAfter";
		expect(stripVideoDirectives(text)).toBe("Before\n\nAfter");
	});

	test("preserves image markdown", () => {
		const text = "![img](/tmp/pic.png)\n![vid](/tmp/clip.mp4)";
		const stripped = stripVideoDirectives(text);
		expect(stripped).toBe("![img](/tmp/pic.png)");
	});

	test("collapses 3+ blank lines after removal", () => {
		const text = "A\n\n![vid](/tmp/clip.mp4)\n\n\n\nB";
		expect(stripVideoDirectives(text)).toBe("A\n\nB");
	});

	test("handles empty string", () => {
		expect(stripVideoDirectives("")).toBe("");
	});
});

describe("video/image pipeline non-interference", () => {
	test("stripping videos first prevents image extractor from grabbing video URLs", () => {
		const text = ["![image](https://example.com/pic.png)", "![video](https://example.com/clip.mp4)"].join("\n");
		const textWithoutVideos = stripVideoDirectives(text);
		const images = extractRemoteUrlImages(textWithoutVideos);
		expect(images).toHaveLength(1);
		expect(images[0]?.url).toBe("https://example.com/pic.png");
		const videos = extractRemoteUrlVideos(text);
		expect(videos).toHaveLength(1);
		expect(videos[0]?.url).toBe("https://example.com/clip.mp4");
	});

	test("local video and local image in same text are separated correctly", () => {
		const text = "![img](/tmp/screenshot.png)\n![vid](/tmp/clip.mp4)";
		const videos = extractLocalFileVideos(text);
		const textWithoutVideos = stripVideoDirectives(text);
		const images = extractLocalFileImages(textWithoutVideos);
		expect(videos).toHaveLength(1);
		expect(videos[0]?.path).toBe("/tmp/clip.mp4");
		expect(images).toHaveLength(1);
		expect(images[0]?.path).toBe("/tmp/screenshot.png");
	});

	test("mixed content: image stays in card, video goes standalone", () => {
		const text = [
			"Here's the analysis:",
			"![chart](/tmp/chart.png)",
			"",
			"And the recording:",
			"![recording](/tmp/session.mp4)",
			"",
			"Done.",
		].join("\n");

		const videos = extractLocalFileVideos(text);
		const textWithoutVideos = stripVideoDirectives(text);
		const images = extractLocalFileImages(textWithoutVideos);
		const finalText = stripImageDirectives(textWithoutVideos);

		expect(videos).toHaveLength(1);
		expect(videos[0]?.path).toBe("/tmp/session.mp4");
		expect(images).toHaveLength(1);
		expect(images[0]?.path).toBe("/tmp/chart.png");
		expect(finalText).toContain("Here's the analysis:");
		expect(finalText).toContain("And the recording:");
		expect(finalText).toContain("Done.");
		expect(finalText).not.toContain("chart.png");
		expect(finalText).not.toContain("session.mp4");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Audio + document extraction (was: dingtalk-audio-document-extract.test.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("extractLocalFileAudios", () => {
	test("matches absolute path with .mp3 extension", () => {
		const text = "Voice memo: ![memo](/tmp/voice-001.mp3)";
		const result = extractLocalFileAudios(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.path).toBe("/tmp/voice-001.mp3");
		expect(result[0]?.alt).toBe("memo");
	});

	test("matches file:// URI for any audio extension", () => {
		const text = [
			"![a](file:///tmp/a.amr)",
			"![b](file:///tmp/b.mp3)",
			"![c](file:///tmp/c.wav)",
			"![d](file:///tmp/d.ogg)",
		].join("\n");
		const result = extractLocalFileAudios(text);
		expect(result).toHaveLength(4);
		expect(result.map(a => a.path)).toEqual(["/tmp/a.amr", "/tmp/b.mp3", "/tmp/c.wav", "/tmp/d.ogg"]);
	});

	test("does NOT match image or video extensions", () => {
		const text = "![img](/tmp/a.png) and ![vid](/tmp/b.mp4) and ![aud](/tmp/c.mp3)";
		const audios = extractLocalFileAudios(text);
		expect(audios).toHaveLength(1);
		expect(audios[0]?.path).toBe("/tmp/c.mp3");
	});
});

describe("extractRemoteUrlAudios", () => {
	test("matches https URL with audio extension", () => {
		const text = "![recording](https://example.com/rec.mp3)";
		const result = extractRemoteUrlAudios(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.url).toBe("https://example.com/rec.mp3");
		expect(result[0]?.alt).toBe("recording");
	});

	test("does NOT match image or video URLs", () => {
		const text = "![img](https://example.com/a.png) and ![vid](https://example.com/b.mp4)";
		expect(extractRemoteUrlAudios(text)).toEqual([]);
	});
});

describe("extractLocalFileDocuments", () => {
	test("matches absolute path with .pdf extension", () => {
		const text = "Report: ![q4](/tmp/q4.pdf)";
		const result = extractLocalFileDocuments(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.path).toBe("/tmp/q4.pdf");
		expect(result[0]?.alt).toBe("q4");
	});

	test("matches .docx / .xlsx / .pptx", () => {
		const text = ["![a](/tmp/a.docx)", "![b](/tmp/b.xlsx)", "![c](/tmp/c.pptx)"].join("\n");
		const result = extractLocalFileDocuments(text);
		expect(result).toHaveLength(3);
	});

	test("does NOT match image / video / audio extensions", () => {
		const text = "![img](/tmp/a.png) ![vid](/tmp/b.mp4) ![aud](/tmp/c.mp3) ![doc](/tmp/d.pdf)";
		const docs = extractLocalFileDocuments(text);
		expect(docs).toHaveLength(1);
		expect(docs[0]?.path).toBe("/tmp/d.pdf");
	});
});

describe("extractRemoteUrlDocuments", () => {
	test("matches https URL with .pdf extension", () => {
		const text = "![report](https://example.com/q4.pdf)";
		const result = extractRemoteUrlDocuments(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.url).toBe("https://example.com/q4.pdf");
		expect(result[0]?.alt).toBe("report");
	});

	test("does NOT match image / video / audio URLs", () => {
		const text =
			"![img](https://example.com/a.png) ![vid](https://example.com/b.mp4) ![aud](https://example.com/c.mp3) ![doc](https://example.com/d.pdf)";
		const docs = extractRemoteUrlDocuments(text);
		expect(docs).toHaveLength(1);
		expect(docs[0]?.url).toBe("https://example.com/d.pdf");
	});
});

describe("stripNonImageMediaDirectives", () => {
	test("removes audio and document markdown (keeps images and video lines)", () => {
		const text = [
			"![img](/tmp/pic.png)",
			"![aud](/tmp/voice.mp3)",
			"![vid](/tmp/clip.mp4)",
			"![doc](/tmp/q4.pdf)",
		].join("\n");
		const stripped = stripNonImageMediaDirectives(text);
		// Strips audio and document but leaves image + video intact.
		expect(stripped).toContain("![img](/tmp/pic.png)");
		expect(stripped).toContain("![vid](/tmp/clip.mp4)");
		expect(stripped).not.toContain("voice.mp3");
		expect(stripped).not.toContain("q4.pdf");
	});

	test("preserves remote image URLs and removes audio", () => {
		const text = "![img](https://example.com/pic.png) and ![aud](https://example.com/voice.mp3)";
		const stripped = stripNonImageMediaDirectives(text);
		expect(stripped).toContain("![img](https://example.com/pic.png)");
		expect(stripped).not.toContain("voice.mp3");
	});

	test("removes audio and document, leaves video if present", () => {
		const text = "![aud](/tmp/voice.mp3)\n![vid](/tmp/clip.mp4)\n![doc](/tmp/q4.pdf)";
		const stripped = stripNonImageMediaDirectives(text);
		expect(stripped).toContain("![vid](/tmp/clip.mp4)");
		expect(stripped).not.toContain("voice.mp3");
		expect(stripped).not.toContain("q4.pdf");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// streamCard media routing pipeline (e2e, fake DingTalk server)
// ═══════════════════════════════════════════════════════════════════════
//
// The card body + standalone message pipeline must, for every media
// token in agent reply text, pick the right deliverable:
//   - image (supported)        → in-card type-3 block
//   - video (supported)        → standalone sampleVideo message
//   - audio (supported)        → standalone sampleAudio message
//   - document (supported)     → standalone sampleFile message
//   - unsupported (any kind)   → clickable fallback link in the answer

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

interface MediaRpc {
	path: string;
	cleanup: () => Promise<void>;
}

async function createMediaFakeRpcBinary(): Promise<MediaRpc> {
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

interface MediaCall {
	method: string;
	path: string;
	body: unknown;
	contentType: string | null;
}

interface MediaFakeServer {
	host: string;
	port: number;
	calls: MediaCall[];
	stop: () => void;
}

async function startMediaFakeDingTalkServer(): Promise<MediaFakeServer> {
	const calls: MediaCall[] = [];
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

			if (url.pathname === "/v1.0/oauth2/accessToken") {
				return Response.json({ accessToken: "test-token", expireIn: 7200 });
			}
			if (url.pathname === "/gettoken") {
				return Response.json({ errcode: 0, access_token: "test-oapi-token" });
			}
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
			if (url.pathname === "/media/upload") {
				return Response.json({ errcode: 0, media_id: `media-${calls.length}` });
			}
			if (
				url.pathname === "/v1.0/robot/oToMessages/batchSend" ||
				url.pathname === "/v1.0/robot/groupMessages/send"
			) {
				return Response.json({});
			}
			if (url.pathname === "/__remote_image") {
				const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
				return new Response(png, { headers: { "Content-Type": "image/png" } });
			}
			if (url.pathname === "/voice.mp3") {
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

function makeMediaMessage(text: string, conversationId: string): InboundMessage {
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

function makeMediaSession(sessionPath: string, conversationId: string): SessionRecord {
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

function makeMediaDingTalkConfig(): DingTalkConfig {
	return {
		enabled: true,
		appKey: "test-key",
		appSecret: "test-secret",
		robotCode: "test-robot",
	};
}

async function installMediaFetchOverride(host: string, port: number): Promise<() => void> {
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
			rewritten = `${base}/${url.slice("https://example.invalid/".length)}`;
		}
		return realFetch(rewritten, init);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = realFetch;
	};
}

async function precreateLocalMediaFiles(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-media-routing-files-"));
	const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
	const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
	const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
	for (const [name, bytes] of [
		["chart.jpg", pngBytes],
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

function rewriteMediaReplyPaths(reply: string, dir: string): string {
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
	let rpc: MediaRpc;
	let server: MediaFakeServer;
	let restoreFetch: () => void;
	let files: { dir: string; cleanup: () => Promise<void> };
	let bridge: AgentBridge;

	beforeEach(async () => {
		rpc = await createMediaFakeRpcBinary();
		server = await startMediaFakeDingTalkServer();
		restoreFetch = await installMediaFetchOverride(server.host, server.port);
		files = await precreateLocalMediaFiles();
		await fs.writeFile(
			rpc.path,
			FAKE_RPC_SCRIPT.replace(
				JSON.stringify(REPLY_WITH_MIXED_MEDIA),
				JSON.stringify(rewriteMediaReplyPaths(REPLY_WITH_MIXED_MEDIA, files.dir)),
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
		channel.setConfig(makeMediaDingTalkConfig());

		const inbound = makeMediaMessage("analyze", "conv-media-routing-1");
		const session = makeMediaSession("/tmp/media-routing-1.jsonl", "conv-media-routing-1");

		const submit = (
			handlers?: Parameters<typeof channel.streamCard>[3],
		): ReturnType<typeof bridge.forwardWithMeta> => bridge.forwardWithMeta(inbound, session, handlers);

		const outbound = await channel.streamCard(
			inbound,
			session,
			{ accountId: "ops", agentName: "ops-bot", dapiCalls: 0 },
			submit,
		);

		expect(outbound).not.toBeNull();

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

		const finishedMap = (
			finishPut as { body: { cardData: { cardParamMap: { content: string; blockList: string } } } }
		).body.cardData.cardParamMap;
		const cardContent = finishedMap.content;
		expect(cardContent).toContain("logo.webp");
		expect(cardContent).toContain("格式不支持");
		expect(cardContent).not.toContain("![chart]");
		expect(cardContent).not.toContain("![voice memo]");
		expect(cardContent).not.toContain("![quarterly report]");
		expect(cardContent).not.toContain("![screen recording]");
		expect(cardContent).not.toContain("![svg logo]");

		const blockList = JSON.parse(finishedMap.blockList) as Array<{
			type: number;
			mediaId?: string;
			text?: string;
		}>;
		const imageBlocks = blockList.filter(b => b.type === 3);
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0].text).toBe("chart");

		const uploads = server.calls.filter(c => c.path === "/media/upload");
		expect(uploads.length).toBe(4);

		const standaloneSends = server.calls.filter(
			c => c.path === "/v1.0/robot/oToMessages/batchSend" || c.path === "/v1.0/robot/groupMessages/send",
		);
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

		const fileBody = byMsgKey.get("sampleFile")?.sample as { msgParam: string };
		const fileParam = JSON.parse(fileBody.msgParam);
		expect(fileParam.fileName).toBe("q4.pdf");
		expect(fileParam.fileType).toBe("pdf");
		expect(typeof fileParam.mediaId).toBe("string");

		const audioBody = byMsgKey.get("sampleAudio")?.sample as { msgParam: string };
		const audioParam = JSON.parse(audioBody.msgParam);
		expect(typeof audioParam.mediaId).toBe("string");
		expect(typeof audioParam.duration).toBe("string");

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
		const restore = await installMediaFetchOverride(broken.hostname, broken.port);
		try {
			const channel = new DingTalkChannel();
			channel.setAccountId("ops");
			channel.setConfig(makeMediaDingTalkConfig());

			const inbound = makeMediaMessage("hi", "conv-media-routing-2");
			const session = makeMediaSession("/tmp/media-routing-2.jsonl", "conv-media-routing-2");
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

// ═══════════════════════════════════════════════════════════════════════
// Inbound image attachment pipeline
//
// Verifies that:
//  1. MIME sniffing from magic bytes works correctly
//  2. Image attachments are forwarded as ImageContent[] in the RPC prompt
//  3. Non-image attachments produce text descriptions without images
// ═══════════════════════════════════════════════════════════════════════

describe("sniffMimeFromBytes", () => {
	test("detects PNG from magic bytes", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(sniffMimeFromBytes(png)).toBe("image/png");
	});

	test("detects JPEG from magic bytes", () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
		expect(sniffMimeFromBytes(jpeg)).toBe("image/jpeg");
	});

	test("detects GIF from magic bytes", () => {
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
		expect(sniffMimeFromBytes(gif)).toBe("image/gif");
	});

	test("detects WebP from magic bytes", () => {
		const webp = new Uint8Array([
			0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
		]);
		expect(sniffMimeFromBytes(webp)).toBe("image/webp");
	});

	test("detects PDF from magic bytes", () => {
		const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
		expect(sniffMimeFromBytes(pdf)).toBe("application/pdf");
	});

	test("detects MP4 from ftyp box", () => {
		const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
		expect(sniffMimeFromBytes(mp4)).toBe("video/mp4");
	});

	test("detects MP3 from sync word", () => {
		const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
		expect(sniffMimeFromBytes(mp3)).toBe("audio/mpeg");
	});

	test("detects MP3 from ID3 tag", () => {
		const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
		expect(sniffMimeFromBytes(id3)).toBe("audio/mpeg");
	});

	test("returns undefined for unknown bytes", () => {
		const unknown = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
		expect(sniffMimeFromBytes(unknown)).toBeUndefined();
	});

	test("returns undefined for empty buffer", () => {
		expect(sniffMimeFromBytes(new Uint8Array([]))).toBeUndefined();
	});

	test("returns undefined for buffer shorter than 4 bytes", () => {
		expect(sniffMimeFromBytes(new Uint8Array([0x89, 0x50]))).toBeUndefined();
	});
});

const IMAGE_AWARE_FAKE_SCRIPT = `#!/usr/bin/env bun
import * as fs from "node:fs";
const logPath = process.env.IMAGE_RPC_LOG;
function log(entry) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    log({
      type: "prompt",
      message: frame.message,
      images: frame.images ?? null,
      imageCount: frame.images ? frame.images.length : 0,
    });
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "received" }] } });
      emit({ type: "agent_end" });
    }, 0);
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

interface ImageRpcHarness {
	path: string;
	logPath: string;
	readLog: () => Promise<Array<{ type: string; message: string; images: unknown; imageCount: number }>>;
	cleanup: () => Promise<void>;
}

async function createImageAwareRpc(): Promise<ImageRpcHarness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-image-rpc-"));
	const scriptPath = path.join(dir, "fake-rpc-image");
	const logPath = path.join(dir, "image-rpc.log");
	await Bun.write(scriptPath, IMAGE_AWARE_FAKE_SCRIPT);
	await fs.chmod(scriptPath, 0o755);
	Bun.env.IMAGE_RPC_LOG = logPath;
	return {
		path: scriptPath,
		logPath,
		readLog: async () => {
			try {
				const text = await fs.readFile(logPath, "utf8");
				return text
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line));
			} catch {
				return [];
			}
		},
		cleanup: async () => {
			Bun.env.IMAGE_RPC_LOG = "";
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function makeImagePipelineSession(sessionPath: string, conversationId: string): SessionRecord {
	return {
		id: conversationId,
		channelId: "dingtalk",
		accountId: "ops",
		userId: "user",
		conversationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: sessionPath,
		status: "active",
	};
}

function makeImageAttachment(overrides?: Partial<InboundAttachment>): InboundAttachment {
	// Minimal valid JPEG: FF D8 FF E0
	const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
	return {
		kind: "image",
		data: jpegBytes,
		mimeType: "image/jpeg",
		filename: "photo.jpg",
		size: jpegBytes.byteLength,
		...overrides,
	};
}

describe("AgentBridge image attachment forwarding", () => {
	test("forwards image attachments as ImageContent[] in the RPC prompt", async () => {
		const fake = await createImageAwareRpc();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();

			const msg: InboundMessage = {
				channelId: "dingtalk",
				accountId: "ops",
				userId: "user1",
				conversationId: "conv-img",
				isGroup: false,
				content: { type: "image", url: "downloadCode:abc123", filename: "photo.jpg" },
				timestamp: new Date(),
				attachments: [makeImageAttachment()],
			};

			const result = await bridge.forwardWithMeta(
				msg,
				makeImagePipelineSession("/tmp/s.jsonl", "conv-img"),
			);
			expect(result).not.toBeNull();

			const log = await fake.readLog();
			expect(log).toHaveLength(1);
			expect(log[0].imageCount).toBe(1);
			expect(log[0].images).toBeArray();
			const images = log[0].images as Array<{ type: string; data: string; mimeType: string }>;
			expect(images[0].type).toBe("image");
			expect(images[0].mimeType).toBe("image/jpeg");
			expect(images[0].data).toBe(Buffer.from(makeImageAttachment().data).toString("base64"));
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("text message with image attachment sends both text and images", async () => {
		const fake = await createImageAwareRpc();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();

			const msg: InboundMessage = {
				channelId: "dingtalk",
				accountId: "ops",
				userId: "user1",
				conversationId: "conv-mixed",
				isGroup: false,
				content: { type: "text", text: "看看这张图" },
				timestamp: new Date(),
				attachments: [makeImageAttachment()],
			};

			await bridge.forwardWithMeta(msg, makeImagePipelineSession("/tmp/s.jsonl", "conv-mixed"));

			const log = await fake.readLog();
			expect(log).toHaveLength(1);
			expect(log[0].message).toBe("看看这张图");
			expect(log[0].imageCount).toBe(1);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("text message without attachments sends no images field", async () => {
		const fake = await createImageAwareRpc();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();

			const msg: InboundMessage = {
				channelId: "dingtalk",
				accountId: "ops",
				userId: "user1",
				conversationId: "conv-text",
				isGroup: false,
				content: { type: "text", text: "hello" },
				timestamp: new Date(),
			};

			await bridge.forwardWithMeta(msg, makeImagePipelineSession("/tmp/s.jsonl", "conv-text"));

			const log = await fake.readLog();
			expect(log).toHaveLength(1);
			expect(log[0].message).toBe("hello");
			expect(log[0].images).toBeNull();
			expect(log[0].imageCount).toBe(0);
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});

	test("non-image attachment produces text description without images", async () => {
		const fake = await createImageAwareRpc();
		const bridge = new AgentBridge({ ompPath: fake.path, timeoutMs: 2_000 });
		try {
			await bridge.start();

			const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
			const msg: InboundMessage = {
				channelId: "dingtalk",
				accountId: "ops",
				userId: "user1",
				conversationId: "conv-file",
				isGroup: false,
				content: { type: "file", url: "downloadCode:xyz", filename: "report.pdf", size: 1024 },
				timestamp: new Date(),
				attachments: [
					{
						kind: "file",
						data: pdfBytes,
						mimeType: "application/pdf",
						filename: "report.pdf",
						size: pdfBytes.byteLength,
					},
				],
			};

			await bridge.forwardWithMeta(msg, makeImagePipelineSession("/tmp/s.jsonl", "conv-file"));

			const log = await fake.readLog();
			expect(log).toHaveLength(1);
			expect(log[0].imageCount).toBe(0);
			expect(log[0].images).toBeNull();
			expect(log[0].message).toContain("PDF");
			expect(log[0].message).toContain("report.pdf");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});
});
