/**
 * Native audio bindings for the live voice session (macOS: miniaudio/CoreAudio).
 */
import { REALTIME_SAMPLE_RATE } from "@oh-my-pi/pi-ai";
import { AudioCapture, AudioPlayback } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { LiveAudioSinkFactory, LiveAudioSource } from "./types";

/** Mic source backed by the native AudioCapture (streaming f32 mono chunks). */
export function createNativeAudioSource(): LiveAudioSource {
	let capture: AudioCapture | undefined;
	return {
		start(onChunk) {
			capture = new AudioCapture(REALTIME_SAMPLE_RATE, (err, samples) => {
				if (err) {
					logger.debug("live capture chunk error", { error: String(err) });
					return;
				}
				onChunk(samples);
			});
		},
		stop() {
			capture?.stop();
			capture = undefined;
		},
	};
}

/** One AudioPlayback per assistant response; `stop()` discards queued audio for barge-in. */
export function createNativeSinkFactory(): LiveAudioSinkFactory {
	return () => {
		const playback = new AudioPlayback(REALTIME_SAMPLE_RATE);
		return {
			write: samples => playback.write(samples),
			stop: () => playback.stop(),
		};
	};
}
