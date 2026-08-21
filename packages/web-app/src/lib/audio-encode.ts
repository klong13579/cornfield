/**
 * 浏览器录音 → 16kHz 单声道 PCM WAV（serve record_transcribe 期望格式，与 TUI 本地录音同标）。
 *
 * 输入为 AudioContext 采集的 Float32 音频（-1..1），输出标准 44 字节头 WAV int16。
 * 重采样用线性插值（说话场景足够的精度，避免引入依赖）；音量钳制 [-1, 1] 防 blowup。
 * 导出大写尺寸常量供 UI（上传体积预估）使用。
 */

export const WAV_TARGET_SAMPLE_RATE = 16_000;

/** 线形重采样：把 samples 从 sampleRate 变到 targetRate，返回插值后的 Float32Array。 */
export function resampleLinear(samples: Float32Array, sampleRate: number, targetRate: number): Float32Array {
	if (sampleRate === targetRate) return samples;
	const ratio = sampleRate / targetRate;
	const outLen = Math.max(1, Math.round(samples.length / ratio));
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const a = samples[idx] ?? 0;
		const b = samples[Math.min(idx + 1, samples.length - 1)] ?? a;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

/**
 * Float32 音频（-1..1，任意采样率）→ 16kHz mono int16 WAV 的 Uint8Array。
 * 超出 32767 采样点数的录音由调用方分块？（不——单次录音 60s@16k=96 万点≈1.9MB，内存无压力）
 */
export function encodeWavPcm16(
	samples: Float32Array,
	sampleRate: number,
	targetRate = WAV_TARGET_SAMPLE_RATE,
): Uint8Array {
	const mono = resampleLinear(samples, sampleRate, targetRate);
	const numFrames = mono.length;
	const dataSize = numFrames * 2;
	const buf = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buf);

	const writeStr = (offset: number, s: string): void => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};

	writeStr(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, targetRate, true);
	view.setUint32(28, targetRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeStr(36, "data");
	view.setUint32(40, dataSize, true);

	let off = 44;
	for (let i = 0; i < numFrames; i++) {
		const v = Math.max(-1, Math.min(1, mono[i] ?? 0));
		view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
		off += 2;
	}
	return new Uint8Array(buf);
}

/** WAV 字节数（近似，UI 上传体积提示用）。 */
export function wavByteSize(durationSec: number, sampleRate = WAV_TARGET_SAMPLE_RATE): number {
	return 44 + Math.round(durationSec * sampleRate) * 2;
}
