import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import * as piAi from "@oh-my-pi/pi-ai";
import { callBackgroundLlm } from "../src/utils/llm";

const testModel = {
	provider: "openai",
	id: "gpt-4o-mini",
	api: "openai-completions",
} as Model;

describe("callBackgroundLlm credentials", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("passes apiKey from auth to completeSimple", async () => {
		const completeSpy = vi.spyOn(piAi, "completeSimple").mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const result = await callBackgroundLlm(testModel, "system", "user", {
			auth: {
				getApiKey: async () => "registry-key",
			},
		});

		expect(result).toBe("ok");
		expect(completeSpy).toHaveBeenCalledTimes(1);
		const options = completeSpy.mock.calls[0]?.[2];
		expect(options?.apiKey).toBe("registry-key");
	});

	test("returns empty when auth has no api key", async () => {
		const completeSpy = vi.spyOn(piAi, "completeSimple");

		const result = await callBackgroundLlm(testModel, "system", "user", {
			auth: {
				getApiKey: async () => undefined,
			},
		});

		expect(result).toBe("");
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("returns empty on stopReason error", async () => {
		vi.spyOn(piAi, "completeSimple").mockResolvedValue({
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "401 invalid key",
			timestamp: Date.now(),
		});

		const result = await callBackgroundLlm(testModel, "system", "user", {
			auth: { getApiKey: async () => "k" },
		});

		expect(result).toBe("");
	});
});
