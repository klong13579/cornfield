import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { alibabaCodingPlanModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";

const originalAlibabaApiKey = Bun.env.ALIBABA_CODING_PLAN_API_KEY;

afterEach(() => {
	if (originalAlibabaApiKey === undefined) {
		delete Bun.env.ALIBABA_CODING_PLAN_API_KEY;
		return;
	}
	Bun.env.ALIBABA_CODING_PLAN_API_KEY = originalAlibabaApiKey;
});

const KNOWN_EMOJI = /^[💬💻🧠👁🎤🔊🎨🎬🔢]\s/u;

describe("alibaba-coding-plan provider support", () => {
	const options = alibabaCodingPlanModelManagerOptions();
	const staticModels = options.staticModels ?? [];

	test("resolves ALIBABA_CODING_PLAN_API_KEY from environment", () => {
		Bun.env.ALIBABA_CODING_PLAN_API_KEY = "alibaba-test-key";
		expect(getEnvApiKey("alibaba-coding-plan")).toBe("alibaba-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "alibaba-coding-plan");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("qwen3.6-plus");
		expect(DEFAULT_MODEL_PER_PROVIDER["alibaba-coding-plan"]).toBe("qwen3.6-plus");
	});

	test("builds model manager options with alibaba-coding-plan defaults", () => {
		expect(options.providerId).toBe("alibaba-coding-plan");
		expect(options.fetchDynamicModels).toBeDefined();
	});

	test("enriches static models with emoji + cost + context + input + reasoning", () => {
		expect(staticModels.length).toBeGreaterThan(0);

		const UNK_CTX = 222_222;
		const UNK_MAX = 8_888;

		for (const model of staticModels) {
			// name is prefixed with an emoji
			expect(KNOWN_EMOJI.test(model.name), `${model.id} name missing emoji: ${model.name}`).toBe(true);

			// context + max tokens are not UNK
			expect(model.contextWindow, `${model.id} contextWindow UNK`).not.toBe(UNK_CTX);
			expect(model.maxTokens, `${model.id} maxTokens UNK`).not.toBe(UNK_MAX);
			expect(model.contextWindow, `${model.id} contextWindow must be > 0`).toBeGreaterThan(0);
			expect(model.maxTokens, `${model.id} maxTokens must be > 0`).toBeGreaterThan(0);

			// input always includes text
			expect(model.input, `${model.id} input missing text`).toContain("text");

			// reasoning is a boolean
			expect(typeof model.reasoning).toBe("boolean");
		}
	});

	test("classifier assigns coding emoji to qwen3-coder-*", () => {
		const coderPlus = staticModels.find(m => m.id === "qwen3-coder-plus");
		const coderNext = staticModels.find(m => m.id === "qwen3-coder-next");
		expect(coderPlus?.name.startsWith("💻")).toBe(true);
		expect(coderNext?.name.startsWith("💻")).toBe(true);
	});

	test("classifier assigns chat emoji to third-party chat models (glm/kimi/MiniMax)", () => {
		for (const id of ["glm-4.7", "glm-5", "kimi-k2.5", "MiniMax-M2.5"]) {
			const m = staticModels.find(model => model.id === id);
			expect(m, `${id} missing from staticModels`).toBeDefined();
			expect(m?.name.startsWith("💬"), `${id} should be 💬 chat, got: ${m?.name}`).toBe(true);
		}
	});

	test("classifier marks qwen3-max-* (non-thinking) as chat emoji + non-zero context", () => {
		const m = staticModels.find(model => model.id === "qwen3-max-2026-01-23");
		expect(m?.name.startsWith("💬")).toBe(true);
		expect(m?.contextWindow).toBeGreaterThan(0);
		expect(m?.reasoning).toBe(false);
	});

	test("sets category field for every static model", () => {
		for (const model of staticModels) {
			expect(model.category, `${model.id} category missing`).toBeDefined();
			const cat = model.category;
			if (!cat) continue;
			expect([
				"chat",
				"coding",
				"reasoning",
				"vision",
				"asr",
				"tts",
				"image",
				"video",
				"embedding",
			] as const).toContain(cat);
		}
	});

	test("category matches emoji prefix on name", () => {
		const categoryToEmoji: Record<string, string> = {
			chat: "💬",
			coding: "💻",
			reasoning: "🧠",
			vision: "👁",
			asr: "🎤",
			tts: "🔊",
			image: "🎨",
			video: "🎬",
			embedding: "🔢",
		};
		for (const model of staticModels) {
			if (!model.category) continue;
			const expectedEmoji = categoryToEmoji[model.category];
			expect(
				model.name.startsWith(expectedEmoji),
				`${model.id} category=${model.category} but name=${model.name}`,
			).toBe(true);
		}
	});

	test("applies cost overrides to 9 static models (no zero cost)", () => {
		for (const model of staticModels) {
			expect(model.cost.input, `${model.id} cost.input`).toBeGreaterThan(0);
			expect(model.cost.output, `${model.id} cost.output`).toBeGreaterThan(0);
			expect(model.cost.cacheRead, `${model.id} cost.cacheRead`).toBeGreaterThanOrEqual(0);
			expect(model.cost.cacheWrite, `${model.id} cost.cacheWrite`).toBeGreaterThanOrEqual(0);
		}
	});
});
