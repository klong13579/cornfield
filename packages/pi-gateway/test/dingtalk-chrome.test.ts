/**
 * v3 chrome extractor (formatDingTalkChrome) + image data URI extractor.
 */
import { describe, expect, test } from "bun:test";
import { extractDataUriImages } from "../src/channels/dingtalk";
import { formatDingTalkChrome, formatDingTalkReply } from "../src/channels/dingtalk-formatter";
import type { AgentResponseMeta, InboundMessage } from "../src/types";

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
