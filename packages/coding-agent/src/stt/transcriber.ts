import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings";
import { readWavInfo } from "./chunker";

import transcribeScript from "./transcribe.py" with { type: "text" };

export interface TranscribeOptions {
	modelName?: string;
	language?: string;
	signal?: AbortSignal;
	onProgress?: (progress: TranscribeProgress) => void;
}

export interface TranscribeViaApiOptions {
	modelName?: string;
	language?: string;
	modelRegistry?: ModelRegistry;
	/** Provider name (e.g. "narwal-plan"). When provided, bypasses model-registry lookup. */
	provider?: string;
	onProgress?: (progress: TranscribeProgress) => void;
}

export interface TranscribeProgress {
	stage: "loading-model" | "transcribing" | "finalizing";
	percent?: number;
}

const FALLBACK_TIMEOUT_SEC = 120;
/** Hard floor on the timeout, regardless of audio length. */
const TIMEOUT_FLOOR_MS = 60_000;
/** How often to emit transcribing-stage progress updates. */
const PROGRESS_INTERVAL_MS = 500;
/**
 * Gateway batch-ASR model used for REST transcription.
 *
 * The WS-realtime model ids (qwen-audio-3.0-realtime-*) are only serviced by
 * the /realtime websocket endpoint, and that path caps the input buffer at
 * 30s — recordings longer than that fail with "Input audio buffer exceeded
 * maximum duration". The REST batch endpoint (POST /v1/audio/transcriptions)
 * has no length limit and returns in seconds; it expects a batch-ASR model
 * id instead of a realtime one.
 */
const REST_BATCH_TRANSCRIPTION_MODEL = "qwen3-asr-flash-filetrans";

/**
 * Find a usable Python command.
 *
 * Priority:
 *   1. mlx-whisper dedicated venv at ~/.venvs/mlx-whisper/ (macOS)
 *   2. System Python (python3 / python / py)
 */
export function resolvePython(): string | null {
	// On macOS, prefer the mlx-whisper venv which has Apple Silicon GPU support
	if (process.platform === "darwin") {
		const mlxVenvPython = path.join(os.homedir(), ".venvs", "mlx-whisper", "bin", "python3");
		try {
			fs.accessSync(mlxVenvPython, fs.constants.X_OK);
			return mlxVenvPython;
		} catch {
			// fall through to system python
		}
	}
	for (const cmd of ["python", "py", "python3"]) {
		if ($which(cmd)) return cmd;
	}
	return null;
}

/**
 * Compute transcription timeout in milliseconds.
 *
 * Adaptive: scales with audio length, capped by user-configured ceiling.
 * Replaces the old hardcoded 120s that caused "Transcription timed out after 120s"
 * on recordings longer than ~40s.
 */
function computeTranscribeTimeoutMs(audioDurationSec: number | null): number {
	const mult = (settings.get("stt.transcribeTimeoutMultiplier") as number | undefined) ?? 3;
	const maxSec = (settings.get("stt.transcribeTimeoutMaxSec") as number | undefined) ?? 3600;
	if (audioDurationSec === null || audioDurationSec <= 0) {
		// Unknown duration — fall back to the old 120s baseline.
		return Math.max(TIMEOUT_FLOOR_MS, FALLBACK_TIMEOUT_SEC * 1000);
	}
	const adaptive = audioDurationSec * mult;
	return Math.min(adaptive, maxSec) * 1000;
}

/**
 * Read the WAV header to get audio duration in seconds. Returns null if the
 * file isn't a parseable PCM WAV.
 */
async function readAudioDurationSec(audioPath: string): Promise<number | null> {
	try {
		const info = await readWavInfo(audioPath);
		if (info.sampleRate <= 0) return null;
		return info.numFrames / info.sampleRate;
	} catch (err) {
		logger.debug("Could not read WAV header for duration", { audioPath, err: String(err) });
		return null;
	}
}

/**
 * Transcribe a WAV file using Python mlx-whisper (Apple Silicon) or openai-whisper.
 *
 * Reads the WAV via Python's built-in `wave` module (no ffmpeg needed),
 * resamples to 16 kHz mono, and passes the numpy array directly to whisper.
 */
export async function transcribe(audioPath: string, options?: TranscribeOptions): Promise<string> {
	const audioFile = Bun.file(audioPath);
	if (audioFile.size < 100) {
		throw new Error(`Audio file is empty or too small (${audioFile.size} bytes). Check microphone.`);
	}

	const pythonCmd = resolvePython();
	if (!pythonCmd) {
		throw new Error("Python not found. Install Python 3.8+ from https://python.org");
	}

	const modelName = options?.modelName ?? "mlx-community/whisper-large-v3-turbo";
	const language = options?.language;

	const audioDurationSec = await readAudioDurationSec(audioPath);
	const timeoutMs = computeTranscribeTimeoutMs(audioDurationSec);

	logger.debug("Transcribing with Python whisper", {
		pythonCmd,
		audioPath,
		modelName,
		language,
		audioDurationSec,
		timeoutMs,
	});

	const args: string[] = [pythonCmd, "-c", transcribeScript, audioPath, modelName];
	if (language) args.push(language);
	const proc = Bun.spawn(args, {
		stdout: "pipe",
		stderr: "pipe",
	});

	if (options?.signal?.aborted) {
		proc.kill();
		options.signal.throwIfAborted();
	}

	const onAbort = () => proc.kill();
	options?.signal?.addEventListener("abort", onAbort, { once: true });

	let timedOut = false;
	const startedAt = Date.now();

	const killTimer = setTimeout(() => {
		timedOut = true;
		logger.error("Python whisper transcription timed out, killing process", { timeoutMs });
		proc.kill();
	}, timeoutMs);

	// Emit progress updates while the process is running. We can't observe
	// mlx-whisper's internal progress, so this is a linear time-based estimate.
	// It still gives the user a "is this hung or working" signal.
	const emitProgress = options?.onProgress;
	if (emitProgress) {
		emitProgress({ stage: "loading-model" });
	}
	const progressTimer = emitProgress
		? setInterval(() => {
				const elapsedMs = Date.now() - startedAt;
				// First 20% of the timeout is "loading-model" (covers HF download / model load
				// on first run); the rest is transcription. This is a rough split — actual
				// ratios vary — but it makes the progress bar feel non-deceptive.
				const total = timeoutMs;
				if (elapsedMs < total * 0.2) {
					emitProgress({ stage: "loading-model", percent: Math.min(100, (elapsedMs / (total * 0.2)) * 100) });
				} else {
					const transcribeElapsed = elapsedMs - total * 0.2;
					const transcribeBudget = total * 0.8;
					const percent = Math.min(99, (transcribeElapsed / transcribeBudget) * 100);
					emitProgress({ stage: "transcribing", percent });
				}
			}, PROGRESS_INTERVAL_MS)
		: null;

	const exitCode = await proc.exited;
	clearTimeout(killTimer);
	if (progressTimer) clearInterval(progressTimer);
	options?.signal?.removeEventListener("abort", onAbort);

	options?.signal?.throwIfAborted();

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	if (timedOut) {
		throw new Error(
			`Transcription timed out after ${Math.round(timeoutMs / 1000)}s ` +
				`(audio was ${audioDurationSec ? `${Math.round(audioDurationSec)}s` : "unknown length"}). ` +
				`Increase stt.transcribeTimeoutMaxSec or use a smaller model.`,
		);
	}

	if (exitCode !== 0) {
		logger.error("Python whisper transcription failed", { exitCode, stderr: stderr.trim() });
		if (stderr.includes("No module named 'mlx_whisper'")) {
			throw new Error("mlx-whisper not installed. Run: pip install mlx-whisper");
		}
		// Show last line of stderr (the actual error, not the full traceback)
		const lastLine = stderr.trim().split("\n").pop() ?? "";
		throw new Error(`Transcription failed: ${lastLine}`);
	}

	if (emitProgress) {
		emitProgress({ stage: "finalizing", percent: 100 });
	}

	const text = stdout.trim();
	logger.debug("Transcription complete", { length: text.length });
	return text;
}

/**
 * Transcribe a WAV file via the OpenAI-compatible audio transcriptions API
 * (e.g. qwen-audio models served over the configured provider's endpoint).
 *
 * Uses the model registry to resolve the provider base URL and API key.
 */
export async function transcribeViaApi(audioPath: string, options?: TranscribeViaApiOptions): Promise<string> {
	const audioFile = Bun.file(audioPath);
	if (audioFile.size < 100) {
		throw new Error(`Audio file is empty or too small (${audioFile.size} bytes). Check microphone.`);
	}

	const modelName = options?.modelName ?? "qwen-audio-3.0-realtime-flash";
	const language = options?.language;
	const registry = options?.modelRegistry;

	if (!registry) {
		throw new Error(
			"Model registry required for API-based transcription. " +
				"Set record.model to a local whisper model (mlx-community/...) to use local transcription instead.",
		);
	}

	// Resolve provider: caller can pass it directly, or we look up the model
	// in the registry. Direct provider is preferred for custom models that
	// aren't in the bundled registry (e.g. qwen-audio-3.0-realtime-flash).
	let provider = options?.provider;
	if (!provider) {
		const available = registry.getAvailable();
		const modelEntry = available.find(m => m.id === modelName || `${m.provider}/${m.id}` === modelName);
		if (!modelEntry) {
			throw new Error(
				`Model "${modelName}" not found in the model registry. ` +
					"Check that the model is configured in your models.yml, or specify the provider " +
					"via record.model in 'provider/modelId' format.",
			);
		}
		provider = modelEntry.provider;
	}

	const baseUrl = registry.getProviderBaseUrl(provider);
	if (!baseUrl) {
		throw new Error(`No base URL configured for provider "${provider}".`);
	}

	const apiKey = await registry.getApiKeyForProvider(provider);
	if (!apiKey) {
		throw new Error(`No API key configured for provider "${provider}".`);
	}

	// Normalize base URL: strip trailing /v1 or /v1/ if present, then append
	// /v1/audio/transcriptions (REST batch semantics).
	const normalizedBase = baseUrl.replace(/\/v1\/?$/, "");
	const transcriptionUrl = `${normalizedBase}/v1/audio/transcriptions`;

	const emitProgress = options?.onProgress;
	emitProgress?.({ stage: "loading-model" });

	const audioDurationSec = await readAudioDurationSec(audioPath);
	// Floor the timeout regardless of readAudioDurationSec: the REST endpoint
	// needs seconds at minimum, and readWavInfo can misparse non-standard
	// headers (afconvert's FLLR chunk) into a near-zero duration that would
	// otherwise produce a sub-second timeout.
	const timeoutMs = Math.max(computeTranscribeTimeoutMs(audioDurationSec), TIMEOUT_FLOOR_MS);

	// Real-time ids (qwen-audio-3.0-realtime-*) are WS-only on the gateway; the
	// REST batch endpoint requires a batch-ASR model id.
	const restModelName = modelName.startsWith("qwen-audio-3.0-realtime-") ? REST_BATCH_TRANSCRIPTION_MODEL : modelName;

	logger.debug("Transcribing via REST batch API", {
		audioPath,
		modelName,
		restModelName,
		provider,
		baseUrl,
		transcriptionUrl,
		language,
	});

	// Build the multipart form data (Content-Type set automatically by fetch
	// for FormData — multipart/form-data).
	const formData = new FormData();
	formData.append("model", restModelName);
	formData.append("file", audioFile, path.basename(audioPath));
	if (language) {
		formData.append("language", language);
	}

	let response: Response;
	try {
		response = await fetch(transcriptionUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			body: formData,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new Error(
				`API transcription timed out after ${Math.round(timeoutMs / 1000)}s ` +
					`(audio was ${audioDurationSec ? `${Math.round(audioDurationSec)}s` : "unknown length"}). ` +
					"Increase stt.transcribeTimeoutMaxSec if the gateway is slow.",
			);
		}
		throw err;
	}

	if (!response.ok) {
		const errorBody = await response.text().catch(() => "(no body)");
		throw new Error(`API transcription failed (${response.status}): ${errorBody.slice(0, 500)}`);
	}

	emitProgress?.({ stage: "transcribing", percent: 50 });

	const result = (await response.json()) as { text?: string };
	const text = (result.text ?? "").trim();

	emitProgress?.({ stage: "finalizing", percent: 100 });

	logger.debug("API transcription complete", {
		length: text.length,
		provider,
		modelName,
		restModelName,
	});
	return text;
}
