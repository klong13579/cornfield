/**
 * WebSocket transport for OpenAI-compatible realtime speech APIs.
 *
 * Bench-verified against narwal-plan (`wss://coder.narwal.com/v1/realtime`,
 * qwen-audio-3.0-realtime-flash/plus) speaking the OpenAI Realtime event protocol.
 *
 * Reconnect contract: on an unintentional drop the transport retries with
 * exponential backoff, then emits state "connected" again. Session config is NOT
 * replayed by the transport — callers must re-send `session.update` on every
 * "connected" transition (the server treats each socket as a fresh session).
 */
import { logger } from "@cornfield/utils";
import { pcm16ToBase64 } from "./audio";
import { parseRealtimeServerEvent, type RealtimeClientEvent, type RealtimeServerEvent } from "./protocol";

export type RealtimeTransportState = "idle" | "connecting" | "connected" | "reconnecting" | "closing" | "closed";

export interface RealtimeReconnectPolicy {
	/** Max consecutive reconnect attempts before giving up (state → "closed"). */
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

const DEFAULT_RECONNECT: RealtimeReconnectPolicy = {
	maxAttempts: 3,
	baseDelayMs: 1_000,
	maxDelayMs: 10_000,
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

export interface RealtimeTransportOptions {
	/** `https://host/v1` or a full `wss://` URL. The `/realtime?model=` suffix is added when missing. */
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Extra handshake headers (merged over Authorization + OpenAI-Beta). */
	headers?: Record<string, string>;
	reconnect?: Partial<RealtimeReconnectPolicy>;
	handshakeTimeoutMs?: number;
}

/** Builds the WebSocket URL from a base URL and model id. */
export function buildRealtimeWsUrl(baseUrl: string, model: string): string {
	const url = new URL(baseUrl);
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	if (!url.pathname.endsWith("/realtime")) {
		url.pathname = `${url.pathname.replace(/\/$/, "")}/realtime`;
	}
	url.searchParams.set("model", model);
	return url.toString();
}

// Bun's WebSocket accepts custom headers; the DOM lib type does not. Same cast
// pattern as providers/openai-codex-responses.ts.
const WebSocketWithHeaders = WebSocket as unknown as {
	new (url: string, options?: { headers?: Record<string, string> }): WebSocket;
};

export class RealtimeWsTransport {
	readonly #options: RealtimeTransportOptions;
	readonly #reconnect: RealtimeReconnectPolicy;
	readonly #listeners = new Set<(event: RealtimeServerEvent) => void>();
	readonly #stateListeners = new Set<(state: RealtimeTransportState) => void>();

	#ws: WebSocket | undefined;
	#state: RealtimeTransportState = "idle";
	#attempts = 0;
	#intentionalClose = false;

	constructor(options: RealtimeTransportOptions) {
		this.#options = options;
		this.#reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect };
	}

	get state(): RealtimeTransportState {
		return this.#state;
	}

	addEventListener(listener: (event: RealtimeServerEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	addStateListener(listener: (state: RealtimeTransportState) => void): () => void {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	/** Connects and resolves once the server's `session.created` arrives. */
	async connect(): Promise<void> {
		if (this.#state === "connected" || this.#state === "connecting") return;
		// A closed transport is terminal: reconnecting here would resurrect a
		// socket nobody owns (dispose races) and loop forever.
		if (this.#state === "closed") {
			throw new Error("realtime transport is closed, cannot reconnect");
		}
		this.#intentionalClose = false;
		await this.#open();
	}

	/** Sends one client event. Throws when the socket is not live — silent drops are worse. */
	send(event: RealtimeClientEvent): void {
		if (this.#state !== "connected" || !this.#ws) {
			throw new Error(`realtime transport not connected (state=${this.#state}), cannot send ${event.type}`);
		}
		this.#ws.send(JSON.stringify(event));
	}

	/** Convenience wrapper for streaming one PCM16 chunk. */
	appendAudio(pcm: Uint8Array): void {
		this.send({ type: "input_audio_buffer.append", audio: pcm16ToBase64(pcm) });
	}

	async close(): Promise<void> {
		if (this.#state === "closed" || this.#state === "closing") return;
		this.#intentionalClose = true;
		this.#setState("closing");
		const ws = this.#ws;
		this.#ws = undefined;
		try {
			ws?.close();
		} catch (err) {
			logger.debug("realtime transport close threw", { error: String(err) });
		}
		this.#setState("closed");
	}

	async #open(): Promise<void> {
		this.#setState(this.#attempts > 0 ? "reconnecting" : "connecting");
		const url = buildRealtimeWsUrl(this.#options.baseUrl, this.#options.model);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.#options.apiKey}`,
			"OpenAI-Beta": "realtime=v1",
			...this.#options.headers,
		};

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timeout = setTimeout(
			() =>
				reject(
					new Error(
						`realtime handshake timeout after ${this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS}ms`,
					),
				),
			this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
		);

		const ws = new WebSocketWithHeaders(url, { headers });
		this.#ws = ws;

		const unsubscribe = this.addEventListener(event => {
			if (event.type === "session.created") {
				clearTimeout(timeout);
				unsubscribe();
				resolve();
			} else if (event.type === "error") {
				clearTimeout(timeout);
				unsubscribe();
				reject(new Error(`realtime session error: ${event.message}`));
			}
		});

		ws.onopen = () => {
			this.#attempts = 0;
			this.#setState("connected");
		};
		ws.onmessage = message => {
			if (typeof message.data !== "string") return;
			let raw: unknown;
			try {
				raw = JSON.parse(message.data);
			} catch {
				logger.warn("realtime transport received non-JSON frame", { preview: message.data.slice(0, 120) });
				return;
			}
			const event = parseRealtimeServerEvent(raw);
			for (const listener of this.#listeners) listener(event);
		};
		ws.onerror = event => {
			clearTimeout(timeout);
			logger.warn("realtime transport socket error", { error: String(event) });
			if (this.#state === "connecting" || this.#state === "reconnecting") {
				reject(new Error("realtime socket error during handshake"));
			}
		};
		ws.onclose = event => {
			clearTimeout(timeout);
			this.#ws = undefined;
			if (this.#intentionalClose) {
				this.#setState("closed");
				return;
			}
			logger.warn("realtime transport dropped", { code: event.code, reason: event.reason });
			this.#scheduleReconnect().catch(err => {
				logger.error("realtime reconnect failed", { error: String(err) });
				this.#setState("closed");
			});
		};

		return promise;
	}

	async #scheduleReconnect(): Promise<void> {
		if (this.#attempts >= this.#reconnect.maxAttempts) {
			logger.error("realtime reconnect attempts exhausted", { attempts: this.#attempts });
			this.#setState("closed");
			return;
		}
		this.#attempts += 1;
		const delay = Math.min(this.#reconnect.baseDelayMs * 2 ** (this.#attempts - 1), this.#reconnect.maxDelayMs);
		this.#setState("reconnecting");
		await Bun.sleep(delay);
		if (this.#intentionalClose) {
			this.#setState("closed");
			return;
		}
		await this.#open();
	}

	#setState(state: RealtimeTransportState): void {
		if (this.#state === state) return;
		this.#state = state;
		for (const listener of this.#stateListeners) listener(state);
	}
}
