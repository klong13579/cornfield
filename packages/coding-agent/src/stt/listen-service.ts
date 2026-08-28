/**
 * ListenService — `/record` 与 wire `record_transcribe`/`listen_list` 共享的转写+落盘服务。
 *
 * 从 ListenController 抽出的纯数据路径（不持有 UI 状态）：
 * - 转写：本地 whisper（mlx-whisper/openai-whisper）或 API `record.model`（qwen3-asr
 *   批量端点），超长音频（> stt.chunkSizeMB）自动分块串行转写后拼接——与 /record 同管线。
 * - 落盘：`~/.omp/listen/YYYY-MM-DD-<desc>.json`，格式 { version, recorded_at, text }。
 *
 * 谁在用：
 * - ListenController（TUI /record、/listen 的控制器外壳，持有录音/电平/VAD 状态机）
 * - wire-server `record_transcribe` / `listen_list`（前端听记）——同目录同格式同模型
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, logger } from "@cornfield/utils";
import type { ModelRegistry } from "../config/model-registry";
import { parseModelString } from "../config/model-resolver";
import { settings } from "../config/settings";
import { cleanupChunks, joinTranscripts, splitWavFile } from "./chunker";
import { type TranscribeProgress, transcribe, transcribeViaApi } from "./transcriber";

export interface ListenRecordingSummary {
	/** 文件名（含 .json）。 */
	name: string;
	/** 绝对路径。 */
	path: string;
	/** JSON 里的 recorded_at（ISO），缺失回退文件 mtime。 */
	recordedAt: string;
	size: number;
	/** 转写全文。 */
	text: string;
}

/** 单个音频的转写结果。 */
export interface TranscribeAudioResult {
	text: string;
	/** 实际使用的模型短名（展示用）。 */
	model: string;
}

function getListenDir(): string {
	const base = getConfigRootDir();
	const d = path.join(base, "listen");
	try {
		fs.mkdirSync(d, { recursive: true });
	} catch {
		/* exists */
	}
	return d;
}

export function buildFilename(description?: string): string {
	const now = new Date();
	const datePart = now.toISOString().slice(0, 10);
	if (description) {
		const safe = description
			.replace(/[<>:"/\\|?*]/g, "")
			.replace(/\s+/g, "-")
			.slice(0, 80);
		return `${datePart}-${safe}.json`;
	}
	const timePart = now.toTimeString().slice(0, 8).replace(/:/g, "");
	return `${datePart}-${timePart}.json`;
}

function readSttNumber(key: string, fallback: number): number {
	const v = (settings.get as (k: string) => unknown)(key);
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export { readSttNumber };

/** Shorten a model name for display: take the last path segment. */
function shortModelName(name: string): string {
	return name.includes("/") ? name.split("/").pop()! : name;
}

/** 返回将要使用的模型短名（不触发转写）。 */
export function resolveEffectiveModelName(modelRegistry?: ModelRegistry): string {
	const recordModel = settings.get("record.model") as string | undefined;
	if (recordModel && !isLocalWhisperModel(recordModel) && modelRegistry) {
		return shortModelName(recordModel);
	}
	// Local whisper path: use record.model if set, else stt.modelName
	const model =
		recordModel ?? (settings.get("stt.modelName") as string | undefined) ?? "mlx-community/whisper-large-v3-turbo";
	return shortModelName(model);
}

function isLocalWhisperModel(modelName: string | undefined): boolean {
	if (!modelName) return true;
	return modelName.startsWith("mlx-community/");
}

/**
 * 转写一个 WAV 文件 —— 本地 whisper 或 API `record.model` 二选一，超长自动分块串行。
 * 与 ListenController 原 #doTranscribe/#transcribeMaybeChunked 同逻辑（抽取共用）。
 */
export async function transcribeAudioWithDefaults(
	audioPath: string,
	opts?: {
		modelRegistry?: ModelRegistry;
		onProgress?: (p: TranscribeProgress, chunk?: { index: number; total: number }) => void;
	},
): Promise<TranscribeAudioResult> {
	const { modelRegistry, onProgress } = opts ?? {};
	const recordModel = settings.get("record.model") as string | undefined;
	const language = settings.get("stt.language") as string | undefined;

	const doTranscribe = async (p: string): Promise<string> => {
		// Use local whisper when the model is a whisper ID or when the API
		// path is unavailable (no modelRegistry).
		if (isLocalWhisperModel(recordModel) || !modelRegistry) {
			const modelName = recordModel ?? (settings.get("stt.modelName") as string | undefined);
			return await transcribe(p, { modelName, language, onProgress });
		}
		const parsed = recordModel ? parseModelString(recordModel) : undefined;
		const provider = parsed?.provider ?? "narwal-plan";
		const modelId = parsed?.id ?? recordModel;
		return await transcribeViaApi(p, {
			modelName: modelId,
			language,
			modelRegistry,
			provider,
			onProgress,
		});
	};

	const model = resolveEffectiveModelName(modelRegistry);

	// Chunk-size decision: stat may fail for non-WAV paths passed directly;
	// fall through to the direct path — transcribe() produces a specific error.
	let stat: fs.Stats | null = null;
	try {
		stat = await fsp.stat(audioPath);
	} catch (err) {
		logger.debug("stat failed before chunking decision; falling back to direct transcribe", {
			audioPath,
			err: String(err),
		});
	}

	const chunkSizeBytes = readSttNumber("stt.chunkSizeMB", 20) * 1024 * 1024;
	if (!stat || stat.size <= chunkSizeBytes) {
		const text = await doTranscribe(audioPath);
		return { text, model };
	}

	const chunks = await splitWavFile(audioPath, { maxChunkBytes: chunkSizeBytes });
	const transcripts: string[] = [];
	try {
		for (let i = 0; i < chunks.length; i++) {
			onProgress?.({ stage: "transcribing", percent: 0 }, { index: i + 1, total: chunks.length });
			const t = await doTranscribe(chunks[i]);
			transcripts.push(t);
		}
	} finally {
		await cleanupChunks(chunks);
	}

	const joined = joinTranscripts(transcripts);
	if (!joined) {
		throw new Error("Transcription produced no text. Check audio quality or model settings.");
	}
	return { text: joined, model };
}

/** 转写文本落盘 `~/.omp/listen/<buildFilename>.json`，返回绝对路径。 */
export async function saveListenText(text: string, description?: string): Promise<string> {
	const dir = getListenDir();
	const out = path.join(dir, buildFilename(description));
	await fsp.writeFile(
		out,
		JSON.stringify({ version: 1, recorded_at: new Date().toISOString(), text }, null, 2),
		"utf-8",
	);
	return out;
}

/** 列出 ~/.omp/listen/ 全部录音（文件名倒序），目录缺失时返回空数组。 */
export async function listListenRecordings(): Promise<ListenRecordingSummary[]> {
	const dir = getListenDir();
	const files = await fsp.readdir(dir).catch(() => []);
	const recordings: ListenRecordingSummary[] = [];
	for (const name of files) {
		if (!name.endsWith(".json")) continue;
		const full = path.join(dir, name);
		try {
			const raw = await fsp.readFile(full, "utf-8");
			const data = JSON.parse(raw) as { recorded_at?: string; text?: string };
			const stat = await fsp.stat(full);
			recordings.push({
				name,
				path: full,
				recordedAt: typeof data.recorded_at === "string" ? data.recorded_at : stat.mtime.toISOString(),
				size: stat.size,
				text: typeof data.text === "string" ? data.text : "",
			});
		} catch (err) {
			logger.warn("Skipping unreadable recording", { file: name, err: String(err) });
		}
	}
	recordings.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
	return recordings;
}
