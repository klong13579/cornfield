/**
 * LiveSessionController — the duplex voice state machine.
 *
 * Owns the realtime transport, mic source, and speaker sink, and drives the
 * phase machine:
 *
 *   connecting → listening ⇄ thinking ⇄ speaking
 *                    ↑           │          │
 *                    └───────────┴── interrupted (barge-in)
 *
 * Key behaviors (all bench-verified against qwen realtime):
 * - The mic streams CONTINUOUSLY, including silence — server_vad's audio clock
 *   only advances with frames, so capture is never paused mid-session. Mute
 *   swaps live chunks for silence frames instead of stopping capture.
 * - Barge-in: `speech_started` while speaking → `response.cancel` + sink.stop()
 *   (client-side discard; qwen sends no reliable truncation event) + an
 *   immediate "interrupted" phase flash, then back to listening.
 * - Echo gate: while speaking, a speech_started below `bargeInLevel` RMS is
 *   treated as speaker bleed and ignored.
 */
import {
	base64ToPcm16,
	createSilenceChunk,
	pcm16ToBase64,
	RealtimeFunctionBridge,
	type RealtimeServerEvent,
} from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { float32ToPcm16, pcm16ToFloat32, rmsLevel } from "../stt/pcm";
import type { LiveAudioSink, LiveConsultHandler, LivePhase, LiveSessionCallbacks, LiveSessionOptions } from "./types";

const DEFAULT_BARGE_IN_LEVEL = 0.04;
const CONSULT_TOOL_NAME = "omp_agent_consult";
/** Silence frames replace mic input while muted (server_vad clock must keep ticking). */
const MUTED_CHUNK_MS = 100;

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export class LiveSessionController {
	readonly #options: LiveSessionOptions;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #bridge: RealtimeFunctionBridge;
	readonly #bargeInLevel: number;
	readonly #onConsult: LiveConsultHandler;

	#phase: LivePhase = "connecting";
	#sink: LiveAudioSink | undefined;
	#muted = false;
	#started = false;
	#disposed = false;
	#inputLevel = 0;
	#outputLevel = 0;
	#removeTransportListeners: Array<() => void> = [];

	constructor(options: LiveSessionOptions) {
		this.#options = options;
		this.#callbacks = options.callbacks;
		this.#bargeInLevel = options.bargeInLevel ?? DEFAULT_BARGE_IN_LEVEL;
		this.#onConsult = options.onConsult ?? (async () => "（语音任务委托尚未接入，请改用文字输入。）");
		this.#bridge = new RealtimeFunctionBridge(options.transport);
		this.#bridge.registerTool({
			name: CONSULT_TOOL_NAME,
			description:
				"Delegate any task requiring files, shell, business systems, or multi-step work to the omp agent. Chitchat and confirmations stay local.",
			parameters: {
				type: "object",
				properties: { task: { type: "string", description: "The user's task, verbatim-enriched." } },
				required: ["task"],
			},
		});
	}

	get phase(): LivePhase {
		return this.#phase;
	}

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		// Field initializer is already "connecting"; emit explicitly since setPhase dedups.
		this.#callbacks.onPhase("connecting");

		this.#removeTransportListeners.push(
			this.#options.transport.addEventListener(event => this.#onServerEvent(event)),
			this.#options.transport.addStateListener(state => {
				if (state === "connected") this.#onTransportConnected();
				if (state === "closed" && !this.#disposed) {
					this.#callbacks.onTerminal(new Error("realtime connection closed"));
				}
			}),
		);

		this.#bridge.attach(async call => {
			const task = JSON.parse(call.arguments) as { task?: string };
			this.#setPhase("thinking");
			return this.#onConsult(task.task ?? call.arguments);
		});

		await this.#options.transport.connect();
		// Mic starts only after the session is live, so no frames hit a dead socket.
		this.#options.source.start(samples => this.#onMicChunk(samples));
	}

	/** Toggle mute: mic keeps running (levels + VAD clock), wire gets silence. */
	setMuted(muted: boolean): void {
		if (this.#muted === muted) return;
		this.#muted = muted;
		if (this.#phase === "muted" || this.#phase === "listening" || this.#phase === "speaking") {
			this.#setPhase(muted ? "muted" : "listening");
		}
	}

	get muted(): boolean {
		return this.#muted;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#options.source.stop();
		this.#sink?.stop();
		this.#sink = undefined;
		this.#bridge.detach();
		for (const remove of this.#removeTransportListeners) remove();
		await this.#options.transport.close();
	}

	#onTransportConnected(): void {
		// Every (re)connect is a fresh server-side session — config must be resent.
		this.#options.transport.send({
			type: "session.update",
			session: { ...this.#options.session, tools: [...this.#bridge.tools], tool_choice: "auto" },
		});
		this.#setPhase(this.#muted ? "muted" : "listening");
	}

	#onMicChunk(samples: Float32Array): void {
		if (this.#disposed) return;
		this.#inputLevel = clamp01(rmsLevel(samples) / 32768);
		this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
		if (this.#options.transport.state !== "connected") return;
		const pcm = this.#muted ? createSilenceChunk(MUTED_CHUNK_MS) : float32ToPcm16(samples);
		try {
			this.#options.transport.send({ type: "input_audio_buffer.append", audio: pcm16ToBase64(pcm) });
		} catch (err) {
			logger.debug("live mic send failed", { error: String(err) });
		}
	}

	#onServerEvent(event: RealtimeServerEvent): void {
		if (this.#disposed) return;
		switch (event.type) {
			case "input_audio_buffer.speech_started":
				this.#onSpeechStarted();
				break;
			case "input_audio_buffer.speech_stopped":
				this.#setPhase("thinking");
				break;
			case "conversation.item.input_audio_transcription.delta":
				this.#callbacks.onTranscript({ role: "user", text: event.delta, final: false });
				break;
			case "conversation.item.input_audio_transcription.completed":
				this.#callbacks.onTranscript({ role: "user", text: event.transcript, final: true });
				break;
			case "response.audio.delta":
				this.#onAudioDelta(event.delta);
				break;
			case "response.audio_transcript.delta":
				this.#callbacks.onTranscript({ role: "assistant", text: event.delta, final: false });
				break;
			case "response.audio_transcript.done":
				this.#callbacks.onTranscript({ role: "assistant", text: event.transcript, final: true });
				break;
			case "response.done":
				this.#sink = undefined;
				this.#outputLevel = 0;
				this.#setPhase(this.#muted ? "muted" : "listening");
				break;
			case "error":
				// Benign race: our response.cancel landed after the response already
				// finished server-side. Not an error condition for the user.
				if (/no active response/i.test(event.message)) {
					logger.debug("live cancel raced a finished response", { message: event.message });
					break;
				}
				logger.warn("live server error", { message: event.message });
				this.#setPhase("error");
				break;
		}
	}

	#onSpeechStarted(): void {
		if (this.#phase === "speaking") {
			// Echo gate: speaker bleed trips server_vad at low RMS; real barge-in is loud.
			if (this.#inputLevel < this.#bargeInLevel) return;
			this.#options.transport.send({ type: "response.cancel" });
			this.#sink?.stop();
			this.#sink = undefined;
			this.#outputLevel = 0;
			// Immediate visual feedback — must land within ~100ms of the interruption.
			this.#setPhase("interrupted");
		}
		this.#setPhase("listening");
	}

	#onAudioDelta(base64: string): void {
		if (this.#phase !== "speaking") {
			this.#sink = this.#options.sinkFactory();
			this.#setPhase("speaking");
		}
		const samples = pcm16ToFloat32(base64ToPcm16(base64));
		this.#outputLevel = clamp01(rmsLevel(samples) / 32768);
		this.#sink?.write(samples);
	}

	#setPhase(phase: LivePhase): void {
		if (this.#phase === phase || this.#disposed) return;
		this.#phase = phase;
		this.#callbacks.onPhase(phase);
	}
}