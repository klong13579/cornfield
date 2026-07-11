/**
 * ListenController — manages recording, transcription, and file storage
 * for the `/record` and `/listen` slash commands.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { type RecordingHandle, startRecording, verifyRecordingFile, detectRecordingTools } from "./recorder";
import { transcribe } from "./transcriber";

export type ListenState = "idle" | "recording" | "transcribing" | "saving";

export interface ListenStatus {
	state: ListenState;
	elapsed?: number;
	description?: string;
}

export interface ListenControllerOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStatusChange(status: ListenStatus): void;
}

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
		const safe = description.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "-").slice(0, 80);
		return `${datePart}-${safe}.json`;
	}
	const timePart = now.toTimeString().slice(0, 8).replace(/:/g, "");
	return `${datePart}-${timePart}.json`;
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
		return this.#recordingStartTime > 0
			? Math.floor((Date.now() - this.#recordingStartTime) / 1000)
			: undefined;
	}

	#setState(s: ListenState, desc?: string): void {
		this.#state = s;
		this.#emit(desc);
	}

	#emit(desc?: string): void {
		this.#onStatusChange({ state: this.#state, elapsed: this.elapsed, description: desc });
	}

	#startTimer(): void {
		this.#recordingStartTime = Date.now();
		this.#timerInterval = setInterval(() => this.#emit(), 1000);
	}

	#stopTimer(): void {
		if (this.#timerInterval) {
			clearInterval(this.#timerInterval);
			this.#timerInterval = null;
		}
		this.#recordingStartTime = 0;
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
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this.#tempFile = path.join(os.tmpdir(), `omp-listen-${id}.wav`);
		try {
			this.#recordingHandle = await startRecording(this.#tempFile);
			this.#setState("recording");
			this.#startTimer();
		} catch (err) {
			this.#tempFile = null;
			this.#showWarning(err instanceof Error ? err.message : "Failed to start recording");
		}
	}

	async stopRecording(_description?: string): Promise<void> {
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
			const text = await transcribe(tempFile, {
				modelName: settings.get("stt.modelName") as string | undefined,
				language: settings.get("stt.language") as string | undefined,
			});
			this.#setState("saving");
			const savedFile = await this.#saveText(text, _description, tempFile);
			this.#setState("idle");
			this.#showStatus(savedFile.replace(os.homedir(), "~"));
		} catch (err) {
			this.#setState("idle");
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				this.#showWarning(err instanceof Error ? err.message : "Transcription failed");
			}
		} finally {
			await fsp.rm(tempFile, { force: true }).catch(() => {});
			this.#tempFile = null;
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
			const text = await transcribe(filePath, {
				modelName: settings.get("stt.modelName") as string | undefined,
				language: settings.get("stt.language") as string | undefined,
			});
			this.#setState("saving");
			const savedFile = await this.#saveText(text, description ?? path.basename(filePath, path.extname(filePath)));
			this.#setState("idle");
			this.#showStatus(savedFile.replace(os.homedir(), "~"));
		} catch (err) {
			this.#setState("idle");
			this.#showWarning(err instanceof Error ? err.message : "Transcription failed");
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

	async #saveText(text: string, description?: string, _sourceFile?: string): Promise<string> {
		const dir = getListenDir();
		const out = path.join(dir, buildFilename(description));
		await fsp.writeFile(out, JSON.stringify({ version: 1, recorded_at: new Date().toISOString(), text }, null, 2), "utf-8");
		this.#lastSavedPath = out;
		return out;
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
