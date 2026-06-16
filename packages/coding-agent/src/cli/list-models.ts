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
 * List available models, optionally filtered by search pattern.
 *
 * Only models confirmed by dynamic discovery are shown. For providers whose
 * discovery fetch failed (e.g. invalid/expired credentials), nothing is shown
 * for that provider.
 */
export async function listModels(modelRegistry: ModelRegistry, searchPattern?: string): Promise<void> {
	const models = modelRegistry.getVerifiedAvailable();

	if (models.length === 0) {
		writeLine("No models available. Set API keys in environment variables.");
		return;
	}

	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, model => `${model.provider} ${model.id}`);
	}

	if (filteredModels.length === 0) {
		writeLine(`No models matching "${searchPattern}"`);
		return;
	}

	filteredModels.sort((left, right) => {
		const providerCmp = left.provider.localeCompare(right.provider);
		if (providerCmp !== 0) return providerCmp;
		return left.id.localeCompare(right.id);
	});

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
