import { describe, expect, test } from "bun:test";
import { encodeWavPcm16, resampleLinear, wavByteSize } from "../src/lib/audio-encode";

/**
 * audio-encode 单测 —— 浏览器录音 → 16kHz mono PCM WAV（serve record_transcribe 输入格式）。
 * 边界：采样率不变 / 重采样、静音、clamp 溢出、WAV 头字段、字节数。
 */

function parseWav(bytes: Uint8Array): {
	sampleRate: number;
	channels: number;
	bits: number;
	dataSize: number;
	data: DataView;
} {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const riff = String.fromCharCode(...bytes.slice(0, 4));
	const wave = String.fromCharCode(...bytes.slice(8, 12));
	const fmt = String.fromCharCode(...bytes.slice(12, 16));
	const dataTag = String.fromCharCode(...bytes.slice(36, 40));
	expect(riff).toBe("RIFF");
	expect(wave).toBe("WAVE");
	expect(fmt).toBe("fmt ");
	expect(dataTag).toBe("data");
	return {
		sampleRate: view.getUint32(24, true),
		channels: view.getUint16(22, true),
		bits: view.getUint16(34, true),
		dataSize: view.getUint32(40, true),
		data: view,
	};
}

describe("encodeWavPcm16", () => {
	test("produces valid 16kHz mono int16 WAV header", () => {
		const samples = new Float32Array(48_000); // 1s @48k 输入 → 重采样到 16k
		const wav = encodeWavPcm16(samples, 48_000);
		const h = parseWav(wav);
		expect(h.sampleRate).toBe(16_000);
		expect(h.channels).toBe(1);
		expect(h.bits).toBe(16);
		expect(h.dataSize).toBe(16_000 * 2);
		expect(wav.length).toBe(44 + 16_000 * 2);
	});

	test("same sample rate keeps length", () => {
		const samples = new Float32Array(8000);
		const wav = encodeWavPcm16(samples, 16_000);
		expect(wav.length).toBe(44 + 8000 * 2);
	});

	test("resamples 48k to 16k (1/3 length)", () => {
		const samples = new Float32Array(48_000);
		const out = resampleLinear(samples, 48_000, 16_000);
		expect(out.length).toBe(16_000);
	});

	test("clamps out-of-range samples to int16 range", () => {
		const samples = new Float32Array([-2, 2, 0.5, -0.5]);
		const wav = encodeWavPcm16(samples, 16_000);
		const h = parseWav(wav);
		// 0.5 * 0x7fff = 16383.5 → int16 截断 16383
		expect(h.data.getInt16(44, true)).toBe(-32768);
		expect(h.data.getInt16(46, true)).toBe(32767);
		expect(h.data.getInt16(48, true)).toBe(16383);
		expect(h.data.getInt16(50, true)).toBe(-16384);
	});

	test("empty input produces header-only wav", () => {
		const wav = encodeWavPcm16(new Float32Array(0), 16_000);
		expect(wav.length).toBe(44);
	});
});

describe("wavByteSize", () => {
	test("estimates upload size from duration", () => {
		expect(wavByteSize(60)).toBe(44 + 60 * 16_000 * 2);
	});
});
