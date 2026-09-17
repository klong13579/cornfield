/**
 * MCP JSON-RPC 2.0 over HTTPS.
 *
 * Lightweight utilities for calling MCP servers directly via HTTP
 * without maintaining persistent connections.
 */
import { logger } from "@cornfield/utils";

/** Parse SSE response format (lines starting with "data: ") */
export function parseSSE(text: string): unknown {
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			const data = line.slice(6).trim();
			if (data === "[DONE]") continue;
			const result = JSON.parse(data) as unknown;
			if (result) return result;
		}
	}
	// Fallback: try parsing entire response as JSON
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** JSON-RPC 2.0 response structure */
export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: string | number;
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

const RETRY_429_MAX_ATTEMPTS = 3;
const RETRY_429_BACKOFF_MS = [1_000, 2_000, 4_000];

/** Default ceiling for one MCP round trip, matching `transports/http.ts`'s 30s default. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/** How much of a non-OK body is kept in the thrown message. */
const MAX_ERROR_EXCERPT = 300;

/**
 * Fields that name the cause in an error envelope (Cloudflare and friends).
 * Ordered most specific first, so the cap drops prose before it drops the cause.
 */
const ERROR_BODY_FIELDS = ["error_name", "error_code", "title", "detail", "message", "error", "what_you_should_do"];

export interface CallMcpOptions {
	/** Caller cancellation. A cancel aborts the request instead of waiting out the ceiling. */
	signal?: AbortSignal;
	/** Hard ceiling for the whole call, in ms. Defaults to {@link DEFAULT_MCP_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/**
 * Call an MCP server with JSON-RPC 2.0 over HTTPS.
 *
 * Retries on 429 Too Many Requests with exponential backoff. Every attempt is
 * bounded: without a ceiling a stalled connection holds the caller forever,
 * because this transport has no other way to settle.
 *
 * @param url - Full MCP server URL (including any query parameters)
 * @param method - JSON-RPC method name (e.g., "tools/list", "tools/call")
 * @param params - Method parameters
 * @param options - Cancellation signal and hard ceiling
 * @returns Parsed JSON-RPC response
 */
export async function callMCP<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
	options: CallMcpOptions = {},
): Promise<JsonRpcResponse<T>> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < RETRY_429_MAX_ATTEMPTS; attempt++) {
		try {
			return await callMCPOnce(url, method, params, options);
		} catch (err) {
			options.signal?.throwIfAborted();
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("429") && attempt < RETRY_429_MAX_ATTEMPTS - 1) {
				const delay = RETRY_429_BACKOFF_MS[attempt] ?? 4_000;
				logger.warn(`MCP 429 rate limit, retrying in ${delay}ms`, { attempt, url, method });
				await abortableDelay(delay, options.signal);
				continue;
			}
			lastError = err instanceof Error ? err : new Error(String(err));
			break;
		}
	}
	throw lastError ?? new Error("MCP request failed");
}

/**
 * Sleep that rejects when the caller cancels, instead of waiting out a backoff.
 * A cancel has to surface rather than be mistaken for a retryable delay.
 */
async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(ms);
		return;
	}
	signal.throwIfAborted();

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	const onAbort = (): void => reject(signal.reason);
	try {
		signal.addEventListener("abort", onAbort, { once: true });
		await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

async function callMCPOnce<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
	options: CallMcpOptions = {},
): Promise<JsonRpcResponse<T>> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_MCP_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (error) {
		// Separate a caller cancel from our own ceiling: the caller needs the
		// cancel to surface unchanged, and a ceiling needs to say what it was.
		if (options.signal?.aborted) throw error;
		if (timeoutSignal.aborted) {
			throw new Error(`MCP request timed out after ${timeoutMs}ms`);
		}
		throw error;
	}

	if (!response.ok) {
		// Keep the body: on a blocked or throttled endpoint it names the reason
		// (Cloudflare reports a ban as a short JSON envelope).
		const excerpt = await readExcerpt(response);
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}${excerpt ? ` — ${excerpt}` : ""}`;
		logger.error(errorMsg, { url, method, params });
		throw new Error(errorMsg);
	}

	const text = await response.text();
	const result = parseSSE(text) as JsonRpcResponse<T> | null;

	if (!result) {
		logger.error("Failed to parse MCP response", { url, method, responseText: text.slice(0, 500) });
		throw new Error("Failed to parse MCP response");
	}

	return result;
}

/**
 * Reduce a non-OK response body to a short excerpt that still names the cause.
 *
 * A plain prefix is not enough: the field naming the cause can sit past any cap
 * (Cloudflare puts `error_name` last), so a JSON body is reduced to its known
 * diagnostic fields first and only then capped.
 */
function summarizeErrorBody(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (!collapsed) return "";

	const capped = (value: string): string =>
		value.length > MAX_ERROR_EXCERPT ? `${value.slice(0, MAX_ERROR_EXCERPT)}…` : value;

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return capped(collapsed);
	}
	if (typeof parsed !== "object" || parsed === null) return capped(collapsed);

	const record = parsed as Record<string, unknown>;
	const picked: string[] = [];
	for (const key of ERROR_BODY_FIELDS) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			picked.push(`${key}=${value.trim()}`);
		}
	}
	return capped(picked.length > 0 ? picked.join("; ") : collapsed);
}

/** Bounded, best-effort text excerpt of a non-OK response body. */
async function readExcerpt(response: Response): Promise<string> {
	try {
		return summarizeErrorBody(await response.text());
	} catch {
		return "";
	}
}
