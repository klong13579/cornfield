/**
 * Audio recording via native AudioCapture (in-process miniaudio streaming).
 *
 * Replaces all external-process recorders (ffmpeg/sox/arecord/PowerShell).
 * The native binding delivers live f32 chunks; we accumulate them and encode
 * the WAV in JS on stop.
 */
import * as fsp from "node:fs/promises";
import { AudioCapture } from "@cornfield/natives";
import { logger } from "@cornfield/utils";
import { encodeWav, float32ToPcm16, rmsLevel } from "./pcm";

export interface RecordingHandle {
	stop(): Promise<void>;
	/** Current RMS audio level, 0-32767. 0 when not recording. */
	getLevel(): number;
	/** Peak RMS seen since start(), 0-32767. */
	getPeak(): number;
}

export interface StartRecordingOptions {
	/** Called with the current RMS audio level (0-32767) for every captured chunk. Optional. */
	onLevel?: (rms: number) => void;
}

/**
 * Detect whether recording is available.
 * With the native AudioCapture, this is always true when the addon loads.
 */
export function detectRecordingTools(): string[] {
	return ["native"];
}

/** Whisper wants 16 kHz; miniaudio resamples internally, so we open the device at the target rate. */
const STT_SAMPLE_RATE = 16_000;

/**
 * Start recording audio to the given output path via native AudioCapture.
 *
 * @param outputPath - Path to write the WAV file.
 * @param options - Optional callbacks for live audio level (used by VAD and the level meter).
 * @returns A handle with `stop()`, `getLevel()`, and `getPeak()` methods.
 */
export function startRecording(outputPath: string, options?: StartRecordingOptions): Promise<RecordingHandle> {
	const chunks: Float32Array[] = [];
	let totalSamples = 0;
	let lastLevel = 0;
	let peakLevel = 0;

	const capture = new AudioCapture(STT_SAMPLE_RATE, (err, samples) => {
		if (err) {
			logger.debug("AudioCapture chunk error", { err: String(err) });
			return;
		}
		chunks.push(samples);
		totalSamples += samples.length;
		const level = rmsLevel(samples);
		lastLevel = level;
		if (level > peakLevel) peakLevel = level;
		if (options?.onLevel) {
			try {
				options.onLevel(level);
			} catch (callbackErr) {
				logger.debug("onLevel callback threw", { err: String(callbackErr) });
			}
		}
	});

	return Promise.resolve({
		async stop() {
			capture.stop();
			const merged = new Float32Array(totalSamples);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.length;
			}
			const wavBuffer = encodeWav(float32ToPcm16(merged), STT_SAMPLE_RATE);
			await Bun.write(outputPath, wavBuffer);
			logger.debug("Audio capture complete", { outputPath, size: wavBuffer.byteLength });
		},
		getLevel: () => lastLevel,
		getPeak: () => peakLevel,
	});
}

/**
 * Verify a recorded audio file is usable.
 * Returns the file size in bytes, or throws.
 */
export async function verifyRecordingFile(filePath: string): Promise<number> {
	try {
		const stat = await fsp.stat(filePath);
		if (stat.size < 100) {
			throw new Error(
				`Recording file is too small (${stat.size} bytes) — audio may not have been captured. ` +
					"Check that a microphone is connected and permissions are granted.",
			);
		}
		return stat.size;
	} catch (err) {
		if (err instanceof Error && err.message.includes("too small")) throw err;
		throw new Error(
			"Recording file was not created. The recording process may have failed silently. " +
				"Check that a microphone is connected.",
		);
	}
}
