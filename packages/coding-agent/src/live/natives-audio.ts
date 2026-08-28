/**
 * Native audio bindings for the live voice session (macOS: miniaudio/CoreAudio).
 */
import { REALTIME_SAMPLE_RATE } from "@cornfield/ai";
import { AudioCapture, AudioPlayback, AudioVoiceSession } from "@cornfield/natives";
import { logger } from "@cornfield/utils";
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
			end: () => playback.end(),
			stop: () => playback.stop(),
		};
	};
}

/**
 * Hardware AEC path (macOS VoiceProcessingIO): one duplex unit owns capture
 * AND playback, so the assistant's own voice is cancelled from the mic —
 * barge-in can work without the speaker feeding itself back to the server.
 * Returns null when unavailable; callers fall back to the raw path.
 */
export function createNativeAecAudio(): { source: LiveAudioSource; sinkFactory: LiveAudioSinkFactory } | null {
	let session: AudioVoiceSession;
	try {
		session = new AudioVoiceSession(REALTIME_SAMPLE_RATE);
	} catch (err) {
		logger.warn("voice AEC unavailable, falling back to raw capture", { error: String(err) });
		return null;
	}
	let generation = 0;
	return {
		source: {
			start(onChunk) {
				session.startCapture((err, samples) => {
					if (err) {
						logger.debug("live AEC capture chunk error", { error: String(err) });
						return;
					}
					onChunk(samples);
				});
			},
			stop() {
				session.stop();
			},
		},
		sinkFactory: () => {
			generation += 1;
			const gen = generation;
			return {
				write: samples => session.writePlayback(samples, gen),
				end: () => session.endPlayback(gen),
				stop: () => session.clearPlayback(),
			};
		},
	};
}
