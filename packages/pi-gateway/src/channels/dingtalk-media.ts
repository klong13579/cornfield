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
import { logger } from "@oh-my-pi/pi-utils";
import { getAccessToken } from "./dingtalk-card";
import type { DingTalkConfig } from "../types";

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const DINGTALK_OAPI = "https://oapi.dingtalk.com";
const DINGTALK_API = "https://api.dingtalk.com";

/**
 * Get OAPI access token (for media download/upload).
 */
async function getOapiAccessToken(config: DingTalkConfig): Promise<string | null> {
	try {
		const resp = await fetch(
			`${DINGTALK_OAPI}/gettoken?appkey=${config.appKey}&appsecret=${config.appSecret}`,
			{ method: "GET" },
		);

		if (!resp.ok) return null;

		const data = await resp.json() as { errcode: number; access_token?: string; errmsg?: string };
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
 * Files are stored in a temp directory and cleaned up on process exit.
 */
async function downloadByDingtalkCode(
	downloadCode: string,
	config: DingTalkConfig,
): Promise<DownloadedMedia | null> {
	const token = await getOapiAccessToken(config);
	if (!token) {
		logger.error("[DingTalk Media] No OAPI token available for download");
		return null;
	}

	try {
		// Step 1: Get download URL
		const infoResp = await fetch(
			`${DINGTALK_API}/v1.0/robot/messageFiles/${downloadCode}`,
			{
				method: "GET",
				headers: {
					"x-acs-dingtalk-access-token": await getAccessToken(config),
					"Content-Type": "application/json",
				},
			},
		);

		if (!infoResp.ok) {
			logger.warn("[DingTalk Media] Failed to get file info", { status: infoResp.status });
			return null;
		}

		const fileInfo = await infoResp.json() as { downloadUrl?: string; fileName?: string; fileSize?: number; mediaType?: string };

		if (!fileInfo.downloadUrl) {
			logger.warn("[DingTalk Media] No download URL in file info");
			return null;
		}

		// Step 2: Download the file
		const fileResp = await fetch(fileInfo.downloadUrl, { method: "GET" });
		if (!fileResp.ok) {
			logger.warn("[DingTalk Media] File download failed", { status: fileResp.status });
			return null;
		}

		const buffer = await fileResp.arrayBuffer();
		const ext = fileInfo.fileName ? path.extname(fileInfo.fileName) : ".bin";
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dingtalk-"));
		const filePath = path.join(tmpDir, fileInfo.fileName ?? `file${ext}`);

		await fs.promises.writeFile(filePath, Buffer.from(buffer));

		logger.debug("[DingTalk Media] Downloaded file", {
			name: fileInfo.fileName,
			size: buffer.byteLength,
			path: filePath,
		});

		return {
			path: filePath,
			mimeType: fileInfo.mediaType ?? "application/octet-stream",
			originalName: fileInfo.fileName ?? `file${ext}`,
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
export async function downloadMedia(
	url: string,
	config: DingTalkConfig,
): Promise<DownloadedMedia | null> {
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

		const data = await resp.json() as { media_id?: string; errcode: number };
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