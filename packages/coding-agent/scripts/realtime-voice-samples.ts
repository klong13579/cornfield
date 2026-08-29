#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
/**
 * Realtime voice sample synthesis — speaks the SAME text with every gateway
 * voice and writes one WAV per voice, so the user can audition and pick.
 *
 * Protocol note: Qwen realtime honors `voice` only on the FIRST
 * `session.update` of a connection, so each voice gets a fresh connection.
 * Text is injected via `conversation.item.create` (OpenAI `input_text`
 * shape, with a `text`-shape retry) and audio is harvested from
 * `response.audio.delta` (24kHz PCM16 mono — verified in pi-ai realtime bench).
 *
 * Usage:
 *   bun run packages/coding-agent/scripts/realtime-voice-samples.ts
 *   bun run packages/coding-agent/scripts/realtime-voice-samples.ts --text "你好，我是米克原子智能助手。"
 *   bun run packages/coding-agent/scripts/realtime-voice-samples.ts --all --play
 *   bun run packages/coding-agent/scripts/realtime-voice-samples.ts --voice longanlufeng --play
 *
 * Options:
 *   --text <content>   Text to speak (default: a neutral Chinese announcement)
 *   --out-dir <dir>    Output dir (default: ~/.cornfield/voice-samples)
 *   --model <id>       Realtime model id (default: qwen-audio-3.0-realtime-flash)
 *   --base-url <url>   Gateway base URL (default: https://coder.narwal.com/v1)
 *   --api-key <key>    API key (default: $NARWAL_PLAN_API_KEY, then models.yml)
 *   --voice <id>       Synthesize only this voice (repeatable)
 *   --all              Include English-only voices (loongmary/loongeva/loongjohn)
 *   --play             Play each WAV with afplay after synthesis (macOS)
 *   --pause-ms <n>     Pause between --play tracks (default: 1500)
 *   -h, --help         Show this help
 */
import { RealtimeWsTransport } from "@cornfield/ai";
import { concatPcm, encodeWav, REALTIME_VOICES, resolveRealtimeCredentials, type VoiceInfo } from "./realtime-common";

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const SYNTH_TIMEOUT_MS = 30_000;

const DEFAULT_TEXT =
	"你好，我是你的智能助手。今天深圳多云转晴，气温二十六到三十三度。下午三点有产品评审会，记得准时参加。";

interface SampleOptions {
	text: string;
	outDir: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	voiceFilters: string[];
	includeEnglish: boolean;
	play: boolean;
	pauseMs: number;
}

function usage(): string {
	return [
		"realtime-voice-samples — speak one text with every gateway voice",
		"",
		"Usage: bun run packages/coding-agent/scripts/realtime-voice-samples.ts [options]",
		"",
		"Options:",
		"  --text <content>   Text to speak (default: neutral Chinese announcement)",
		"  --out-dir <dir>    Output dir (default: ~/.cornfield/voice-samples)",
		"  --model <id>       Realtime model id (default: qwen-audio-3.0-realtime-flash)",
		"  --base-url <url>   Gateway base URL (default: https://coder.narwal.com/v1)",
		"  --api-key <key>    API key (default: $NARWAL_PLAN_API_KEY, then models.yml)",
		"  --voice <id>       Synthesize only this voice (repeatable)",
		"  --all              Include English-only voices (loongmary/loongeva/loongjohn)",
		"  --play             Play each WAV with afplay after synthesis (macOS)",
		"  --pause-ms <n>     Pause between --play tracks (default: 1500)",
		"  -h, --help         Show this help",
	].join("\n");
}

function parseCliArgs(argv: string[]): SampleOptions {
	const options: SampleOptions = {
		text: DEFAULT_TEXT,
		outDir: path.join(os.homedir(), ".omp", "voice-samples"),
		model: "qwen-audio-3.0-realtime-flash",
		baseUrl: "https://coder.narwal.com/v1",
		apiKey: process.env.NARWAL_PLAN_API_KEY ?? "",
		voiceFilters: [],
		includeEnglish: false,
		play: false,
		pauseMs: 1_500,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[i + 1];
			if (value === undefined) {
				console.error(`missing value for ${arg}`);
				process.exit(2);
			}
			i += 1;
			return value;
		};
		switch (arg) {
			case "--text":
				options.text = next();
				break;
			case "--out-dir":
				options.outDir = next();
				break;
			case "--model":
				options.model = next();
				break;
			case "--base-url":
				options.baseUrl = next();
				break;
			case "--api-key":
				options.apiKey = next();
				break;
			case "--voice":
				options.voiceFilters.push(next());
				break;
			case "--all":
				options.includeEnglish = true;
				break;
			case "--play":
				options.play = true;
				break;
			case "--pause-ms":
				options.pauseMs = Number(next());
				break;
			case "--help":
			// biome-ignore lint/suspicious/noFallthroughSwitchClause: --help and -h share the usage/exit body
			case "-h":
				console.log(usage());
				process.exit(0);
			default:
				console.error(`unknown argument: ${arg}\n\n${usage()}`);
				process.exit(2);
		}
	}
	return options;
}

interface SynthResult {
	pcm: Uint8Array | undefined;
	error: string | undefined;
	/** Server-echoed voice from session.updated — diagnostic for voice mismatch. */
	serverVoice: string | undefined;
}

/**
 * Synthesizes the text with one voice. Retries once with the alternate
 * content-item shape if the first was rejected as invalid content.
 */
async function synthesize(opts: SampleOptions, voiceId: string, text: string): Promise<SynthResult> {
	const shapes = ["input_text", "text"] as const;
	for (const shape of shapes) {
		const result = await trySynthesize(opts, voiceId, text, shape);
		if (result.pcm) return result;
		if (shape === "input_text" && result.error && /content|item|input|invalid|unsupported/i.test(result.error)) {
			continue;
		}
		return result;
	}
	return { pcm: undefined, error: "unreachable", serverVoice: undefined };
}

async function trySynthesize(
	opts: SampleOptions,
	voiceId: string,
	text: string,
	contentShape: "input_text" | "text",
): Promise<SynthResult> {
	const transport = new RealtimeWsTransport({
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		model: opts.model,
	});
	const audioParts: string[] = [];
	let serverError: string | undefined;
	let serverVoice: string | undefined;
	const { promise, resolve, reject } = Promise.withResolvers<SynthResult>();
	const timeout = setTimeout(
		() => reject(new Error(`synthesis timeout after ${SYNTH_TIMEOUT_MS}ms (voice=${voiceId})`)),
		SYNTH_TIMEOUT_MS,
	);
	const unsubscribe = transport.addEventListener(event => {
		if (event.type === "response.audio.delta") {
			audioParts.push(event.delta);
		} else if (event.type === "response.done") {
			clearTimeout(timeout);
			unsubscribe();
			const pcm = concatPcm(audioParts);
			resolve(
				pcm.byteLength > 0
					? { pcm, error: undefined, serverVoice }
					: { pcm: undefined, error: serverError ?? "empty audio", serverVoice },
			);
		} else if (event.type === "session.updated") {
			serverVoice = event.session.voice;
		} else if (event.type === "error") {
			serverError = event.message;
		}
	});
	try {
		await transport.connect();
		transport.send({
			type: "session.update",
			session: { modalities: ["audio"], voice: voiceId, turn_detection: null },
		});
		transport.send({
			type: "conversation.item.create",
			item: { type: "message", role: "user", content: [{ type: contentShape, text }] },
		});
		transport.send({ type: "response.create" });
		return await promise;
	} finally {
		await transport.close().catch(() => undefined);
	}
}

interface SummaryRow {
	voice: VoiceInfo;
	seconds: number;
	error: string | undefined;
}

async function playWav(file: string): Promise<void> {
	if (process.platform !== "darwin") {
		console.log(`--play requires macOS (afplay); file ready at ${file}`);
		return;
	}
	const proc = Bun.spawn(["afplay", file], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
}

async function main(): Promise<void> {
	const opts = parseCliArgs(process.argv.slice(2));
	const credentials = await resolveRealtimeCredentials(opts.apiKey, opts.baseUrl);
	const resolved = { ...opts, ...credentials };

	const voices =
		opts.voiceFilters.length > 0
			? REALTIME_VOICES.filter(v => opts.voiceFilters.includes(v.id))
			: REALTIME_VOICES.filter(v => opts.includeEnglish || v.lang === "zh");
	if (voices.length === 0) {
		console.error(`no matching voices for: ${opts.voiceFilters.join(", ")}`);
		process.exit(2);
	}

	console.log(`speaking: ${resolved.text}`);
	console.log(`voices: ${voices.map(v => v.id).join(", ")}\n`);

	const summary: SummaryRow[] = [];
	for (const voice of voices) {
		process.stdout.write(`[${voice.id}] synthesizing... `);
		const result = await synthesize(resolved, voice.id, resolved.text);
		if (result.pcm && result.pcm.byteLength > 0) {
			const echo = result.serverVoice ? ` echo=${result.serverVoice}` : "";
			const index = String(voices.indexOf(voice) + 1).padStart(2, "0");
			const file = path.join(resolved.outDir, `${index}-${voice.id}.wav`);
			await Bun.write(file, encodeWav(result.pcm, SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE));
			const seconds = Number((result.pcm.byteLength / (SAMPLE_RATE * (BITS_PER_SAMPLE / 8))).toFixed(1));
			summary.push({ voice, seconds, error: undefined });
			console.log(`ok (${seconds}s${echo}) → ${file}`);
		} else {
			summary.push({ voice, seconds: 0, error: result.error });
			console.log(`FAILED: ${result.error}`);
		}
	}

	const indexLines = [
		`# omp realtime voice samples (${new Date().toISOString().slice(0, 10)})`,
		`# text: ${resolved.text}`,
		"",
		'# play all: for f in ~/.cornfield/voice-samples/*.wav; do afplay "$f"; done',
		"",
	];
	for (const row of summary) {
		const line = row.error
			? `${row.voice.id}  ${row.voice.name}  ${row.voice.trait}  -- FAILED: ${row.error}`
			: `${row.voice.id}  ${row.voice.name}  ${row.voice.trait}  ${row.seconds}s`;
		indexLines.push(line);
	}
	await Bun.write(path.join(resolved.outDir, "index.txt"), indexLines.join("\n"));
	console.log(`\nindex: ${path.join(resolved.outDir, "index.txt")}`);

	const failed = summary.filter(row => row.error !== undefined);
	if (failed.length > 0) {
		console.log(`failed: ${failed.map(row => row.voice.id).join(", ")}`);
	}
	if (!resolved.play) {
		console.log("\nadd --play to audition them back-to-back, or:");
		console.log(`afplay ${path.join(resolved.outDir, "01-longanqian.wav")}`);
		return;
	}
	for (const row of summary) {
		if (row.error) continue;
		const index = String(summary.indexOf(row) + 1).padStart(2, "0");
		await playWav(path.join(resolved.outDir, `${index}-${row.voice.id}.wav`));
		await Bun.sleep(resolved.pauseMs);
	}
}

void main();
