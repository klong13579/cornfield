/**
 * Opening the model selector must correct a stale catalog: it refreshes discovery for the
 * providers the session can actually pick from, then re-resolves the session scope and
 * rebuilds the list in place. Before this, a session kept the scope snapshot taken at
 * startup forever (main.ts resolved it once), so models added to the gateway never showed
 * up without a restart.
 */
import { describe, expect, test, vi } from "bun:test";
import type { Model } from "@cornfield/ai";
import type { ModelRegistry } from "@cornfield/coding-agent/config/model-registry";
import { Settings } from "@cornfield/coding-agent/config/settings";
import { ModelSelectorComponent } from "@cornfield/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@cornfield/coding-agent/modes/theme/theme";
import type { TUI } from "@cornfield/tui";

function makeModel(provider: string, id: string): Model {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as unknown as Model;
}

function normalizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function createSelector(config: {
	provider: string;
	scoped: Model[];
	resynced?: Model[];
	refreshProvider: (provider: string, strategy?: string) => Promise<void>;
}) {
	// The component renders through the global theme instance (same as InteractiveMode).
	if (testTheme) setThemeInstance(testTheme);
	const requestRender = vi.fn();
	const ui = { requestRender } as unknown as TUI;
	const settings = Settings.isolated();
	const modelRegistry = {
		getAll: () => config.scoped,
		getAvailable: () => config.scoped,
		getError: () => undefined,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getProviderDiscoveryState: () => ({ status: "ok", fetchedAt: Date.now() - 5 * 60_000 }),
		refresh: vi.fn(async () => {}),
		refreshProvider: config.refreshProvider,
	} as unknown as ModelRegistry;

	const scopedModels = config.scoped.map(model => ({ model, thinkingLevel: "off" }));
	const selector = new ModelSelectorComponent(
		ui,
		config.scoped[0],
		settings,
		modelRegistry,
		scopedModels,
		() => {},
		() => {},
		{
			resyncScope: async () => (config.resynced ?? config.scoped).map(model => ({ model, thinkingLevel: "off" })),
		},
	);

	return { selector, requestRender };
}

const testTheme = await getThemeByName("dark");

describe("ModelSelector discovery refresh on open", () => {
	test("refreshes the scoped providers and picks up newly discovered models", async () => {
		const existing = makeModel("anthropic", "claude-sonnet-4-5");
		const discovered = makeModel("anthropic", "claude-sonnet-4-5-next");
		const refreshProvider = vi.fn(async () => {});
		const { selector } = createSelector({
			provider: "anthropic",
			scoped: [existing],
			resynced: [existing, discovered],
			refreshProvider,
		});

		await Bun.sleep(10);
		setThemeInstance(testTheme!);

		expect(refreshProvider).toHaveBeenCalledWith("anthropic", "online");
		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("claude-sonnet-4-5-next");
		// Freshness + refresh affordance share the hint row (panes too short for two headers).
		expect(rendered).toContain("Showing models from --models scope");
		expect(rendered).toContain("Ctrl+R to refresh");
	});

	test("throttles repeat refreshes of the same provider across opens", async () => {
		const model = makeModel("alibaba-coding-plan", "qwen3-coder-plus");
		const refreshProvider = vi.fn(async () => {});

		createSelector({ provider: "alibaba-coding-plan", scoped: [model], refreshProvider });
		await Bun.sleep(10);
		expect(refreshProvider).toHaveBeenCalledTimes(1);

		// Second open inside the throttle window must not hit the gateway again.
		createSelector({ provider: "alibaba-coding-plan", scoped: [model], refreshProvider });
		await Bun.sleep(10);
		expect(refreshProvider).toHaveBeenCalledTimes(1);
	});

	test("Ctrl+R forces a refresh past the throttle", async () => {
		const model = makeModel("google", "gemini-3-pro");
		const refreshProvider = vi.fn(async () => {});
		const { selector } = createSelector({ provider: "google", scoped: [model], refreshProvider });
		await Bun.sleep(10);
		const callsAfterOpen = refreshProvider.mock.calls.length;

		selector.handleInput("\x12");
		await Bun.sleep(10);

		expect(refreshProvider.mock.calls.length).toBeGreaterThan(callsAfterOpen);
	});

	test("falls back to the cached list when the live refresh fails", async () => {
		const model = makeModel("openai", "gpt-5.4");
		const refreshProvider = vi.fn(async () => {
			throw new Error("gateway unreachable");
		});
		const { selector } = createSelector({ provider: "openai", scoped: [model], refreshProvider });
		await Bun.sleep(10);
		setThemeInstance(testTheme!);

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Live refresh failed");
		expect(rendered).toContain("gpt-5.4");
	});
});
