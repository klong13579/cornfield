/**
 * PCM audio helpers shared by the STT recorder and the realtime voice module.
 *
 * The native addon speaks mono `Float32Array` (AudioCapture in, AudioPlayback
 * out); whisper and WAV files speak s16 PCM. These conversions live in exactly
 * one place.
 */

/** RMS of an f32 chunk, scaled to the i16 range [0, 32767] used by level meters. */
export function rmsLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i]!;
		sumSquares += s * s;
	}
	return Math.min(32767, Math.round(Math.sqrt(sumSquares / samples.length) * 32768));
}

/** f32 [-1, 1] samples → s16 LE PCM bytes, clamped. */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
	const out = new Uint8Array(samples.length * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]!));
		view.setInt16(i * 2, Math.round(clamped * 32767), true);
	}
	return out;
}

/** s16 LE PCM bytes → f32 [-1, 1] samples (native byte order must be LE; odd tails dropped). */
export function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
	const out = new Float32Array(view.byteLength / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = view.getInt16(i * 2, true) / 32768;
	}
	return out;
}

/**
 * Resample 16-bit PCM audio from one sample rate to another using linear interpolation.
 *
 * Used to convert between the recorder's native rate (16kHz) and the realtime
 * endpoint's expected rate (24kHz). Linear interpolation is adequate for speech
 * transcription — the quality difference vs polyphase filtering is negligible
 * for ASR purposes.
 */
export function resamplePcm16(input: Uint8Array, fromRate: number, toRate: number): Uint8Array {
	const inputSamples = new Int16Array(input.buffer, input.byteOffset, input.byteLength / 2);
	const outputLength = Math.round((inputSamples.length * toRate) / fromRate);
	const output = new Int16Array(outputLength);
	const ratio = fromRate / toRate;

	for (let i = 0; i < outputLength; i++) {
		const pos = i * ratio;
		const idx = Math.min(Math.floor(pos), inputSamples.length - 2);
		const frac = pos - idx;
		const a = inputSamples[idx];
		const b = inputSamples[idx + 1];
		output[i] = Math.round(a + (b - a) * frac);
	}

	return new Uint8Array(output.buffer);
}

/** Wraps s16 PCM bytes in a canonical 44-byte WAV header (mono). */
export function encodeWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
	const byteRate = sampleRate * 2;
	const wav = new Uint8Array(44 + pcm.length);
	const view = new DataView(wav.buffer);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + pcm.length, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(36, "data");
	view.setUint32(40, pcm.length, true);
	wav.set(pcm, 44);
	return wav;
}
