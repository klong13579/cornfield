import { getAgentDbPath } from "@cornfield/utils";
import { AgentStorage } from "../../../session/agent-storage";
import { SearchProviderError, type SearchProviderId, type SearchSource } from "../types";
import { dateToAgeSeconds } from "../utils";

/**
 * Default hard ceiling for one web-search round trip, in milliseconds.
 *
 * 60s tolerates legitimately slow LLM-mediated providers (anthropic, codex,
 * gemini, perplexity) while still bounding a transport that stops making
 * progress. The provider chain advances only after `search()` settles, so an
 * unbounded request holds back every provider behind it.
 */
export const SEARCH_HARD_TIMEOUT_MS = 60_000;

/** Largest hard ceiling a user may configure, in milliseconds. */
export const MAX_SEARCH_HARD_TIMEOUT_MS = 300_000;

/** Largest response body a provider may return when it is read as text. */
export const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Largest error body a provider may return. An error body never needs to be large. */
export const MAX_SEARCH_ERROR_BYTES = 8 * 1024;

/**
 * Compose a caller-supplied {@link AbortSignal} with a hard timeout, so an
 * outbound `fetch()` settles within `ms` even when the runtime fails to
 * deliver the caller's cancellation to the underlying transport.
 *
 * Bun's WinHTTP backend ignores `AbortSignal` once a TCP/TLS connection
 * stalls (oven-sh/bun#15275, oven-sh/bun#18536), which left `web_search`
 * unable to settle. The timer supplies a second abort source that does not
 * depend on the caller cancelling.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param ms - Hard ceiling in milliseconds. Defaults to {@link SEARCH_HARD_TIMEOUT_MS}.
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Read a response body as text, up to `maxBytes`.
 *
 * A provider that streams more than the cap is misconfigured or hostile;
 * without the cap its whole body lands in memory and then in the model's
 * context. With `truncate: false` (the default) an oversized body raises a
 * {@link SearchProviderError} so the chain advances to another provider.
 * Error paths pass `truncate: true`: a long error body must not replace the
 * real failure with a size failure.
 */
export async function readLimitedText(
	response: Response,
	provider: SearchProviderId,
	maxBytes: number,
	truncate = false,
): Promise<string> {
	if (!response.body) return "";

	const reader = response.body.getReader();
	let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let bytes = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const accepted = Math.min(value.byteLength, maxBytes - bytes);
			const nextBytes = bytes + accepted;
			if (nextBytes > buffer.byteLength) {
				const grown = new Uint8Array(Math.min(maxBytes, Math.max(nextBytes, buffer.byteLength * 2)));
				grown.set(buffer.subarray(0, bytes));
				buffer = grown;
			}
			buffer.set(value.subarray(0, accepted), bytes);
			bytes = nextBytes;
			if (accepted < value.byteLength) {
				await reader.cancel().catch(() => undefined);
				if (!truncate) {
					throw new SearchProviderError(
						provider,
						`${provider} response body exceeded the ${maxBytes} byte limit`,
						500,
					);
				}
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	return new TextDecoder().decode(buffer.subarray(0, bytes));
}

/**
 * Search for an API credential by checking an env-derived key first,
 * then falling back to agent.db stored credentials for the given providers.
 *
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in AgentStorage
 */
export async function findCredential(
	envKey: string | null | undefined,
	...storageProviders: string[]
): Promise<string | null> {
	if (envKey) return envKey;

	try {
		const storage = await AgentStorage.open(getAgentDbPath());
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Probe whether a provider's API key lookup resolves to a truthy value.
 * Swallows lookup errors and reports unavailability.
 */
export async function isApiKeyAvailable(findApiKey: () => string | null | Promise<string | null>) {
	try {
		return !!(await findApiKey());
	} catch {
		return false;
	}
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}
