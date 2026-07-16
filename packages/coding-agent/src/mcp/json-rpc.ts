/**
 * MCP JSON-RPC 2.0 over HTTPS.
 *
 * Lightweight utilities for calling MCP servers directly via HTTP
 * without maintaining persistent connections.
 */
import { logger } from "@oh-my-pi/pi-utils";

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

/**
 * Call an MCP server with JSON-RPC 2.0 over HTTPS.
 *
 * Retries on 429 Too Many Requests with exponential backoff.
 *
 * @param url - Full MCP server URL (including any query parameters)
 * @param method - JSON-RPC method name (e.g., "tools/list", "tools/call")
 * @param params - Method parameters
 * @returns Parsed JSON-RPC response
 */
export async function callMCP<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
): Promise<JsonRpcResponse<T>> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < RETRY_429_MAX_ATTEMPTS; attempt++) {
		try {
			return await callMCPOnce(url, method, params);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("429") && attempt < RETRY_429_MAX_ATTEMPTS - 1) {
				const delay = RETRY_429_BACKOFF_MS[attempt] ?? 4_000;
				logger.warn("MCP 429 rate limit, retrying in " + delay + "ms", { attempt, url, method });
				await new Promise(r => setTimeout(r, delay));
				continue;
			}
			lastError = err instanceof Error ? err : new Error(String(err));
			break;
		}
	}
	throw lastError ?? new Error("MCP request failed");
}

async function callMCPOnce<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
): Promise<JsonRpcResponse<T>> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorMsg = `MCP request failed: ${response.status} ${response.statusText}`;
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
