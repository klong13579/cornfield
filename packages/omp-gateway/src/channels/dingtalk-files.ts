/**
 * DingTalk file type classification.
 *
 * The DingTalk card / media APIs each accept a different set of file
 * formats and sizes. A single markdown `![alt](url)` token in agent
 * text can be an image, audio, video, or document — we have to know
 * which one to route it to before we can decide:
 *   - which media kind to upload (`image` / `voice` / `video` / `file`)
 *   - which standalone message template to send it as
 *   - which size limit to enforce before attempting upload
 *   - what to do with formats the client cannot render
 *
 * This module is the single source of truth for those rules. Extractors
 * and the streamCard pipeline both consume it — they do NOT hard-code
 * format / size numbers themselves.
 *
 * Source of truth: https://open.dingtalk.com/document/development/upload-media-files
 *   - image: jpg/jpeg, gif, png, bmp   ≤ 20 MB
 *   - voice: amr, mp3, wav             ≤ 2 MB
 *   - video: mp4                       ≤ 20 MB
 *   - file:  doc, docx, xls, xlsx, ppt, pptx, zip, pdf, rar ≤ 20 MB
 *
 * Caveat: the older sampleAudio message template docs list ogg + amr
 * as the playback formats it supports, but the upload endpoint accepts
 * amr/mp3/wav. We accept all three on upload and let the client decide
 * playback — if it can't, the user gets a clickable file link in the
 * card body instead of a silent broken player.
 */

import { logger } from "@oh-my-pi/pi-utils";

/** Coarse kind for routing media through DingTalk. */
export type FileKind = "image" | "audio" | "video" | "document" | "unsupported";

/** Media type parameter for `uploadMedia`. */
export type DingTalkMediaType = "image" | "voice" | "video" | "file";

/** Extensions (lowercase, no dot) supported per kind, derived from the
 *  DingTalk upload spec. Includes the conventional aliases (jpeg → jpg). */
const SUPPORTED_EXTENSIONS: Record<Exclude<FileKind, "unsupported">, ReadonlySet<string>> = {
	image: new Set(["jpg", "jpeg", "png", "gif", "bmp"]),
	audio: new Set(["amr", "mp3", "wav", "ogg"]),
	video: new Set(["mp4"]),
	document: new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "pdf", "rar"]),
};

/** Hard size limits per kind (in bytes). Matches the upload endpoint. */
export const FILE_SIZE_LIMITS: Record<Exclude<FileKind, "unsupported">, number> = {
	image: 20 * 1024 * 1024,
	audio: 2 * 1024 * 1024,
	video: 20 * 1024 * 1024,
	document: 20 * 1024 * 1024,
};

/** Map a `FileKind` (excluding `unsupported`) to the media kind the
 *  `uploadMedia` API expects. */
export function mediaTypeForKind(kind: Exclude<FileKind, "unsupported">): DingTalkMediaType {
	switch (kind) {
		case "image":
			return "image";
		case "audio":
			return "voice";
		case "video":
			return "video";
		case "document":
			return "file";
	}
}

/**
 * Extract the lowercase extension from a path or URL. Returns "" for
 * paths with no extension or where the final segment has none.
 *
 * Strips query strings / fragments before extracting. Handles trailing
 * slashes defensively (returns "" rather than throwing).
 */
export function extractExtension(input: string): string {
	if (!input) return "";
	const noQuery = input.split(/[?#]/, 1)[0] ?? "";
	const lastSlash = Math.max(noQuery.lastIndexOf("/"), noQuery.lastIndexOf("\\"));
	const lastSegment = lastSlash === -1 ? noQuery : noQuery.slice(lastSlash + 1);
	const dot = lastSegment.lastIndexOf(".");
	if (dot <= 0 || dot === lastSegment.length - 1) return "";
	return lastSegment.slice(dot + 1).toLowerCase();
}

/**
 * Classify a file path or URL by its extension. Returns `"unsupported"`
 * for any extension not in the supported set (including empty / no
 * extension). The result drives both routing and the fallback-to-link
 * path for files the DingTalk client cannot render inline.
 */
export function classifyFile(input: string): FileKind {
	const ext = extractExtension(input);
	if (!ext) return "unsupported";
	for (const [kind, set] of Object.entries(SUPPORTED_EXTENSIONS) as Array<
		[Exclude<FileKind, "unsupported">, ReadonlySet<string>]
	>) {
		if (set.has(ext)) return kind;
	}
	return "unsupported";
}

/** Type guard narrowing `FileKind` to the routable subset. */
export function isRoutableKind(kind: FileKind): kind is Exclude<FileKind, "unsupported"> {
	return kind !== "unsupported";
}

/** Test whether `ext` (lowercase, no dot) is in the supported set
 *  for `kind`. Useful when a caller already has a kind in hand. */
export function isExtensionSupported(kind: Exclude<FileKind, "unsupported">, ext: string): boolean {
	return SUPPORTED_EXTENSIONS[kind].has(ext.toLowerCase());
}

/** Test whether a file of `kind` and `sizeBytes` is under the limit. */
export function isFileSizeAllowed(kind: Exclude<FileKind, "unsupported">, sizeBytes: number): boolean {
	return sizeBytes > 0 && sizeBytes <= FILE_SIZE_LIMITS[kind];
}

/**
 * Replace an unsupported media token in agent text with a clickable
 * link the user can open in their browser. Returns a markdown link of
 * the form `🔗 [name](url)` so the rendering is visually distinct from
 * the regular text but still actionable. `displayName` defaults to the
 * last URL path segment (filename).
 */
export function unsupportedFallbackMarkdown(alt: string, url: string, kind: FileKind, reason: string): string {
	const trimmedAlt = alt?.trim();
	const fallbackName = trimmedAlt ? trimmedAlt : url.split("/").pop() || "file";
	const reasonTag = reason ? ` (${reason})` : "";
	return `🔗 [${fallbackName}](${url}) — ${kind} 格式不支持${reasonTag}`;
}

/**
 * Log a structured warning for an unsupported file. Used by the
 * pipeline so operators can grep for it in gateway logs.
 */
export function warnUnsupportedFile(input: string, reason: string, accountId: string, conversationId: string): void {
	logger.warn("[DingTalk] media format unsupported; degrading to link", {
		input: input.slice(0, 200),
		reason,
		accountId,
		conversationId,
	});
}
