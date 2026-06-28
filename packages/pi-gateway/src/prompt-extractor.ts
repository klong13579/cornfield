/**
 * PromptExtractor — converts an InboundMessage into a prompt the agent can consume.
 *
 * Extracted from AgentBridge to keep the bridge focused on orchestration.
 * The extractor owns:
 * - Attachment classification (image → inline, PDF → text extract, file → save to disk)
 * - Content type extraction (text/markdown/voice → plain text)
 * - Video detection (filename-based + content type)
 * - Placeholder fallback for unhandled content types
 *
 * Returns `{ text, images }` where `text` is the prompt string and `images`
 * is the list of inline images for vision-capable models.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { extractPdfText } from "./channels/dingtalk-media";
import type { InboundAttachment, InboundMessage } from "./types";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"];
const PDF_TEXT_LIMIT = 10_000;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Attachment classification result. */
type AttachmentResult = { images: ImageContent[]; texts: string[] };

/** Classify an attachment into inline images or text labels. */
async function classifyAttachment(att: InboundAttachment, cwd: string): Promise<AttachmentResult> {
	if (att.mimeType.startsWith("image/")) {
		return {
			images: [
				{
					type: "image",
					data: Buffer.from(att.data).toString("base64"),
					mimeType: att.mimeType,
				},
			],
			texts: [],
		};
	}
	if (att.mimeType === "application/pdf") {
		const name = att.filename ?? "document.pdf";
		const pdfText = extractPdfText(att.data);
		if (pdfText) {
			return { images: [], texts: [`[PDF: ${name}]\n\t\t\t\t\t\t${pdfText.slice(0, PDF_TEXT_LIMIT)}`] };
		}
		return {
			images: [],
			texts: [`[PDF: ${name} (${formatBytes(att.size)}) — scanned PDF, no extractable text]`],
		};
	}
	const savedPath = await saveAttachmentToDisk(att, cwd);
	if (savedPath) {
		return {
			images: [],
			texts: [`[file: ${savedPath} (${att.mimeType}, ${formatBytes(att.size)})]`],
		};
	}
	const name = att.filename ?? "file";
	return {
		images: [],
		texts: [`[${att.kind}: ${name} (${att.mimeType}, ${formatBytes(att.size)}) — failed to save to disk]`],
	};
}

async function saveAttachmentToDisk(att: InboundAttachment, cwd: string): Promise<string | null> {
	const filename = att.filename ?? "attachment";
	const safeName = filename.replace(/[/\\\0]/g, "_");
	const attachmentsDir = path.join(cwd, "attachments");

	try {
		await fs.mkdir(attachmentsDir, { recursive: true });
		const filePath = path.join(attachmentsDir, safeName);
		await fs.writeFile(filePath, att.data);
		logger.info("[PromptExtractor] Attachment saved to disk", {
			path: filePath,
			mimeType: att.mimeType,
			size: att.size,
		});
		return filePath;
	} catch (err) {
		logger.warn("[PromptExtractor] Failed to save attachment to disk", {
			filename: safeName,
			mimeType: att.mimeType,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** Extract the base text from a message's content, or empty string if none. */
function extractBaseText(msg: InboundMessage): string {
	const content = msg.content;
	if (content.type === "text") return content.text;
	if (content.type === "markdown") return content.markdown;
	if (content.type === "voice" && content.text) return content.text;
	return "";
}

/** Detect whether a message is a video by content type or filename extension. */
function isVideoMessage(msg: InboundMessage): boolean {
	if (msg.content.type === "video") return true;
	if (msg.content.type === "file") {
		const filename = (msg.content as { filename?: string }).filename;
		if (filename) {
			return VIDEO_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
		}
	}
	return false;
}

export class PromptExtractor {
	readonly #cwd: string;

	constructor(cwd: string = process.cwd()) {
		this.#cwd = cwd;
	}

	async extract(msg: InboundMessage): Promise<{ text: string; images: ImageContent[] }> {
		const images: ImageContent[] = [];
		const texts: string[] = [];

		if (msg.attachments) {
			for (const att of msg.attachments) {
				const result = await classifyAttachment(att, this.#cwd);
				images.push(...result.images);
				texts.push(...result.texts);
			}
		}

		const baseText = extractBaseText(msg);
		if (texts.length > 0) {
			return {
				text: [baseText, ...texts].filter(Boolean).join("\n\n"),
				images,
			};
		}

		if (baseText) return { text: baseText, images };

		if (isVideoMessage(msg)) {
			return this.#handleVideoMessage(msg, images);
		}

		if (msg.attachments && msg.attachments.length > 0) {
			return this.#describeAttachments(msg, images);
		}

		logger.info("[PromptExtractor] Non-text message without attachments — degrading to placeholder", {
			contentType: msg.content.type,
			hasAttachments: !!msg.attachments,
		});
		return { text: "[non-text message]", images };
	}

	#handleVideoMessage(msg: InboundMessage, images: ImageContent[]): { text: string; images: ImageContent[] } {
		const filename = (msg.content as { filename?: string }).filename;
		const name = filename ?? "video";
		const size = "size" in msg.content && msg.content.size ? formatBytes(msg.content.size) : "unknown size";

		if (images.length > 0) {
			return {
				text: `[用户发送了视频文件: ${name} (${size})。已从视频中提取 ${images.length} 个关键帧，请基于这些帧分析视频内容。]`,
				images,
			};
		}
		return {
			text: `[用户发送了视频文件: ${name} (${size})。视频帧提取失败，你无法查看视频内容。如果需要分析，请让用户截取关键帧图片重发。]`,
			images,
		};
	}

	#describeAttachments(msg: InboundMessage, images: ImageContent[]): { text: string; images: ImageContent[] } {
		const descriptions = msg.attachments!.map(att => {
			const name = att.filename ?? "file";
			return `[${att.kind}: ${name} (${att.mimeType}, ${formatBytes(att.size)})]`;
		});
		logger.info("[PromptExtractor] Non-text message with attachments", {
			contentType: msg.content.type,
			attachmentCount: msg.attachments!.length,
			imageCount: images.length,
			text: descriptions.join("\n"),
		});
		return { text: descriptions.join("\n"), images };
	}
}
