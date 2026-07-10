/**
 * Real omp agent model hot-swap integration test.
 *
 * Starts a real omp --mode rpc subprocess and tests the model
 * management RPC commands end-to-end: get_available_models,
 * set_model, get_state. This proves the model hot-swap path
 * works through the actual agent, not just through mocks.
 */
import { describe, expect, test } from "bun:test";
import { AgentBridge } from "../src/agent-bridge";

describe("real omp agent model hot-swap", () => {
	const bridge = new AgentBridge({
		ompPath: "omp",
	});

	test("starts real omp agent", async () => {
		await bridge.start();
		expect(bridge.isRunning).toBe(true);
	});

	test("getAvailableModels returns real model list", async () => {
		const response = await bridge.getAvailableModels();
		expect(response.success).toBe(true);
		expect(response.command).toBe("get_available_models");
		const data = response.data as { models: Array<{ provider: string; id: string }> };
		expect(Array.isArray(data.models)).toBe(true);
		expect(data.models.length).toBeGreaterThan(0);

		// Verify at least narwal-plan models are present
		const narwalModels = data.models.filter(m => m.provider === "narwal-plan");
		expect(narwalModels.length).toBeGreaterThan(0);
	});

	test("getState returns current model with provider and id", async () => {
		const response = await bridge.getState();
		expect(response.success).toBe(true);
		const state = response.data as { model: { provider: string; id: string }; thinkingLevel: string };
		expect(state.model).toBeDefined();
		expect(state.model.provider).toBeTruthy();
		expect(state.model.id).toBeTruthy();
	});

	test("setModel hot-swaps to a different model", async () => {
		// Get current model first
		const initialState = await bridge.getState();
		const initialModel = (initialState.data as { model: { provider: string; id: string } }).model;

		// Get available models to find a different one to switch to
		const modelsResp = await bridge.getAvailableModels();
		const models = (modelsResp.data as { models: Array<{ provider: string; id: string }> }).models;

		// Find a model that's different from current
		const differentModel = models.find(m => m.provider !== initialModel.provider || m.id !== initialModel.id);
		expect(differentModel).toBeDefined();
		if (!differentModel) return;

		// Switch model
		const switchResp = await bridge.setModel(differentModel.provider, differentModel.id);
		expect(switchResp.success).toBe(true);
		const switchedModel = switchResp.data as { provider: string; id: string };
		expect(switchedModel.provider).toBe(differentModel.provider);
		expect(switchedModel.id).toBe(differentModel.id);

		// Verify the change persisted via getState
		const newState = await bridge.getState();
		const newModel = (newState.data as { model: { provider: string; id: string } }).model;
		expect(newModel.provider).toBe(differentModel.provider);
		expect(newModel.id).toBe(differentModel.id);
	});

	test("setModel fails gracefully for nonexistent model", async () => {
		await expect(bridge.setModel("nonexistent-provider", "no-such-model")).rejects.toThrow();
	});

	test("cleanup: stop bridge", async () => {
		bridge.stop();
		expect(bridge.isRunning).toBe(false);
	});
});
