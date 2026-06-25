/**
 * Inbound image attachment pipeline tests.
 *
 * Verifies that:
 * 1. MIME sniffing from magic bytes works correctly
 * 2. Image attachments are forwarded as ImageContent[] in the RPC prompt
 * 3. Non-image attachments produce text descriptions without images
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge } from "../src/agent-bridge";
import { sniffMimeFromBytes } from "../src/channels/dingtalk-media";
import type { InboundAttachment, InboundMessage, SessionRecord } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// MIME Sniffing
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
			0x52, 0x49, 0x46, 0x46, // RIFF
			0x00, 0x00, 0x00, 0x00, // size
			0x57, 0x45, 0x42, 0x50, // WEBP
		]);
		expect(sniffMimeFromBytes(webp)).toBe("image/webp");
	});

	test("detects PDF from magic bytes", () => {
		const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
		expect(sniffMimeFromBytes(pdf)).toBe("application/pdf");
	});

	test("detects MP4 from ftyp box", () => {
		const mp4 = new Uint8Array([
			0x00, 0x00, 0x00, 0x20, // box size
			0x66, 0x74, 0x79, 0x70, // ftyp
			0x69, 0x73, 0x6f, 0x6d, // isom
		]);
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

// ═══════════════════════════════════════════════════════════════════════
// Bridge image forwarding
// ═══════════════════════════════════════════════════════════════════════

/**
 * Fake RPC that records the full prompt frame (including images) to a log.
 */
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
    // Log the full frame including images array
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

async function createImageAwareRpc(): Promise<{
	path: string;
	logPath: string;
	readLog: () => Promise<Array<{ type: string; message: string; images: unknown; imageCount: number }>>;
	cleanup: () => Promise<void>;
}> {
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

function makeSession(sessionPath: string, conversationId: string): SessionRecord {
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

			const result = await bridge.forwardWithMeta(msg, makeSession("/tmp/s.jsonl", "conv-img"));
			expect(result).not.toBeNull();

			const log = await fake.readLog();
			expect(log).toHaveLength(1);
			expect(log[0].imageCount).toBe(1);
			expect(log[0].images).toBeArray();
			const images = log[0].images as Array<{ type: string; data: string; mimeType: string }>;
			expect(images[0].type).toBe("image");
			expect(images[0].mimeType).toBe("image/jpeg");
			// data should be base64-encoded
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

			await bridge.forwardWithMeta(msg, makeSession("/tmp/s.jsonl", "conv-mixed"));

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

			await bridge.forwardWithMeta(msg, makeSession("/tmp/s.jsonl", "conv-text"));

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

			await bridge.forwardWithMeta(msg, makeSession("/tmp/s.jsonl", "conv-file"));

			const log = await fake.readLog();
			expect(log).toHaveLength(1);
			expect(log[0].imageCount).toBe(0);
			expect(log[0].images).toBeNull();
			// PDF attachment should be described (fake 8-byte buffer has no extractable text)
			expect(log[0].message).toContain("PDF");
			expect(log[0].message).toContain("report.pdf");
		} finally {
			bridge.stop();
			await fake.cleanup();
		}
	});
});
