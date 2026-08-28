/**
 * Full live session smoke test — runs the real LiveSessionController against
 * the real WebSocket transport, without the TUI. Isolates whether the voice
 * mode is broken in the TUI vs. the live code itself.
 *
 * Run: bun scripts/live-session-smoke.ts [baseUrl] [model] [apiKey]
 * (env NARWAL_PLAN_BASE_URL / NARWAL_PLAN_API_KEY work too)
 */
import { RealtimeWsTransport } from "@cornfield/ai";
import { LiveSessionController } from "../packages/coding-agent/src/live/controller";
import { createNativeAudioSource, createNativeSinkFactory } from "../packages/coding-agent/src/live/natives-audio";

const baseUrl = process.argv[2] ?? process.env.NARWAL_PLAN_BASE_URL ?? "https://coder.narwal.com/v1";
const model = process.argv[3] ?? process.env.NARWAL_PLAN_MODEL ?? "qwen-audio-3.0-realtime-flash";
const apiKey = process.argv[4] ?? process.env.NARWAL_PLAN_API_KEY;
if (!apiKey) {
	console.error("Set NARWAL_PLAN_API_KEY env var or pass as 3rd arg");
	process.exit(2);
}

const WINDOW_MS = 8_000;
const stats = {
	startedAt: 0,
	chunks: 0,
	transcripts: [] as Array<{ role: string; text: string; final: boolean }>,
	transcriptTexts: new Set<string>(),
	level: 0,
	peak: 0,
	phase: "connecting" as string,
	terminal: undefined as Error | undefined,
};

const transport = new RealtimeWsTransport({ baseUrl, apiKey, model });
const session = new LiveSessionController({
	transport,
	source: createNativeAudioSource(),
	sinkFactory: createNativeSinkFactory(),
	session: {
		modalities: ["text", "audio"],
		instructions: "You are a test agent. Respond briefly when the user speaks.",
		input_audio_format: "pcm16",
		output_audio_format: "pcm16",
		input_audio_transcription: { model: "fun-asr" },
		turn_detection: {
			type: "server_vad",
			threshold: 0.4,
			silence_duration_ms: 800,
		},
	},
	callbacks: {
		onPhase: p => {
			stats.phase = p;
			console.log(`  phase: ${p}`);
		},
		onLevels: (input, output) => {
			stats.chunks += 1;
			stats.level = input;
			if (input > stats.peak) stats.peak = input;
		},
		onTranscript: t => {
			stats.transcripts.push(t);
			if (t.final && t.text) stats.transcriptTexts.add(t.text);
		},
		onTerminal: err => {
			stats.terminal = err;
			if (err) console.log(`  terminal: ${err.message}`);
		},
	},
});

const clear = "\x1b[2K\r";
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function levelBar(level: number, width = 40): string {
	const filled = Math.round(level * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

console.log(cyan("=== Full live session smoke ==="));
console.log(dim(`  baseUrl: ${baseUrl}`));
console.log(dim(`  model:   ${model}`));
console.log(dim(`  Speak into the mic for ${WINDOW_MS / 1000}s. Auto-commits on silence.\n`));

let lastTick = Date.now();
let lastChunks = 0;
const tickInterval = setInterval(() => {
	const now = Date.now();
	const elapsed = now - stats.startedAt;
	const remaining = Math.max(0, WINDOW_MS - elapsed);
	const deltaChunks = stats.chunks - lastChunks;
	lastChunks = stats.chunks;
	const bar = levelBar(stats.level);
	process.stdout.write(
		`${clear}${dim(`${(elapsed / 1000).toFixed(1)}s`)} ${bar} ${stats.level.toFixed(3)} ` +
			`peak=${stats.peak.toFixed(3)} ` +
			`${dim(`chunks=${stats.chunks}(+${deltaChunks}) transcripts=${stats.transcripts.length} phase=${stats.phase}`)} ` +
			`${dim(`(remaining ${(remaining / 1000).toFixed(1)}s)`)}`,
	);
}, 250);

await session.start();
stats.startedAt = Date.now();
console.log(cyan(`[start] ${new Date().toISOString()}`));

await new Promise(r => setTimeout(r, WINDOW_MS));
clearInterval(tickInterval);

// Force a final commit so the server processes anything in the buffer.
try {
	(session as unknown as { commitMic: () => void }).commitMic?.();
} catch {}

await new Promise(r => setTimeout(r, 1_500));
await session.dispose();

process.stdout.write("\n\n");
console.log(cyan("=== Result ==="));
console.log(`  Phase:       ${stats.phase}`);
console.log(`  Chunks:      ${stats.chunks}`);
console.log(`  Peak level:  ${stats.peak.toFixed(4)}`);
console.log(`  Transcripts: ${stats.transcripts.length}`);
if (stats.transcripts.length > 0) {
	console.log(dim("    " + stats.transcripts.map(t => `[${t.role}${t.final ? "*" : ""}] ${t.text}`).join("\n    ")));
}
console.log(`  Terminal:    ${stats.terminal?.message ?? "none"}`);
console.log("");

let verdict: "OK" | "DEAD" | "ERR" | "STUCK";
let detail: string;
if (stats.terminal) {
	verdict = "ERR";
	detail = `terminal: ${stats.terminal.message}`;
} else if (stats.chunks === 0) {
	verdict = "DEAD";
	detail = "no mic chunks during the session — native capture isn't delivering";
} else if (stats.transcripts.length === 0) {
	verdict = "DEAD";
	detail = `${stats.chunks} chunks but no transcriptions`;
} else {
	verdict = "OK";
	detail = `${stats.chunks} chunks, ${stats.transcripts.length} transcript events`;
}
const color = verdict === "OK" ? green : verdict === "DEAD" ? yellow : red;
console.log(color(`  Verdict: ${verdict} — ${detail}`));
process.exit(verdict === "OK" ? 0 : 1);
