/**
 * One-shot rescue transcription for the stuck 2026-08-18 20:10 interview recording.
 *
 * Model selection mirrors ListenController.#doTranscribe exactly — reads the
 * configured record.model / stt.modelName, routes mlx-community/* to local
 * whisper and anything else to the realtime API path. Nothing is hardcoded.
 *
 * Writes the joined transcript as a listen-dir JSON file.
 *
 * Usage: bun rescue-transcribe.ts [--model <modelId>]
 */
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "./packages/coding-agent/src/config/settings";
import { initializeWithSettings } from "./packages/coding-agent/src/capability/index";
import { discoverAuthStorage } from "./packages/coding-agent/src/sdk";
import { ModelRegistry } from "./packages/coding-agent/src/config/model-registry";
import {
	transcribe,
	transcribeViaApi,
	type TranscribeProgress,
} from "./packages/coding-agent/src/stt/transcriber";

const RESCUE_DIR = path.join(os.homedir(), ".omp", "listen", "rescue-20260818-2010");
const CHUNKS = [
	"omp-listen-1787052797766-6h6h_chunk001.wav",
	"omp-listen-1787052797766-6h6h_chunk002.wav",
	"omp-listen-1787052797766-6h6h_chunk003.wav",
	"omp-listen-1787052797766-6h6h_chunk004.wav",
];

/** Same routing as ListenController.#isLocalWhisperModel. */
function isLocalWhisperModel(modelName: string | undefined): boolean {
	if (!modelName) return true;
	return modelName.startsWith("mlx-community/");
}

async function main(): Promise<void> {
	const settings = await Settings.init({ cwd: process.cwd() });
	initializeWithSettings(settings);

	const cliModel = process.argv.find(a => a.startsWith("--model="))?.slice("--model=".length);
	const recordModel = cliModel ?? (settings.get("record.model") as string | undefined);
	const sttModel = settings.get("stt.modelName") as string | undefined;
	const language = (settings.get("stt.language") as string | undefined) ?? "zh";

	console.log(`model=${recordModel ?? sttModel ?? "(default)"} lang=${language} dir=${RESCUE_DIR}`);

	// API fallback needs the registry; build it lazily only when the configured
	// model routes to the realtime path.
	const needsRegistry = recordModel !== undefined && !isLocalWhisperModel(recordModel);
	const registry = needsRegistry ? new ModelRegistry(await discoverAuthStorage()) : undefined;

	const parts: string[] = [];
	let lastPercent = -1;
	for (let i = 0; i < CHUNKS.length; i++) {
		const file = path.join(RESCUE_DIR, CHUNKS[i]);
		const t0 = Date.now();
		console.log(`[${i + 1}/${CHUNKS.length}] ${path.basename(file)} …`);
		const onProgress = (p: TranscribeProgress) => {
			const pct = p.percent ?? 0;
			if (p.stage === "loading-model" && pct === 0) console.log("   loading-model…");
			if (p.stage === "transcribing" && pct - lastPercent >= 10) {
				lastPercent = pct;
				console.log(`   ${pct}%`);
			}
		};

		let text: string;
		if (isLocalWhisperModel(recordModel)) {
			const modelName = recordModel ?? sttModel ?? "mlx-community/whisper-large-v3-turbo";
			text = await transcribe(file, { modelName, language, onProgress });
		} else {
			text = await transcribeViaApi(file, {
				modelName: recordModel,
				language,
				modelRegistry: registry,
				onProgress,
			});
		}

		const secs = ((Date.now() - t0) / 1000).toFixed(1);
		console.log(`[${i + 1}/${CHUNKS.length}] done in ${secs}s, ${text.length} chars`);
		if (text.trim()) {
			parts.push(text.trim());
		} else {
			console.warn(`   !! chunk ${i + 1} came back EMPTY`);
		}
	}

	const joined = parts.join("\n\n");
	const out = path.join(RESCUE_DIR, "rescue-20260818-2010.json");
	await Bun.write(
		out,
		JSON.stringify({ version: 1, recorded_at: new Date().toISOString(), text: joined }, null, 2),
	);
	console.log(`\nSAVED: ${out} (${joined.length} chars)`);
	console.log("--- preview ---");
	console.log(joined.slice(0, 1500));
}

main().catch(err => {
	console.error("FAILED:", err);
	process.exit(1);
});