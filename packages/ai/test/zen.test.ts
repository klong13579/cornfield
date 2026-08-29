import { describe, expect, it } from "bun:test";
import MODELS from "@cornfield/ai/models.json" with { type: "json" };
import { complete } from "@cornfield/ai/stream";
import type { Model } from "@cornfield/ai/types";
import { e2eApiKey } from "./oauth";

describe.skipIf(!e2eApiKey("OPENCODE_API_KEY"))("OpenCode Models Smoke Test", () => {
	const providers = [
		{ key: "opencode-zen", label: "OpenCode Zen" },
		{ key: "opencode-go", label: "OpenCode Go" },
	] as const;

	providers.forEach(({ key, label }) => {
		const providerModels = Object.values(MODELS[key]);
		providerModels.forEach(model => {
			it(`${label}: ${model.id}`, async () => {
				const response = await complete(model as unknown as Model, {
					messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
				});

				expect(response.content).toBeTruthy();
				expect(response.stopReason).toBe("stop");
			}, 60000);
		});
	});
});
