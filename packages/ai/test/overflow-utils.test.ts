import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { isContextOverflow } from "@oh-my-pi/pi-ai/utils/overflow";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow - model_context_window_exceeded", () => {
	it("detects model_context_window_exceeded in finish_reason error message", () => {
		const message = createErrorMessage("Provider finish_reason: model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects raw model_context_window_exceeded in error message", () => {
		const message = createErrorMessage("model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});
});

describe("isContextOverflow - HTTP 413 variants", () => {
	it("detects generic 413 payload-too-large errors", () => {
		const message = createErrorMessage("413 Request Entity Too Large: payload too large for request body");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects Anthropic request size overflow wording", () => {
		const message = createErrorMessage("Request exceeds the maximum size allowed by this model");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("does not classify unrelated 413 errors as overflow", () => {
		const message = createErrorMessage("413 Forbidden");
		expect(isContextOverflow(message)).toBe(false);
	});
});
function createUsage(input: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("isContextOverflow - fallback usage", () => {
	it("detects overflow via fallback usage when gateway swallows the real error text", () => {
		// Regression: new-api style gateway shells (observed on narwal-plan)
		const message = createErrorMessage(
			"400 openai_error (type=bad_response_status_code param=bad_response_status_code)",
		);
		expect(isContextOverflow(message, 1_000_000, createUsage(1_003_237))).toBe(true);
	});

	it("does not classify as overflow when fallback usage is within the window", () => {
		const message = createErrorMessage(
			"400 openai_error (type=bad_response_status_code param=bad_response_status_code)",
		);
		expect(isContextOverflow(message, 1_000_000, createUsage(500_000))).toBe(false);
	});

	it("prefers the message's own nonzero usage over the fallback", () => {
		const message = createErrorMessage("400 openai_error");
		message.usage = createUsage(900_000);
		expect(isContextOverflow(message, 1_000_000, createUsage(1_500_000))).toBe(false);
	});

	it("returns false without fallback when the error turn carries zeroed usage", () => {
		const message = createErrorMessage("400 openai_error");
		expect(isContextOverflow(message, 1_000_000)).toBe(false);
	});
});
