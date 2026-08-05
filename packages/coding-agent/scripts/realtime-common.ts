/**
 * Shared helpers for realtime voice scripts (probe + sample synthesis).
 *
 * Both scripts talk to the same gateway (narwal-plan by default) and resolve
 * credentials the same way: CLI --api-key > $NARWAL_PLAN_API_KEY >
 * ~/.omp/agent/models.yml. The voice whitelist below is the gateway's OWN
 * list, harvested from a live probe (see realtime-voice-probe.ts): the server
 * rejects any id not in this set, and it is longer than the official
 * Qwen-Audio-Realtime doc list (5 voices).
 */
import { isEnoent } from "@oh-my-pi/pi-utils";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_MODEL = "qwen-audio-3.0-realtime-flash";
export const DEFAULT_BASE_URL = "https://coder.narwal.com/v1";
export const DEFAULT_PROVIDER = "narwal-plan";

export interface VoiceInfo {
	id: string;
	name: string;
	trait: string;
	lang: "zh" | "en";
}

/** Gateway-verified voice whitelist (probe output, 2026-08-04). */
export const REALTIME_VOICES: readonly VoiceInfo[] = [
	{ id: "longanqian", name: "默认音色", trait: "官方 quickstart 默认", lang: "zh" },
	{ id: "longanlingxin", name: "龙安灵心", trait: "知心温暖 女 25", lang: "zh" },
	{ id: "longanlingxi", name: "龙安灵希", trait: "可爱甜美 女 25", lang: "zh" },
	{ id: "longanxiaoxin", name: "龙安小昕", trait: "亲切活泼 女 22", lang: "zh" },
	{ id: "longanlufeng", name: "龙安鲁风", trait: "明亮开朗 男 25", lang: "zh" },
	{ id: "longanfengyue", name: "龙安风悦", trait: "自然亲切 女 30", lang: "zh" },
	{ id: "longanyuanfei", name: "龙安元妃", trait: "高傲妃子 女 30", lang: "zh" },
	{ id: "longanhuan_v3.6", name: "龙安欢", trait: "活力女声 25", lang: "zh" },
	{ id: "longjielidou_v3.6", name: "龙杰力豆", trait: "天真男童 5", lang: "zh" },
	{ id: "longpaopao_v3.6", name: "龙泡泡", trait: "软糯可爱 女 5", lang: "zh" },
	{ id: "longhuohuo_v3.6", name: "龙火火", trait: "顽皮少年 男 8", lang: "zh" },
	{ id: "longchuanshu_v3.6", name: "龙川叔", trait: "川普大叔 男 40", lang: "zh" },
	{ id: "loongmary", name: "Loong Mary", trait: "温暖英音 女 20 (en)", lang: "en" },
	{ id: "loongeva_v3.6", name: "Loong Eva", trait: "高智美音 女 28 (en)", lang: "en" },
	{ id: "loongjohn", name: "Loong John", trait: "沉稳美音 男 28 (en)", lang: "en" },
];

export interface RealtimeCredentials {
	baseUrl: string;
	apiKey: string;
}

interface ProviderEntry {
	apiKey?: string;
	baseUrl?: string;
}

/** Resolves gateway credentials: explicit > env > ~/.omp/agent/models.yml. */
export async function resolveRealtimeCredentials(
	apiKey: string | undefined,
	baseUrl: string,
): Promise<RealtimeCredentials> {
	if (apiKey) return { baseUrl, apiKey };
	const modelsPath = path.join(os.homedir(), ".omp", "agent", "models.yml");
	let parsed: Record<string, unknown> | undefined;
	try {
		const text = await Bun.file(modelsPath).text();
		const raw = Bun.YAML.parse(text) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			parsed = raw as Record<string, unknown>;
		}
	} catch (err) {
		if (isEnoent(err)) {
			console.error(`no API key: pass --api-key, set NARWAL_PLAN_API_KEY, or create ${modelsPath}`);
			process.exit(2);
		}
		throw err;
	}
	const providerRoot = parsed?.[DEFAULT_PROVIDER];
	// models.yml wraps providers under a `providers:` key; accept both shapes.
	const provider =
		(providerRoot && typeof providerRoot === "object" && !Array.isArray(providerRoot)
			? (providerRoot as ProviderEntry)
			: ((parsed?.providers as ProviderEntry | undefined) ?? {}) as ProviderEntry);
	const apiKeyRef = provider.apiKey;
	// models.yml apiKey is usually an env var NAME; fall back to a literal key.
	const resolved = apiKeyRef ? (process.env[apiKeyRef] ?? apiKeyRef) : undefined;
	if (!resolved) {
		console.error(`no apiKey for ${DEFAULT_PROVIDER} in ${modelsPath} and NARWAL_PLAN_API_KEY unset`);
		process.exit(2);
	}
	return { baseUrl: provider.baseUrl ?? baseUrl, apiKey: resolved };
}

/** Concatenates base64 PCM16 wire parts into one raw PCM buffer. */
export function concatPcm(parts: string[]): Uint8Array {
	const bufs = parts.map(part => Buffer.from(part, "base64"));
	const total = bufs.reduce((sum, buf) => sum + buf.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const buf of bufs) {
		out.set(new Uint8Array(buf), offset);
		offset += buf.length;
	}
	return out;
}

/** Encodes raw PCM16 into a RIFF/WAV file. */
export function encodeWav(
	pcm: Uint8Array,
	sampleRate: number,
	channels: number,
	bitsPerSample: number,
): Uint8Array {
	const dataSize = pcm.length;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};
	const byteRate = (sampleRate * channels * bitsPerSample) / 8;
	const blockAlign = (channels * bitsPerSample) / 8;
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	writeAscii(36, "data");
	view.setUint32(40, dataSize, true);
	new Uint8Array(buffer, 44).set(pcm);
	return new Uint8Array(buffer);
}
