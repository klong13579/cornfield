/**
 * Shared types for the live voice session (Jarvis).
 *
 * The controller owns three resources: a realtime WS transport (pi-ai), an
 * audio source (mic), and an audio sink (speaker). All three sit behind small
 * interfaces so tests can drive the state machine without hardware.
 */
import type { RealtimeSessionConfig, RealtimeWsTransport } from "@oh-my-pi/pi-ai";

export type LivePhase = "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "muted" | "error";

export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	final: boolean;
}

export interface LiveSessionCallbacks {
	onPhase(phase: LivePhase): void;
	/** Normalized RMS levels 0..1 (input mic, output speaker). */
	onLevels(input: number, output: number): void;
	onTranscript(transcript: LiveTranscript): void;
	/** Terminal stop — the session is over, optionally with a cause. */
	onTerminal(error?: Error): void;
}

/** Mic abstraction: production = native AudioCapture, tests = scripted. */
export interface LiveAudioSource {
	/** Start delivering f32 mono chunks at the negotiated sample rate. */
	start(onChunk: (samples: Float32Array) => void): void;
	stop(): void;
}

/** Speaker abstraction: production = native AudioPlayback, tests = scripted. */
export interface LiveAudioSink {
	write(samples: Float32Array): void;
	/** Discard everything queued, immediately. Used by barge-in. */
	stop(): void;
}

/** Factory for sinks — one playback instance per assistant response. */
export type LiveAudioSinkFactory = () => LiveAudioSink;

/** Consult hook — P0c wires the real AgentSession delegation behind this. */
export type LiveConsultHandler = (task: string) => Promise<string>;

export interface LiveSessionOptions {
	transport: RealtimeWsTransport;
	source: LiveAudioSource;
	sinkFactory: LiveAudioSinkFactory;
	session: RealtimeSessionConfig;
	callbacks: LiveSessionCallbacks;
	/** Task delegation for `omp_agent_consult`. Default: verbal refusal. */
	onConsult?: LiveConsultHandler;
	/** Barge-in gate: mic RMS (0..1) required to interrupt playback. Default 0.04. */
	bargeInLevel?: number;
}

/** Frozen at P0b exit — P0c (consult bridge) and P0d (VoicePanel) build against these. */
export type { RealtimeSessionConfig, RealtimeWsTransport };
