/**
 * List available models with optional fuzzy search
 */
import { type Api, getSupportedEfforts, type Model } from "@oh-my-pi/pi-ai";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { fuzzyFilter } from "../utils/fuzzy";

interface ProviderRow {
	provider: string;
	model: string;
	context: string;
	maxOut: string;
	thinking: string;
	images: string;
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function renderTable<T extends Record<string, string>>(rows: T[], headers: T): void {
	const widths = Object.fromEntries(
		Object.keys(headers).map(key => [key, Math.max(headers[key]!.length, ...rows.map(row => row[key]!.length))]),
	) as Record<keyof T, number>;

	const headerLine = Object.keys(headers)
		.map(key => headers[key as keyof T]!.padEnd(widths[key as keyof T]))
		.join("  ");
	writeLine(headerLine);

	for (const row of rows) {
		const line = Object.keys(headers)
			.map(key => row[key as keyof T]!.padEnd(widths[key as keyof T]))
			.join("  ");
		writeLine(line);
	}
}

/**
 * Collect verified available models, optionally scoped to an allowlist,
 * sorted by provider then model id.
 *
 * Shared data layer used by both the CLI `--list-models` command and the
 * LLM `list_models` tool. Callers layer their own search filter and
 * output formatting on top.
 */
export function collectVerifiedModels(
	modelRegistry: ModelRegistry,
	enabledModelIds?: Set<string>,
): Model<Api>[] {
	let models = modelRegistry.getVerifiedAvailable();

	if (enabledModelIds && enabledModelIds.size > 0) {
		models = models.filter(m => enabledModelIds.has(`${m.provider}/${m.id}`));
	}

	models.sort((left, right) => {
		const providerCmp = left.provider.localeCompare(right.provider);
		if (providerCmp !== 0) return providerCmp;
		return left.id.localeCompare(right.id);
	});

	return models;
}

/**
 * List available models, optionally filtered by search pattern.
 *
 * Only models confirmed by dynamic discovery are shown. For providers whose
 * discovery fetch failed (e.g. invalid/expired credentials), nothing is shown
 * for that provider.
 *
 * When `enabledModelIds` is provided (non-empty), only models whose
 * `provider/id` appears in the set are listed. This makes --list-models
 * match the model selector's enabledModels allowlist.
 */
export async function listModels(
	modelRegistry: ModelRegistry,
	searchPattern?: string,
	enabledModelIds?: Set<string>,
): Promise<void> {
	let filteredModels = collectVerifiedModels(modelRegistry, enabledModelIds);

	if (filteredModels.length === 0) {
		writeLine(enabledModelIds?.size ? "No models available." : "No models available. Set API keys in environment variables.");
		return;
	}

	if (searchPattern) {
		filteredModels = fuzzyFilter(filteredModels, searchPattern, model => `${model.provider} ${model.id}`);
		if (filteredModels.length === 0) {
			writeLine(`No models matching "${searchPattern}"`);
			return;
		}
	}


	const providerRows = filteredModels.map(model => ({
		provider: model.provider,
		model: model.id,
		context: formatNumber(model.contextWindow),
		maxOut: formatNumber(model.maxTokens),
		thinking: model.thinking ? getSupportedEfforts(model).join(",") : model.reasoning ? "yes" : "-",
		images: model.input.includes("image") ? "yes" : "no",
	})) satisfies ProviderRow[];

	renderTable(providerRows, {
		provider: "provider",
		model: "model",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	});
}
