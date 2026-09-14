/**
 * `narwal-plan/glm-5.3` accepts only `reasoning_effort ∈ low|high|max` upstream
 * — every other token (including the harness default `medium` and the harness
 * top level `xhigh`) comes back as
 *
 *   400 该模型始终思考，不支持关闭思考；请使用 low、high 或 max
 *
 * (measured 2026-09-14 against https://coder.narwal.com/v1/chat/completions:
 * low/high/max = 200, medium/xhigh = 400).
 *
 * A session that emits a rejected token fails *on every turn*, which is how a
 * squad worker ended up alive-but-mute for 8 minutes while its parent waited on
 * an ack. This test locks the invariant that matters: **every level the model
 * advertises as supported must map onto a token the upstream accepts** — so the
 * next model added to this catalog cannot silently reintroduce the trap.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { clampThinkingLevelForModel, Effort, getSupportedEfforts } from "@cornfield/ai/model-thinking";
import { getBundledModel } from "@cornfield/ai/models";
import { streamOpenAICompletions } from "@cornfield/ai/providers/openai-completions";
import type { Context, Model, Tool } from "@cornfield/ai/types";
import { Type } from "@sinclair/typebox";

/** The vocabulary this gateway accepts for always-thinking GLM models. */
const UPSTREAM_ACCEPTED_EFFORTS = new Set(["low", "high", "max"]);

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
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

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

/** Capture the wire body the provider would send for a given reasoning level. */
function captureBody(model: Model<"openai-completions">, reasoning: Effort): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, ctx, {
		reasoning,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

function glm53(): Model<"openai-completions"> {
	const model = getBundledModel("narwal-plan", "glm-5.3");
	if (!model) throw new Error("bundled catalog is missing narwal-plan/glm-5.3");
	return model as Model<"openai-completions">;
}

describe("narwal-plan/glm-5.3 reasoning_effort vocabulary", () => {
	it("advertises only the levels the upstream accepts", () => {
		// medium and minimal are absent: the upstream rejects them outright.
		expect(getSupportedEfforts(glm53())).toEqual([Effort.Low, Effort.High, Effort.XHigh]);
	});

	it("emits a token the upstream accepts for every advertised level", async () => {
		const model = glm53();
		const emitted = new Map<string, string>();
		for (const level of getSupportedEfforts(model)) {
			const body = (await captureBody(model, level)) as { reasoning_effort?: string };
			expect(body.reasoning_effort).toBeDefined();
			emitted.set(level, body.reasoning_effort!);
		}

		// xhigh is harness vocabulary; the upstream spells the top level `max`.
		expect(Object.fromEntries(emitted)).toEqual({ low: "low", high: "high", xhigh: "max" });
		for (const token of emitted.values()) {
			expect(UPSTREAM_ACCEPTED_EFFORTS.has(token)).toBe(true);
		}
	});

	it("clamps the harness default (medium) into an accepted level before it reaches the wire", async () => {
		const model = glm53();
		// This is what the session layer does with `defaultThinkingLevel: medium`.
		const resolved = clampThinkingLevelForModel(model, Effort.Medium);
		expect(resolved).toBe(Effort.Low);

		const body = (await captureBody(model, resolved!)) as { reasoning_effort?: string };
		expect(body.reasoning_effort).toBe(Effort.Low);
	});
});
