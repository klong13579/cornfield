/**
 * PCM16 audio codec helpers for realtime sessions.
 *
 * narwal/qwen realtime was bench-verified at 24kHz PCM16 mono in both directions
 * (2026-08-04). Keep rate assumptions here, not scattered through callers.
 */

export const REALTIME_SAMPLE_RATE = 24_000;
export const REALTIME_BYTES_PER_SAMPLE = 2;
export const REALTIME_CHANNELS = 1;

/** Encodes raw PCM16 samples to the base64 wire format. */
export function pcm16ToBase64(pcm: Uint8Array): string {
	return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

/** Decodes a base64 audio delta back into raw PCM16 samples. */
export function base64ToPcm16(encoded: string): Uint8Array {
	return new Uint8Array(Buffer.from(encoded, "base64"));
}

/** Byte count for a duration of PCM16 mono audio. */
export function pcm16ByteCount(durationMs: number, sampleRate: number = REALTIME_SAMPLE_RATE): number {
	return Math.floor((sampleRate * REALTIME_BYTES_PER_SAMPLE * REALTIME_CHANNELS * durationMs) / 1000);
}

/**
 * A zero-filled PCM16 chunk.
 *
 * server_vad only advances its audio clock when frames keep arriving: after the
 * user stops speaking the client MUST keep streaming silence or `speech_stopped`
 * never fires (bench finding 2026-08-04).
 */
export function createSilenceChunk(durationMs: number, sampleRate: number = REALTIME_SAMPLE_RATE): Uint8Array {
	return new Uint8Array(pcm16ByteCount(durationMs, sampleRate));
}

/** Splits a PCM16 buffer into fixed-duration chunks (last chunk may be shorter). */
export function chunkPcm16(pcm: Uint8Array, chunkMs: number, sampleRate: number = REALTIME_SAMPLE_RATE): Uint8Array[] {
	const chunkBytes = pcm16ByteCount(chunkMs, sampleRate);
	if (chunkBytes <= 0) return [pcm];
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
		chunks.push(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)));
	}
	return chunks;
}
