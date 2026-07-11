/**
 * Audio recording via native AudioCapture (in-process cpal).
 *
 * Replaces all external-process recorders (ffmpeg/sox/arecord/PowerShell).
 */

import { AudioCapture } from "@oh-my-pi/pi-natives";
import * as fsp from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";

export interface RecordingHandle {
	stop(): Promise<void>;
}

/**
 * Detect whether recording is available.
 * With the native AudioCapture, this is always true when the addon loads.
 */
export function detectRecordingTools(): string[] {
	return ["native"];
}

/**
 * Start recording audio to the given output path via native AudioCapture.
 *
 * @param outputPath - Path to write the WAV file.
 * @returns A handle with a `stop()` method.
 */
export async function startRecording(outputPath: string): Promise<RecordingHandle> {
	const capture = new AudioCapture();
	capture.start(1);
	return {
		async stop() {
			const wavBuffer = capture.stop();
			await Bun.write(outputPath, wavBuffer);
			logger.debug("Audio capture complete", { outputPath, size: wavBuffer.byteLength });
		},
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
