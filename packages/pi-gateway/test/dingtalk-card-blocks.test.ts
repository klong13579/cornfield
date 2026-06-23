/**
 * v3 AI Card module: schema + block builders + cardParamMap shape.
 *
 * The streaming PUT to `/v1.0/card/instances` and `/v1.0/card/streaming`
 * is exercised end-to-end in `dingtalk-card-e2e.test.ts`; this file
 * covers the unit-level builders (block shape, chrome fields,
 * cardParamMap key set) that don't require a network round-trip.
 */
import { describe, expect, test } from "bun:test";
import {
	buildAnswerBlock,
	buildImageBlock,
	buildThinkBlock,
	buildToolBlock,
	cardParamMapFromData,
	cardParamMapForStreamStart,
} from "../src/channels/dingtalk-card";

describe("buildAnswerBlock", () => {
	test("wraps raw text in a type-0 block with normalized markdown", () => {
		const block = buildAnswerBlock("Hello world");
		expect(block.type).toBe(0);
		expect(block.text).toBe("Hello world");
		expect(block.markdown).toBe("Hello world");
	});

	test("preserves multi-line content", () => {
		const block = buildAnswerBlock("line 1\nline 2\n\nline 3");
		expect(block.markdown).toContain("line 1");
		expect(block.markdown).toContain("line 3");
	});
});

describe("buildThinkBlock", () => {
	test("wraps thinking text in a type-1 block with gray font tag", () => {
		const block = buildThinkBlock("Reasoning step");
		expect(block.type).toBe(1);
		expect(block.text).toBe("Reasoning step");
		expect(block.markdown).toContain("common_level2_base_color");
		expect(block.markdown).toContain("Reasoning step");
	});

	test("trims surrounding whitespace", () => {
		const block = buildThinkBlock("  think  \n");
		expect(block.text).toBe("think");
	});
});

describe("buildToolBlock", () => {
	test("emits Exec: <name>(<args>) prefix and gray font tag", () => {
		const block = buildToolBlock({ name: "read", args: { path: "/tmp/x" } }, "file contents", false);
		expect(block.type).toBe(2);
		expect(block.text).toContain("Exec: read");
		expect(block.text).toContain("file contents");
		expect(block.markdown).toContain("common_level2_base_color");
	});

	test("flags isError in the prefix and replaces body when result is empty", () => {
		const block = buildToolBlock({ name: "bash", args: "rm -rf /" }, "", true);
		expect(block.text).toContain("— error");
		expect(block.text).toContain("Exec: bash(rm -rf /)");
	});

	test("truncates long args preview to 60 chars", () => {
		const longArgs = "x".repeat(200);
		const block = buildToolBlock({ name: "echo", args: longArgs }, "out", false);
		expect(block.text).toContain("…");
		expect(block.text.length).toBeLessThan(400);
	});
});

describe("buildImageBlock", () => {
	test("emits type-3 block with mediaId and caption", () => {
		const block = buildImageBlock("@lALPDfmVR_test", "my screenshot");
		expect(block.type).toBe(3);
		expect(block.mediaId).toBe("@lALPDfmVR_test");
		expect(block.text).toBe("my screenshot");
	});

	test("handles empty caption", () => {
		const block = buildImageBlock("@lALPDfmVR_test", "");
		expect(block.type).toBe(3);
		expect(block.mediaId).toBe("@lALPDfmVR_test");
	});
});

describe("cardParamMapFromData", () => {
	test("serializes all v3 schema fields", () => {
		const map = cardParamMapFromData(
			{
				content: "answer text",
				blockList: [{ type: 0, text: "answer text", markdown: "answer text" }],
				quoteContent: "triggering message",
				statusLine: "model · agent",
				copyContent: "answer text",
				hasAction: false,
				version: 1,
			},
			"3",
		);
		expect(map.flowStatus).toBe("3");
		expect(map.content).toBe("answer text");
		expect(map.quoteContent).toBe("triggering message");
		expect(map.statusLine).toBe("model · agent");
		expect(map.copy_content).toBe("answer text");
		expect(JSON.parse(map.blockList)).toEqual([
			{ type: 0, text: "answer text", markdown: "answer text" },
		]);
		expect(JSON.parse(map.hasAction)).toBe(false);
		expect(JSON.parse(map.version)).toBe(1);
	});

	test("defaults all fields when data is empty", () => {
		const map = cardParamMapFromData({}, "1");
		expect(map.flowStatus).toBe("1");
		expect(map.content).toBe("");
		expect(JSON.parse(map.blockList)).toEqual([]);
		expect(map.quoteContent).toBe("");
		expect(map.statusLine).toBe("");
	});
});

describe("cardParamMapForStreamStart", () => {
	test("uses INPUTING status and includes content + blockList", () => {
		const map = cardParamMapForStreamStart("hello", [
			{ type: 0, text: "hello", markdown: "hello" },
		]);
		expect(map.flowStatus).toBe("2");
		expect(map.content).toBe("hello");
		expect(JSON.parse(map.blockList)).toEqual([
			{ type: 0, text: "hello", markdown: "hello" },
		]);
	});
});
