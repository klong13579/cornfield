/**
 * Shared types for the live voice session (Jarvis).
 *
 * The controller owns three resources: a realtime WS transport (pi-ai), an
 * audio source (mic), and an audio sink (speaker). All three sit behind small
 * interfaces so tests can drive the state machine without hardware.
 */
import type { RealtimeSessionConfig, RealtimeWsTransport } from "@oh-my-pi/pi-ai";

export type LivePhase = "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "muted" | "error";

/** Which registered function the realtime model resolved an utterance to. */
export type LiveIntent = "query" | "task" | "confirm";

/** The user's spoken answer to a pending operation confirmation (omp_voice_confirm). */
export type VoiceConfirmDecision = "confirm" | "cancel" | "unclear";

/** Mid-task control action resolved from a spoken utterance (omp_agent_control, P1b §6). */
export type LiveControlAction = "status" | "steer" | "cancel";

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
	/**
	 * Intent classification resolved via a function call (P1 steer router).
	 * Fired before the handler runs — lets the caller route transcript recording:
	 * "task" utterances are recorded by the main session itself, not the recorder.
	 */
	onIntent?(intent: LiveIntent): void;
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
	/** Resolve when the queued audio has finished playing (drain). */
	end(): Promise<void>;
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
	/** Task delegation for `omp_agent_task` — executes in the MAIN session (P1 §4). */
	onTask?: LiveConsultHandler;
	/** The user's spoken answer to a pending confirmation (omp_voice_confirm). */
	onConfirmDecision?: (decision: VoiceConfirmDecision) => void;
	/** Mid-task control (omp_agent_control): status / steer / cancel (P1b §6). */
	onControl?: (action: LiveControlAction, text?: string) => Promise<string>;
	/** Barge-in gate: mic RMS (0..1) required to interrupt playback. Default 0.04. */
	bargeInLevel?: number;
	/** Allow barge-in at all (interrupting playback by speaking). Default true. */
	bargeInEnabled?: boolean;
	/** Mic RMS (0-1) below which frames are uplinked as silence (ambient noise gate). 0 disables. */
	micNoiseFloor?: number;
	/** How long to wait for a consult result before the "please wait" handoff (design §3.3). */
	consultHandoffMs?: number;
	/** Handoff window for tasks (default 1s): real tasks never settle faster, only instant rejections do. */
	taskHandoffMs?: number;
	/** Who decides turn boundaries: "server" (server_vad) or "client" (this controller
	 * tracks speech and commits turns — the fixed server silence window cuts off
	 * natural mid-sentence pauses). Default "server" for backward compatibility. */
	endpointing?: "client" | "server";
	/** Client endpointing: silence window (ms) before committing a turn. Default 1200. */
	clientSilenceMs?: number;
	/** No mic chunk for this long fires the capture-stall watchdog. Default 5000ms. */
	captureStallMs?: number;
	/** Idle (no commit, no speech) this long → clear the server input buffer. Default 60000ms. */
	bufferClearMs?: number;
	/** Capture stalled (mic silent) — show the user a restart hint. */
	onCaptureStall?: () => void;
	/** Capture resumed after a stall — clear the hint. */
	onCaptureResume?: () => void;
	/** Whether a voice confirmation is waiting for the user's answer (P1 gate).
	 * While pending, 1-2 char transcripts ("确认"/"做"/"好") bypass the noise guard. */
	isConfirmationPending?: () => boolean;
}

/** Frozen at P0b exit — P0c (consult bridge) and P0d (VoicePanel) build against these. */
export type { RealtimeSessionConfig, RealtimeWsTransport };
