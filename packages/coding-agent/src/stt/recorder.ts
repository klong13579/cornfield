/**
 * Audio recording via native AudioCapture (in-process cpal).
 *
 * Replaces all external-process recorders (ffmpeg/sox/arecord/PowerShell).
 */

import * as fsp from "node:fs/promises";
import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

export interface RecordingHandle {
	stop(): Promise<void>;
	/** Current RMS audio level, 0-32767. 0 when not recording. */
	getLevel(): number;
	/** Peak RMS seen since start(), 0-32767. */
	getPeak(): number;
}

export interface StartRecordingOptions {
	/** Called at ~20Hz with the current RMS audio level. Optional. */
	onLevel?: (rms: number) => void;
}

/**
 * Detect whether recording is available.
 * With the native AudioCapture, this is always true when the addon loads.
 */
export function detectRecordingTools(): string[] {
	return ["native"];
}

const LEVEL_POLL_MS = 50;

/**
 * Start recording audio to the given output path via native AudioCapture.
 *
 * @param outputPath - Path to write the WAV file.
 * @param options - Optional callbacks for live audio level (used by VAD and the level meter).
 * @returns A handle with `stop()`, `getLevel()`, and `getPeak()` methods.
 */
export async function startRecording(outputPath: string, options?: StartRecordingOptions): Promise<RecordingHandle> {
	const capture = new AudioCapture();
	capture.start(1);

	let pollInterval: ReturnType<typeof setInterval> | null = null;
	if (options?.onLevel) {
		const cb = options.onLevel;
		pollInterval = setInterval(() => {
			try {
				cb(capture.getLevel());
			} catch (err) {
				logger.debug("onLevel callback threw", { err: String(err) });
			}
		}, LEVEL_POLL_MS);
	}

	return {
		async stop() {
			if (pollInterval !== null) {
				clearInterval(pollInterval);
				pollInterval = null;
			}
			const wavBuffer = capture.stop();
			await Bun.write(outputPath, wavBuffer);
			logger.debug("Audio capture complete", { outputPath, size: wavBuffer.byteLength });
		},
		getLevel: () => capture.getLevel(),
		getPeak: () => capture.getPeak(),
	};
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
