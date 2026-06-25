/**
 * File type classification: extractExtension, classifyFile, size/format
 * checks, and unsupported-fallback markdown builder.
 *
 * These are the routing primitives the streamCard pipeline depends on.
 * If any of these regress, the pipeline will silently misroute media
 * (upload a webp to the image media endpoint, reject a valid pdf, etc.)
 * so the tests pin both the happy path and the boundary conditions.
 */
import { describe, expect, test } from "bun:test";
import {
	classifyFile,
	extractExtension,
	FILE_SIZE_LIMITS,
	isExtensionSupported,
	isFileSizeAllowed,
	isRoutableKind,
	mediaTypeForKind,
	unsupportedFallbackMarkdown,
	warnUnsupportedFile,
} from "../src/channels/dingtalk-files";

// ═══════════════════════════════════════════════════════════════════════
// extractExtension
// ═══════════════════════════════════════════════════════════════════════

describe("extractExtension", () => {
	test("returns lowercase extension from a simple path", () => {
		expect(extractExtension("/tmp/photo.PNG")).toBe("png");
		expect(extractExtension("/tmp/photo.png")).toBe("png");
	});

	test("handles file:// URIs", () => {
		expect(extractExtension("file:///tmp/clip.MP4")).toBe("mp4");
	});

	test("strips query string before extracting", () => {
		expect(extractExtension("https://example.com/v.mp4?token=abc&exp=1")).toBe("mp4");
	});

	test("strips fragment before extracting", () => {
		expect(extractExtension("https://example.com/v.mp4#t=10")).toBe("mp4");
	});

	test("returns empty string when there is no extension", () => {
		expect(extractExtension("https://example.com/page")).toBe("");
		expect(extractExtension("/tmp/Makefile")).toBe("");
	});

	test("returns empty string for empty input", () => {
		expect(extractExtension("")).toBe("");
	});

	test("handles windows-style backslash paths", () => {
		expect(extractExtension("C:\\Users\\me\\clip.mp4")).toBe("mp4");
	});

	test("ignores leading dots (hidden files)", () => {
		expect(extractExtension("/tmp/.env")).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// classifyFile
// ═══════════════════════════════════════════════════════════════════════

describe("classifyFile", () => {
	test("classifies common image formats", () => {
		expect(classifyFile("/tmp/a.png")).toBe("image");
		expect(classifyFile("/tmp/a.jpg")).toBe("image");
		expect(classifyFile("/tmp/a.jpeg")).toBe("image");
		expect(classifyFile("/tmp/a.gif")).toBe("image");
		expect(classifyFile("/tmp/a.bmp")).toBe("image");
	});

	test("classifies common audio formats", () => {
		expect(classifyFile("/tmp/a.amr")).toBe("audio");
		expect(classifyFile("/tmp/a.mp3")).toBe("audio");
		expect(classifyFile("/tmp/a.wav")).toBe("audio");
		expect(classifyFile("/tmp/a.ogg")).toBe("audio");
	});

	test("classifies mp4 as video", () => {
		expect(classifyFile("/tmp/a.mp4")).toBe("video");
	});

	test("classifies office documents and archives", () => {
		expect(classifyFile("/tmp/a.pdf")).toBe("document");
		expect(classifyFile("/tmp/a.doc")).toBe("document");
		expect(classifyFile("/tmp/a.docx")).toBe("document");
		expect(classifyFile("/tmp/a.xls")).toBe("document");
		expect(classifyFile("/tmp/a.xlsx")).toBe("document");
		expect(classifyFile("/tmp/a.ppt")).toBe("document");
		expect(classifyFile("/tmp/a.pptx")).toBe("document");
		expect(classifyFile("/tmp/a.zip")).toBe("document");
		expect(classifyFile("/tmp/a.rar")).toBe("document");
	});

	test("rejects unsupported formats as 'unsupported'", () => {
		expect(classifyFile("/tmp/a.webp")).toBe("unsupported");
		expect(classifyFile("/tmp/a.svg")).toBe("unsupported");
		expect(classifyFile("/tmp/a.webm")).toBe("unsupported");
		expect(classifyFile("/tmp/a.mov")).toBe("unsupported");
		expect(classifyFile("/tmp/a.avi")).toBe("unsupported");
		expect(classifyFile("/tmp/a.mkv")).toBe("unsupported");
		expect(classifyFile("/tmp/a.flac")).toBe("unsupported");
		expect(classifyFile("/tmp/a.txt")).toBe("unsupported");
		expect(classifyFile("/tmp/a.html")).toBe("unsupported");
	});

	test("returns 'unsupported' for paths with no extension", () => {
		expect(classifyFile("https://example.com/page")).toBe("unsupported");
		expect(classifyFile("/tmp/Makefile")).toBe("unsupported");
	});

	test("extension matching is case-insensitive", () => {
		expect(classifyFile("/tmp/a.JPG")).toBe("image");
		expect(classifyFile("/tmp/a.Mp4")).toBe("video");
	});

	test("handles URL with query string", () => {
		expect(classifyFile("https://example.com/v.mp4?token=abc")).toBe("video");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// mediaTypeForKind
// ═══════════════════════════════════════════════════════════════════════

describe("mediaTypeForKind", () => {
	test("maps each kind to the uploadMedia type", () => {
		expect(mediaTypeForKind("image")).toBe("image");
		expect(mediaTypeForKind("audio")).toBe("voice");
		expect(mediaTypeForKind("video")).toBe("video");
		expect(mediaTypeForKind("document")).toBe("file");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// isRoutableKind
// ═══════════════════════════════════════════════════════════════════════

describe("isRoutableKind", () => {
	test("routable kinds return true", () => {
		expect(isRoutableKind("image")).toBe(true);
		expect(isRoutableKind("audio")).toBe(true);
		expect(isRoutableKind("video")).toBe(true);
		expect(isRoutableKind("document")).toBe(true);
	});

	test("unsupported returns false", () => {
		expect(isRoutableKind("unsupported")).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// isExtensionSupported
// ═══════════════════════════════════════════════════════════════════════

describe("isExtensionSupported", () => {
	test("accepts the canonical extensions", () => {
		expect(isExtensionSupported("image", "jpg")).toBe(true);
		expect(isExtensionSupported("audio", "amr")).toBe(true);
		expect(isExtensionSupported("video", "mp4")).toBe(true);
		expect(isExtensionSupported("document", "pdf")).toBe(true);
	});

	test("rejects unknown extensions", () => {
		expect(isExtensionSupported("image", "webp")).toBe(false);
		expect(isExtensionSupported("video", "mov")).toBe(false);
		expect(isExtensionSupported("audio", "flac")).toBe(false);
	});

	test("case-insensitive", () => {
		expect(isExtensionSupported("image", "JPG")).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// isFileSizeAllowed
// ═══════════════════════════════════════════════════════════════════════

describe("isFileSizeAllowed", () => {
	test("returns true under the limit", () => {
		expect(isFileSizeAllowed("image", 1)).toBe(true);
		expect(isFileSizeAllowed("image", FILE_SIZE_LIMITS.image)).toBe(true);
		expect(isFileSizeAllowed("audio", FILE_SIZE_LIMITS.audio)).toBe(true);
	});

	test("returns false over the limit", () => {
		expect(isFileSizeAllowed("image", FILE_SIZE_LIMITS.image + 1)).toBe(false);
		expect(isFileSizeAllowed("audio", FILE_SIZE_LIMITS.audio + 1)).toBe(false);
		expect(isFileSizeAllowed("video", FILE_SIZE_LIMITS.video + 1)).toBe(false);
		expect(isFileSizeAllowed("document", FILE_SIZE_LIMITS.document + 1)).toBe(false);
	});

	test("returns false for zero or negative", () => {
		expect(isFileSizeAllowed("image", 0)).toBe(false);
		expect(isFileSizeAllowed("image", -1)).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// unsupportedFallbackMarkdown
// ═══════════════════════════════════════════════════════════════════════

describe("unsupportedFallbackMarkdown", () => {
	test("uses alt text as link label when present", () => {
		const md = unsupportedFallbackMarkdown("diagram", "https://example.com/a.webp", "image", "客户端不支持");
		expect(md).toBe("🔗 [diagram](https://example.com/a.webp) — image 格式不支持 (客户端不支持)");
	});

	test("derives label from URL filename when alt is empty", () => {
		const md = unsupportedFallbackMarkdown("", "https://example.com/path/clip.webm", "video", "");
		expect(md).toBe("🔗 [clip.webm](https://example.com/path/clip.webm) — video 格式不支持");
	});

	test("trims whitespace in alt", () => {
		const md = unsupportedFallbackMarkdown("   ", "https://example.com/x", "audio", "");
		// falls back to filename "x" since alt is empty after trim
		expect(md).toBe("🔗 [x](https://example.com/x) — audio 格式不支持");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// warnUnsupportedFile
// ═══════════════════════════════════════════════════════════════════════

describe("warnUnsupportedFile", () => {
	test("does not throw", () => {
		// Smoke test: logger.warn is a side effect; we just confirm the
		// helper accepts all params without throwing.
		warnUnsupportedFile("/tmp/a.webp", "ext not in supported set", "ops", "conv-1");
	});
});
