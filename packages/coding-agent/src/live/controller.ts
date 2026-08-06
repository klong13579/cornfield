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
 * Key behaviors (bench-verified against qwen realtime):
 * - The mic captures CONTINUOUSLY — server_vad's audio clock only advances
 *   with frames, so capture is never paused mid-session. Mute swaps live
 *   chunks for silence frames instead of stopping capture.
 * - Echo break: while assistant audio is playing (phase "speaking", including
 *   the post-response.done drain), the uplink sends silence so speaker bleed
 *   can never reach the server as a fake user turn — the root fix for the
 *   self-talking loop. Barge-in is detected CLIENT-side: the mic RMS must
 *   exceed a playback-scaled echo floor (bleed grows with playback loudness)
 *   for several consecutive chunks before the uplink reopens.
 * - Handshake: session.update is sent only after session.created, and the
 *   uplink stays gated until the server acks with session.updated (or a
 *   timeout fallback for servers that never ack). Config must land before
 *   the first audio frame, or qwen rejects turn_detection and the session
 *   is permanently broken.
 * - Error breaker: repeated server errors end the session via onTerminal
 *   instead of storming forever; the 180s server-side idle timeout ends the
 *   session cleanly instead of silently resurrecting it in a loop.
 */
import {
	base64ToPcm16,
	createSilenceChunk,
	pcm16ToBase64,
	REALTIME_SAMPLE_RATE,
	RealtimeFunctionBridge,
	type RealtimeServerEvent,
} from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { float32ToPcm16, pcm16ToFloat32, rmsLevel } from "../stt/pcm";
import type {
	LiveAudioSink,
	LiveConsultHandler,
	LiveControlAction,
	LivePhase,
	LiveSessionCallbacks,
	LiveSessionOptions,
	VoiceConfirmDecision,
} from "./types";

const DEFAULT_BARGE_IN_LEVEL = 0.04;
/** Speaker→mic bleed scales with playback loudness; barge-in must clearly exceed it. */
const BARGE_IN_ECHO_RATIO = 3;
/** Consecutive over-threshold chunks required before accepting a barge-in. */
const BARGE_IN_SUSTAIN_CHUNKS = 5;
const CONSULT_TOOL_NAME = "omp_agent_consult";
const TASK_TOOL_NAME = "omp_agent_task";
const CONFIRM_TOOL_NAME = "omp_voice_confirm";
const CONTROL_TOOL_NAME = "omp_agent_control";
/** Design §3.3: wait this long for a consult result before handing the model a filler. */
const CONSULT_HANDOFF_MS = 3_000;
/**
 * Filler spoken while slow work runs. MUST be a pure speakable sentence:
 * qwen parrots meta-instructions verbatim ("结果出来后系统会再次提供给你…"
 * was read out loud in P1 acceptance), so no scaffolding text may appear here.
 */
const CONSULT_HANDOFF_TEXT = "正在处理，请稍等，结果出来我马上告诉你。";
/** Design §3.6: let the model know its answer was cut short by a barge-in. */
const INTERRUPTED_NOTE = "（你刚才的语音回答被用户打断了，没说完）";
/** Silence frames replace mic input while muted/speaking (server_vad clock must keep ticking). */
const MUTED_CHUNK_MS = 100;
/**
 * Post-playback protection window: the uplink stays gated by the echo floor
 * for this long after the sink drains. 300ms proved too short — airborne echo
 * of short replies ("好的，没问题") leaked through as fake user turns and the
 * model answered itself (P1 acceptance, 2026-08-05). Barge-in still works
 * inside the window (sustained loud speech breaks through the floor).
 */
const ROOM_DECAY_MS = 1_000;
/** Give up waiting for the session.updated ack and stream anyway (some servers never ack). */
const CONFIG_ACK_TIMEOUT_MS = 2_000;
/** Consecutive server errors before the session is declared terminal. */
const MAX_SERVER_ERRORS = 3;
/** Client endpointing: RMS level that arms a speech segment. */
const CLIENT_VAD_START_LEVEL = 0.04;
/** Client endpointing: shorter segments are noise blips — never committed. */
const CLIENT_MIN_UTTERANCE_MS = 300;
/** Client endpointing default silence window before committing a turn. */
const DEFAULT_CLIENT_SILENCE_MS = 1_200;

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export class LiveSessionController {
	readonly #options: LiveSessionOptions;
	readonly #callbacks: LiveSessionCallbacks;
	readonly #bridge: RealtimeFunctionBridge;
	readonly #bargeInLevel: number;
	readonly #bargeInEnabled: boolean;
	readonly #micNoiseFloor: number;
	readonly #consultHandoffMs: number;
	readonly #onConsult: LiveConsultHandler;
	readonly #onTask: LiveConsultHandler;
	readonly #onControl: (action: LiveControlAction, text?: string) => Promise<string>;

	#phase: LivePhase = "connecting";
	#sink: LiveAudioSink | undefined;
	/** Playback still draining after response.done — kept so barge-in can stop it. */
	#drainingSink: LiveAudioSink | undefined;
	#muted = false;
	#started = false;
	#disposed = false;
	#inputLevel = 0;
	#outputLevel = 0;
	#removeTransportListeners: Array<() => void> = [];
	#assistantUtterances: string[] = [];
	#assistantText = "";
	/** Uplink gate: cleared by the session.updated ack or the ack timeout. */
	#configAcked = false;
	#configAckTimer: ReturnType<typeof setTimeout> | undefined;
	/** Consecutive server errors since the last good config ack. */
	#errorCount = 0;
	/** Terminal error state: uplink halted until the session ends. */
	#halted = false;
	/** Monotonic drain generation — stale sink.end() continuations become no-ops. */
	#drainGeneration = 0;
	/** Consecutive loud chunks seen while speaking (barge-in sustain gate). */
	#bargeInArmed = 0;
	/** Endpointing mode: client = this controller decides turn boundaries. */
	readonly #endpointing: "client" | "server";
	readonly #clientSilenceWindowMs: number;
	/** Client VAD state. */
	#clientSpeechActive = false;
	#clientSilenceMs = 0;
	#clientSpeechMs = 0;
	/** A response is in flight server-side (response.created → response.done). */
	#responseInProgress = false;
	/** User speech ended while a response was in flight — commit once it's done. */
	#commitQueued = false;

	constructor(options: LiveSessionOptions) {
		this.#options = options;
		this.#callbacks = options.callbacks;
		this.#bargeInLevel = options.bargeInLevel ?? DEFAULT_BARGE_IN_LEVEL;
		this.#bargeInEnabled = options.bargeInEnabled ?? true;
		this.#micNoiseFloor = options.micNoiseFloor ?? 0;
		this.#endpointing = options.endpointing ?? "server";
		this.#clientSilenceWindowMs = options.clientSilenceMs ?? DEFAULT_CLIENT_SILENCE_MS;
		this.#consultHandoffMs = options.consultHandoffMs ?? CONSULT_HANDOFF_MS;
		this.#onConsult = options.onConsult ?? (async () => "（语音任务委托尚未接入，请改用文字输入。）");
		this.#onTask = options.onTask ?? (async () => "（语音任务派发尚未接入，请改用文字输入。）");
		this.#onControl = options.onControl ?? (async () => "（执行中控制尚未接入。）");
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
		this.#bridge.registerTool({
			name: TASK_TOOL_NAME,
			description:
				"Delegate a task that CHANGES files or system state (edit code, create files, run commands, send messages, mark todos done) to the omp main session. Read-only queries go to omp_agent_consult instead.",
			parameters: {
				type: "object",
				properties: { task: { type: "string", description: "The user's task, verbatim-enriched." } },
				required: ["task"],
			},
		});
		this.#bridge.registerTool({
			name: CONFIRM_TOOL_NAME,
			description:
				"Report the user's spoken answer to a pending operation confirmation. Only use it after the system injected a confirmation request.",
			parameters: {
				type: "object",
				properties: {
					decision: {
						type: "string",
						enum: ["confirm", "cancel", "unclear"],
						description: "confirm = user agreed, cancel = user refused, unclear = answer not understood",
					},
				},
				required: ["decision"],
			},
		});
		this.#bridge.registerTool({
			name: CONTROL_TOOL_NAME,
			description:
				"Control the task currently running in the main session: status = report progress, steer = pass a course correction to the running task, cancel = stop it. Only use it while a task is executing.",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["status", "steer", "cancel"],
						description: "status = 到哪了, steer = 修正方向, cancel = 停",
					},
					text: {
						type: "string",
						description: "For steer: the course correction, verbatim-enriched.",
					},
				},
				required: ["action"],
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
				if (state === "reconnecting") this.#setPhase("connecting");
				if (state === "closed" && !this.#disposed) {
					this.#callbacks.onTerminal(new Error("realtime connection closed"));
				}
			}),
		);

		this.#bridge.attach(async call => {
			switch (call.name) {
				case TASK_TOOL_NAME: {
					const args = JSON.parse(call.arguments) as { task?: string };
					this.#setPhase("thinking");
					this.#callbacks.onIntent?.("task");
					return this.#withHandoff(
						() => this.#onTask(args.task ?? call.arguments),
						text => this.deliverTaskSummary(text),
					);
				}
				case CONFIRM_TOOL_NAME: {
					const args = JSON.parse(call.arguments) as { decision?: string };
					this.#callbacks.onIntent?.("confirm");
					const decision = this.#normalizeDecision(args.decision);
					if (!decision) {
						return "（无法识别该答复。请以 confirm、cancel 或 unclear 调用 omp_voice_confirm。）";
					}
					this.#options.onConfirmDecision?.(decision);
					return "（用户的答复已转达。）";
				}
				case CONTROL_TOOL_NAME: {
					const args = JSON.parse(call.arguments) as { action?: string; text?: string };
					const action = this.#normalizeControlAction(args.action);
					if (!action) {
						return "（无法识别该控制指令。请以 status、steer 或 cancel 调用 omp_agent_control。）";
					}
					return this.#onControl(action, args.text);
				}
				default: {
					const args = JSON.parse(call.arguments) as { task?: string };
					this.#setPhase("thinking");
					this.#callbacks.onIntent?.("query");
					return this.#withHandoff(
						() => this.#onConsult(args.task ?? call.arguments),
						text => this.#deliverDeferredConsultResult(text),
					);
				}
			}
		});

		await this.#options.transport.connect();
		if (this.#disposed) return;
		// Capture starts immediately; the UPLINK stays gated until the session
		// config is acknowledged (see #onMicChunk), so no frame can beat the
		// turn_detection config to the server.
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

	/**
	 * Force the server to commit the current audio buffer as a user turn. Kept
	 * for callers that want to flush; no-op when the mic gate isn't open (PTT
	 * is gone — there's no gate anymore, so this just sends the event).
	 */
	commitMic(): void {
		if (this.#disposed) return;
		try {
			this.#options.transport.send({ type: "input_audio_buffer.commit" });
		} catch (err) {
			logger.debug("live mic commit failed", { error: String(err) });
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#cancelConfigAckTimer();
		this.#drainGeneration += 1;
		this.#options.source.stop();
		this.#sink?.stop();
		this.#sink = undefined;
		this.#drainingSink?.stop();
		this.#drainingSink = undefined;
		this.#bridge.detach();
		for (const remove of this.#removeTransportListeners) remove();
		await this.#options.transport.close();
	}

	#onTransportConnected(): void {
		// Every (re)connect is a fresh server-side session. Config goes out on
		// session.created (server ready); the uplink gate opens on the ack.
		this.#configAcked = false;
		this.#halted = false;
		this.#cancelConfigAckTimer();
		this.#setPhase("connecting");
	}

	#sendSessionConfig(): void {
		// Client endpointing runs the server with turn_detection null — this
		// controller commits turns (probe-verified against qwen, 2026-08-06).
		const session =
			this.#endpointing === "client" ? { ...this.#options.session, turn_detection: null } : this.#options.session;
		this.#options.transport.send({
			type: "session.update",
			session: { ...session, tools: [...this.#bridge.tools], tool_choice: "auto" },
		});
		this.#cancelConfigAckTimer();
		this.#configAckTimer = setTimeout(() => {
			if (!this.#configAcked) {
				// Some servers never emit session.updated — proceed optimistically.
				logger.debug("live session.update ack timeout, opening uplink anyway");
				this.#configAcked = true;
				this.#setPhase(this.#muted ? "muted" : "listening");
			}
		}, CONFIG_ACK_TIMEOUT_MS);
	}

	#cancelConfigAckTimer(): void {
		if (this.#configAckTimer) {
			clearTimeout(this.#configAckTimer);
			this.#configAckTimer = undefined;
		}
	}

	#onMicChunk(samples: Float32Array): void {
		if (this.#disposed) return;
		this.#inputLevel = clamp01(rmsLevel(samples) / 32768);
		this.#callbacks.onLevels(this.#inputLevel, this.#outputLevel);
		if (this.#options.transport.state !== "connected") return;
		// Fatal error state or config still in flight: nothing may hit the wire.
		if (this.#halted || !this.#configAcked) return;
		if (this.#muted) return this.#sendSilence();
		// Echo break: while assistant audio is playing or draining, the server
		// gets silence so speaker bleed can never become a fake user turn. A loud
		// chunk is treated as real barge-in: cancel playback, reopen the uplink.
		if (this.#phase === "speaking") {
			// Barge-in disabled: the uplink stays silence for the whole playback —
			// no self-interruption, at the cost of not being able to talk over it.
			if (!this.#bargeInEnabled) return this.#sendSilence();
			if (this.#inputLevel >= this.#bargeInThreshold()) {
				this.#bargeInArmed += 1;
				if (this.#bargeInArmed >= BARGE_IN_SUSTAIN_CHUNKS) {
					this.#doBargeIn();
					return this.#sendPcm(float32ToPcm16(samples));
				}
				return this.#sendSilence();
			}
			this.#bargeInArmed = 0;
			return this.#sendSilence();
		}
		this.#bargeInArmed = 0;
		// Ambient noise gate: sub-floor frames become silence so rustle never
		// reaches server VAD as a speech candidate (phantom-turn defense, P1
		// acceptance: faint sounds committed as turns → "好的，没问题" replies).
		if (this.#micNoiseFloor > 0 && this.#inputLevel < this.#micNoiseFloor) {
			return this.#sendSilence();
		}
		if (this.#endpointing === "client") this.#trackClientSpeech(samples.length);
		this.#sendPcm(float32ToPcm16(samples));
	}

	#sendPcm(pcm: Uint8Array): void {
		try {
			this.#options.transport.send({ type: "input_audio_buffer.append", audio: pcm16ToBase64(pcm) });
		} catch (err) {
			logger.debug("live mic send failed", { error: String(err) });
		}
	}

	#sendSilence(): void {
		this.#sendPcm(createSilenceChunk(MUTED_CHUNK_MS));
	}

	/**
	 * Client-side endpointing (endpointing: "client"): the server runs with
	 * turn_detection null, so THIS controller decides turn boundaries. A fixed
	 * server silence window can't distinguish mid-sentence pauses from the end
	 * of speech (premature responses); here the window is ours to tune, short
	 * blips are never committed, and commits never race an in-flight response.
	 */
	#trackClientSpeech(frameSamples: number): void {
		const chunkMs = (frameSamples / REALTIME_SAMPLE_RATE) * 1000;
		if (this.#inputLevel >= CLIENT_VAD_START_LEVEL) {
			this.#clientSilenceMs = 0;
			if (!this.#clientSpeechActive) {
				this.#clientSpeechActive = true;
				this.#clientSpeechMs = 0;
				this.#setPhase("listening");
			}
			this.#clientSpeechMs += chunkMs;
			return;
		}
		if (!this.#clientSpeechActive) return;
		this.#clientSpeechMs += chunkMs;
		this.#clientSilenceMs += chunkMs;
		if (this.#clientSilenceMs >= this.#clientSilenceWindowMs) this.#clientEndpoint();
	}

	#clientEndpoint(): void {
		this.#clientSpeechActive = false;
		const durationMs = this.#clientSpeechMs;
		this.#clientSpeechMs = 0;
		this.#clientSilenceMs = 0;
		// Noise blip: too short to be an utterance — never commit it.
		if (durationMs < CLIENT_MIN_UTTERANCE_MS) return;
		if (this.#responseInProgress) {
			// A response is still in flight; commit once it completes, or the
			// create would collide ("Cannot create response while another…").
			this.#commitQueued = true;
			return;
		}
		this.#commitAndRespond();
	}

	#commitAndRespond(): void {
		try {
			this.#options.transport.send({ type: "input_audio_buffer.commit" });
			this.#options.transport.send({ type: "response.create" });
			this.#responseInProgress = true;
			this.#setPhase("thinking");
		} catch (err) {
			logger.debug("live client endpoint commit failed", { error: String(err) });
		}
	}

	/** Expected echo floor: bleed ≈ coupling × playback level. Real barge-in must exceed it. */
	#bargeInThreshold(): number {
		return Math.max(this.#bargeInLevel, this.#outputLevel * BARGE_IN_ECHO_RATIO);
	}

	#doBargeIn(): void {
		logger.info("live barge-in", {
			inputLevel: this.#inputLevel,
			outputLevel: this.#outputLevel,
			threshold: this.#bargeInThreshold(),
		});
		this.#options.transport.send({ type: "response.cancel" });
		// Design §3.6: the model must know its answer was cut short, so the next
		// turn can continue naturally instead of forgetting mid-sentence.
		this.#options.transport.send({
			type: "conversation.item.create",
			item: { type: "message", role: "user", content: [{ type: "input_text", text: INTERRUPTED_NOTE }] },
		});
		this.#sink?.stop();
		this.#sink = undefined;
		// Abort the drain tail too — its audio is still physically playing.
		this.#drainingSink?.stop();
		this.#drainingSink = undefined;
		this.#drainGeneration += 1;
		this.#outputLevel = 0;
		this.#bargeInArmed = 0;
		// Response state reset: the cancel ends the in-flight response; drop any
		// queued commit — the barge-in utterance gets its own endpoint tracking.
		this.#responseInProgress = false;
		this.#commitQueued = false;
		// The user is speaking right now — re-arm client speech tracking.
		this.#clientSpeechActive = true;
		this.#clientSpeechMs = 0;
		this.#clientSilenceMs = 0;
		// Immediate visual feedback — must land within ~100ms of the interruption.
		this.#setPhase("interrupted");
		this.#setPhase("listening");
	}

	/**
	 * Design §3.3 「thinking 期不断线」 (P0 consult, P1 task): if the work doesn't
	 * produce a result within the handoff window, hand the model a filler to say
	 * ("正在查，稍等") and deliver the real result as a fresh conversation turn
	 * when it lands — the voice session never stalls in silence behind slow work.
	 */
	async #withHandoff(run: () => Promise<string>, deliver: (text: string) => boolean): Promise<string> {
		let settled = false;
		const work = run().then(text => {
			settled = true;
			return text;
		});
		await Promise.race([work, Bun.sleep(this.#consultHandoffMs)]);
		if (settled) return await work;
		void work.then(
			text => deliver(text),
			err => deliver(`（后台任务执行失败：${err instanceof Error ? err.message : String(err)}）`),
		);
		return CONSULT_HANDOFF_TEXT;
	}

	#normalizeDecision(value: string | undefined): VoiceConfirmDecision | undefined {
		if (value === "confirm" || value === "cancel" || value === "unclear") return value;
		return undefined;
	}

	#normalizeControlAction(value: string | undefined): LiveControlAction | undefined {
		if (value === "status" || value === "steer" || value === "cancel") return value;
		return undefined;
	}

	/**
	 * Deliver a late background result while the voice session is alive
	 * (design §5). Returns false when the session can't take it — the caller
	 * then falls back to the text chat stream.
	 */
	deliverBackgroundResult(text: string): boolean {
		return this.#deliverDeferredConsultResult(text);
	}

	#deliverDeferredConsultResult(text: string): boolean {
		return this.#injectUserNote(`（后台任务已完成，请把下面的结果用口语播报给用户）\n${text}`);
	}

	/**
	 * Deliver the spoken summary of a finished voice task as a fresh conversation
	 * turn (P1 §4): the dispatching function call already resolved with the
	 * handoff filler, so the result cannot ride its function_call_output.
	 */
	deliverTaskSummary(text: string): boolean {
		return this.#injectUserNote(
			`（刚才的语音任务已完成，请用一两句话口播执行结果，细节用户可以在屏幕上看到。）\n${text}`,
		);
	}

	/**
	 * Inject instruction text (e.g. a VoiceGate confirmation request) as a fresh
	 * conversation turn. Returns false when the session can't take it — callers
	 * fail safe on that.
	 */
	speakConfirmationNote(text: string): boolean {
		return this.#injectUserNote(text);
	}

	/**
	 * Refresh the realtime session instructions mid-session (P1 context
	 * freshness: the voice front-end's summary of the main session goes stale
	 * as work happens). Sends instructions ONLY — qwen rejects any
	 * session.update that touches turn_detection after audio processing started.
	 */
	updateInstructions(instructions: string): boolean {
		if (this.#disposed || this.#halted) return false;
		try {
			this.#options.transport.send({ type: "session.update", session: { instructions } });
			return true;
		} catch (err) {
			logger.debug("live instructions refresh failed", { error: String(err) });
			return false;
		}
	}

	#injectUserNote(text: string): boolean {
		if (this.#disposed || this.#halted) return false;
		try {
			// Never race an in-progress server response — "Cannot create response
			// while another response is in progress" rejected the create, and three
			// rejections trip the error breaker. Cancel first (benign when nothing
			// is active) and take over the floor: stop local playback and drop to
			// listening so the note's own response owns the speaker next.
			this.#options.transport.send({ type: "response.cancel" });
			this.#sink?.stop();
			this.#sink = undefined;
			this.#drainingSink?.stop();
			this.#drainingSink = undefined;
			this.#drainGeneration += 1;
			this.#outputLevel = 0;
			this.#bargeInArmed = 0;
			this.#setPhase(this.#muted ? "muted" : "listening");
			this.#options.transport.send({
				type: "conversation.item.create",
				item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
			});
			this.#options.transport.send({ type: "response.create" });
			return true;
		} catch (err) {
			logger.debug("live user note injection failed", { error: String(err) });
			return false;
		}
	}

	#onServerEvent(event: RealtimeServerEvent): void {
		if (this.#disposed) return;
		switch (event.type) {
			case "session.created":
				// The server session is ready — only NOW send the config, so
				// turn_detection can never race a session already processing audio.
				this.#sendSessionConfig();
				break;
			case "session.updated":
				this.#configAcked = true;
				this.#cancelConfigAckTimer();
				this.#errorCount = 0;
				this.#setPhase(this.#muted ? "muted" : "listening");
				break;
			case "input_audio_buffer.speech_started":
				this.#onSpeechStarted();
				break;
			case "input_audio_buffer.speech_stopped":
				this.#setPhase("thinking");
				break;
			case "conversation.item.input_audio_transcription.delta":
				this.#callbacks.onTranscript({ role: "user", text: event.delta, final: false });
				break;
			case "conversation.item.input_audio_transcription.completed": {
				// Defense in depth: with the silence uplink the server should never
				// transcribe speaker bleed, but guard the recording path anyway.
				if (this.#phase === "speaking" || this.#isEcho(event.transcript)) break;
				// Drop 1-2 char transcripts before they reach the model. Bleed
				// fragments ("。", "都", "三") and tail-of-reverb ghosts would
				// otherwise commit as full user turns and feed the self-loop.
				// Exception: while a confirmation is pending, short answers ("确认",
				// "做", "好") are legitimate and must reach the panel/recorder.
				const tooShort = event.transcript.replace(/\s|\p{P}|\p{S}/gu, "").length < 3;
				if (tooShort && !(this.#options.isConfirmationPending?.() ?? false)) break;
				this.#callbacks.onTranscript({ role: "user", text: event.transcript, final: true });
				break;
			}
			case "response.audio.delta":
				this.#onAudioDelta(event.delta);
				break;
			case "response.audio_transcript.delta":
				this.#assistantText += event.delta;
				this.#callbacks.onTranscript({ role: "assistant", text: event.delta, final: false });
				break;
			case "response.audio_transcript.done":
				this.#assistantUtterances.push(event.transcript);
				if (this.#assistantUtterances.length > 5) this.#assistantUtterances.shift();
				this.#callbacks.onTranscript({ role: "assistant", text: event.transcript, final: true });
				break;
			case "response.created":
				this.#responseInProgress = true;
				break;
			case "response.done":
				this.#responseInProgress = false;
				if (this.#commitQueued) {
					this.#commitQueued = false;
					this.#commitAndRespond();
				}
				if (this.#assistantText) {
					this.#assistantUtterances.push(this.#assistantText);
					if (this.#assistantUtterances.length > 5) this.#assistantUtterances.shift();
					this.#assistantText = "";
				}
				// Keep #outputLevel through the drain: the echo floor must stay high
				// while the tail is still physically playing (barge-in gate uses it).
				this.#drainSink();
				break;
			case "error":
				this.#onServerError(event.message);
				break;
		}
	}

	#onServerError(message: string): void {
		// Benign race: our response.cancel landed after the response already
		// finished server-side. Not an error condition for the user.
		if (/no active response/i.test(message)) {
			logger.debug("live cancel raced a finished response", { message });
			return;
		}
		// Server-side idle timeout: the session is gone. Silently resurrecting it
		// loops forever (180s close → reconnect → 180s close…) and loses context;
		// end cleanly instead — the user can re-enter with alt+v.
		if (/no response was generated/i.test(message)) {
			logger.info("live session closed by server after idle timeout");
			this.#halted = true;
			this.#callbacks.onTerminal(new Error("voice session ended after prolonged inactivity"));
			return;
		}
		this.#errorCount += 1;
		logger.warn("live server error", { message, errorCount: this.#errorCount });
		if (this.#errorCount >= MAX_SERVER_ERRORS) {
			this.#halted = true;
			this.#callbacks.onTerminal(new Error(`voice channel failed: ${message}`));
			return;
		}
		// Stop feeding a broken session: halt the uplink (this is what turned one
		// config error into a 49-error storm before). Recovery comes from the
		// transport reconnecting with a fresh server session, or the user re-entering.
		this.#setPhase("error");
	}

	#onSpeechStarted(): void {
		if (this.#phase === "speaking") {
			// With barge-in disabled the server can only have heard bleed/noise —
			// never interrupt playback.
			if (!this.#bargeInEnabled) return;
			// With the silence uplink the server only hears real user audio, but
			// keep the RMS gate as defense in depth against residual bleed.
			if (this.#inputLevel < this.#bargeInThreshold()) return;
			this.#doBargeIn();
			return;
		}
		this.#setPhase("listening");
	}

	#onAudioDelta(base64: string): void {
		if (!this.#sink) {
			this.#sink = this.#options.sinkFactory();
			// A new response invalidates any in-flight drain continuation.
			this.#drainGeneration += 1;
		}
		if (this.#phase !== "speaking") this.#setPhase("speaking");
		const samples = pcm16ToFloat32(base64ToPcm16(base64));
		this.#outputLevel = clamp01(rmsLevel(samples) / 32768);
		this.#sink.write(samples);
	}

	#drainSink(): void {
		const sink = this.#sink;
		// Next response gets a fresh sink immediately; the old one plays out.
		this.#sink = undefined;
		if (!sink) {
			this.#setPhase(this.#muted ? "muted" : "listening");
			return;
		}
		this.#drainingSink = sink;
		const generation = ++this.#drainGeneration;
		// Phase stays "speaking": the uplink keeps sending silence until the
		// hardware buffer is actually empty, so the mic never hears itself.
		const done = (): void => {
			if (this.#drainingSink === sink) this.#drainingSink = undefined;
			if (this.#disposed || generation !== this.#drainGeneration) return;
			// Small post-drain cooldown: even after AudioPlayback reports the
			// last sample played, the room has 100-300ms of reverb left. Hold
			// the speaking phase so the mic stays muted until it decays.
			Bun.sleep(ROOM_DECAY_MS).then(() => {
				if (this.#disposed || generation !== this.#drainGeneration) return;
				this.#outputLevel = 0;
				this.#setPhase(this.#muted ? "muted" : "listening");
			});
		};
		sink.end().then(done, done);
	}

	#setPhase(phase: LivePhase): void {
		if (this.#phase === phase || this.#disposed) return;
		this.#phase = phase;
		this.#callbacks.onPhase(phase);
	}

	#isEcho(text: string): boolean {
		if (text.length < 3) return false;
		// Strip whitespace, punctuation, and symbols so ASR variants (no punctuation)
		// still match the assistant's original (with punctuation).
		const norm = text.replace(/[\s\p{P}\p{S}]/gu, "");
		return this.#assistantUtterances.some(
			u => u.replace(/[\s\p{P}\p{S}]/gu, "").includes(norm) || norm.includes(u.replace(/[\s\p{P}\p{S}]/gu, "")),
		);
	}
}
