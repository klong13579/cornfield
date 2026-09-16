/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 *
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@cornfield/agent";
import { StringEnum } from "@cornfield/ai";
import { prompt } from "@cornfield/utils";
import { Type } from "@sinclair/typebox";
import { settings } from "../../config/settings";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import type { ToolSession } from "../../tools";
import { formatAge } from "../../tools/render-utils";
import { getSearchProvider, resolveProviderChain, type SearchProvider } from "./provider";
import { MAX_SEARCH_HARD_TIMEOUT_MS, SEARCH_HARD_TIMEOUT_MS } from "./providers/utils";
import { renderSearchCall, renderSearchResult, type SearchRenderDetails } from "./render";
import type { SearchProviderId, SearchResponse } from "./types";
import { SearchProviderError } from "./types";

/** Web search tool parameters schema */
export const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	recency: Type.Optional(
		StringEnum(["day", "week", "month", "year"], {
			description: "Recency filter (Brave, Perplexity)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max results to return" })),
	max_tokens: Type.Optional(Type.Number({ description: "Maximum output tokens" })),
	temperature: Type.Optional(Type.Number({ description: "Sampling temperature" })),
	num_search_results: Type.Optional(Type.Number({ description: "Number of search results to retrieve" })),
});

export type SearchToolParams = {
	query: string;
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	/** Maximum output tokens. Defaults to 4096. */
	max_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. Defaults to 0.2. */
	temperature?: number;
	/** Number of search results to retrieve. Defaults to 10. */
	num_search_results?: number;
};

export interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
}

function formatProviderError(error: unknown, provider: SearchProvider): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			return `${getSearchProvider(error.provider).label} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** One provider's failure, kept so the final report can name every cause. */
interface SearchFailure {
	provider: SearchProvider;
	error: unknown;
}

/** Longest single failure message kept in the combined failure report. */
const MAX_FAILURE_CHARS = 300;

/**
 * True when a response carries anything the model can use.
 *
 * A 200 with no answer, sources, citations, or queries is indistinguishable
 * from success when returned verbatim, so the chain treats it as a failure and
 * tries the next provider instead.
 */
function hasRenderableContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

/**
 * Hard ceiling for one provider request, in milliseconds, from settings.
 *
 * Falls back to the built-in default when Settings is not initialized (the
 * one-shot `q` CLI path and unit tests), so the chain never aborts before any
 * provider has run.
 */
function resolveHardTimeoutMs(): number {
	try {
		const configuredSeconds = settings.get("providers.webSearchTimeoutSeconds");
		if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
			return Math.min(configuredSeconds, MAX_SEARCH_HARD_TIMEOUT_MS / 1000) * 1000;
		}
	} catch {
		// Settings unavailable; keep the built-in ceiling.
	}
	return SEARCH_HARD_TIMEOUT_MS;
}

/** Report every provider failure, not only the last one. */
function formatFailures(failures: readonly SearchFailure[]): string {
	const [first, ...rest] = failures;
	if (!first) return "No web search provider configured.";
	const firstMessage = truncateText(formatProviderError(first.error, first.provider), MAX_FAILURE_CHARS);
	if (rest.length === 0) return firstMessage;
	const parts = failures.map(
		failure =>
			`${failure.provider.id}: ${truncateText(formatProviderError(failure.error, failure.provider), MAX_FAILURE_CHARS)}`,
	);
	return `All ${failures.length} available web search providers failed — ${parts.join("; ")}`;
}

/** Truncate text for tool output */
function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatCount(label: string, count: number): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

/** Format response for LLM consumption */
function formatForLLM(response: SearchResponse): string {
	const parts: string[] = [];

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncateText(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncateText(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncateText(query, 120)}`);
		}
	}

	return parts.join("\n");
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const providers =
		params.provider && params.provider !== "auto"
			? (await getSearchProvider(params.provider).isAvailable())
				? [getSearchProvider(params.provider)]
				: await resolveProviderChain("auto")
			: await resolveProviderChain();
	if (providers.length === 0) {
		const message = "No web search provider configured.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	const timeoutMs = resolveHardTimeoutMs();
	const failures: SearchFailure[] = [];

	for (const provider of providers) {
		try {
			const response = await provider.search({
				query: params.query.replace(/202\d/g, String(new Date().getFullYear())), // LUL
				limit: params.limit,
				recency: params.recency,
				systemPrompt: webSearchSystemPrompt,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal,
				timeoutMs,
			});

			// A 200 with nothing in it is not a result. Treat it as a provider
			// failure so the chain advances, instead of handing the model an empty
			// success it cannot tell apart from "the web has no answer".
			if (!hasRenderableContent(response)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no usable results`, 204);
			}

			const text = formatForLLM(response);

			return {
				content: [{ type: "text" as const, text }],
				details: { response },
			};
		} catch (error) {
			// An abort must propagate — falling through would start the next
			// provider and keep a cancelled turn alive (the 67s web_search case).
			if (signal?.aborted) throw error;
			failures.push({ provider, error });
		}
	}

	const message = formatFailures(failures);

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { response: { provider: failures.at(-1)?.provider.id ?? "none", sources: [] }, error: message },
	};
}

/**
 * Execute a web search query for CLI/testing workflows.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	return executeSearch("cli-web-search", params);
}

/**
 * Web search tool implementation.
 *
 * Supports Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Z.AI, SearXNG, and Synthetic providers with automatic fallback.
 * Session is accepted for interface consistency but not used.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchRenderDetails> {
	readonly name = "web_search";
	readonly label = "Web Search";
	readonly loadMode = "essential" as const;
	readonly summary = "Finds up-to-date information on the web.";
	readonly description: string;
	readonly parameters = webSearchSchema;
	readonly strict = true;

	constructor(_session: ToolSession) {
		this.description = prompt.render(webSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		return executeSearch(_toolCallId, params, signal);
	}
}

/** Web search tool as CustomTool (for TUI rendering support) */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchRenderDetails> = {
	name: "web_search",
	label: "Web Search",
	description: prompt.render(webSearchDescription),
	parameters: webSearchSchema,

	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		return executeSearch(toolCallId, params, signal);
	},

	renderCall(args: SearchToolParams, options: RenderResultOptions, theme: Theme) {
		return renderSearchCall(args, options, theme);
	},

	renderResult(result, options: RenderResultOptions, theme: Theme) {
		return renderSearchResult(result, options, theme);
	},
};

export function getSearchTools(): CustomTool<any, any>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider, setPreferredSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
export { isSearchProviderPreference } from "./types";
