import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AudioCapture } from "@cornfield/natives";
import { logger, Snowflake } from "@cornfield/utils";
import type { ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings";
import { ensureSTTDependencies } from "./downloader";
import { rmsLevel } from "./pcm";
import { type RecordingHandle, startRecording, verifyRecordingFile } from "./recorder";
import { createStreamingTranscriber, type StreamingTranscriber } from "./streaming";
import { transcribe } from "./transcriber";

export type SttState = "idle" | "recording" | "transcribing";

export type SttTranscriptionKind = "local" | "streaming";

/**
 * Decide how a Speech Model setting runs: `mlx-community/*` → local whisper,
 * anything else (e.g. `qwen-audio-3.0-realtime-plus`) → realtime streaming.
 */
export function getTranscriptionKind(modelName: string | undefined): SttTranscriptionKind {
	return modelName && !modelName.startsWith("mlx-community/") ? "streaming" : "local";
}

/** Provider serving the realtime transcription endpoint (the bench-verified one). */
const STREAMING_PROVIDER = "narwal-plan";
/** VAD: silence for this long (after confirmed speech) commits the segment. */
const SEGMENT_SILENCE_MS = 1_200;
/** VAD: RMS amplitude above which audio counts as speech. 0-32767. */
const SEGMENT_SPEECH_RMS = 200;

interface ToggleOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	/** Live (streaming) partial transcription; empty string when nothing yet. */
	onPartial(text: string): void;
	onStateChange(state: SttState): void;
}

interface Editor {
	insertText(text: string): void;
}

export class STTController {
	#state: SttState = "idle";
	#recordingHandle: RecordingHandle | null = null;
	#tempFile: string | null = null;
	#depsResolved = false;
	#toggling = false;
	#disposed = false;
	#transcriptionAbort: AbortController | null = null;

	// Streaming (qwen realtime) path.
	#kind: SttTranscriptionKind = "local";
	#streamingTranscriber: StreamingTranscriber | null = null;
	#capture: AudioCapture | null = null;
	#activeEditor: Editor | null = null;
	#segHasSpoken = false;
	#segSilenceStartMs = 0;
	#segCommitting = false;
	#segAnyText = false;
	#lastPartialShown = "";

	constructor(private readonly registry: ModelRegistry | undefined) {}

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: ToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#toggling) return;
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					this.#activeEditor = editor;
					await this.#startRecording(options);
					break;
				case "recording":
					await this.#stopAndTranscribe(editor, options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
			}
		} finally {
			this.#toggling = false;
		}
	}

	async #startRecording(options: ToggleOptions): Promise<void> {
		const modelName = settings.get("stt.modelName") as string | undefined;
		this.#kind = getTranscriptionKind(modelName);

		if (this.#kind === "streaming") {
			await this.#startStreaming(options, modelName ?? "qwen-audio-3.0-realtime-plus");
			return;
		}
		await this.#startLocal(options);
	}

	// ---- Local whisper path (file recording + batch transcription) ----

	async #startLocal(options: ToggleOptions): Promise<void> {
		if (!this.#depsResolved) {
			try {
				options.showStatus("Checking STT dependencies...");
				await ensureSTTDependencies({
					modelName: settings.get("stt.modelName") as string | undefined,
					onProgress: p => options.showStatus(p.stage + (p.percent != null ? ` (${p.percent}%)` : "")),
				});
				options.showStatus("");
				this.#depsResolved = true;
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
				options.showWarning(msg);
				logger.error("STT dependency setup failed", { error: msg });
				return;
			}
		}
		const id = Snowflake.next();
		this.#tempFile = path.join(os.tmpdir(), `omp-stt-${id}.wav`);

		try {
			this.#recordingHandle = await startRecording(this.#tempFile);
			this.#setState("recording", options);
			logger.debug("STT recording started", { tempFile: this.#tempFile });
		} catch (err) {
			this.#tempFile = null;
			const msg = err instanceof Error ? err.message : "Failed to start recording";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
		}
	}

	async #stopAndTranscribe(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#kind === "streaming") {
			await this.#stopStreaming(editor, options);
			return;
		}

		const handle = this.#recordingHandle;
		const tempFile = this.#tempFile;
		this.#recordingHandle = null;

		if (!handle || !tempFile) {
			this.#setState("idle", options);
			return;
		}

		try {
			await handle.stop();
			// Validate the recording produced a usable file
			await verifyRecordingFile(tempFile);
			this.#setState("transcribing", options);

			const sttSettings = {
				modelName: settings.get("stt.modelName") as string | undefined,
				language: settings.get("stt.language") as string | undefined,
			};
			this.#transcriptionAbort = new AbortController();
			const text = await transcribe(tempFile, { ...sttSettings, signal: this.#transcriptionAbort.signal });
			this.#transcriptionAbort = null;
			if (this.#disposed) return;
			if (text.length > 0) {
				editor.insertText(text);
				options.showStatus("");
			} else {
				options.showStatus("No speech detected.");
			}
			if (!this.#disposed) this.#setState("idle", options);
		} catch (err) {
			if (this.#disposed) return;
			if (err instanceof DOMException && err.name === "AbortError") {
				this.#setState("idle", options);
				return;
			}
			const msg = err instanceof Error ? err.message : "Transcription failed";
			options.showWarning(msg);
			logger.error("STT transcription failed", { error: msg });
			this.#setState("idle", options);
		} finally {
			try {
				await fs.rm(tempFile, { force: true });
			} catch {
				// best effort cleanup
			}
			this.#tempFile = null;
		}
	}

	// ---- Streaming path (qwen realtime — type as you speak) ----

	async #startStreaming(options: ToggleOptions, modelName: string): Promise<void> {
		try {
			const registry = this.registry;
			if (!registry) {
				throw new Error("Streaming STT requires a model registry");
			}
			const baseUrl = registry.getProviderBaseUrl(STREAMING_PROVIDER);
			const apiKey = await registry.getApiKeyForProvider(STREAMING_PROVIDER).catch(() => undefined);
			if (!baseUrl || !apiKey) {
				throw new Error(`Streaming STT provider "${STREAMING_PROVIDER}" is missing baseUrl or credentials`);
			}

			this.#segHasSpoken = false;
			this.#segSilenceStartMs = 0;
			this.#segCommitting = false;
			this.#segAnyText = false;
			this.#lastPartialShown = "";

			const transcriber = await createStreamingTranscriber({
				baseUrl,
				apiKey,
				model: modelName,
				onPartial: text => {
					if (text === this.#lastPartialShown) return;
					this.#lastPartialShown = text;
					options.onPartial(text);
				},
				onSegment: text => {
					const trimmed = text.trim();
					if (trimmed.length > 0) {
						this.#segAnyText = true;
						this.#activeEditor?.insertText(text);
					}
				},
				onError: err => {
					logger.error("streaming STT server error", { message: err.message });
				},
			});
			this.#streamingTranscriber = transcriber;

			this.#capture = new AudioCapture(16_000, (err, samples) => {
				if (err) {
					logger.debug("STT capture chunk error", { err: String(err) });
					return;
				}
				transcriber.feed(samples);
				this.#feedSegmentVad(samples);
			});
			this.#setState("recording", options);
			logger.debug("STT streaming started", { model: modelName });
		} catch (err) {
			this.#cleanupStreaming();
			const msg = err instanceof Error ? err.message : "Failed to start streaming transcription";
			options.showWarning(msg);
			logger.error("STT streaming failed to start", { error: msg });
		}
	}

	/** VAD: after confirmed speech, sustained silence commits the current segment. */
	#feedSegmentVad(samples: Float32Array): void {
		const rms = rmsLevel(samples);
		const now = Date.now();

		if (rms > SEGMENT_SPEECH_RMS) {
			this.#segHasSpoken = true;
			this.#segSilenceStartMs = 0;
			return;
		}
		if (!this.#segHasSpoken || this.#segCommitting) return;
		if (this.#segSilenceStartMs === 0) {
			this.#segSilenceStartMs = now;
		} else if (now - this.#segSilenceStartMs >= SEGMENT_SILENCE_MS) {
			this.#segCommitting = true;
			void this.#streamingTranscriber?.commit().finally(() => {
				this.#segCommitting = false;
				this.#segSilenceStartMs = 0;
			});
		}
	}

	async #stopStreaming(_editor: Editor, options: ToggleOptions): Promise<void> {
		const transcriber = this.#streamingTranscriber;
		if (transcriber) {
			// Commit whatever is left in the buffer so the final segment lands.
			await transcriber.commit().catch(() => {});
		}
		this.#cleanupStreaming();

		if (this.#disposed) return;
		if (!this.#segAnyText) {
			options.showStatus("No speech detected.");
		} else {
			options.showStatus("");
		}
		if (!this.#disposed) this.#setState("idle", options);
	}

	#cleanupStreaming(): void {
		this.#streamingTranscriber?.dispose();
		this.#streamingTranscriber = null;
		this.#capture?.stop();
		this.#capture = null;
		this.#activeEditor = null;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#transcriptionAbort) {
			this.#transcriptionAbort.abort();
			this.#transcriptionAbort = null;
		}
		this.#cleanupStreaming();
		if (this.#recordingHandle) {
			this.#recordingHandle.stop().catch(() => {});
			this.#recordingHandle = null;
		}
		if (this.#tempFile) {
			fs.rm(this.#tempFile, { force: true }).catch(() => {});
			this.#tempFile = null;
		}
		this.#state = "idle";
		this.#depsResolved = false;
	}
}
