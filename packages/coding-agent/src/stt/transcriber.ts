import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import transcribeScript from "./transcribe.py" with { type: "text" };

export interface TranscribeOptions {
	modelName?: string;
	language?: string;
	signal?: AbortSignal;
}

const TRANSCRIBE_TIMEOUT_MS = 120_000;

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

	logger.debug("Transcribing with Python whisper", { pythonCmd, audioPath, modelName, language });

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

	const killTimer = setTimeout(() => {
		timedOut = true;
		logger.error("Python whisper transcription timed out, killing process", { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
		proc.kill();
	}, TRANSCRIBE_TIMEOUT_MS);

	const exitCode = await proc.exited;
	clearTimeout(killTimer);
	options?.signal?.removeEventListener("abort", onAbort);

	options?.signal?.throwIfAborted();

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	if (timedOut) {
		throw new Error(`Transcription timed out after ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)}s`);
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

	const text = stdout.trim();
	logger.debug("Transcription complete", { length: text.length });
	return text;
}
