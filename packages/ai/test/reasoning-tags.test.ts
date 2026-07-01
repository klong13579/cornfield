import { describe, expect, it } from "bun:test";
import {
	findFirstTag,
	getTrailingPartialTag,
	REASONING_CLOSE_TAGS,
	REASONING_OPEN_TAGS,
	shouldParseReasoningTags,
	stripReasoningTagsFromText,
} from "../src/utils/reasoning-tags";

describe("stripReasoningTagsFromText", () => {
	describe("basic stripping", () => {
		it("strips a single <think> block", () => {
			expect(stripReasoningTagsFromText("<think>secret reasoning</think>visible answer")).toBe("visible answer");
		});

		it("strips a single <think> block followed by visible text on a new line", () => {
			expect(stripReasoningTagsFromText("<think>\nsecret\n</think>\nvisible answer")).toBe("\nvisible answer");
		});

		it("strips multiple <think> blocks", () => {
			expect(stripReasoningTagsFromText("<think>first</think>one<think>second</think>two")).toBe("onetwo");
		});

		it("strips the namespaced antml:think variant", () => {
			expect(stripReasoningTagsFromText("<antml:think>secret</antml:think>visible")).toBe("visible");
		});

		it("strips the namespaced mm:think variant (MiniMax M3)", () => {
			expect(stripReasoningTagsFromText("<mm:think>secret reasoning</mm:think>visible answer")).toBe(
				"visible answer",
			);
		});

		it("strips the thought variant", () => {
			expect(stripReasoningTagsFromText("<thought>secret</thought>visible")).toBe("visible");
		});

		it("strips the reasoning variant", () => {
			expect(stripReasoningTagsFromText("<reasoning>secret</reasoning>visible")).toBe("visible");
		});

		it("strips the antthinking variant", () => {
			expect(stripReasoningTagsFromText("<antthinking>secret</antthinking>visible")).toBe("visible");
		});

		it("returns text unchanged when no tags are present", () => {
			const input = "Just normal text with <html> and <body> tags that are not thinking tags.";
			expect(stripReasoningTagsFromText(input)).toBe(input);
		});

		it("returns empty string for empty input", () => {
			expect(stripReasoningTagsFromText("")).toBe("");
		});

		it("handles multiline reasoning content", () => {
			const input = `<think>
line 1 of reasoning
line 2 of reasoning
</think>
visible answer`;
			const result = stripReasoningTagsFromText(input);
			expect(result).not.toContain("reasoning");
			expect(result).toContain("visible answer");
		});
	});

	describe("code-region preservation", () => {
		it("preserves <think> literal inside a fenced code block", () => {
			const input = "Some prose.\n\n```\n<think>this is example code</think>\n```\n\nMore prose.";
			expect(stripReasoningTagsFromText(input)).toBe(input);
		});

		it("preserves <think> inside a python fenced block", () => {
			const input = 'Example:\n\n```python\nresult = "<think>fake</think>"\n```\n\nDone.';
			expect(stripReasoningTagsFromText(input)).toBe(input);
		});

		it("preserves ~~~ tilde-fenced blocks with mm:think", () => {
			const input = "Code:\n\n~~~\n<mm:think>fake</mm:think>\n~~~\n\nEnd.";
			expect(stripReasoningTagsFromText(input)).toBe(input);
		});

		it("strips reasoning before code block and after", () => {
			const input = "<think>hidden</think>before\n```\n<think>kept</think>\n```\n<think>hidden again</think>after";
			const result = stripReasoningTagsFromText(input);
			expect(result).toBe("before\n```\n<think>kept</think>\n```\nafter");
		});

		it("does not touch text outside the reasoning-tag set", () => {
			const input = "Use <html> and <body> freely. Also <custom> tags work.";
			expect(stripReasoningTagsFromText(input)).toBe(input);
		});
	});

	describe("realistic stream content", () => {
		it("removes the leaked preamble that streaming parser missed", () => {
			// Simulates a case where the streaming parser failed to move the
			// <think> block into a thinking content block (e.g. unknown namespace
			// or chunk-boundary bug). The renderer should still clean it up.
			const input = "<think>The user asked 2+2. Answer is 4.</mm:think>The answer is 4.";
			expect(stripReasoningTagsFromText(input)).toBe("The answer is 4.");
		});

		it("preserves code examples that happen to look like reasoning tags", () => {
			const input = `<think>thinking...</mm:think>Here's an example:

\`\`\`xml
<think>example</think>
\`\`\`

That's the syntax.`;
			const result = stripReasoningTagsFromText(input);
			expect(result).toBe("Here's an example:\n\n```xml\n<think>example</think>\n```\n\nThat's the syntax.");
		});
	});
});

describe("shouldParseReasoningTags", () => {
	describe("provider allowlist", () => {
		it("enables for minimax-code provider regardless of model id", () => {
			expect(shouldParseReasoningTags({ provider: "minimax-code", id: "anything" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "minimax-code", id: "M2" })).toBe(true);
		});

		it("enables for narwal-plan provider (the user's gateway)", () => {
			expect(shouldParseReasoningTags({ provider: "narwal-plan", id: "minimax-m3" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "narwal-plan", id: "qwen3.5-flash" })).toBe(true);
		});

		it("does not enable for unrelated providers by default", () => {
			expect(shouldParseReasoningTags({ provider: "openai", id: "gpt-4o" })).toBe(false);
			expect(shouldParseReasoningTags({ provider: "anthropic", id: "claude-sonnet-4-5" })).toBe(false);
			expect(shouldParseReasoningTags({ provider: "alibaba-coding-plan", id: "qwen-plus" })).toBe(false);
		});
	});

	describe("model id patterns", () => {
		it("matches MiniMax / antml / mm / minimaxai prefix (case-insensitive)", () => {
			expect(shouldParseReasoningTags({ provider: "x", id: "minimax-m3" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "MiniMax-M2" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "antml-anything" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "mm-something" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "minimaxai-v1" })).toBe(true);
		});

		it("matches the explicit MiniMax prefix", () => {
			expect(shouldParseReasoningTags({ provider: "x", id: "MiniMax-sonnet" })).toBe(true);
		});

		it("matches model ids ending in -thinking", () => {
			expect(shouldParseReasoningTags({ provider: "x", id: "qwen3-thinking" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "deepseek-r1-0528-thinking" })).toBe(true);
		});

		it("matches deepseek reasoning variants the user has in models.yml", () => {
			expect(shouldParseReasoningTags({ provider: "x", id: "deepseek-r1-0528" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "deepseek-v3-0324" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "deepseek-v3.1-terminus" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "deepseek-v3.2" })).toBe(true);
			expect(shouldParseReasoningTags({ provider: "x", id: "deepseek-v4-pro" })).toBe(true);
		});

		it("does not match NVIDIA's deepseek-ai/... naming (handled by chat-template stripper instead)", () => {
			// Regression: the broad `^deepseek-` would have turned on the
			// reasoning-tag parser for NVIDIA NIM's `deepseek-ai/deepseek-v4-flash`,
			// suppressing the chat-template special-token stripper and breaking
			// `openai-completions-compat.test.ts`. The narrower pattern keeps
			// NVIDIA's path on the deepseek stripper branch.
			expect(shouldParseReasoningTags({ provider: "nvidia", id: "deepseek-ai/deepseek-v4-flash" })).toBe(false);
			expect(shouldParseReasoningTags({ provider: "nvidia", id: "deepseek-ai/deepseek-v3.1" })).toBe(false);
		});

		it("does not match unrelated model ids", () => {
			expect(shouldParseReasoningTags({ provider: "x", id: "gpt-4o" })).toBe(false);
			expect(shouldParseReasoningTags({ provider: "x", id: "claude-sonnet-4-5" })).toBe(false);
			expect(shouldParseReasoningTags({ provider: "x", id: "llama-3.1-70b" })).toBe(false);
			expect(shouldParseReasoningTags({ provider: "x", id: "qwen3.5-flash" })).toBe(false);
		});
	});

	describe("regression: the original bug", () => {
		it("the exact failing case from session 185119__374fa743.jsonl parses", () => {
			// The user's actual session showed: narwal-plan/minimax-m3 emitted
			// `<think>...</think>` inline in `content` and the parser was
			// off because the old gate only matched `minimax-code`. The new
			// gate must return true for this combination.
			expect(shouldParseReasoningTags({ provider: "narwal-plan", id: "minimax-m3" })).toBe(true);
		});
	});
});

describe("findFirstTag", () => {
	it("returns the earliest matching tag", () => {
		const result = findFirstTag("hello <think>reasoning</think> world", REASONING_OPEN_TAGS);
		expect(result).toBeDefined();
		expect(result?.tag).toBe("<think>");
		expect(result?.index).toBe(6);
	});

	it("picks the earliest when multiple tags could match", () => {
		// <think> appears at index 0, </think> at index 20.
		// The open set should pick <think> (the first open tag).
		const result = findFirstTag("<think>then text then </think>", REASONING_OPEN_TAGS);
		expect(result?.tag).toBe("<think>");
		expect(result?.index).toBe(0);
	});

	it("returns undefined when no tag is present", () => {
		expect(findFirstTag("plain text without tags", REASONING_OPEN_TAGS)).toBeUndefined();
	});

	it("matches namespaced variants", () => {
		const result = findFirstTag("hello <mm:think>x", REASONING_OPEN_TAGS);
		expect(result?.tag).toBe("<mm:think>");
		expect(result?.index).toBe(6);
	});

	it("matches close tags when passed the close set", () => {
		const result = findFirstTag("x</think>y", REASONING_CLOSE_TAGS);
		expect(result?.tag).toBe("</think>");
	});

	it("returns the literal tag the parser will consume, including any prefix collision", () => {
		// `<think>` is a prefix of `<thinking>` and `<thought>`. The parser
		// needs the literal that starts the match, which is `<think>` here.
		const result = findFirstTag("<think>ing", REASONING_OPEN_TAGS);
		expect(result?.tag).toBe("<think>");
	});
});

describe("getTrailingPartialTag", () => {
	it("returns empty string when no tag could be in progress", () => {
		expect(getTrailingPartialTag("hello world", REASONING_OPEN_TAGS)).toBe("");
	});

	it("holds back a trailing `<` that could grow into a tag", () => {
		expect(getTrailingPartialTag("hello <", REASONING_OPEN_TAGS)).toBe("<");
	});

	it("holds back `<thi` that could grow into `<think>`", () => {
		expect(getTrailingPartialTag("hello <thi", REASONING_OPEN_TAGS)).toBe("<thi");
	});

	it("holds back the longest matching prefix when several tags could start", () => {
		// Both `<think>` and `<thinking` are valid prefixes of the trailing
		// slice; the helper must hold back the longest to avoid splitting
		// at a point where a longer tag could still arrive.
		const held = getTrailingPartialTag("hello <thinkin", REASONING_OPEN_TAGS);
		expect(held.length).toBeGreaterThanOrEqual("<thin".length);
		expect("<thinkin".startsWith(held)).toBe(true);
	});

	it("returns empty when the buffer ends with text that cannot start a tag", () => {
		expect(getTrailingPartialTag("hello abc", REASONING_OPEN_TAGS)).toBe("");
	});

	it("does not hold back content that already contains a complete tag", () => {
		// Once a complete `<think>` is present, the buffer could be split
		// right after it; no partial needs holding.
		expect(getTrailingPartialTag("<think>done</think>", REASONING_OPEN_TAGS)).toBe("");
	});
});
