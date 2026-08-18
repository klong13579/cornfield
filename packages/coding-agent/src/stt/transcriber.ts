import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRealtimeWsUrl, chunkPcm16, pcm16ToBase64, REALTIME_SAMPLE_RATE } from "@oh-my-pi/pi-ai";
import { $which, logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings";
import { readWavInfo } from "./chunker";
import { resamplePcm16 } from "./pcm";

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

	// Keep the base URL as-is (e.g. "https://coder.narwal.com/v1").
	// buildRealtimeWsUrl handles the /realtime suffix and protocol upgrade.
	const normalizedBase = baseUrl.replace(/\/?$/, "");

	logger.debug("Transcribing via realtime WebSocket", {
		audioPath,
		modelName,
		provider,
		baseUrl,
		language,
	});

	const emitProgress = options?.onProgress;
	emitProgress?.({ stage: "loading-model" });

	// ---- Read WAV, extract PCM, resample to 24kHz ----
	const wavInfo = await readWavInfo(audioPath);
	if (wavInfo.channels !== 1 || wavInfo.sampleWidth !== 2) {
		throw new Error(
			`Unsupported WAV format: ${wavInfo.channels}ch ${wavInfo.sampleWidth * 8}bit ` +
				"(only mono 16-bit PCM is supported)",
		);
	}

	const wavBuf = Buffer.from(await audioFile.arrayBuffer());
	// Skip the 44-byte RIFF/WAV header to get the raw PCM data.
	const pcmRaw = new Uint8Array(wavBuf.buffer, wavBuf.byteOffset + 44, wavBuf.byteLength - 44);

	// Resample to 24kHz if the recording is at a different rate.
	// The recorder produces 16kHz; the realtime endpoint expects 24kHz PCM16.
	let pcm: Uint8Array;
	if (wavInfo.sampleRate === REALTIME_SAMPLE_RATE) {
		pcm = pcmRaw;
	} else {
		pcm = resamplePcm16(pcmRaw, wavInfo.sampleRate, REALTIME_SAMPLE_RATE);
	}

	// ---- WebSocket realtime transcription ----
	const wsUrl = buildRealtimeWsUrl(normalizedBase, modelName);

	// Bun's WebSocket accepts custom headers; the DOM lib type does not.
	const WebSocketWithHeaders = WebSocket as unknown as {
		new (url: string, options?: { headers?: Record<string, string> }): WebSocket;
	};

	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const ws = new WebSocketWithHeaders(wsUrl, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"OpenAI-Beta": "realtime=v1",
		},
	});

	// Timeout scales with audio length (same policy as the local whisper path): the
	// realtime server must consume `duration` seconds of audio before it can return a
	// transcript, so a fixed 120s cap misfires on multi-minute recordings.
	const audioDurationSec = wavInfo.numFrames / wavInfo.sampleRate;
	const TIMEOUT_MS = computeTranscribeTimeoutMs(audioDurationSec);

	// Settle exactly once — the WS can close, error, time out, or deliver the transcript
	// in any order. Any path that leaves the promise pending locks the ListenController
	// in "transcribing" forever (progress frozen at the last emit). onclose in particular
	// MUST reject: it can fire without an error event (server-side clean close), and the
	// old handler cleared the timeout, permanently stranding the await below.
	let settled = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const finish = (op: () => void): void => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		op();
	};

	timeout = setTimeout(() => {
		ws.close();
		finish(() => reject(new Error(`WebSocket transcription timed out after ${TIMEOUT_MS / 1000}s`)));
	}, TIMEOUT_MS);

	let transcript = "";

	ws.onopen = () => {
		logger.debug("realtime WS connected");
	};

	ws.onmessage = (event: MessageEvent) => {
		if (typeof event.data !== "string") return;

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(event.data) as Record<string, unknown>;
		} catch {
			return;
		}

		const type = msg.type as string;

		switch (type) {
			case "session.created": {
				// Server is ready — configure the session for transcription.
				ws.send(
					JSON.stringify({
						type: "session.update",
						session: {
							modalities: ["text"],
							input_audio_format: "pcm16",
							input_audio_transcription: { model: "fun-asr" },
							turn_detection: null,
						},
					}),
				);
				logger.debug("sent session.update");
				break;
			}

			case "session.updated": {
				// Session configured — start sending audio chunks.
				emitProgress?.({ stage: "transcribing", percent: 10 });

				// Send audio in 200ms chunks for smooth streaming.
				const chunks = chunkPcm16(pcm, 200, REALTIME_SAMPLE_RATE);
				for (const chunk of chunks) {
					ws.send(
						JSON.stringify({
							type: "input_audio_buffer.append",
							audio: pcm16ToBase64(chunk),
						}),
					);
				}
				logger.debug("sent audio chunks", { count: chunks.length });

				// Commit the buffer so the server processes the audio.
				ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
				logger.debug("sent input_audio_buffer.commit");
				emitProgress?.({ stage: "transcribing", percent: 50 });
				break;
			}

			case "conversation.item.created": {
				// Audio item created on the server — ignore.
				break;
			}

			case "conversation.item.input_audio_transcription.delta": {
				// Streaming partial transcript.
				const delta = msg.delta as string;
				if (delta) transcript += delta;
				break;
			}

			case "conversation.item.input_audio_transcription.completed": {
				// Final transcript received.
				const finalTranscript = msg.transcript as string;
				if (finalTranscript) {
					transcript = finalTranscript;
				} else {
					transcript = transcript.trim();
				}
				finish(() => {
					ws.close();
					resolve(transcript);
				});
				break;
			}

			case "response.done": {
				// Server finished processing — if we haven't resolved yet, close.
				// The transcript should have arrived via the completed event.
				if (!transcript) {
					const raw = msg.raw as Record<string, unknown> | undefined;
					const response = raw?.response as Record<string, unknown> | undefined;
					const output = response?.output as Array<Record<string, unknown>> | undefined;
					if (output) {
						for (const item of output) {
							if (item.type === "input_audio") {
								const content = item.content as Array<Record<string, unknown>> | undefined;
								if (content) {
									for (const c of content) {
										if (c.type === "input_audio_transcription" && c.transcript) {
											transcript = c.transcript as string;
										}
									}
								}
							}
						}
					}
					finish(() => {
						ws.close();
						resolve(transcript || "");
					});
				}
				break;
			}

			case "error": {
				const errMsg = (msg.message as string) ?? JSON.stringify(msg);
				logger.error("realtime WS error", { message: errMsg });
				finish(() => {
					ws.close();
					reject(new Error(`Realtime transcription error: ${errMsg}`));
				});
				break;
			}
		}
	};

	ws.onerror = (err: Event) => {
		logger.error("realtime WS onerror", { error: String(err) });
		const errMsg = err instanceof ErrorEvent ? err.message : "WebSocket connection failed";
		finish(() => reject(new Error(`Realtime connection error: ${errMsg}`)));
	};

	ws.onclose = (event: CloseEvent) => {
		const code = event?.code;
		const reason = event?.reason;
		logger.debug("realtime WS closed", { code, reason });
		const detail = code !== undefined ? ` (code=${code}${reason ? `, reason=${reason}` : ""})` : "";
		finish(() => reject(new Error(`Realtime connection closed before transcription completed${detail}`)));
	};

	const text = await promise;

	emitProgress?.({ stage: "finalizing", percent: 100 });

	logger.debug("API transcription complete", {
		length: text.length,
		provider,
		modelName,
	});
	return text;
}
