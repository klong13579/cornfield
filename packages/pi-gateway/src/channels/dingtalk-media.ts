/**
 * DingTalk media handling — download/upload for images, files, and voice messages.
 *
 * Uses the DingTalk OAPI (old API) for media operations:
 * - Download: GET /media/download with access_token param
 * - Upload: POST /media/upload with multipart/form-data
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { logger } from "@oh-my-pi/pi-utils";
import type { DingTalkConfig, InboundAttachment } from "../types";
import { getAccessToken } from "./dingtalk-card";

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const DINGTALK_OAPI = "https://oapi.dingtalk.com";
const DINGTALK_API = "https://api.dingtalk.com";

/** Maximum inbound attachment size (100 MB).
 * Aligned with `MAX_VIDEO_DOWNLOAD_BYTES` — the 20 MB figure that used to
 * live here was a misread of DingTalk's *upload* (sender-side) limit, not a
 * download (receiver-side) one. 100 MB comfortably holds typical work
 * attachments (PPTX decks, code review bundles, recorded screen shares) and
 * matches the video budget. Anything still over the cap is returned to the
 * bridge as a `status: "too_large"` stub rather than silently dropped. */
const MAX_INBOUND_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Maximum video download size (100 MB). Videos are larger than images/files.
 * and we only need them temporarily for frame extraction before deleting. */
const MAX_VIDEO_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** Video file extensions — DingTalk sends videos as msgtype="file". */
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"];

/** Maximum number of frames to extract from a video. */
const MAX_VIDEO_FRAMES = 8;

/** Target width for extracted frames (height auto-scales to preserve aspect ratio). */
const VIDEO_FRAME_WIDTH = 1024;

// ═══════════════════════════════════════════════════════════════════════
// MIME Sniffing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sniff MIME type from magic bytes (file header).
 *
 * Returns undefined when no known signature matches — callers fall back
 * to the platform-declared MIME or Content-Type header.
 */
export function sniffMimeFromBytes(buffer: Uint8Array): string | undefined {
	if (buffer.length < 4) return undefined;

	// PNG: 89 50 4E 47
	if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
		return "image/png";
	}
	// JPEG: FF D8 FF
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "image/jpeg";
	}
	// GIF: 47 49 46 38
	if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
		return "image/gif";
	}
	// WebP: 52 49 46 46 ... 57 45 42 50
	if (
		buffer.length >= 12 &&
		buffer[0] === 0x52 &&
		buffer[1] === 0x49 &&
		buffer[2] === 0x46 &&
		buffer[3] === 0x46 &&
		buffer[8] === 0x57 &&
		buffer[9] === 0x45 &&
		buffer[10] === 0x42 &&
		buffer[11] === 0x50
	) {
		return "image/webp";
	}
	// BMP: 42 4D
	if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
		return "image/bmp";
	}
	// PDF: 25 50 44 46
	if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
		return "application/pdf";
	}
	// ZIP (also OOXML: docx/xlsx/pptx): 50 4B 03 04
	if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
		return "application/zip";
	}
	// MP4: 00 00 00 XX 66 74 79 70
	if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
		return "video/mp4";
	}
	// MP3: FF FB / FF F3 / FF F2 / ID3
	if (
		(buffer[0] === 0xff && (buffer[1] === 0xfb || buffer[1] === 0xf3 || buffer[1] === 0xf2)) ||
		(buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33)
	) {
		return "audio/mpeg";
	}
	// WAV: 52 49 46 46 ... 57 41 56 45
	if (
		buffer.length >= 12 &&
		buffer[0] === 0x52 &&
		buffer[1] === 0x49 &&
		buffer[2] === 0x46 &&
		buffer[3] === 0x46 &&
		buffer[8] === 0x57 &&
		buffer[9] === 0x41 &&
		buffer[10] === 0x56 &&
		buffer[11] === 0x45
	) {
		return "audio/wav";
	}
	// OGG: 4F 67 67 53
	if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
		return "audio/ogg";
	}

	return undefined;
}

/**
 * Resolve the most trustworthy MIME type for a downloaded file.
 *
 * Priority: magic-byte sniff > platform-declared > Content-Type header > fallback.
 */
function resolveMimeType(buffer: Uint8Array, declared: string | undefined): string {
	const sniffed = sniffMimeFromBytes(buffer);
	if (sniffed) return sniffed;
	if (declared && declared !== "application/octet-stream") return declared;
	return declared ?? "application/octet-stream";
}
/**
 * Extract text content from a PDF buffer.
 *
 * Handles both uncompressed and FlateDecode-compressed streams.
 * Extracts text from Tj and TJ operators inside BT...ET blocks.
 * Returns empty string for scanned PDFs (image-only) or parse failures.
 */
export function extractPdfText(buffer: Uint8Array): string {
	try {
		const raw = Buffer.from(buffer).toString("latin1");
		const texts: string[] = [];

		// Find all stream...endstream blocks
		const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
		let match;
		while ((match = streamRegex.exec(raw)) !== null) {
			let streamData = match[1];

			// Try FlateDecode decompression
			try {
				const compressed = Buffer.from(streamData, "binary");
				streamData = zlib.inflateSync(compressed).toString("latin1");
			} catch {
				// Not compressed — use as-is
			}

			// Extract text from Tj operators: (text) Tj
			const tjRegex = /\(([^)]*)\)\s*Tj/g;
			let tjMatch;
			while ((tjMatch = tjRegex.exec(streamData)) !== null) {
				texts.push(decodePdfString(tjMatch[1]));
			}

			// Extract text from TJ arrays: [(text1) -10 (text2)] TJ
			const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
			let tjArrayMatch;
			while ((tjArrayMatch = tjArrayRegex.exec(streamData)) !== null) {
				const parts = tjArrayMatch[1].match(/\(([^)]*)\)/g);
				if (parts) {
					texts.push(parts.map(p => decodePdfString(p.slice(1, -1))).join(""));
				}
			}
		}

		const result = texts.join(" ").replace(/\s+/g, " ").trim();
		return result;
	} catch {
		return "";
	}
}

/** Decode PDF string escapes (e.g. \( \n \\ \r \t). */
function decodePdfString(s: string): string {
	return s
		.replaceAll("\\\\", "\\")
		.replaceAll("\\(", "(")
		.replaceAll("\\)", ")")
		.replaceAll("\\n", "\n")
		.replaceAll("\\r", "\r")
		.replaceAll("\\t", "\t");
}

/**
 * OOXML text-extraction helpers.
 *
 * PPTX is a zip archive whose slide text lives in `ppt/slides/slideN.xml`
 * as `<a:t>` runs. We shell out to `unzip` (the same approach as
 * ffmpeg/ffprobe in this file) to avoid dragging in a zip-parse dep.
 *
 * If `unzip` is unavailable (e.g. minimal Alpine CI image) or the buffer
 * isn't a valid zip, the function returns an empty string — the caller
 * (`prompt-extractor.classifyAttachment`) will fall back to saving the
 * raw file to disk, where the agent's own bash tool can extract it.
 */
const PPTX_SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/i;
const A_TEXT_RE = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;

function decodeXmlEntities(s: string): string {
	return s
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'");
}

/**
 * Extract concatenated slide text from a PPTX buffer.
 *
 * Returns text in slide order, each slide prefixed with `[Slide N]`.
 * Returns empty string on any failure (bad zip, missing `unzip`, no
 * slides, all slides empty) — never throws.
 */
export function extractPptxText(buffer: Uint8Array): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pptx-"));
	const pptxPath = path.join(dir, "inbound.pptx");
	try {
		fs.writeFileSync(pptxPath, Buffer.from(buffer));

		// Step 1: list entries. `unzip -Z1` prints one path per line.
		const listResult = Bun.spawnSync(["unzip", "-Z1", pptxPath], { stdout: "pipe", stderr: "pipe" });
		if (listResult.exitCode !== 0) {
			logger.warn("[DingTalk Media] unzip -Z1 failed for PPTX", {
				exitCode: listResult.exitCode,
				stderr: listResult.stderr.toString().trim().slice(0, 200),
			});
			return "";
		}
		const entries = new TextDecoder().decode(listResult.stdout).split("\n");
		const slideEntries = entries
			.map(e => e.trim())
			.filter(e => PPTX_SLIDE_RE.test(e))
			.sort((a, b) => {
				const na = Number(a.match(PPTX_SLIDE_RE)?.[1] ?? 0);
				const nb = Number(b.match(PPTX_SLIDE_RE)?.[1] ?? 0);
				return na - nb;
			});

		if (slideEntries.length === 0) {
			logger.warn("[DingTalk Media] PPTX has no slide entries", { totalEntries: entries.length });
			return "";
		}

		// Step 2: extract each slide and pull <a:t> runs.
		const slideBlocks: string[] = [];
		for (const entry of slideEntries) {
			const slideNum = entry.match(PPTX_SLIDE_RE)?.[1] ?? "?";
			const extractResult = Bun.spawnSync(["unzip", "-p", pptxPath, entry], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (extractResult.exitCode !== 0) {
				logger.warn("[DingTalk Media] unzip -p failed for slide", {
					entry,
					exitCode: extractResult.exitCode,
				});
				continue;
			}
			const xml = new TextDecoder().decode(extractResult.stdout);
			const runs: string[] = [];
			for (const m of xml.matchAll(A_TEXT_RE)) {
				const raw = m[1];
				if (!raw) continue;
				const decoded = decodeXmlEntities(raw).trim();
				if (decoded) runs.push(decoded);
			}
			const slideText = runs.join(" ").replace(/\s+/g, " ").trim();
			if (slideText) slideBlocks.push(`[Slide ${slideNum}]\n${slideText}`);
		}

		return slideBlocks.join("\n\n");
	} catch (err) {
		logger.warn("[DingTalk Media] extractPptxText threw", { error: String(err) });
		return "";
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/**
 * Get OAPI access token (for media download/upload).
 */
async function getOapiAccessToken(config: DingTalkConfig): Promise<string | null> {
	try {
		const resp = await fetch(`${DINGTALK_OAPI}/gettoken?appkey=${config.appKey}&appsecret=${config.appSecret}`, {
			method: "GET",
		});

		if (!resp.ok) return null;

		const data = (await resp.json()) as { errcode: number; access_token?: string; errmsg?: string };
		if (data.errcode === 0 && data.access_token) {
			return data.access_token;
		}
		return null;
	} catch (err) {
		logger.warn("[DingTalk Media] Failed to get OAPI token", { error: String(err) });
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Media Download
// ═══════════════════════════════════════════════════════════════════════

export interface DownloadedMedia {
	path: string;
	mimeType: string;
	originalName: string;
	size: number;
}

/**
 * Download a file from DingTalk using downloadCode.
 * Uses POST /v1.0/robot/messageFiles/download with { downloadCode, robotCode }
 * (matching DingTalk's official robot message file download API).
 */
async function downloadByDingtalkCode(downloadCode: string, config: DingTalkConfig): Promise<DownloadedMedia | null> {
	try {
		const token = await getAccessToken(config);
		if (!token) {
			logger.error("[DingTalk Media] No access token available for download");
			return null;
		}

		const robotCode = config.robotCode ?? config.appKey ?? "";
		if (!robotCode) {
			logger.error("[DingTalk Media] No robotCode/appKey available for download");
			return null;
		}

		// Step 1: Exchange downloadCode for a download URL
		const infoResp = await fetch(`${DINGTALK_API}/v1.0/robot/messageFiles/download`, {
			method: "POST",
			headers: {
				"x-acs-dingtalk-access-token": token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ downloadCode, robotCode }),
		});

		if (!infoResp.ok) {
			const errText = await infoResp.text().catch(() => "");
			logger.warn("[DingTalk Media] Failed to get file info", {
				status: infoResp.status,
				body: errText.slice(0, 500),
			});
			return null;
		}

		const fileInfo = (await infoResp.json()) as {
			downloadUrl?: string;
		};

		if (!fileInfo.downloadUrl) {
			logger.warn("[DingTalk Media] No download URL in file info response");
			return null;
		}

		// Step 2: Download the actual file
		const fileResp = await fetch(fileInfo.downloadUrl, { method: "GET" });
		if (!fileResp.ok) {
			logger.warn("[DingTalk Media] File download failed", { status: fileResp.status });
			return null;
		}

		const buffer = await fileResp.arrayBuffer();
		const contentType = fileResp.headers.get("content-type") ?? "application/octet-stream";
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dingtalk-"));
		const filePath = path.join(tmpDir, `inbound-${Date.now()}`);

		await fs.promises.writeFile(filePath, Buffer.from(buffer));

		logger.debug("[DingTalk Media] Downloaded file", {
			size: buffer.byteLength,
			contentType,
			path: filePath,
		});

		return {
			path: filePath,
			mimeType: contentType,
			originalName: `inbound-${Date.now()}`,
			size: buffer.byteLength,
		};
	} catch (err) {
		logger.error("[DingTalk Media] Download failed", { error: String(err) });
		return null;
	}
}

/**
 * Download image from direct URL.
 */
async function downloadByUrl(url: string): Promise<DownloadedMedia | null> {
	try {
		const resp = await fetch(url, { method: "GET" });
		if (!resp.ok) return null;

		const buffer = await resp.arrayBuffer();
		const contentType = resp.headers.get("content-type") ?? "image/jpeg";
		const ext = contentType.split("/").pop() ?? "jpg";
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dingtalk-"));
		const filePath = path.join(tmpDir, `image.${ext}`);

		await fs.promises.writeFile(filePath, Buffer.from(buffer));

		return {
			path: filePath,
			mimeType: contentType,
			originalName: `image.${ext}`,
			size: buffer.byteLength,
		};
	} catch (err) {
		logger.error("[DingTalk Media] URL download failed", { error: String(err) });
		return null;
	}
}

/**
 * Download media from a DingTalk message content URL or download code.
 */
export async function downloadMedia(url: string, config: DingTalkConfig): Promise<DownloadedMedia | null> {
	if (url.startsWith("downloadCode:")) {
		const code = url.slice("downloadCode:".length);
		return downloadByDingtalkCode(code, config);
	}

	if (url.startsWith("http://") || url.startsWith("https://")) {
		return downloadByUrl(url);
	}

	logger.warn("[DingTalk Media] Unknown URL format", { url: url.slice(0, 100) });
	return null;
}
/** Check if a filename has a video extension. */
function isVideoFile(filename: string | undefined): boolean {
	return !!filename && VIDEO_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

/**
 * Extract key frames from a video file using ffmpeg.
 *
 * Downloads the video to a temp file, uses ffprobe to get the duration,
 * then extracts up to `MAX_VIDEO_FRAMES` evenly-spaced frames as JPEG images
 * scaled to `VIDEO_FRAME_WIDTH` pixels wide (preserving aspect ratio).
 *
 * Returns an array of `InboundAttachment` entries with kind="image" and
 * mimeType="image/jpeg" — these flow through the existing image pipeline
 * and reach the agent as inline base64 images.
 *
 * Returns an empty array if ffmpeg/ffprobe is unavailable or fails.
 * The caller falls back to a text-only description in that case.
 */
async function extractVideoFrames(videoPath: string, filename: string): Promise<InboundAttachment[]> {
	// Probe duration with ffprobe
	let durationSec = 0;
	try {
		const probe = Bun.spawnSync([
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"csv=p=0",
			videoPath,
		]);
		if (probe.exitCode !== 0) {
			logger.warn("[DingTalk Media] ffprobe failed", { stderr: probe.stderr.toString().trim() });
			return [];
		}
		durationSec = parseFloat(probe.stdout.toString().trim());
		if (!Number.isFinite(durationSec) || durationSec <= 0) {
			logger.warn("[DingTalk Media] ffprobe returned invalid duration", {
				duration: probe.stdout.toString().trim(),
			});
			return [];
		}
	} catch (err) {
		logger.warn("[DingTalk Media] ffprobe not available", { error: String(err) });
		return [];
	}

	// Calculate frame timestamps: evenly spaced, avoiding the very start/end
	// (first/last frames are often black or title screens).
	const frameCount = Math.min(MAX_VIDEO_FRAMES, Math.max(1, Math.ceil(durationSec / 10)));
	const offset = durationSec / (frameCount + 1);
	const timestamps: number[] = [];
	for (let i = 1; i <= frameCount; i++) {
		timestamps.push(offset * i);
	}

	const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-video-frames-"));
	const frames: InboundAttachment[] = [];

	try {
		for (let i = 0; i < timestamps.length; i++) {
			const framePath = path.join(frameDir, `frame_${i}.jpg`);
			const ffmpeg = Bun.spawnSync([
				"ffmpeg",
				"-y",
				"-ss",
				timestamps[i].toFixed(2),
				"-i",
				videoPath,
				"-frames:v",
				"1",
				"-vf",
				`scale=${VIDEO_FRAME_WIDTH}:-1`,
				"-q:v",
				"2",
				framePath,
			]);
			if (ffmpeg.exitCode !== 0) {
				logger.warn("[DingTalk Media] ffmpeg frame extraction failed", {
					frame: i,
					timestamp: timestamps[i],
					stderr: ffmpeg.stderr.toString().trim().slice(0, 200),
				});
				continue;
			}

			const data = await fs.promises.readFile(framePath);
			if (data.byteLength === 0) continue;

			frames.push({
				kind: "image",
				data: new Uint8Array(data),
				mimeType: "image/jpeg",
				filename: `${filename}_frame${i}.jpg`,
				size: data.byteLength,
			});
		}
	} finally {
		// Clean up temp frame directory
		try {
			fs.rmSync(frameDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}

	logger.info("[DingTalk Media] Video frames extracted", {
		filename,
		duration: durationSec.toFixed(1),
		requested: timestamps.length,
		extracted: frames.length,
	});

	return frames;
}

/**
 * Download and resolve all media attachments from an inbound message.
 *
 * Downloads from `content.url` (the primary attachment) and
 * `msg.mediaUrls` (additional images, e.g. from richText messages).
 * Returns an array of `InboundAttachment` with raw bytes, sniffed MIME,
 * and size metadata. Returns an empty array for text-only messages or
 * when downloads fail (fail-soft: the message still reaches the agent as text).
 *
 * Video files (detected by extension) are downloaded to a temp file, then
 * key frames are extracted via ffmpeg and returned as image attachments.
 * If ffmpeg is unavailable or frame extraction fails, the video is
 * silently dropped — the bridge layer falls back to a text description.
 *
 * `customDownloader` is a test seam: when provided, replaces the default
 * `downloadOneAttachment` for non-video URLs. Production callers omit it;
 * integration tests use it to inject a fake downloader that materialises
 * placeholder files instead of dialing the real DingTalk OAPI.
 */
export async function resolveInboundAttachments(
	msg: { content: { type: string; url?: string; filename?: string }; mediaUrls?: string[] },
	config: DingTalkConfig,
	customDownloader?: (
		ref: string,
		kind: "image" | "voice" | "video" | "file",
	) => Promise<{ path: string; mimeType: string; originalName: string; size: number } | null>,
): Promise<InboundAttachment[]> {
	const { content } = msg;
	const results: InboundAttachment[] = [];

	// --- Video: download + extract key frames via ffmpeg ---
	if (content.url) {
		const kind = content.type as InboundAttachment["kind"];
		const filename = content.filename ?? "video";
		const isVideo = kind === "video" || isVideoFile(content.filename);

		if (isVideo) {
			const videoFrames = await downloadAndExtractVideoFrames(content.url, filename, config);
			results.push(...videoFrames);
			return results;
		}
	}

	// --- Non-video: collect all URLs to download ---
	const urls: Array<{ url: string; kind: InboundAttachment["kind"]; filename?: string }> = [];

	if (content.url) {
		const kind = content.type as InboundAttachment["kind"];
		if (kind === "image" || kind === "file" || kind === "voice") {
			urls.push({ url: content.url, kind, filename: content.filename });
		}
	}

	// Additional media URLs from richText messages
	if (msg.mediaUrls) {
		for (const url of msg.mediaUrls) {
			urls.push({ url, kind: "image" });
		}
	}

	for (const { url, kind, filename } of urls) {
		const att = customDownloader
			? await customDownloadOneAttachment(url, kind, filename, customDownloader)
			: await downloadOneAttachment(url, kind, config, filename);
		if (att) results.push(att);
	}

	return results;
}

/**
 * Adapter: convert a custom downloader's `DownloadedMedia` shape into the
 * `InboundAttachment` shape that the rest of the pipeline expects. Used
 * only when a test seam has injected a `customDownloader`.
 */
async function customDownloadOneAttachment(
	url: string,
	kind: InboundAttachment["kind"],
	filename: string | undefined,
	downloader: (
		ref: string,
		kind: "image" | "voice" | "video" | "file",
	) => Promise<{ path: string; mimeType: string; originalName: string; size: number } | null>,
): Promise<InboundAttachment | null> {
	const downloaded = await downloader(url, kind);
	if (!downloaded) return null;
	return {
		kind,
		path: downloaded.path,
		mimeType: downloaded.mimeType,
		filename: filename ?? downloaded.originalName,
		size: downloaded.size,
	};
}

/**
 * Download a video file, extract key frames with ffmpeg, then delete the video.
 * Returns image attachments (kind="image", mimeType="image/jpeg").
 * Returns an empty array if the download fails, the file is too large,
 * or ffmpeg/ffprobe is unavailable.
 */
async function downloadAndExtractVideoFrames(
	url: string,
	filename: string,
	config: DingTalkConfig,
): Promise<InboundAttachment[]> {
	let downloaded: DownloadedMedia | null;
	try {
		downloaded = await downloadMedia(url, config);
	} catch (err) {
		logger.warn("[DingTalk Media] Video download threw", { error: String(err) });
		return [];
	}

	if (!downloaded) {
		logger.warn("[DingTalk Media] Video download returned null", { url: url.slice(0, 100) });
		return [];
	}

	// Video gets a larger size limit than regular attachments
	if (downloaded.size > MAX_VIDEO_DOWNLOAD_BYTES) {
		logger.warn("[DingTalk Media] Video exceeds size limit, skipping frame extraction", {
			size: downloaded.size,
			limit: MAX_VIDEO_DOWNLOAD_BYTES,
			filename: downloaded.originalName,
		});
		cleanupDownloadedMedia(downloaded);
		return [];
	}

	try {
		const frames = await extractVideoFrames(downloaded.path, filename);
		return frames;
	} finally {
		// Always clean up the downloaded video temp file
		cleanupDownloadedMedia(downloaded);
	}
}

/** Download a single attachment URL and convert to InboundAttachment. */
async function downloadOneAttachment(
	url: string,
	kind: InboundAttachment["kind"],
	config: DingTalkConfig,
	filenameOverride?: string,
): Promise<InboundAttachment | null> {
	let downloaded: DownloadedMedia | null;
	try {
		downloaded = await downloadMedia(url, config);
	} catch (err) {
		logger.warn("[DingTalk Media] Attachment download threw", { error: String(err) });
		return null;
	}

	if (!downloaded) {
		logger.warn("[DingTalk Media] Attachment download returned null", { url: url.slice(0, 100) });
		return null;
	}

	try {
		return await makeInboundAttachment(downloaded, kind, filenameOverride);
	} catch (err) {
		logger.warn("[DingTalk Media] Failed to build inbound attachment", {
			path: downloaded.path,
			error: String(err),
		});
		return null;
	} finally {
		// Temp file always cleaned up — bytes are now in memory (or the
		// too_large stub was returned). Previously this only happened on
		// the too_large path; the success case leaked the temp dir.
		cleanupDownloadedMedia(downloaded);
	}
}

/**
 * Build an `InboundAttachment` from a downloaded `DownloadedMedia`.
 *
 * Size guard runs first: if the file exceeds `MAX_INBOUND_ATTACHMENT_BYTES`,
 * the bytes are intentionally NOT read — the function returns a metadata-only
 * stub with `status: "too_large"` so the bridge can surface the situation
 * to the agent (filename + size + mime) instead of silently dropping the
 * attachment. The temp file is the caller's responsibility to clean up.
 *
 * Exported so the too-large path is testable without a real download.
 */
export async function makeInboundAttachment(
	downloaded: DownloadedMedia,
	kind: InboundAttachment["kind"],
	filenameOverride?: string,
): Promise<InboundAttachment> {
	const filename = filenameOverride ?? downloaded.originalName;

	if (downloaded.size > MAX_INBOUND_ATTACHMENT_BYTES) {
		logger.warn("[DingTalk Media] Attachment exceeds size limit, returning too_large stub", {
			size: downloaded.size,
			limit: MAX_INBOUND_ATTACHMENT_BYTES,
			filename,
		});
		return {
			kind,
			data: new Uint8Array(0),
			mimeType: downloaded.mimeType,
			filename,
			size: downloaded.size,
			status: "too_large",
		};
	}

	const buffer = new Uint8Array(await fs.promises.readFile(downloaded.path));
	const mimeType = resolveMimeType(buffer, downloaded.mimeType);
	return {
		kind,
		data: buffer,
		mimeType,
		filename,
		size: buffer.byteLength,
	};
}

/**
 * Clean up a downloaded temp file and its parent directory.
 */
export function cleanupDownloadedMedia(media: DownloadedMedia): void {
	try {
		const dir = path.dirname(media.path);
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best effort
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Media Upload
// ═══════════════════════════════════════════════════════════════════════

export interface UploadResult {
	mediaId: string;
	url?: string;
}

/**
 * Upload a media file to DingTalk.
 */
export async function uploadMedia(
	filePath: string,
	mediaType: "image" | "file" | "voice" | "video",
	config: DingTalkConfig,
): Promise<UploadResult | null> {
	const token = await getOapiAccessToken(config);
	if (!token) {
		logger.error("[DingTalk Media] No OAPI token available for upload");
		return null;
	}

	try {
		const stat = await fs.promises.stat(filePath);
		const fileName = path.basename(filePath);
		const fileBlob = new Blob([await fs.promises.readFile(filePath)]);

		const formData = new FormData();
		formData.append("media", fileBlob, fileName);
		formData.append("type", mediaType);

		const resp = await fetch(`${DINGTALK_OAPI}/media/upload?access_token=${token}`, {
			method: "POST",
			body: formData,
		});

		if (!resp.ok) {
			const text = await resp.text();
			logger.warn("[DingTalk Media] Upload failed", { status: resp.status, body: text });
			return null;
		}

		const data = (await resp.json()) as { media_id?: string; errcode: number };
		if (data.errcode !== 0 || !data.media_id) {
			logger.warn("[DingTalk Media] Upload returned error", { errcode: data.errcode });
			return null;
		}

		logger.debug("[DingTalk Media] Uploaded file", {
			mediaId: data.media_id,
			fileName,
			size: stat.size,
		});

		return { mediaId: data.media_id };
	} catch (err) {
		logger.error("[DingTalk Media] Upload failed", { error: String(err) });
		return null;
	}
}
