import { afterEach, describe, expect, it, vi } from "bun:test";
import { dropUnresolvedNewModels } from "../src/model-manager";
import { narwalPlanModelManagerOptions, UNK_CONTEXT_WINDOW } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

/** Run real discovery for narwal-plan against a stubbed `GET /v1/models` payload. */
async function discoverModels(payload: unknown[]) {
	global.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: payload }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as typeof fetch;
	return (await narwalPlanModelManagerOptions({ apiKey: "sk-narwal-test" }).fetchDynamicModels?.()) ?? [];
}

describe("dropUnresolvedNewModels", () => {
	it("drops a newly discovered model whose context window stayed unresolved", async () => {
		// No limit fields in the payload, no seed entry, no models.dev reference: baking this
		// model would ship the UNK window (222222) into the bundled catalog.
		const models = await discoverModels([{ id: "brand-new-model-x", object: "model" }]);
		expect(models.find(model => model.id === "brand-new-model-x")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);

		const { models: kept, dropped } = dropUnresolvedNewModels(models, []);
		expect(dropped).toEqual(["narwal-plan/brand-new-model-x"]);
		expect(kept.some(model => model.id === "brand-new-model-x")).toBe(false);
	});

	it("keeps an unresolved model that already shipped in the previous catalog", async () => {
		const models = await discoverModels([{ id: "brand-new-model-x", object: "model" }]);

		const { models: kept, dropped } = dropUnresolvedNewModels(models, models);
		expect(dropped).toEqual([]);
		expect(kept.some(model => model.id === "brand-new-model-x")).toBe(true);
	});

	it("keeps a model with a resolved window even when its output cap is unknown", async () => {
		const models = await discoverModels([{ id: "brand-new-model-y", object: "model", context_length: 1_000_000 }]);
		expect(models.find(model => model.id === "brand-new-model-y")?.contextWindow).toBe(1_000_000);

		const { dropped } = dropUnresolvedNewModels(models, []);
		expect(dropped).toEqual([]);
	});
});
