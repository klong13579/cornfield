/**
 * Shared types and utilities for web-fetch handlers
 */

import * as dns from "node:dns/promises";
import { ptree } from "@oh-my-pi/pi-utils";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { ToolAbortError } from "../../tools/tool-errors";

export { formatNumber } from "@oh-my-pi/pi-utils";

export interface RenderResult {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	content: string;
	fetchedAt: string;
	truncated: boolean;
	notes: string[];
}

export type SpecialHandler = (url: string, timeout: number, signal?: AbortSignal) => Promise<RenderResult | null>;

export const MAX_OUTPUT_CHARS = 500_000;
export const MAX_BYTES = 50 * 1024 * 1024;

const USER_AGENTS = [
	"curl/8.0",
	"Mozilla/5.0 (compatible; TextBot/1.0)",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function isBotBlocked(status: number, content: string): boolean {
	if (status === 403 || status === 503) {
		const lower = content.toLowerCase();
		return (
			lower.includes("cloudflare") ||
			lower.includes("captcha") ||
			lower.includes("challenge") ||
			lower.includes("blocked") ||
			lower.includes("access denied") ||
			lower.includes("bot detection")
		);
	}
	return false;
}

/**
 * Truncate and cleanup output
 */
export function finalizeOutput(content: string): { content: string; truncated: boolean } {
	const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
	const truncated = cleaned.length > MAX_OUTPUT_CHARS;
	return {
		content: cleaned.slice(0, MAX_OUTPUT_CHARS),
		truncated,
	};
}

export interface LoadPageOptions {
	timeout?: number;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	maxBytes?: number;
	signal?: AbortSignal;
	/** When true (default), blocks requests to private/internal IP addresses (SSRF protection). */
	blockPrivateUrls?: boolean;
}

export interface LoadPageResult {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;
}

/**
 * Always-blocked hostnames — cloud metadata endpoints that have no legitimate
 * agent fetch target under any configuration.
 */
const ALWAYS_BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata.goog", "metadata.tencentyun.com"]);

/**
 * Check whether a URL targets a private/internal/forbidden network address.
 *
 * DNS-resolves the hostname and checks against:
 * - Always-blocked hostnames (cloud metadata endpoints)
 * - Private IP ranges (RFC 1918, RFC 6598 CGNAT)
 * - Loopback, link-local, multicast, reserved addresses
 *
 * Returns null if safe, or an error message string if blocked.
 */
export async function checkUrlSsrf(url: string): Promise<string | null> {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();

		if (ALWAYS_BLOCKED_HOSTNAMES.has(hostname)) {
			return `URL blocked for security: ${hostname} is a cloud metadata endpoint`;
		}

		// Check if the hostname is already an IP literal
		const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
		if (ipMatch) {
			const ip = hostname;
			const reason = isPrivateOrBlockedIp(ip);
			if (reason) {
				return `URL blocked for security: ${ip} is a ${reason}`;
			}
			// Public IP literal — let the request proceed
			return null;
		}

		// Resolve the hostname to IP(s)
		let addresses: string[];
		try {
			const resolved = await dns.resolve4(hostname);
			addresses = resolved;
		} catch {
			// Also try AAAA (IPv6) if IPv4 fails
			try {
				const resolved = await dns.resolve6(hostname);
				addresses = resolved;
			} catch {
				// DNS resolution failed entirely — let the request proceed
				// (the fetch itself will fail if the host is truly unreachable)
				return null;
			}
		}

		for (const ip of addresses) {
			const reason = isPrivateOrBlockedIp(ip);
			if (reason) {
				return `URL blocked for security: ${hostname} resolves to ${reason} (${ip})`;
			}
		}

		return null;
	} catch {
		// URL parsing failed — let the request proceed so the caller sees a normal fetch error
		return null;
	}
}

/**
 * Check if an IP address is private, loopback, link-local, CGNAT, or multicast.
 * Returns a human-readable reason string, or null if the IP is publicly routable.
 */
function isPrivateOrBlockedIp(ip: string): string | null {
	if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") {
		return "loopback address";
	}

	const ipv4 = addressToInt(ip);
	if (ipv4 === -1) return null; // Not a valid IPv4 address

	if (
		(ipv4 >= 0x0a000000 && ipv4 <= 0x0affffff) || // 10.0.0.0/8
		(ipv4 >= 0xac100000 && ipv4 <= 0xac1fffff) || // 172.16.0.0/12
		(ipv4 >= 0xc0a80000 && ipv4 <= 0xc0a8ffff) || // 192.168.0.0/16
		(ipv4 >= 0x64400000 && ipv4 <= 0x647fffff) || // 100.64.0.0/10 (CGNAT)
		(ipv4 >= 0xa9fe0000 && ipv4 <= 0xa9feffff) || // 169.254.0.0/16 (link-local)
		(ipv4 >= 0x7f000000 && ipv4 <= 0x7fffffff) // 127.0.0.0/8 (loopback)
	) {
		return "private network address";
	}

	return null;
}

function addressToInt(ip: string): number {
	const parts = ip.split(".");
	if (parts.length !== 4) return -1;
	for (const p of parts) {
		const n = Number.parseInt(p, 10);
		if (Number.isNaN(n) || n < 0 || n > 255) return -1;
	}
	// >>> 0 converts signed int32 to unsigned, making range comparisons correct
	return (
		((Number.parseInt(parts[0]!, 10) << 24) |
			(Number.parseInt(parts[1]!, 10) << 16) |
			(Number.parseInt(parts[2]!, 10) << 8) |
			Number.parseInt(parts[3]!, 10)) >>>
		0
	);
}

/**
 * Fetch a page with timeout and size limit
 */
export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
	const {
		timeout = 20,
		headers = {},
		maxBytes = MAX_BYTES,
		signal,
		method = "GET",
		body,
		blockPrivateUrls = true,
	} = options;

	// SSRF check — block requests to private/internal IPs before any network call
	if (blockPrivateUrls) {
		const ssrfBlocked = await checkUrlSsrf(url);
		if (ssrfBlocked) {
			return { content: ssrfBlocked, contentType: "", finalUrl: url, ok: false };
		}
	}

	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}

		const userAgent = USER_AGENTS[attempt];
		const perAttemptTimeout = Math.ceil((timeout * 1000) / USER_AGENTS.length);
		const requestSignal = ptree.combineSignals(signal, perAttemptTimeout);

		try {
			const requestInit: RequestInit = {
				signal: requestSignal,
				method,
				headers: {
					"User-Agent": userAgent,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					"Accept-Encoding": "identity", // Cloudflare Markdown-for-Agents returns corrupted bytes when compression is negotiated
					...headers,
				},
				redirect: "follow",
			};

			if (body !== undefined) {
				requestInit.body = body;
			}

			const response = await fetch(url, requestInit);

			const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
			const finalUrl = response.url;

			const reader = response.body?.getReader();
			if (!reader) {
				return { content: "", contentType, finalUrl, ok: false, status: response.status };
			}

			const chunks: Uint8Array[] = [];
			let totalSize = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				chunks.push(value);
				totalSize += value.length;

				if (totalSize > maxBytes) {
					reader.cancel();
					break;
				}
			}

			const content = Buffer.concat(chunks).toString("utf-8");
			if (isBotBlocked(response.status, content) && attempt < USER_AGENTS.length - 1) {
				continue;
			}

			if (!response.ok) {
				return { content, contentType, finalUrl, ok: false, status: response.status };
			}

			return { content, contentType, finalUrl, ok: true, status: response.status };
		} catch (_err) {
			if (requestSignal?.aborted) {
				throw new ToolAbortError();
			}
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			if (attempt === USER_AGENTS.length - 1) {
				return { content: "", contentType: "", finalUrl: url, ok: false };
			}
		}
	}

	return { content: "", contentType: "", finalUrl: url, ok: false };
}

/** Module-level Turndown instance — matches markit-ai's configuration. */
const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
turndown.use(gfm);
turndown.addRule("strikethrough", {
	filter: ["del", "s", "strike"],
	replacement(content) {
		return `~~${content}~~`;
	},
});
turndown.addRule("heading", {
	filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
	replacement(content, node) {
		const level = Number(node.nodeName.charAt(1));
		const prefix = "#".repeat(level);
		const cleaned = content.replace(/\\([.])/g, "$1").trim();
		return `\n\n${prefix} ${cleaned}\n\n`;
	},
});

type TurndownListParent = {
	nodeName: string;
	getAttribute(name: string): string | null;
	children: ArrayLike<unknown>;
};

turndown.addRule("listItem", {
	filter: "li",
	replacement(content, node, options) {
		content = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
		const parent = node.parentNode as unknown as TurndownListParent | null;
		let prefix = `${options.bulletListMarker} `;
		if (parent?.nodeName === "OL") {
			const start = parent.getAttribute("start");
			const index = Array.prototype.indexOf.call(parent.children, node);
			prefix = `${(start ? Number(start) : 1) + index}. `;
		}
		return prefix + content + (node.nextSibling ? "\n" : "");
	},
});

/**
 * Convert HTML to markdown using Turndown with GFM support.
 * Strips script/style tags before conversion.
 */
export function htmlToBasicMarkdown(html: string): string {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	return turndown.turndown(cleaned).trim();
}

/**
 * Build a RenderResult from markdown content. Calls finalizeOutput internally.
 */
export function buildResult(
	md: string,
	opts: { url: string; finalUrl?: string; method: string; fetchedAt: string; notes?: string[]; contentType?: string },
): RenderResult {
	const output = finalizeOutput(md);
	return {
		url: opts.url,
		finalUrl: opts.finalUrl ?? opts.url,
		contentType: opts.contentType ?? "text/markdown",
		method: opts.method,
		content: output.content,
		fetchedAt: opts.fetchedAt,
		truncated: output.truncated,
		notes: opts.notes ?? [],
	};
}

/**
 * Format a date value as YYYY-MM-DD. Returns empty string on invalid input.
 */
export function formatIsoDate(value?: string | number | Date): string {
	if (value == null) return "";
	if (typeof value === "string") {
		const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/);
		if (datePrefix) return datePrefix[0];
	}
	try {
		return new Date(value).toISOString().split("T")[0];
	} catch {
		return "";
	}
}

/**
 * Decode common HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ");
}

/**
 * Format seconds into HH:MM:SS or MM:SS.
 */
export function formatMediaDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = Math.floor(totalSeconds % 60);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Extract localized text, preferring en-US/en.
 */
export type LocalizedText = string | Record<string, string | null> | null | undefined;

export function getLocalizedText(value: LocalizedText, defaultLocale?: string): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
	return (
		value["en-US"] ?? value.en_US ?? value.en ?? Object.values(value).find(v => typeof v === "string") ?? undefined
	);
}

/**
 * Check if content looks like HTML by inspecting the leading tag.
 */
export function looksLikeHtml(content: string): boolean {
	const trimmed = content.trim().toLowerCase();
	return (
		trimmed.startsWith("<!doctype") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<head") ||
		trimmed.startsWith("<body")
	);
}
