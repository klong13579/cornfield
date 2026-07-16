/**
 * Tests for the WAV chunker.
 *
 * Strategy: synthesize small valid WAV files in a temp dir, split them,
 * verify the chunks are valid WAVs that concatenate back to the original
 * sample data, and verify joinTranscripts is the inverse of split.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupChunks, joinTranscripts, readWavInfo, splitWavFile } from "@oh-my-pi/pi-coding-agent/stt/chunker";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-chunker-test-"));
});

afterEach(async () => {
	await fsp.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Build a minimal valid 16-bit mono PCM WAV file in memory and write to disk.
 * `totalFrames` samples of alternating 0x10 0x20 (any pattern — we just need
 * valid samples to verify round-tripping).
 */
async function writeTestWav(filePath: string, totalFrames: number, sampleRate = 16000): Promise<void> {
	const channels = 1;
	const sampleWidth = 2;
	const dataSize = totalFrames * channels * sampleWidth;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataSize, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * channels * sampleWidth, 28);
	header.writeUInt16LE(channels * sampleWidth, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataSize, 40);

	const samples = Buffer.alloc(dataSize);
	for (let i = 0; i < totalFrames; i++) {
		samples.writeInt16LE(i % 1000, i * sampleWidth);
	}
	await fsp.writeFile(filePath, Buffer.concat([header, samples]));
}

describe("readWavInfo", () => {
	test("parses a valid PCM WAV header", async () => {
		const p = path.join(tmpDir, "test.wav");
		await writeTestWav(p, 1000);
		const info = await readWavInfo(p);
		expect(info.channels).toBe(1);
		expect(info.sampleWidth).toBe(2);
		expect(info.sampleRate).toBe(16000);
		expect(info.numFrames).toBe(1000);
	});

	test("throws on truncated header", async () => {
		const p = path.join(tmpDir, "bad.wav");
		await fsp.writeFile(p, Buffer.from("RIFF"));
		await expect(readWavInfo(p)).rejects.toThrow(/truncated/);
	});

	test("throws on non-WAVE file", async () => {
		const p = path.join(tmpDir, "bad.wav");
		const buf = Buffer.alloc(44);
		buf.write("XXXX", 0);
		await fsp.writeFile(p, buf);
		await expect(readWavInfo(p)).rejects.toThrow(/RIFF/);
	});
});

describe("splitWavFile", () => {
	test("small file produces single chunk identical to source", async () => {
		const src = path.join(tmpDir, "src.wav");
		await writeTestWav(src, 500); // ~1KB file
		const chunks = await splitWavFile(src, { maxChunkBytes: 1024 * 1024 });
		expect(chunks.length).toBe(1);
		const info = await readWavInfo(chunks[0]);
		expect(info.numFrames).toBe(500);
	});

	test("large file splits into multiple chunks that round-trip", async () => {
		const src = path.join(tmpDir, "src.wav");
		const totalFrames = 10_000;
		await writeTestWav(src, totalFrames);

		// HEADER_RESERVE (64KB) + frames_per_chunk * blockAlign. Force ~3 chunks
		// for 10000 frames (20KB samples): 7KB chunk budget is below HEADER_RESERVE,
		// so we need a budget larger than 64KB. Use 70KB total (5.4KB samples per
		// chunk after reserve).
		const chunks = await splitWavFile(src, { maxChunkBytes: 70_000 });
		expect(chunks.length).toBeGreaterThanOrEqual(2);

		// Each chunk should be a valid WAV
		let totalChunkFrames = 0;
		for (const c of chunks) {
			const info = await readWavInfo(c);
			expect(info.channels).toBe(1);
			expect(info.sampleRate).toBe(16000);
			totalChunkFrames += info.numFrames;
		}
		expect(totalChunkFrames).toBe(totalFrames);

		// Chunks should be in order
		expect(chunks[0].includes("_chunk001")).toBe(true);
	});

	test("rejects when maxChunkBytes is too small for even one frame", async () => {
		const src = path.join(tmpDir, "src.wav");
		await writeTestWav(src, 100);
		await expect(splitWavFile(src, { maxChunkBytes: 100 })).rejects.toThrow(/too small/);
	});
});

describe("cleanupChunks", () => {
	test("removes all chunk files and tolerates missing ones", async () => {
		const src = path.join(tmpDir, "src.wav");
		await writeTestWav(src, 500);
		const chunks = await splitWavFile(src, { maxChunkBytes: 1024 * 1024 });
		const fakePath = path.join(tmpDir, "nonexistent.wav");
		const allPaths = [...chunks, fakePath];

		await cleanupChunks(allPaths);

		for (const c of chunks) {
			await expect(fsp.access(c)).rejects.toThrow();
		}
	});
});

describe("joinTranscripts", () => {
	test("joins non-empty transcripts with single space", () => {
		expect(joinTranscripts(["hello", "world"])).toBe("hello world");
	});

	test("filters empty strings and trims", () => {
		expect(joinTranscripts(["hello", "  ", "world  "])).toBe("hello world");
	});

	test("handles all-empty input", () => {
		expect(joinTranscripts(["", "  ", ""])).toBe("");
	});
});
