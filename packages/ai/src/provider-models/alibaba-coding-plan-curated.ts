/**
 * Alibaba Coding Plan (DashScope OpenAI-compatible): models exposed in OMP bundled catalog and selector.
 * Used by runtime discovery (`openai-compat`) and coding-agent bundled load (`ModelRegistry.#loadBuiltInModels`).
 */
export const ALIBABA_CODING_PLAN_SELECTOR_MODEL_IDS: ReadonlySet<string> = new Set([
	"qwen3.6-flash",
	"qwen3.6-plus",
	"deepseek-v4-pro",
	"deepseek-v4-flash",
	"glm-5.1",
	"MiniMax-M2.5",
]);
