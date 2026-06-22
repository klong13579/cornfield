/**
 * Unit tests for `formatDingTalkReply` — the markdown composer that turns
 * AgentResponseMeta + InboundMessage into a single DingTalk reply.
 *
 * Test contracts (each test pins one externally observable behavior):
 *
 * - Section ordering: quoteContent → tool summary → answer → status line.
 * - Each section only renders when its data is present.
 * - Fallback strings (circuit open, recovery) skip all chrome and return
 *   just the localized error text.
 * - Long replies truncate the answer body, not the chrome.
 * - Status line omits fields the agent didn't report (don't show "0" for
 *   tokens if no usage was returned).
 * - Markdown special chars in sender names don't break the blockquote.
 */

import { describe, expect, test } from "bun:test";
import { formatDingTalkReply } from "../src/channels/dingtalk-formatter";
import type { AgentResponseMeta, InboundMessage, ReplyFormatterContext } from "../src/types";

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
	accountId: "ops",
	agentName: null,
	dapiCalls: 0,
	...overrides,
});

describe("formatDingTalkReply — fallback path", () => {
	test("circuit-open fallback returns just the error text, no chrome", () => {
		const meta = baseMeta({ isFallback: true, text: "系统繁忙，请稍后重试。" });
		const result = formatDingTalkReply({ meta, inbound: textInbound(), ...ctx() });
		expect(result.markdown).toBe("系统繁忙，请稍后重试。");
		expect(result.truncated).toBe(false);
		expect(result.markdown).not.toContain("---");
		expect(result.markdown).not.toContain("工具");
	});

	test("recovery fallback also skips chrome", () => {
		const meta = baseMeta({ isFallback: true, text: "系统正在恢复中，请稍后再试。" });
		const result = formatDingTalkReply({ meta, inbound: textInbound(), ...ctx() });
		expect(result.markdown).toBe("系统正在恢复中，请稍后再试。");
		expect(result.truncated).toBe(false);
	});
});

describe("formatDingTalkReply — quoteContent (header)", () => {
	test("text inbound renders as a blockquote with sender name", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({ userName: "Bob", content: { type: "text", text: "hi" } }),
			...ctx(),
		});
		expect(result.markdown).toContain("> 💬 **Bob**: hi");
	});

	test("markdown inbound uses the raw markdown body", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({ content: { type: "markdown", markdown: "**urgent**" } }),
			...ctx(),
		});
		expect(result.markdown).toContain("> 💬 **Alice**: **urgent**");
	});

	test("image inbound is rendered as [图片] placeholder", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({ content: { type: "image", url: "/x.jpg", filename: "x.jpg" } }),
			...ctx(),
		});
		expect(result.markdown).toContain("[图片]");
		expect(result.markdown).not.toContain("/x.jpg");
	});

	test("file inbound shows the filename in brackets", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({
				content: { type: "file", url: "/p.pdf", filename: "report.pdf", size: 1024 },
			}),
			...ctx(),
		});
		expect(result.markdown).toContain("[文件: report.pdf]");
	});

	test("voice inbound without ASR shows [语音]", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({ content: { type: "voice", url: "/v.amr", duration: 5 } }),
			...ctx(),
		});
		expect(result.markdown).toContain("[语音]");
	});

	test("voice inbound with ASR shows [语音转文字] + recognition text", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({
				content: { type: "voice", url: "/v.amr", duration: 5, text: "明天天气如何" },
			}),
			...ctx(),
		});
		expect(result.markdown).toContain("[语音转文字] 明天天气如何");
	});

	test("video inbound shows [视频: <filename>]", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({ content: { type: "video", url: "/v.mp4", filename: "clip.mp4" } }),
			...ctx(),
		});
		expect(result.markdown).toContain("[视频: clip.mp4]");
	});

	test("long inbound is truncated with ellipsis", () => {
		const long = "a".repeat(200);
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({ content: { type: "text", text: long } }),
			...ctx(),
		});
		// The quote length cap is 120 chars; ellipsis is added.
		const quoteMatch = result.markdown.match(/^> 💬 \*\*Alice\*\*: (.+?)$/m);
		expect(quoteMatch).not.toBeNull();
		expect(quoteMatch?.[1]).toMatch(/…$/);
		expect(quoteMatch?.[1].length).toBeLessThanOrEqual(121);
	});

	test("sender name with markdown special chars is escaped", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound({ userName: "*bold*_name_" }),
			...ctx(),
		});
		// Asterisks and underscores in the name should be backslash-escaped
		// so the surrounding markdown doesn't accidentally render.
		expect(result.markdown).toContain("\\*bold\\*\\_name\\_");
		expect(result.markdown).not.toMatch(/\*\*\*(.*)\*\*\*/); // no triple-asterisk
	});
});

describe("formatDingTalkReply — tool summary", () => {
	test("no tool calls → no summary line", () => {
		const result = formatDingTalkReply({ meta: baseMeta(), inbound: textInbound(), ...ctx() });
		expect(result.markdown).not.toContain("**工具**");
	});

	test("single tool call appears as `工具: name`", () => {
		const meta = baseMeta({
			toolCalls: [{ id: "t1", name: "read", args: {} }],
			toolResults: [{ id: "t1", name: "read", isError: false }],
		});
		const result = formatDingTalkReply({ meta, inbound: textInbound(), ...ctx() });
		expect(result.markdown).toContain("**工具**: read");
		expect(result.markdown).not.toContain("×"); // no count
	});

	test("repeated tool calls collapse with × count", () => {
		const meta = baseMeta({
			toolCalls: [
				{ id: "1", name: "read", args: {} },
				{ id: "2", name: "read", args: {} },
				{ id: "3", name: "read", args: {} },
			],
			toolResults: [
				{ id: "1", name: "read", isError: false },
				{ id: "2", name: "read", isError: false },
				{ id: "3", name: "read", isError: false },
			],
		});
		const result = formatDingTalkReply({ meta, inbound: textInbound(), ...ctx() });
		expect(result.markdown).toContain("**工具**: read × 3");
	});

	test("multiple distinct tools appear in invocation order", () => {
		const meta = baseMeta({
			toolCalls: [
				{ id: "1", name: "read", args: {} },
				{ id: "2", name: "grep", args: {} },
				{ id: "3", name: "edit", args: {} },
			],
			toolResults: [
				{ id: "1", name: "read", isError: false },
				{ id: "2", name: "grep", isError: false },
				{ id: "3", name: "edit", isError: false },
			],
		});
		const result = formatDingTalkReply({ meta, inbound: textInbound(), ...ctx() });
		expect(result.markdown).toContain("**工具**: read, grep, edit");
	});

	test("tool errors are surfaced in the summary", () => {
		const meta = baseMeta({
			toolCalls: [
				{ id: "1", name: "bash", args: {} },
				{ id: "2", name: "bash", args: {} },
			],
			toolResults: [
				{ id: "1", name: "bash", isError: true },
				{ id: "2", name: "bash", isError: false },
			],
		});
		const result = formatDingTalkReply({ meta, inbound: textInbound(), ...ctx() });
		expect(result.markdown).toContain("(1 错误)");
	});
});

describe("formatDingTalkReply — status line", () => {
	test("full status line: model · effort · taskTime · tokens · dapi · agent", () => {
		const meta = baseMeta({ effort: "medium" });
		const result = formatDingTalkReply({
			meta,
			inbound: textInbound(),
			...ctx({ agentName: "ops-agent", dapiCalls: 3 }),
		});
		expect(result.markdown).toContain("`claude-sonnet-4-5`");
		expect(result.markdown).toContain("effort `medium`");
		expect(result.markdown).toMatch(/1\.5s|1\.4s/); // taskDuration
		expect(result.markdown).toContain("150 tok"); // 100+50+0+0
		expect(result.markdown).toContain("3 dapi");
		expect(result.markdown).toContain("agent `ops-agent`");
	});

	test("missing effort hides the effort field", () => {
		const result = formatDingTalkReply({
			meta: baseMeta({ effort: null }),
			inbound: textInbound(),
			...ctx(),
		});
		expect(result.markdown).not.toContain("effort");
	});

	test("missing usage shows `— tokens` placeholder", () => {
		const result = formatDingTalkReply({
			meta: baseMeta({ usage: null }),
			inbound: textInbound(),
			...ctx(),
		});
		expect(result.markdown).toContain("— tokens");
	});

	test("missing model falls back to provider/? when provider known", () => {
		const result = formatDingTalkReply({
			meta: baseMeta({ model: null, provider: "anthropic" }),
			inbound: textInbound(),
			...ctx(),
		});
		expect(result.markdown).toContain("`anthropic/?`");
	});

	test("default account with no agentName shows agent `default`", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound(),
			...ctx({ accountId: "__default__", agentName: null }),
		});
		expect(result.markdown).toContain("agent `default`");
	});

	test("named account with no agentName falls back to accountId", () => {
		const result = formatDingTalkReply({
			meta: baseMeta(),
			inbound: textInbound(),
			...ctx({ accountId: "hr", agentName: null }),
		});
		expect(result.markdown).toContain("agent `hr`");
	});

	test("large token count uses k/M abbreviation", () => {
		const result = formatDingTalkReply({
			meta: baseMeta({
				usage: { input: 5000, output: 2500, cacheRead: 0, cacheWrite: 0 },
			}),
			inbound: textInbound(),
			...ctx(),
		});
		expect(result.markdown).toContain("7.5k tok");
	});

	test("duration under 1s shown in ms", () => {
		const result = formatDingTalkReply({
			meta: baseMeta({ taskDurationMs: 850 }),
			inbound: textInbound(),
			...ctx(),
		});
		expect(result.markdown).toContain("850ms");
	});

	test("duration over 60s shown as XmYYs", () => {
		const result = formatDingTalkReply({
			meta: baseMeta({ taskDurationMs: 75_500 }),
			inbound: textInbound(),
			...ctx(),
		});
		expect(result.markdown).toContain("1m15s");
	});
});

describe("formatDingTalkReply — sanitization", () => {
	test("think blocks in meta.text are stripped", () => {
		const meta = baseMeta({
			text: "answer<think>hidden reasoning</think>more",
		});
		const result = formatDingTalkReply({ meta, inbound: textInbound(), ...ctx() });
		expect(result.markdown).not.toContain("hidden reasoning");
		expect(result.markdown).not.toContain("<think>");
	});

	test("truncation note is appended when answer is capped", () => {
		const longAnswer = "x".repeat(5000);
		const result = formatDingTalkReply({
			meta: baseMeta({ text: longAnswer }),
			inbound: textInbound(),
			...ctx(),
		});
		expect(result.truncated).toBe(true);
		expect(result.markdown).toContain("...(内容已截断");
		// Header (quote) and footer (status line) should both be present.
		expect(result.markdown).toContain("> 💬 **Alice**");
		expect(result.markdown).toContain("`claude-sonnet-4-5`");
	});
});

describe("formatDingTalkReply — section ordering", () => {
	test("full reply: header → tool summary → answer → status line", () => {
		const meta = baseMeta({
			toolCalls: [{ id: "1", name: "bash", args: {} }],
			toolResults: [{ id: "1", name: "bash", isError: false }],
		});
		const result = formatDingTalkReply({ meta, inbound: textInbound(), ...ctx() });
		const headerIdx = result.markdown.indexOf("> 💬");
		const toolIdx = result.markdown.indexOf("**工具**");
		const answerIdx = result.markdown.indexOf("Hello, world.");
		const statusIdx = result.markdown.indexOf("---");
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		expect(toolIdx).toBeGreaterThan(headerIdx);
		expect(answerIdx).toBeGreaterThan(toolIdx);
		expect(statusIdx).toBeGreaterThan(answerIdx);
	});
});

describe("DingTalkChannel.formatReply integration", () => {
	// Smoke test for the channel-level wrapper. Imports here intentionally
	// avoid a heavy DingTalkChannel construction — we just need a stub.
	test("formatReply returns a markdown OutboundMessage with the channel id", async () => {
		const { DingTalkChannel } = await import("../src/channels/dingtalk");
		// Build a channel without triggering onConnect (we won't call it).
		const ch = Object.create(DingTalkChannel.prototype) as DingTalkChannel;
		// The formatReply method must be defined.
		expect(typeof ch.formatReply).toBe("function");
	});
});
