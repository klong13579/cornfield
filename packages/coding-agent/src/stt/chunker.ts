/**
 * WAV chunker for transcribing oversized recordings.
 *
 * Mirrors Hermes Agent's `_split_wav_for_transcription` (tools/voice_mode.py:953-998):
 * when a recorded WAV exceeds the provider's file size cap, split it into
 * provider-sized chunks of identical format, transcribe each serially, then
 * concatenate non-empty transcripts with single spaces.
 *
 * Why chunk instead of streaming? mlx-whisper takes a single numpy array;
 * chunking is the simplest path that fits within that constraint. The
 * cross-chunk context loss (whisper doesn't see what came before) is
 * acceptable for typical dictation where each chunk is one or two sentences.
 */

import * as fsp from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";

const WAV_HEADER_BYTES = 44;
/** Reserve 64KB for any chunk-level metadata (matches Hermes). */
const HEADER_RESERVE = 64 * 1024;

export interface WavInfo {
	channels: number;
	sampleWidth: number;
	sampleRate: number;
	numFrames: number;
}

/**
 * Read WAV header from a file. Throws if the file is not a valid RIFF/WAVE PCM.
 *
 * Lightweight parser — only handles the PCM subset we generate (16-bit mono).
 * For other formats we bail out and let the caller fall back to no-chunking.
 */
export async function readWavInfo(path: string): Promise<WavInfo> {
	// Force a Buffer: some runtimes (Bun in particular) hand back a plain
	// Uint8Array from fs.promises.readFile, and Uint8Array.prototype.toString
	// returns "52,73,70,70" rather than "RIFF".
	const buf = Buffer.from(await fsp.readFile(path));
	if (buf.length < WAV_HEADER_BYTES) {
		throw new Error(`WAV header truncated (${buf.length} bytes)`);
	}
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("Not a RIFF/WAVE file");
	}
	// sub-chunk size at offset 16 should be 16 for PCM
	const subChunk1Size = buf.readUInt32LE(16);
	if (subChunk1Size !== 16) {
		throw new Error(`Unsupported WAV sub-chunk1 size ${subChunk1Size} (only PCM supported)`);
	}
	const channels = buf.readUInt16LE(22);
	const sampleRate = buf.readUInt32LE(24);
	const bitsPerSample = buf.readUInt16LE(34);
	const sampleWidth = bitsPerSample / 8;
	// data sub-chunk: "data" + 4-byte size + samples
	const dataSize = buf.readUInt32LE(40);
	const numFrames = dataSize / (channels * sampleWidth);
	return { channels, sampleWidth, sampleRate, numFrames };
}

export interface SplitOptions {
	/** Maximum bytes per chunk including WAV header. Default 20MB. */
	maxChunkBytes: number;
	/** Directory to write chunk files. If omitted, uses the source file's dir. */
	outputDir?: string;
}

/**
 * Split a WAV file into chunks of <= maxChunkBytes. Each chunk is a valid
 * standalone WAV with the same format. Returns the chunk file paths in order.
 *
 * The caller is responsible for deleting the chunks after use.
 */
export async function splitWavFile(sourcePath: string, options: SplitOptions): Promise<string[]> {
	const info = await readWavInfo(sourcePath);
	const blockAlign = Math.max(1, info.channels * info.sampleWidth);
	const maxDataBytes = options.maxChunkBytes - HEADER_RESERVE;
	if (maxDataBytes < blockAlign) {
		throw new Error(
			`maxChunkBytes too small for WAV chunking: need at least ${HEADER_RESERVE + blockAlign} bytes ` +
				`(got ${options.maxChunkBytes})`,
		);
	}
	const framesPerChunk = Math.max(1, Math.floor(maxDataBytes / blockAlign));

	const sourceDir = sourcePath.substring(0, Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\")) + 1);
	const outDir = options.outputDir ?? sourceDir;
	await fsp.mkdir(outDir, { recursive: true });

	const sourceFh = await fsp.open(sourcePath, "r");
	const baseName = sourcePath
		.split(/[\\/]/)
		.pop()!
		.replace(/\.wav$/i, "");
	const chunkPaths: string[] = [];

	try {
		let index = 0;
		while (true) {
			const frameBuf = Buffer.alloc(framesPerChunk * blockAlign);
			const offset = WAV_HEADER_BYTES + index * framesPerChunk * blockAlign;
			const { bytesRead } = await sourceFh.read(frameBuf, 0, frameBuf.length, offset);
			if (bytesRead === 0) break;
			const actualFrames = bytesRead / blockAlign;
			const dataSize = actualFrames * blockAlign;

			const chunkPath = `${outDir}/${baseName}_chunk${String(index + 1).padStart(3, "0")}.wav`;
			// Build the full chunk (header + data) in a single buffer to avoid
			// FileHandle position-tracking quirks on some runtimes.
			const chunkBuf = Buffer.alloc(WAV_HEADER_BYTES + dataSize);
			writeWavHeaderInto(chunkBuf, info, dataSize);
			frameBuf.copy(chunkBuf, WAV_HEADER_BYTES, 0, bytesRead);
			await Bun.write(chunkPath, chunkBuf);
			chunkPaths.push(chunkPath);
			index++;
			if (bytesRead < frameBuf.length) break;
		}
	} finally {
		await sourceFh.close();
	}

	return chunkPaths;
}

function writeWavHeaderInto(target: Buffer, info: WavInfo, dataSize: number): void {
	const { channels, sampleWidth, sampleRate } = info;
	const bitsPerSample = sampleWidth * 8;
	const blockAlign = channels * sampleWidth;
	const byteRate = sampleRate * blockAlign;
	const riffSize = 36 + dataSize;

	target.write("RIFF", 0);
	target.writeUInt32LE(riffSize, 4);
	target.write("WAVE", 8);
	target.write("fmt ", 12);
	target.writeUInt32LE(16, 16);
	target.writeUInt16LE(1, 20); // PCM
	target.writeUInt16LE(channels, 22);
	target.writeUInt32LE(sampleRate, 24);
	target.writeUInt32LE(byteRate, 28);
	target.writeUInt16LE(blockAlign, 32);
	target.writeUInt16LE(bitsPerSample, 34);
	target.write("data", 36);
	target.writeUInt32LE(dataSize, 40);
}

/**
 * Clean up chunk files. Best-effort — errors are swallowed.
 */
export async function cleanupChunks(paths: readonly string[]): Promise<void> {
	await Promise.all(
		paths.map(async p => {
			try {
				await fsp.unlink(p);
			} catch (err) {
				if (!isEnoent(err)) {
					// best effort
				}
			}
		}),
	);
}

/**
 * Concatenate per-chunk transcripts. Filters empty strings and joins with a
 * single space. Mirrors Hermes' `transcribe_recording` join logic.
 */
export function joinTranscripts(parts: readonly string[]): string {
	return parts
		.map(p => p.trim())
		.filter(p => p.length > 0)
		.join(" ")
		.trim();
}
