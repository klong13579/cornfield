/**
 * Streaming speech-to-text via the OpenAI-compatible realtime WebSocket endpoint.
 *
 * Turns the alt+h STT flow into "type as you speak": the mic PCM flows into
 * the server in 200ms slices, partial transcripts stream out live
 * (`onPartial`), and every manual commit (VAD silence) yields a final segment
 * (`onSegment`) that the caller inserts into the editor immediately.
 *
 * Same session shape as `transcribeViaApi` (transcriber.ts) — bench-verified
 * against qwen-audio-3.0-realtime-flash/plus: `modalities: ["text"]` with
 * `turn_detection: null` (the caller controls commit timing) and server-side
 * `input_audio_transcription: { model: "fun-asr" }`.
 */
import { buildRealtimeWsUrl, pcm16ToBase64, REALTIME_SAMPLE_RATE } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { float32ToPcm16, resamplePcm16 } from "./pcm";

/** Give up waiting for the session.updated ack (some servers never ack). */
const CONFIG_ACK_TIMEOUT_MS = 5_000;
/** Give up waiting for a committed segment's completed event (silence/quiet servers). */
const COMMIT_TIMEOUT_MS = 5_000;

export interface StreamingTranscriberOptions {
	/** e.g. "https://coder.narwal.com/v1" */
	baseUrl: string;
	apiKey: string;
	/** e.g. "qwen-audio-3.0-realtime-plus" */
	model: string;
	/** Called with each partial transcript delta while a segment is in flight. */
	onPartial?: (text: string) => void;
	/** Called with the final transcript of a committed segment. */
	onSegment?: (text: string) => void;
	/** Called when the server flags an error (transcription stays usable). */
	onError?: (err: Error) => void;
	/** Override the session.updated ack timeout (tests only). Default 5000ms. */
	configAckTimeoutMs?: number;
	/** Override the commit completed-event timeout (tests only). Default 5000ms. */
	commitTimeoutMs?: number;
}

export interface StreamingTranscriber {
	/**
	 * Feed a capture chunk of f32 samples (recorder's native 16kHz mono).
	 * Resamples to 24kHz and appends to the server in 200ms slices.
	 */
	feed(samples: Float32Array): void;
	/**
	 * Commit the accumulated input audio. The server finalizes the current
	 * segment and emits `conversation.item.input_audio_transcription.completed`.
	 * Resolves when that completed event lands (or the connection dies).
	 */
	commit(): Promise<void>;
	/** Close the connection. Safe to call multiple times. */
	dispose(): void;
}

/**
 * Create a streaming transcriber session. The returned object is inert until
 * this promise resolves (session.update acked), after which `feed()` may be
 * called. Rejects if the WebSocket handshake or session config fails.
 */
export async function createStreamingTranscriber(options: StreamingTranscriberOptions): Promise<StreamingTranscriber> {
	const wsUrl = buildRealtimeWsUrl(options.baseUrl.replace(/\/?$/, ""), options.model);

	// Bun's WebSocket accepts custom headers; the DOM lib type does not.
	const WebSocketWithHeaders = WebSocket as unknown as {
		new (url: string, init?: { headers?: Record<string, string> }): WebSocket;
	};
	const ws = new WebSocketWithHeaders(wsUrl, {
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
			"OpenAI-Beta": "realtime=v1",
		},
	});

	// Appends are sent per capture chunk (~100ms of audio); the streaming
	// endpoint consumes them incrementally and does not care about slice size.
	let currentSegment = "";

	// Manual commit state: the caller drives commit timing via VAD silence.
	let committing = false;
	let committedResolvers: (() => void) | undefined;

	const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	const readyTimer = setTimeout(() => {
		rejectReady(new Error("Streaming transcription: session config not acked"));
	}, options.configAckTimeoutMs ?? CONFIG_ACK_TIMEOUT_MS);

	ws.onopen = () => {
		logger.debug("streaming STT ws connected", { model: options.model });
	};

	ws.onmessage = (event: MessageEvent) => {
		if (typeof event.data !== "string") return;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(event.data) as Record<string, unknown>;
		} catch {
			return;
		}

		switch (msg.type as string) {
			case "session.created": {
				ws.send(
					JSON.stringify({
						type: "session.update",
						session: {
							modalities: ["text"],
							input_audio_format: "pcm16",
							input_audio_transcription: { model: "fun-asr" },
							turn_detection: null,
						},
					}),
				);
				break;
			}

			case "session.updated": {
				clearTimeout(readyTimer);
				resolveReady();
				break;
			}

			case "conversation.item.input_audio_transcription.delta": {
				const delta = msg.delta as string;
				if (delta) {
					currentSegment += delta;
					options.onPartial?.(currentSegment);
				}
				break;
			}

			case "conversation.item.input_audio_transcription.completed": {
				const finalTranscript = msg.transcript as string;
				currentSegment = "";
				options.onSegment?.(finalTranscript ?? "");
				if (committing) {
					committing = false;
					committedResolvers?.();
					committedResolvers = undefined;
				}
				break;
			}

			case "input_audio_buffer.committed": {
				// Ack for a manual commit; the transcript arrives separately.
				break;
			}

			case "error": {
				const err = new Error(`Streaming transcription error: ${(msg.message as string) ?? JSON.stringify(msg)}`);
				logger.error("streaming STT ws error", { message: err.message });
				options.onError?.(err);
				break;
			}
		}
	};

	ws.onerror = (err: Event) => {
		const errMsg = err instanceof ErrorEvent ? err.message : "WebSocket connection failed";
		rejectReady(new Error(`Streaming transcription connection error: ${errMsg}`));
	};

	ws.onclose = () => {
		if (committing) {
			// Connection died mid-commit: unblock the caller, drop the segment.
			committing = false;
			committedResolvers?.();
			committedResolvers = undefined;
		}
	};

	await ready;

	return {
		feed(samples: Float32Array) {
			if (ws.readyState !== WebSocket.OPEN) return;
			// Recorder is 16kHz; realtime expects 24kHz PCM16.
			const pcm16 = resamplePcm16(float32ToPcm16(samples), 16_000, REALTIME_SAMPLE_RATE);
			ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16ToBase64(pcm16) }));
		},

		commit() {
			if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
			committing = true;
			const { promise, resolve } = Promise.withResolvers<void>();
			committedResolvers = resolve;
			ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

			// The server is supposed to reply with input_audio_transcription.completed.
			// Some servers stay silent (quiet audio, half-dead connection); without
			// a timeout the caller (STT stop) awaits forever and re-toggles deadlock.
			const timer = setTimeout(() => {
				if (committedResolvers === resolve) {
					logger.warn("streaming STT commit timed out; dropping segment");
					committing = false;
					committedResolvers = undefined;
					resolve();
				}
			}, options.commitTimeoutMs ?? COMMIT_TIMEOUT_MS);

			return promise.finally(() => clearTimeout(timer));
		},

		dispose() {
			try {
				ws.close();
			} catch {
				// already closed
			}
		},
	};
}
