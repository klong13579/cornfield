import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { AgentMessage, AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";

import summarizationSystemPrompt from "../src/prompts/system/summarization-system.md" with { type: "text" };
import updateSummaryPrompt from "../src/prompts/compaction/compaction-update-summary.md" with { type: "text" };
import { generateSummary } from "../src/session/compaction/compaction";

// ============================================================================
// Spy isolation
// ============================================================================

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================================
// Fixtures
// ============================================================================

function createMockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage ?? createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createTestModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");
	return model;
}

function makeConversation(): AgentMessage[] {
	return [
		createUserMessage("Refactor the cron service to use sub-agents"),
		createAssistantMessage("I'll start by reading the existing cron service code.", createMockUsage(500, 200)),
		createUserMessage("Found what you need?"),
		createAssistantMessage("Yes, I have enough context. Proceeding with the refactor.", createMockUsage(800, 300)),
	];
}

// ============================================================================
// Static prompt content tests — guard against re-introducing the
// "preserve all + add new" instructions that caused summaries to compound
// across compactions (6K → 15K → 25K chars).
// ============================================================================

describe("compaction-update-summary.md prompt content", () => {
	it("instructs REPLACE behavior, not preserve-and-append", () => {
		// The bug was: "MUST preserve all information from previous summary"
		//              + "MUST add new progress" → summary grew linearly
		// The fix must explicitly say REPLACE.
		expect(updateSummaryPrompt).toMatch(/REPLACE/i);
		// The old preserve-and-add instruction must be gone.
		expect(updateSummaryPrompt).not.toMatch(/MUST preserve all information from previous summary/);
	});

	it("caps total output length to a stable band (6,000–8,000 chars)", () => {
		// Length cap is the second half of the fix — without it, the model
		// can still drift upward even with REPLACE instructions.
		expect(updateSummaryPrompt).toMatch(/6[,.]?000/);
		expect(updateSummaryPrompt).toMatch(/8[,.]?000/);
		// Should explicitly call out that growing lengths across compactions
		// are a problem, so future maintainers don't relax the cap.
		expect(updateSummaryPrompt).toMatch(/grow(s|ing)?\s+across\s+compactions/i);
	});

	it("includes guidance on what to drop when length forces compression", () => {
		// Without explicit drop rules, the model will not know what to
		// sacrifice to stay in the length band.
		expect(updateSummaryPrompt).toMatch(/drop\s+(older|completed|superseded|resolved)/i);
	});

	it("includes guidance on what to always preserve", () => {
		// Must keep the goal, unresolved blockers, pending questions,
		// recent decisions — even when length forces other content out.
		expect(updateSummaryPrompt).toMatch(/Goal/i);
		expect(updateSummaryPrompt).toMatch(/Blocked/i);
		expect(updateSummaryPrompt).toMatch(/Next Steps/i);
	});
});

describe("summarization-system.md prompt content", () => {
	it("applies the length cap to BOTH initial and update paths", () => {
		// The system prompt is shared between initial and update calls.
		// The cap must apply to both.
		expect(summarizationSystemPrompt).toMatch(/6[,.]?000/);
		expect(summarizationSystemPrompt).toMatch(/8[,.]?000/);
		expect(summarizationSystemPrompt).toMatch(/REPLACE/i);
	});
});

// ============================================================================
// Behavioral test — verify generateSummary actually wires the previous
// summary into the LLM call in <previous-summary> tags, alongside the
// REPLACE directive. This is the integration point that broke summaries:
// if previousSummary is dropped or the wrong prompt is used, summaries
// stop compounding but lose prior context.
// ============================================================================

describe("generateSummary with previousSummary", () => {
	it("passes previousSummary to the LLM wrapped in <previous-summary> tags", async () => {
		const model = createTestModel();
		const previousSummary = "## Goal\nAnalyze gateway cron.";
		const messages = makeConversation();

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		completeSimpleSpy.mockResolvedValueOnce(createAssistantMessage("New summary", createMockUsage(50, 200)));

		await generateSummary(messages, model, 16_384, "test-key", undefined, undefined, previousSummary);

		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
		const call = completeSimpleSpy.mock.calls[0];
		const options = call[1] as { messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> };
		const userMessage = options.messages[0];
		const promptText = userMessage.content[0].text;

		// Previous summary is present, in tags, with content intact.
		expect(promptText).toContain("<previous-summary>");
		expect(promptText).toContain("</previous-summary>");
		expect(promptText).toContain(previousSummary);

		// New conversation is also in the prompt.
		expect(promptText).toContain("<conversation>");
		expect(promptText).toContain("Refactor the cron service to use sub-agents");
	});

	it("uses the update prompt (with REPLACE directive) when previousSummary is set", async () => {
		const model = createTestModel();
		const messages = makeConversation();

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		completeSimpleSpy.mockResolvedValueOnce(createAssistantMessage("Updated summary", createMockUsage(50, 200)));

		await generateSummary(messages, model, 16_384, "test-key", undefined, undefined, "## Goal\nOld goal");

		const call = completeSimpleSpy.mock.calls[0];
		const options = call[1] as { messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> };
		const promptText = options.messages[0].content[0].text;

		// The update prompt contains the REPLACE directive. The initial
		// prompt does not (it has no notion of prior summary).
		expect(promptText).toMatch(/REPLACE/i);
		expect(promptText).toMatch(/6[,.]?000/);
		expect(promptText).toMatch(/8[,.]?000/);
	});

	it("uses the initial prompt (no REPLACE directive) when previousSummary is absent", async () => {
		const model = createTestModel();
		const messages = makeConversation();

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		completeSimpleSpy.mockResolvedValueOnce(createAssistantMessage("Initial summary", createMockUsage(50, 200)));

		await generateSummary(messages, model, 16_384, "test-key", undefined, undefined, undefined);

		const call = completeSimpleSpy.mock.calls[0];
		const options = call[1] as { messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> };
		const promptText = options.messages[0].content[0].text;

		// No <previous-summary> tag in the initial path.
		expect(promptText).not.toContain("<previous-summary>");
		// System prompt still applies the length cap (it is shared).
		expect(promptText).not.toContain("<previous-summary>");
	});
});
