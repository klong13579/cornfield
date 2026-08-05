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
import { LiveTranscriptRecorder, VOICE_MESSAGE_TYPE } from "../../live/transcript-recorder";
import type { LivePhase, LiveTranscript } from "../../live/types";
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
	#panelState: VoicePanelState = { phase: "connecting", inputLevel: 0, outputLevel: 0, recording: false };

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
		const instructions = buildVoiceInstructions(liveInstructions, this.#ctx.session.agent.state.messages);
		this.#consultBridge = new LiveConsultBridge({
			cwd: this.#ctx.session.sessionManager.getCwd(),
			onActivity: line => this.#pushPanelState({ toolLine: line }),
			onBackgroundResult: (task, text) => this.#onBackgroundResult(task, text),
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
				onTerminal: error => {
					if (error) this.#ctx.showError(`Voice session ended: ${error.message}`);
					void this.stop();
				},
			},
			onConsult: async task => {
				this.#pushPanelState({ consultTask: task });
				return this.#consultBridge?.consult(task) ?? "（consult 未初始化）";
			},
			bargeInLevel: settings.get("voice.bargeInLevel"),
			bargeInEnabled: settings.get("voice.interrupt"),
		});
		this.#session = session;

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
		// Only finalized turns land in the shared session history.
		if (transcript.final) {
			this.#recorder?.record(transcript);
		}
	}

	/** Design §5: a timed-out consult finished late — speak it if voice is alive, else text. */
	#onBackgroundResult(task: string, text: string): void {
		const body = `（后台任务「${task}」的结果）\n${text}`;
		const spoken = this.#session?.deliverBackgroundResult(body) ?? false;
		if (spoken) return; // the spoken turn is recorded via the transcript path
		this.#ctx.session.sessionManager.appendCustomMessageEntry(VOICE_MESSAGE_TYPE, body, true, { role: "assistant", source: "voice-consult" }, "agent");
	}

	#pushPanelState(partial: Partial<VoicePanelState>): void {
		if (!this.#panel) return;
		this.#panelState = { ...this.#panelState, ...partial };
		this.#panel.update(this.#panelState);
	}
}
