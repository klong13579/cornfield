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
 *      `~/.omp/listen/YYYY-MM-DD-<desc>.json` (or auto-named if no desc).
 *
 * Adaptive timeout: transcription timeout scales with audio length
 * (`stt.transcribeTimeoutMultiplier × duration`, capped at
 * `stt.transcribeTimeoutMaxSec`). Replaces the old hard 120s cap.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { cleanupChunks, joinTranscripts, splitWavFile } from "./chunker";
import { detectRecordingTools, type RecordingHandle, startRecording, verifyRecordingFile } from "./recorder";
import { type TranscribeProgress, transcribe } from "./transcriber";
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
}

const LEVEL_BAR_CELLS = 7;
const LEVEL_EMIT_THROTTLE_MS = 100;

function getListenDir(): string {
	const base = getConfigRootDir();
	const d = path.join(base, "listen");
	try {
		fs.mkdirSync(d, { recursive: true });
	} catch {
		/* exists */
	}
	return d;
}

export function buildFilename(description?: string): string {
	const now = new Date();
	const datePart = now.toISOString().slice(0, 10);
	if (description) {
		const safe = description
			.replace(/[<>:"/\\|?*]/g, "")
			.replace(/\s+/g, "-")
			.slice(0, 80);
		return `${datePart}-${safe}.json`;
	}
	const timePart = now.toTimeString().slice(0, 8).replace(/:/g, "");
	return `${datePart}-${timePart}.json`;
}

function readSttNumber(key: string, fallback: number): number {
	// settings.get is typed as a keyof-Settings generic; a string variable
	// loses the literal narrowing, so we go through `as never` to keep the
	// single-line accessor ergonomic without losing the runtime safety net below.
	const v = (settings.get as (k: string) => unknown)(key);
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
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
	#tempFile: string | null = null;
	#lastSavedPath: string | null = null;
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
	#currentChunkPaths: string[] = [];

	get lastSavedPath(): string | null {
		return this.#lastSavedPath;
	}

	constructor(opts: ListenControllerOptions) {
		this.#showWarning = opts.showWarning;
		this.#showStatus = opts.showStatus;
		this.#onStatusChange = opts.onStatusChange;
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
				`Max recording duration reached (${Math.round(this.#maxRecordingMs / 1000)}s) — auto-stopping.`,
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
		this.#currentChunkPaths = [];
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
			const text = await this.#transcribeMaybeChunked(tempFile);
			this.#setState("saving");
			const savedFile = await this.#saveText(text, description, tempFile);
			this.#setState("idle");
			this.#showStatus(savedFile.replace(os.homedir(), "~"));
		} catch (err) {
			this.#setState("idle");
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
			const text = await this.#transcribeMaybeChunked(filePath);
			this.#setState("saving");
			const savedFile = await this.#saveText(text, description ?? path.basename(filePath, path.extname(filePath)));
			this.#setState("idle");
			this.#showStatus(savedFile.replace(os.homedir(), "~"));
		} catch (err) {
			this.#setState("idle");
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

	/**
	 * Transcribe a WAV file. If it exceeds `stt.chunkSizeMB`, split into chunks
	 * and transcribe serially. Returns the joined transcript.
	 */
	async #transcribeMaybeChunked(audioPath: string): Promise<string> {
		const chunkSizeMB = readSttNumber("stt.chunkSizeMB", 20);
		const chunkSizeBytes = chunkSizeMB * 1024 * 1024;
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(audioPath);
		} catch (err) {
			// File might be missing, unreadable, or a non-WAV path passed via
			// transcribeFile. Fall through to the direct path — transcribe()
			// will produce a more specific error.
			logger.debug("stat failed before chunking decision; falling back to direct transcribe", {
				audioPath,
				err: String(err),
			});
			return await transcribe(audioPath, {
				modelName: settings.get("stt.modelName") as string | undefined,
				language: settings.get("stt.language") as string | undefined,
				onProgress: p => this.#emit({ progress: p }),
			});
		}

		if (stat.size <= chunkSizeBytes) {
			return await transcribe(audioPath, {
				modelName: settings.get("stt.modelName") as string | undefined,
				language: settings.get("stt.language") as string | undefined,
				onProgress: p => this.#emit({ progress: p }),
			});
		}

		// Oversized file: split and transcribe chunk by chunk.
		const chunks = await splitWavFile(audioPath, { maxChunkBytes: chunkSizeBytes });
		this.#currentChunkPaths = chunks;
		logger.info("Recording exceeded chunk threshold; transcribing in parts", {
			audioPath,
			totalChunks: chunks.length,
			chunkSizeMB,
		});

		const transcripts: string[] = [];
		try {
			for (let i = 0; i < chunks.length; i++) {
				this.#emit({
					progress: { stage: "transcribing", percent: 0 },
					chunkIndex: i + 1,
					chunkTotal: chunks.length,
				});
				const t = await transcribe(chunks[i], {
					modelName: settings.get("stt.modelName") as string | undefined,
					language: settings.get("stt.language") as string | undefined,
					onProgress: p =>
						this.#emit({
							progress: p,
							chunkIndex: i + 1,
							chunkTotal: chunks.length,
						}),
				});
				transcripts.push(t);
			}
		} finally {
			await cleanupChunks(chunks);
			this.#currentChunkPaths = [];
		}

		const joined = joinTranscripts(transcripts);
		if (!joined) {
			throw new Error("Transcription produced no text. Check audio quality or model settings.");
		}
		return joined;
	}

	async #saveText(text: string, description?: string, _sourceFile?: string): Promise<string> {
		const dir = getListenDir();
		const out = path.join(dir, buildFilename(description));
		await fsp.writeFile(
			out,
			JSON.stringify({ version: 1, recorded_at: new Date().toISOString(), text }, null, 2),
			"utf-8",
		);
		this.#lastSavedPath = out;
		return out;
	}

	async #cleanupTranscriptionArtifacts(tempFile: string | null): Promise<void> {
		// Clean up any leftover chunk files (in case of mid-transcribe error).
		if (this.#currentChunkPaths.length > 0) {
			await cleanupChunks(this.#currentChunkPaths);
			this.#currentChunkPaths = [];
		}
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
