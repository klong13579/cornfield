/**
 * narwal-plan ids that must ride `/v1/responses`.
 *
 * The gateway's `gpt-6-astra` / `gpt-5.6-luna` / `gpt-5.6-terra` upstreams
 * refuse function tools on `/v1/chat/completions` whenever reasoning is engaged
 * — including when `reasoning_effort` is omitted altogether (measured
 * 2026-09-17: any non-empty `tools` → 400 "Function tools with reasoning_effort
 * are not supported … use /v1/responses"; the "set reasoning_effort to 'none'"
 * advice in that message is dead — `none` comes back as "Unsupported value").
 * Every agent turn carries tools, so those ids have no usable request on the
 * completions transport at all.
 *
 * This file pins both halves: the api the catalog declares, and the wire each
 * transport actually produces for those ids (and for the ids that must stay on
 * completions, so a blanket flip cannot silently strip their effort ladder).
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { Type } from "@sinclair/typebox";

import { NARWAL_PLAN_STATIC_MODELS, type NarwalPlanApi } from "../src/provider-models/narwal-plan";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Context, Model, Tool } from "../src/types";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: Type.Object({ text: Type.String() }),
};

const ctx: Context = {
	messages: [{ role: "user", content: "do it", timestamp: Date.now() }],
	tools: [echoTool],
};

function seedModel(id: string): Model<NarwalPlanApi> {
	const model = NARWAL_PLAN_STATIC_MODELS.find(candidate => candidate.id === id);
	if (!model) {
		throw new Error(`seed entry missing for ${id}`);
	}
	return model;
}

function getRequestUrl(input: string | URL | Request): string {
	if (input instanceof Request) {
		return input.url;
	}
	return typeof input === "string" ? input : input.toString();
}

/** Capture the one request the provider emits, then fail it (we only read the wire). */
function captureRequest(): { urls: string[]; bodies: Array<Record<string, unknown>> } {
	const urls: string[] = [];
	const bodies: Array<Record<string, unknown>> = [];
	global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		urls.push(getRequestUrl(input));
		bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
		return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { urls, bodies };
}

describe("narwal-plan responses transport", () => {
	it("declares the tools-hostile ids as responses-only, leaving their permissive siblings alone", () => {
		for (const id of ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-terra"]) {
			expect(seedModel(id).api).toBe("openai-responses");
		}
		// Controls measured on the same day: these still return 200 with tools on
		// chat/completions, so they must not be swept along.
		expect(seedModel("gpt-5.6-sol").api).toBe("openai-completions");
		expect(seedModel("gpt-5.5").api).toBe("openai-completions");
		expect(seedModel("minimax-m3").api).toBe("openai-completions");
	});

	it("posts a responses-API seed to /responses with flat tools and no reasoning_effort", async () => {
		const { urls, bodies } = captureRequest();

		const result = await streamOpenAIResponses(seedModel("gpt-6-astra") as Model<"openai-responses">, ctx, {
			apiKey: "sk-narwal-test",
			reasoning: "medium",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(urls[0]).toBe("https://coder.narwal.com/v1/responses");

		const body = bodies[0]!;
		// The completions-only knobs must be absent on this transport…
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.max_completion_tokens).toBeUndefined();
		// …while the responses spellings carry the same intent.
		expect(body.input).toBeDefined();
		expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "echo",
				description: "Echo input",
				parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			},
		]);
	});

	it("still sends reasoning_effort for the ids that keep the completions transport", async () => {
		const { urls, bodies } = captureRequest();

		// deepseek-v4-flash keeps the OpenAI-shaped effort knob (minimax ids use
		// `enable_thinking` instead, so they cannot serve as the control here).
		const result = await streamOpenAICompletions(seedModel("deepseek-v4-flash") as Model<"openai-completions">, ctx, {
			apiKey: "sk-narwal-test",
			reasoning: "medium",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(urls[0]).toBe("https://coder.narwal.com/v1/chat/completions");
		expect((bodies[0] as { reasoning_effort?: unknown }).reasoning_effort).toBe("medium");
	});
});
