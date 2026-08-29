/**
 * ListenController — manages recording, transcription, and file storage
 * for the `/record` and `/listen` slash commands.
 *
 * Recording flow:
 *   1. startRecording() opens the native AudioCapture and emits "recording"
 *      status with live audio level. A 10Hz level poller drives the VAD
 *      state machine (auto-stop on sustained silence) and the on-screen
 *      level bar.
 *   2. stopRecording() stops capture, verifies the WAV, and routes to the
 *      transcription path. If the file exceeds `stt.chunkSizeMB`, it's
 *      split into chunks and each chunk is transcribed serially; results
 *      are concatenated.
 *   3. The final text is written to a JSON file under
 *      `~/.cornfield/listen/YYYY-MM-DD-<desc>.json` (or auto-named if no desc).
 *
 * Adaptive timeout: transcription timeout scales with audio length
 * (`stt.transcribeTimeoutMultiplier × duration`, capped at
 * `stt.transcribeTimeoutMaxSec`). Replaces the old hard 120s cap.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings";
import {
	readSttNumber,
	resolveEffectiveModelName,
	saveListenText,
	transcribeAudioWithDefaults,
} from "./listen-service";
import { detectRecordingTools, type RecordingHandle, startRecording, verifyRecordingFile } from "./recorder";
import type { TranscribeProgress } from "./transcriber";
import { DEFAULT_VAD_OPTIONS, feedVadStream, initialVadStreamState, type VadStreamState } from "./vad";

export type ListenState = "idle" | "recording" | "transcribing" | "saving";

export interface ListenStatus {
	state: ListenState;
	elapsed?: number;
	description?: string;
	/** Current RMS level, 0-32767. Present only during "recording". */
	level?: number;
	/** Pre-rendered 7-cell level bar (e.g. "▃▅▆▇▇▅▂"). */
	levelBar?: string;
	/** Peak RMS seen so far in this session. */
	peakRms?: number;
	/** Present only during "transcribing". */
	progress?: TranscribeProgress;
	/** 1-based chunk index when a recording was split into multiple chunks. */
	chunkIndex?: number;
	/** Total chunks. Omitted when no chunking happened. */
	chunkTotal?: number;
}

export interface ListenControllerOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStatusChange(status: ListenStatus): void;
	modelRegistry?: ModelRegistry;
}

const LEVEL_BAR_CELLS = 7;
const LEVEL_EMIT_THROTTLE_MS = 100;

/** Format a duration in seconds as a readable label (e.g. 7200 -> "2h"). */
function formatDuration(totalSec: number): string {
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
	if (m > 0) return `${m}m`;
	return `${totalSec}s`;
}

function renderBarFromRms(samples: readonly number[]): string {
	const cells = [...samples.slice(-LEVEL_BAR_CELLS)];
	while (cells.length < LEVEL_BAR_CELLS) cells.unshift(0);
	// Inline mapping: 0-7 index, sqrt scale, max 16000 RMS -> level 7
	const GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
	const maxRms = 16000;
	return cells
		.map(rms => {
			if (rms <= 0) return GLYPHS[0];
			const norm = Math.min(1, rms / maxRms);
			const idx = Math.min(7, Math.round(Math.sqrt(norm) * 7));
			return GLYPHS[idx];
		})
		.join("");
}

export class ListenController {
	#state: ListenState = "idle";
	#recordingHandle: RecordingHandle | null = null;
	#modelRegistry: ModelRegistry | undefined;
	#tempFile: string | null = null;
	#lastSavedPath: string | null = null;
	#lastUsedModel: string | undefined;
	#onStatusChange: (status: ListenStatus) => void;
	#showWarning: (msg: string) => void;
	#showStatus: (msg: string) => void;
	#recordingStartTime = 0;
	#timerInterval: ReturnType<typeof setInterval> | null = null;

	// VAD / level tracking
	#vadState: VadStreamState = initialVadStreamState();
	#vadOptions = DEFAULT_VAD_OPTIONS;
	#vadEnabled = true;
	#recentRms: number[] = [];
	#lastLevelEmitMs = 0;
	#autoStopTriggered = false;
	#maxRecordingMs = 0;

	get lastSavedPath(): string | null {
		return this.#lastSavedPath;
	}

	/** The model name used in the most recent transcription, if any. */
	get lastUsedModel(): string | undefined {
		return this.#lastUsedModel;
	}

	/**
	 * Resolve the effective model name from settings, without running
	 * transcription. Returns the model that WILL be used on the next call.
	 */
	getEffectiveModelName(): string {
		return resolveEffectiveModelName(this.#modelRegistry);
	}

	constructor(opts: ListenControllerOptions) {
		this.#showWarning = opts.showWarning;
		this.#showStatus = opts.showStatus;
		this.#onStatusChange = opts.onStatusChange;
		this.#modelRegistry = opts.modelRegistry;
	}

	get state(): ListenState {
		return this.#state;
	}

	get elapsed(): number | undefined {
		return this.#recordingStartTime > 0 ? Math.floor((Date.now() - this.#recordingStartTime) / 1000) : undefined;
	}

	#setState(s: ListenState, desc?: string): void {
		this.#state = s;
		this.#emit(desc !== undefined ? { description: desc } : {});
	}

	#buildStatus(extra: Partial<ListenStatus> = {}): ListenStatus {
		return {
			state: this.#state,
			elapsed: this.elapsed,
			...extra,
		};
	}

	#emit(extra: Partial<ListenStatus> = {}): void {
		this.#onStatusChange(this.#buildStatus(extra));
	}

	#startTimer(): void {
		this.#recordingStartTime = Date.now();
		// 1Hz elapsed-tick. The level poller (see startRecording) drives UI
		// updates between these ticks for smooth meter display.
		this.#timerInterval = setInterval(() => this.#emit(), 1000);
	}

	#stopTimer(): void {
		if (this.#timerInterval) {
			clearInterval(this.#timerInterval);
			this.#timerInterval = null;
		}
		this.#recordingStartTime = 0;
	}

	#readVadOptions(): void {
		this.#vadEnabled = (settings.get("stt.vadEnabled") as boolean | undefined) ?? true;
		this.#vadOptions = {
			silenceThreshold: Math.max(0, readSttNumber("stt.silenceThreshold", DEFAULT_VAD_OPTIONS.silenceThreshold)),
			silenceDurationMs:
				readSttNumber("stt.silenceDurationSec", DEFAULT_VAD_OPTIONS.silenceDurationMs / 1000) * 1000,
			minSpeechDurationMs: DEFAULT_VAD_OPTIONS.minSpeechDurationMs,
			maxWaitMs: readSttNumber("stt.maxRecordingSec", DEFAULT_VAD_OPTIONS.maxWaitMs / 1000) * 1000,
		};
		this.#maxRecordingMs = this.#vadOptions.maxWaitMs;
	}

	#handleLevelSample(rms: number): void {
		if (this.#state !== "recording") return;
		// Feed the VAD state machine. It tracks peakRms internally; no need
		// to do it here.
		const now = Date.now();
		const result = feedVadStream(this.#vadState, rms, now, this.#recordingStartTime, this.#vadOptions);
		this.#vadState = result.state;

		// Buffer for level bar
		this.#recentRms.push(rms);
		if (this.#recentRms.length > LEVEL_BAR_CELLS) this.#recentRms.shift();

		// Throttle UI emit to ~10Hz to keep TUI renders cheap
		if (now - this.#lastLevelEmitMs < LEVEL_EMIT_THROTTLE_MS) {
			// Still check VAD/maxRecording even if we throttle the emit
			this.#maybeAutoStop(result.shouldStop, now);
			return;
		}
		this.#lastLevelEmitMs = now;

		this.#emit({
			level: rms,
			levelBar: renderBarFromRms(this.#recentRms),
			peakRms: this.#vadState.peakRms,
		});

		this.#maybeAutoStop(result.shouldStop, now);
	}

	#maybeAutoStop(vadWantsStop: boolean, now: number): void {
		if (this.#autoStopTriggered || this.#state !== "recording") return;
		const elapsedMs = now - this.#recordingStartTime;
		// Safety net: max recording duration, regardless of VAD state.
		if (elapsedMs >= this.#maxRecordingMs) {
			this.#autoStopTriggered = true;
			this.#showStatus(
				`Max recording duration reached (${formatDuration(Math.round(this.#maxRecordingMs / 1000))}) — auto-stopping.`,
			);
			void this.stopRecording();
			return;
		}
		if (this.#vadEnabled && vadWantsStop) {
			this.#autoStopTriggered = true;
			void this.stopRecording();
		}
	}

	async startRecording(): Promise<void> {
		if (this.#state !== "idle") {
			this.#showWarning("Already recording. Use /record stop to finish.");
			return;
		}
		if (detectRecordingTools().length === 0) {
			this.#showWarning("Audio capture is not available. Try rebuilding with: bun build:native");
			return;
		}
		this.#readVadOptions();
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this.#tempFile = path.join(os.tmpdir(), `omp-listen-${id}.wav`);
		this.#vadState = initialVadStreamState();
		this.#recentRms = [];
		this.#lastLevelEmitMs = 0;
		this.#autoStopTriggered = false;
		try {
			this.#recordingHandle = await startRecording(this.#tempFile, {
				onLevel: rms => this.#handleLevelSample(rms),
			});
			this.#setState("recording");
			this.#startTimer();
		} catch (err) {
			this.#tempFile = null;
			this.#recordingHandle = null;
			this.#showWarning(err instanceof Error ? err.message : "Failed to start recording");
		}
	}

	async stopRecording(description?: string): Promise<void> {
		if (this.#state !== "recording") return;
		const handle = this.#recordingHandle;
		const tempFile = this.#tempFile;
		this.#recordingHandle = null;
		this.#stopTimer();
		if (!handle || !tempFile) {
			this.#setState("idle");
			return;
		}
		try {
			await handle.stop();
			await verifyRecordingFile(tempFile);
			this.#setState("transcribing");
			this.#showStatus("Transcribing audio...");
			const { text, model } = await transcribeAudioWithDefaults(tempFile, {
				modelRegistry: this.#modelRegistry,
				onProgress: (p, chunk) =>
					this.#emit({
						progress: p,
						...(chunk ? { chunkIndex: chunk.index, chunkTotal: chunk.total } : {}),
					}),
			});
			this.#lastUsedModel = model;
			this.#setState("saving");
			const savedFile = await saveListenText(text, description);
			this.#lastSavedPath = savedFile;
			this.#setState("idle");
			const modelLabel = this.#lastUsedModel ?? "";
			this.#showStatus(`${savedFile.replace(os.homedir(), "~")} （${modelLabel}）`);
		} catch (err) {
			this.#setState("idle");
			this.#showStatus(""); // Clear the "Transcribing audio..." status
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				this.#showWarning(err instanceof Error ? err.message : "Transcription failed");
			}
		} finally {
			await this.#cleanupTranscriptionArtifacts(tempFile);
		}
	}

	async transcribeFile(filePath: string, description?: string): Promise<void> {
		if (this.#state !== "idle") {
			this.#showWarning("Recording in progress. Use /record stop first.");
			return;
		}
		try {
			await fsp.access(filePath, fs.constants.R_OK);
		} catch {
			this.#showWarning(`File not found: ${filePath}`);
			return;
		}
		this.#setState("transcribing");
		this.#showStatus("Transcribing audio file...");
		try {
			const { text, model } = await transcribeAudioWithDefaults(filePath, {
				modelRegistry: this.#modelRegistry,
				onProgress: (p, chunk) =>
					this.#emit({
						progress: p,
						...(chunk ? { chunkIndex: chunk.index, chunkTotal: chunk.total } : {}),
					}),
			});
			this.#lastUsedModel = model;
			this.#setState("saving");
			const savedFile = await saveListenText(text, description ?? path.basename(filePath, path.extname(filePath)));
			this.#lastSavedPath = savedFile;
			this.#setState("idle");
			const modelLabel = this.#lastUsedModel ?? "";
			this.#showStatus(`${savedFile.replace(os.homedir(), "~")} （${modelLabel}）`);
		} catch (err) {
			this.#setState("idle");
			this.#showStatus(""); // Clear the "Transcribing audio file..." status
			this.#showWarning(err instanceof Error ? err.message : "Transcription failed");
		} finally {
			await this.#cleanupTranscriptionArtifacts(null);
		}
	}

	async cancelRecording(): Promise<void> {
		if (this.#state !== "recording") {
			this.#showWarning("No active recording.");
			return;
		}
		const handle = this.#recordingHandle;
		const tempFile = this.#tempFile;
		this.#recordingHandle = null;
		this.#autoStopTriggered = true; // suppress any pending VAD trigger
		this.#stopTimer();
		try {
			await handle?.stop();
		} catch {
			/* best effort */
		}
		if (tempFile) await fsp.rm(tempFile, { force: true }).catch(() => {});
		this.#tempFile = null;
		this.#setState("idle");
		this.#showStatus("Recording cancelled.");
	}

	async #cleanupTranscriptionArtifacts(tempFile: string | null): Promise<void> {
		if (tempFile) {
			await fsp.rm(tempFile, { force: true }).catch(() => {});
		}
		this.#tempFile = null;
	}

	dispose(): void {
		this.#stopTimer();
		if (this.#recordingHandle) {
			this.#recordingHandle.stop().catch(() => {});
			this.#recordingHandle = null;
		}
		if (this.#tempFile) {
			fsp.rm(this.#tempFile, { force: true }).catch(() => {});
			this.#tempFile = null;
		}
		this.#lastSavedPath = null;
		this.#state = "idle";
	}
}
