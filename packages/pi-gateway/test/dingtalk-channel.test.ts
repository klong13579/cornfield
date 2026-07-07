/**
 * DingTalk channel + chrome + files + formatter tests.
 *
 * Merged:
 *   - dingtalk-channel.test.ts        (channel parsing + outbound)
 *   - dingtalk-chrome.test.ts         (chrome extractor + image directives)
 *   - dingtalk-files.test.ts          (file classification)
 *   - dingtalk-formatter.test.ts      (markdown composer)
 */
import { describe, expect, test } from "bun:test";
import { extractDataUriImages, extractLocalFileImages, stripImageDirectives } from "../src/channels/dingtalk";
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
import { formatDingTalkChrome, formatDingTalkReply } from "../src/channels/dingtalk-formatter";
import type { AgentResponseMeta, InboundMessage, ReplyFormatterContext } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════

function makeMeta(overrides: Partial<AgentResponseMeta> = {}): AgentResponseMeta {
	return {
		text: "Here is the answer.",
		rawText: "Here is the answer.",
		model: "claude-sonnet-4-5",
		provider: "anthropic",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		agentDurationMs: 100,
		taskDurationMs: 200,
		effort: "medium",
		toolCalls: [],
		toolResults: [],
		error: null,
		aborted: false,
		isFallback: false,
		...overrides,
	};
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channelId: "dingtalk",
		accountId: "ops",
		userId: "u1",
		userName: "Alice",
		conversationId: "c1",
		isGroup: false,
		content: { type: "text", text: "summarize this" },
		timestamp: new Date(),
		...overrides,
	};
}

const baseMeta = (overrides: Partial<AgentResponseMeta> = {}): AgentResponseMeta => ({
	text: "Hello, world.",
	rawText: "Hello, world.",
	model: "claude-sonnet-4-5",
	provider: "anthropic",
	usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
	agentDurationMs: 1234,
	taskDurationMs: 1500,
	effort: null,
	toolCalls: [],
	toolResults: [],
	error: null,
	aborted: false,
	isFallback: false,
	...overrides,
});

const textInbound = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
	channelId: "dingtalk",
	userId: "u1",
	userName: "Alice",
	conversationId: "c1",
	isGroup: false,
	content: { type: "text", text: "what's the weather?" },
	timestamp: new Date(),
	sessionWebhook: "https://example.com/hook",
	...overrides,
});

const ctx = (overrides: Partial<ReplyFormatterContext> = {}): ReplyFormatterContext => ({
	agentName: "ops-bot",
	accountId: "ops",
	dapiCalls: 0,
	...overrides,
});

// ═══════════════════════════════════════════════════════════════════════
// Chrome extractor (was: dingtalk-chrome.test.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("formatDingTalkChrome", () => {
	test("extracts quoteContent / statusLine / toolSummary / answerText", () => {
		const chrome = formatDingTalkChrome({
			meta: makeMeta(),
			inbound: makeInbound(),
			agentName: "ops-bot",
			accountId: "ops",
			dapiCalls: 3,
		});
		expect(chrome.quoteContent).toContain("Alice");
		expect(chrome.quoteContent).toContain("summarize this");
		expect(chrome.statusLine).toContain("claude-sonnet-4-5");
		expect(chrome.statusLine).toContain("ops-bot");
		expect(chrome.answerText).toBe("Here is the answer.");
		expect(chrome.copyContent).toBe("Here is the answer.");
		expect(chrome.toolSummary).toBeNull();
	});

	test("chrome.toolSummary non-null when meta has tool calls", () => {
		const chrome = formatDingTalkChrome({
			meta: makeMeta({
				toolCalls: [
					{ id: "t1", name: "read", args: null },
					{ id: "t2", name: "read", args: null },
				],
				toolResults: [{ id: "t1", name: "read", isError: false }],
			}),
			inbound: makeInbound(),
			agentName: null,
			accountId: "ops",
			dapiCalls: 0,
		});
		expect(chrome.toolSummary).toContain("read × 2");
	});

	test("fallback path: every chrome field is null / empty", () => {
		const chrome = formatDingTalkChrome({
			meta: makeMeta({ text: "系统繁忙，请稍后再试。", isFallback: true }),
			inbound: makeInbound(),
			agentName: null,
			accountId: "ops",
			dapiCalls: 0,
		});
		expect(chrome.quoteContent).toBeNull();
		expect(chrome.statusLine).toBeNull();
		expect(chrome.copyContent).toBe("");
		expect(chrome.toolSummary).toBeNull();
		expect(chrome.answerText).toBe("系统繁忙，请稍后再试。");
		expect(chrome.isFallback).toBe(true);
	});
});

describe("extractDataUriImages", () => {
	test("finds a single PNG data URI image", () => {
		const text = "before ![screenshot](data:image/png;base64,iVBORw0KGgo=) after";
		const out = extractDataUriImages(text);
		expect(out).toHaveLength(1);
		expect(out[0]?.mimeType).toBe("image/png");
		expect(out[0]?.base64).toBe("iVBORw0KGgo=");
		expect(out[0]?.alt).toBe("screenshot");
		expect(out[0]?.dataUri).toContain("image/png;base64");
	});

	test("finds multiple data URI images of different types", () => {
		const text = "![a](data:image/png;base64,AAA) and ![b](data:image/jpeg;base64,BBB)";
		const out = extractDataUriImages(text);
		expect(out).toHaveLength(2);
		expect(out[0]?.mimeType).toBe("image/png");
		expect(out[1]?.mimeType).toBe("image/jpeg");
	});

	test("ignores remote https images", () => {
		const text = "![remote](https://example.com/foo.png)";
		expect(extractDataUriImages(text)).toEqual([]);
	});

	test("returns empty array for plain text", () => {
		expect(extractDataUriImages("no images here")).toEqual([]);
	});

	test("preserves alt text and handles empty alt", () => {
		const text = "![](data:image/png;base64,AAA)";
		const out = extractDataUriImages(text);
		expect(out[0]?.alt).toBe("");
	});
});

describe("extractLocalFileImages", () => {
	test("finds absolute path image", () => {
		const text = "before ![arch](/tmp/diagram.png) after";
		const out = extractLocalFileImages(text);
		expect(out).toHaveLength(1);
		expect(out[0]?.path).toBe("/tmp/diagram.png");
		expect(out[0]?.alt).toBe("arch");
	});

	test("finds file:// URI image", () => {
		const text = "![img](file:///Users/x/y.jpeg)";
		const out = extractLocalFileImages(text);
		expect(out).toHaveLength(1);
		expect(out[0]?.path).toBe("/Users/x/y.jpeg");
	});

	test("ignores remote https URLs", () => {
		const text = "![remote](https://example.com/foo.png)";
		expect(extractLocalFileImages(text)).toEqual([]);
	});

	test("ignores relative paths", () => {
		const text = "![rel](assets/foo.png)";
		expect(extractLocalFileImages(text)).toEqual([]);
	});

	test("ignores paths without image extensions", () => {
		const text = "![doc](/tmp/readme.md)";
		expect(extractLocalFileImages(text)).toEqual([]);
	});

	test("finds multiple local images", () => {
		const text = "![a](/tmp/a.png) and ![b](file:///tmp/b.jpg)";
		const out = extractLocalFileImages(text);
		expect(out).toHaveLength(2);
		expect(out[0]?.path).toBe("/tmp/a.png");
		expect(out[1]?.path).toBe("/tmp/b.jpg");
	});

	test("decodes percent-encoded file:// URIs", () => {
		const text = "![img](file:///tmp/my%20file.png)";
		const out = extractLocalFileImages(text);
		expect(out[0]?.path).toBe("/tmp/my file.png");
	});
});

describe("stripImageDirectives", () => {
	test("strips data URI images from text", () => {
		const text = "before ![shot](data:image/png;base64,AAA) after";
		expect(stripImageDirectives(text)).toBe("before  after");
	});

	test("strips local file images from text", () => {
		const text = "Here is the diagram:\n![arch](/tmp/diagram.png)\nDone.";
		expect(stripImageDirectives(text)).toBe("Here is the diagram:\n\nDone.");
	});

	test("strips both data URI and local file images together", () => {
		const text = "![a](data:image/png;base64,AAA)\n![b](/tmp/b.png)";
		const result = stripImageDirectives(text);
		expect(result).not.toContain("data:image");
		expect(result).not.toContain("/tmp/b.png");
	});

	test("leaves remote URLs intact", () => {
		const text = "![remote](https://example.com/page.html) stays";
		expect(stripImageDirectives(text)).toBe("![remote](https://example.com/page.html) stays");
	});

	test("collapses excessive blank lines after stripping", () => {
		const text = "a\n\n\n![img](/tmp/x.png)\n\n\nb";
		expect(stripImageDirectives(text)).toBe("a\n\nb");
	});

	test("returns empty string when text is only images", () => {
		const text = "![only](/tmp/x.png)";
		expect(stripImageDirectives(text)).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// File classification (was: dingtalk-files.test.ts)
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

describe("mediaTypeForKind", () => {
	test("maps each kind to the uploadMedia type", () => {
		expect(mediaTypeForKind("image")).toBe("image");
		expect(mediaTypeForKind("audio")).toBe("voice");
		expect(mediaTypeForKind("video")).toBe("video");
		expect(mediaTypeForKind("document")).toBe("file");
	});
});

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
		expect(md).toBe("🔗 [x](https://example.com/x) — audio 格式不支持");
	});
});

describe("warnUnsupportedFile", () => {
	test("does not throw", () => {
		warnUnsupportedFile("/tmp/a.webp", "ext not in supported set", "ops", "conv-1");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Formatter (was: dingtalk-formatter.test.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("formatDingTalkReply backward compat (v1)", () => {
	test("still assembles quote + answer + status into a single markdown string", () => {
		const out = formatDingTalkReply({
			meta: makeMeta(),
			inbound: makeInbound(),
			agentName: "ops-bot",
			accountId: "ops",
			dapiCalls: 0,
		});
		expect(out.markdown).toContain("Alice");
		expect(out.markdown).toContain("Here is the answer.");
		expect(out.markdown).toContain("claude-sonnet-4-5");
	});

	test("fallback path produces just the error text", () => {
		const out = formatDingTalkReply({
			meta: makeMeta({ text: "系统繁忙", isFallback: true }),
			inbound: makeInbound(),
			agentName: null,
			accountId: "ops",
			dapiCalls: 0,
		});
		expect(out.markdown).toBe("系统繁忙");
	});
});

describe("formatDingTalkReply — section ordering and gating", () => {
	test("non-fallback: quoteContent → tool summary → answer → status line", () => {
		const out = formatDingTalkReply({
			meta: baseMeta({
				toolCalls: [{ id: "t1", name: "read", args: null }],
				toolResults: [{ id: "t1", name: "read", isError: false }],
			}),
			inbound: textInbound(),
			...ctx(),
		});
		// Quote first (sender)
		const quoteIdx = out.markdown.indexOf("Alice");
		const toolIdx = out.markdown.indexOf("read");
		const answerIdx = out.markdown.indexOf("Hello, world.");
		const statusIdx = out.markdown.indexOf("claude-sonnet-4-5");
		expect(quoteIdx).toBeGreaterThanOrEqual(0);
		expect(toolIdx).toBeGreaterThan(quoteIdx);
		expect(answerIdx).toBeGreaterThan(toolIdx);
		expect(statusIdx).toBeGreaterThan(answerIdx);
	});

	test("fallback string returns only the localized text (no chrome)", () => {
		const out = formatDingTalkReply({
			meta: baseMeta({ text: "系统繁忙，请稍后再试。", isFallback: true }),
			inbound: textInbound(),
			...ctx(),
		});
		expect(out.markdown).toBe("系统繁忙，请稍后再试。");
		expect(out.markdown).not.toContain("Alice");
		expect(out.markdown).not.toContain("claude-sonnet-4-5");
	});
});
