/**
 * VoiceModeController — owns the full Jarvis voice stack inside the TUI:
 * RealtimeWsTransport + LiveSessionController + VoicePanel + LiveConsultBridge
 * + LiveTranscriptRecorder.
 *
 * Lifecycle: app.voice.toggle (alt+v) enters/exits; app.voice.mute (alt+m)
 * toggles mute inside the session. The panel mounts above the editor so text
 * input keeps working while voice runs (design §4.4).
 */
import { RealtimeWsTransport } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { LiveConsultBridge } from "../../live/consult-bridge";
import { LiveSessionController } from "../../live/controller";
import { buildVoiceInstructions } from "../../live/instructions";
import { createNativeAecAudio, createNativeAudioSource, createNativeSinkFactory } from "../../live/natives-audio";
import { LiveTaskRouter, type TaskRouterSession } from "../../live/task-router";
import { LiveTranscriptRecorder, VOICE_MESSAGE_TYPE } from "../../live/transcript-recorder";
import { LiveTurnBuffer } from "../../live/turn-buffer";
import type { LiveIntent, LivePhase, LiveTranscript } from "../../live/types";
import { VoiceGate } from "../../live/voice-gate";
import liveInstructions from "../../prompts/live/live-instructions.md" with { type: "text" };
import { VoicePanel, type VoicePanelCallbacks, type VoicePanelState } from "../components/voice-panel";
import type { InteractiveModeContext } from "../types";

/** P0: narwal-plan is the only bench-verified realtime endpoint. */
const REALTIME_PROVIDER = "narwal-plan";

export class VoiceModeController {
	readonly #ctx: InteractiveModeContext;

	#panel: VoicePanel | undefined;
	#session: LiveSessionController | undefined;
	#consultBridge: LiveConsultBridge | undefined;
	#recorder: LiveTranscriptRecorder | undefined;
	#gate: VoiceGate | undefined;
	#taskRouter: LiveTaskRouter | undefined;
	/** Design §7 dedup: holds finalized user utterances until intent is known. */
	#turnBuffer: LiveTurnBuffer | undefined;
	/** Set when a task/confirm intent arrives BEFORE its final transcript (race). */
	#suppressNextUserTurn = false;
	#panelState: VoicePanelState = { phase: "connecting", inputLevel: 0, outputLevel: 0 };

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	get active(): boolean {
		return this.#session !== undefined;
	}

	async toggle(): Promise<void> {
		if (this.active) {
			await this.stop();
			return;
		}
		if (!this.#ctx.settings.get("voice.enabled")) {
			this.#ctx.showWarning("Live voice is disabled. Enable it in settings: voice.enabled");
			return;
		}
		await this.#start().catch(err => {
			this.#ctx.showError(`Voice mode failed to start: ${err instanceof Error ? err.message : String(err)}`);
			void this.stop();
		});
	}

	toggleMute(): void {
		if (!this.#session) return;
		this.#session.setMuted(!this.#session.muted);
	}

	async stop(): Promise<void> {
		const session = this.#session;
		this.#session = undefined;
		this.#turnBuffer?.flush();
		this.#turnBuffer = undefined;
		this.#suppressNextUserTurn = false;
		this.#taskRouter?.dispose();
		this.#taskRouter = undefined;
		this.#gate?.disarm();
		this.#gate = undefined;
		if (session) {
			await session.dispose().catch(err => logger.debug("voice session dispose failed", { error: String(err) }));
		}
		if (this.#panel) {
			this.#ctx.editorContainer.removeChild(this.#panel);
			this.#panel = undefined;
			this.#ctx.ui.requestRender();
		}
		// The TUI's focused component is the panel right now; setFocus with the
		// editor hands control back so the user can keep typing.
		this.#ctx.ui.setFocus(this.#ctx.editor);
	}

	async dispose(): Promise<void> {
		await this.stop();
	}

	async #start(): Promise<void> {
		const settings = this.#ctx.settings;
		const model = settings.get("voice.model") ?? "qwen-audio-3.0-realtime-flash";
		const registry = this.#ctx.session.modelRegistry;
		const baseUrl = registry.getProviderBaseUrl(REALTIME_PROVIDER);
		const apiKey = await registry.getApiKeyForProvider(REALTIME_PROVIDER);
		if (!baseUrl || !apiKey) {
			throw new Error(`realtime provider "${REALTIME_PROVIDER}" is missing baseUrl or credentials`);
		}

		this.#panelState = { phase: "connecting", inputLevel: 0, outputLevel: 0 };
		const exitKeys = this.#ctx.keybindings.getKeys("app.voice.toggle");

		const recorder = new LiveTranscriptRecorder(this.#ctx.session);
		this.#recorder = recorder;
		this.#turnBuffer = new LiveTurnBuffer(recorder);
		const instructions = buildVoiceInstructions(liveInstructions, this.#ctx.session.agent.state.messages);
		this.#consultBridge = new LiveConsultBridge({
			cwd: this.#ctx.session.sessionManager.getCwd(),
			onActivity: line => this.#pushPanelState({ toolLine: line }),
			onBackgroundResult: (task, text) => this.#onBackgroundResult(task, text),
		});

		// P1: confirmation gate + main-session task router. The gate's channel is
		// late-bound to the live session controller (created below); it only speaks
		// during task execution, long after startup.
		const gate = new VoiceGate({
			channel: { speak: text => this.#session?.speakConfirmationNote(text) ?? false },
		});
		this.#taskRouter = new LiveTaskRouter({
			session: this.#ctx.session as unknown as TaskRouterSession,
			gate,
			isPlanMode: () => this.#ctx.planModeEnabled,
			onActivity: line => this.#pushPanelState({ toolLine: line }),
		});

		const aec = settings.get("voice.aec") ? createNativeAecAudio() : null;
		const transport = new RealtimeWsTransport({ baseUrl, apiKey, model });
		const session = new LiveSessionController({
			transport,
			source: aec?.source ?? createNativeAudioSource(),
			sinkFactory: aec?.sinkFactory ?? createNativeSinkFactory(),
			session: {
				modalities: ["text", "audio"],
				instructions,
				voice: settings.get("voice.voice"),
				input_audio_format: "pcm16",
				output_audio_format: "pcm16",
				input_audio_transcription: { model: "fun-asr" },
				turn_detection: {
					type: "server_vad",
					threshold: 0.4,
					silence_duration_ms: settings.get("voice.vadSilenceMs"),
				},
			},
			callbacks: {
				onPhase: phase => this.#onPhase(phase),
				onLevels: (input, output) => this.#pushPanelState({ inputLevel: input, outputLevel: output }),
				onTranscript: transcript => this.#onTranscript(transcript),
				onIntent: intent => this.#onLiveIntent(intent),
				onTerminal: error => {
					if (error) this.#ctx.showError(`Voice session ended: ${error.message}`);
					void this.stop();
				},
			},
			onConsult: async task => {
				this.#pushPanelState({ consultTask: task });
				return this.#consultBridge?.consult(task) ?? "（consult 未初始化）";
			},
			onTask: async task => {
				this.#pushPanelState({ consultTask: task });
				return this.#taskRouter?.dispatch(task) ?? "（任务派发未初始化）";
			},
			onConfirmDecision: decision => this.#gate?.resolveDecision(decision),
			onControl: async (action, text) => {
				// §7 dedup: a steer injection is the utterance's canonical record; a
				// status/cancel utterance keeps the usual voice recording path.
				if (action === "steer") this.#turnBuffer?.drop();
				else this.#turnBuffer?.flush();
				const router = this.#taskRouter;
				if (action === "status") {
					if (router?.inFlight) return router.status();
					if (this.#consultBridge?.busy) {
						const activity = this.#consultBridge.activity;
						return activity ? `（正在执行查询：${activity}）` : "（正在查询，还没有中间结果。）";
					}
					return "（现在没有在跑的任务或查询。）";
				}
				if (action === "cancel") {
					// Cancel covers BOTH execution paths — a spoken "stop" must kill
					// whichever is running, consult session included.
					const consultCancelled = this.#consultBridge?.abortCurrent() ?? false;
					const wasTask = router?.inFlight ?? false;
					const taskText = router ? await router.cancel() : "（现在没有在跑的任务或查询。）";
					if (wasTask && consultCancelled) return "（已停止任务，查询也取消了。）";
					if (consultCancelled) return "（已取消正在进行的查询。简短告知用户即可。）";
					return taskText;
				}
				if (!router) return "（执行中控制未初始化。）";
				if (!text) return "（没有听到具体的补充指示。）";
				return router.steer(text);
			},
			bargeInLevel: settings.get("voice.bargeInLevel"),
			bargeInEnabled: settings.get("voice.interrupt"),
			isConfirmationPending: () => this.#gate?.confirmationPending ?? false,
		});
		this.#session = session;

		// Arm the gate on the MAIN session's runner only — typed turns and other
		// sessions never trigger voice confirmations. Without a runner the task path
		// stays fail-closed (the router refuses dispatch).
		const extensionRunner = this.#ctx.session.extensionRunner;
		if (extensionRunner) gate.arm(extensionRunner);
		else logger.warn("voice task path disabled: no extension runner (fail-closed)");
		this.#gate = gate;

		const panelCallbacks: VoicePanelCallbacks = {
			onExit: () => {
				void this.stop();
			},
		};
		const panel = new VoicePanel({ tui: this.#ctx.ui, callbacks: panelCallbacks, exitKeys });
		this.#panel = panel;
		// Panel sits above the editor so the user can see the live state. Text
		// input keeps working while voice runs (the editor is still focused).
		this.#ctx.editorContainer.children.unshift(panel);
		this.#ctx.ui.requestRender();

		await session.start();
	}

	#onPhase(phase: LivePhase): void {
		const error = phase === "error" ? "语音通道异常，按 alt+v 重连" : undefined;
		this.#pushPanelState({ phase, error });
	}
	#onTranscript(transcript: LiveTranscript): void {
		this.#pushPanelState({ transcript });
		if (!transcript.final) {
			// First sign of a direct assistant answer flushes the held user utterance.
			if (transcript.role === "assistant") this.#turnBuffer?.flush();
			// Partials only reset the recorder's dedup guard.
			this.#recorder?.record(transcript);
			return;
		}
		if (transcript.role === "assistant") {
			this.#turnBuffer?.flush();
			this.#recorder?.record(transcript);
			return;
		}
		// Finalized user utterance: hold until intent classification resolves.
		// task utterances are recorded by the main-session injection itself, and
		// confirmation answers are consumed by the gate (design §7 dedup).
		if (this.#suppressNextUserTurn) {
			// The task/confirm intent already arrived before this transcript (race):
			// the injection is canonical, this record would be a duplicate.
			this.#suppressNextUserTurn = false;
			return;
		}
		if (this.#gate?.confirmationPending) return;
		this.#turnBuffer?.hold(transcript.text);
	}

	/** Design §7: route the held utterance once the realtime model classifies it. */
	#onLiveIntent(intent: LiveIntent): void {
		if (intent === "query") {
			this.#turnBuffer?.flush();
			return;
		}
		// task: the injected user message is the canonical record; confirm: the
		// gate consumed the answer — neither may be recorded a second time.
		if (this.#turnBuffer?.pending) this.#turnBuffer.drop();
		// The intent function call can beat the final transcript over the wire —
		// arm the suppress flag so the late-arriving transcript is dropped too.
		else this.#suppressNextUserTurn = true;
	}

	/** Design §5: a timed-out consult finished late — speak it if voice is alive, else text. */
	#onBackgroundResult(task: string, text: string): void {
		const body = `（后台任务「${task}」的结果）\n${text}`;
		const spoken = this.#session?.deliverBackgroundResult(body) ?? false;
		if (spoken) return; // the spoken turn is recorded via the transcript path
		this.#ctx.session.sessionManager.appendCustomMessageEntry(
			VOICE_MESSAGE_TYPE,
			body,
			true,
			{ role: "assistant", source: "voice-consult" },
			"agent",
		);
	}

	#pushPanelState(partial: Partial<VoicePanelState>): void {
		if (!this.#panel) return;
		this.#panelState = { ...this.#panelState, ...partial };
		this.#panel.update(this.#panelState);
	}
}
