#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
/**
 * Live-path voice test — sends REAL audio (like a mic) through server_vad and
 * compares the assistant's spoken reply across voices.
 *
 * This exercises the same path omp live voice uses
 * (input_audio_buffer.append → server_vad → audio reply), which is DIFFERENT
 * from realtime-voice-samples.ts (text injection). It exists because
 * narwal-plan's gateway rejected fake voices but returned identical-sounding
 * audio for valid ones via the text path — so the open question is whether
 * the `voice` parameter actually takes effect on the audio-input path.
 *
 * Usage:
 *   bun run packages/coding-agent/scripts/realtime-voice-live-test.ts
 *   bun run packages/coding-agent/scripts/realtime-voice-live-test.ts --input /tmp/my-question.wav --play
 *
 * Options:
 *   --input <wav>      Question audio, 24kHz PCM16 mono (default: /tmp/live-in.wav)
 *   --voice <id>       Voices to compare (repeatable; default: longanqian, longanlufeng)
 *   --out-dir <dir>    Output dir (default: ~/.omp/voice-samples/live-test)
 *   --model <id>       Realtime model id (default: qwen-audio-3.0-realtime-flash)
 *   --base-url <url>   Gateway base URL (default: https://coder.narwal.com/v1)
 *   --api-key <key>    API key (default: $NARWAL_PLAN_API_KEY, then models.yml)
 *   --play             Play each reply with afplay after the run (macOS)
 *   -h, --help         Show this help
 */
import { chunkPcm16, createSilenceChunk, pcm16ToBase64, RealtimeWsTransport } from "@cornfield/ai";
import { concatPcm, encodeWav, resolveRealtimeCredentials } from "./realtime-common";

const INPUT_SAMPLE_RATE = 24_000; // narwal/qwen realtime input is 24kHz PCM16 (bench-verified)
const CHUNK_MS = 100;
const TAIL_SILENCE_MS = 1_500;
const REPLY_TIMEOUT_MS = 60_000;

interface LiveTestOptions {
	input: string;
	outDir: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	voiceFilters: string[];
	play: boolean;
}

function usage(): string {
	return [
		"realtime-voice-live-test — compare assistant reply voices via real audio input",
		"",
		"Usage: bun run packages/coding-agent/scripts/realtime-voice-live-test.ts [options]",
		"",
		"Options:",
		"  --input <wav>      Question audio, 24kHz PCM16 mono (default: /tmp/live-in.wav)",
		"  --voice <id>       Voices to compare (repeatable; default: longanqian, longanlufeng)",
		"  --out-dir <dir>    Output dir (default: ~/.omp/voice-samples/live-test)",
		"  --model <id>       Realtime model id (default: qwen-audio-3.0-realtime-flash)",
		"  --base-url <url>   Gateway base URL (default: https://coder.narwal.com/v1)",
		"  --api-key <key>    API key (default: $NARWAL_PLAN_API_KEY, then models.yml)",
		"  --play             Play each reply with afplay after the run (macOS)",
		"  -h, --help         Show this help",
	].join("\n");
}

function parseCliArgs(argv: string[]): LiveTestOptions {
	const options: LiveTestOptions = {
		input: "/tmp/live-in.wav",
		outDir: path.join(os.homedir(), ".omp", "voice-samples", "live-test"),
		model: "qwen-audio-3.0-realtime-flash",
		baseUrl: "https://coder.narwal.com/v1",
		apiKey: process.env.NARWAL_PLAN_API_KEY ?? "",
		voiceFilters: [],
		play: false,
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
			case "--input":
				options.input = next();
				break;
			case "--voice":
				options.voiceFilters.push(next());
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
			case "--play":
				options.play = true;
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

/**
 * Parses a RIFF/WAV file and returns the raw PCM payload of the `data` chunk.
 * Handles non-standard headers (extra chunks like `fact`) instead of assuming
 * 44 bytes. Validates the fmt chunk is 24kHz mono 16-bit PCM.
 */
async function readInputPcm(wavPath: string): Promise<Uint8Array> {
	const bytes = new Uint8Array(await Bun.file(wavPath).arrayBuffer());
	if (bytes.length < 12 || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
		throw new Error(`not a RIFF/WAV file: ${wavPath}`);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunkId = (offset: number): string => {
		let s = "";
		for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
		return s;
	};
	let sampleRate: number | undefined;
	let offset = 12; // skip RIFF marker + size + WAVE tag
	while (offset + 8 <= bytes.length) {
		const id = chunkId(offset);
		const size = view.getUint32(offset + 4, true);
		const payload = offset + 8;
		if (id === "fmt ") {
			const channels = view.getUint16(payload + 2, true);
			sampleRate = view.getUint32(payload + 4, true);
			const bits = view.getUint16(payload + 14, true);
			if (sampleRate !== INPUT_SAMPLE_RATE || channels !== 1 || bits !== 16) {
				throw new Error(
					`input must be ${INPUT_SAMPLE_RATE}Hz mono 16-bit PCM, got ${sampleRate}Hz ${channels}ch ${bits}bit`,
				);
			}
		} else if (id === "data") {
			if (sampleRate === undefined) throw new Error(`fmt chunk missing before data in ${wavPath}`);
			return bytes.subarray(payload, payload + size);
		}
		offset = payload + size + (size % 2); // chunks are word-aligned
	}
	throw new Error(`no data chunk in ${wavPath}`);
}

interface VoiceReply {
	wav: Uint8Array;
	seconds: number;
	error: string | undefined;
}

/** One voice: connect, stream the question audio, collect the spoken reply. */
async function runVoice(opts: LiveTestOptions, voiceId: string, input: Uint8Array): Promise<VoiceReply> {
	const transport = new RealtimeWsTransport({
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		model: opts.model,
	});
	const audioParts: string[] = [];
	let serverError: string | undefined;
	const { promise, resolve, reject } = Promise.withResolvers<VoiceReply>();
	const timeout = setTimeout(
		() => reject(new Error(`no reply within ${REPLY_TIMEOUT_MS}ms (voice=${voiceId})`)),
		REPLY_TIMEOUT_MS,
	);
	const unsubscribe = transport.addEventListener(event => {
		if (event.type === "response.audio.delta") {
			audioParts.push(event.delta);
		} else if (event.type === "response.done") {
			clearTimeout(timeout);
			unsubscribe();
			const pcm = concatPcm(audioParts);
			const seconds = Number((pcm.byteLength / (INPUT_SAMPLE_RATE * 2)).toFixed(1));
			resolve({
				wav: pcm,
				seconds,
				error: pcm.byteLength > 0 ? undefined : (serverError ?? "empty audio reply"),
			});
		} else if (event.type === "error") {
			serverError = event.message;
		}
	});
	try {
		await transport.connect();
		transport.send({
			type: "session.update",
			session: {
				modalities: ["audio"],
				voice: voiceId,
				input_audio_format: "pcm16",
				output_audio_format: "pcm16",
				input_audio_transcription: { model: "fun-asr" },
				turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 },
			},
		});
		const chunkBytes = Math.floor((INPUT_SAMPLE_RATE * 2 * CHUNK_MS) / 1000);
		for (let offset = 0; offset < input.length; offset += chunkBytes) {
			transport.send({
				type: "input_audio_buffer.append",
				audio: pcm16ToBase64(input.subarray(offset, Math.min(offset + chunkBytes, input.length))),
			});
			await Bun.sleep(30);
		}
		// Keep streaming silence so server_vad's audio clock advances past the
		// speech tail and `speech_stopped` actually fires (bench finding).
		for (const chunk of chunkPcm16(
			createSilenceChunk(TAIL_SILENCE_MS, INPUT_SAMPLE_RATE),
			CHUNK_MS,
			INPUT_SAMPLE_RATE,
		)) {
			transport.send({ type: "input_audio_buffer.append", audio: pcm16ToBase64(chunk) });
			await Bun.sleep(30);
		}
		return await promise;
	} finally {
		await transport.close().catch(() => undefined);
	}
}

async function main(): Promise<void> {
	const opts = parseCliArgs(process.argv.slice(2));
	const credentials = await resolveRealtimeCredentials(opts.apiKey, opts.baseUrl);
	const resolved = { ...opts, ...credentials };

	const voices = opts.voiceFilters.length > 0 ? opts.voiceFilters : ["longanqian", "longanlufeng"];
	const input = await readInputPcm(resolved.input);
	const inputSeconds = Number((input.length / (INPUT_SAMPLE_RATE * 2)).toFixed(1));
	console.log(`question audio: ${resolved.input} (${inputSeconds}s, 24kHz PCM16)`);
	console.log(`voices: ${voices.join(", ")}\n`);

	const results: Array<{ voice: string; reply: VoiceReply }> = [];
	for (const voice of voices) {
		process.stdout.write(`[${voice}] streaming question... `);
		const reply = await runVoice(resolved, voice, input);
		if (!reply.error) {
			const file = path.join(resolved.outDir, `${voice}.wav`);
			await Bun.write(file, encodeWav(reply.wav, INPUT_SAMPLE_RATE, 1, 16));
			results.push({ voice, reply });
			console.log(`reply ${reply.seconds}s → ${file}`);
		} else {
			results.push({ voice, reply });
			console.log(`FAILED: ${reply.error}`);
		}
	}

	console.log("\n── summary ──");
	for (const { voice, reply } of results) {
		console.log(`${voice}: ${reply.error ?? `${reply.seconds}s reply`}`);
	}

	if (resolved.play) {
		for (const { voice, reply } of results) {
			if (reply.error) continue;
			const file = path.join(resolved.outDir, `${voice}.wav`);
			const proc = Bun.spawn(["afplay", file], { stdout: "ignore", stderr: "ignore" });
			await proc.exited;
			await Bun.sleep(800);
		}
	}
}

void main();
