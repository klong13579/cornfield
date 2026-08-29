/**
 * Mic smoke test — direct AudioCapture diagnostic, no PTT, no TUI, no transport.
 *
 * Run: `bun scripts/voice-mic-smoke.ts`
 *
 * What it tests: whether the native AudioCapture device delivers any audio
 * samples in the current terminal environment. If the device opens but no
 * samples arrive, the OS is sandbox-blocking mic access (e.g., App Store
 * Ghostty with sandboxed child processes).
 *
 * Speak normally for the 5-second window. The script reports chunk count,
 * peak RMS, and a final verdict: MIC OK / MIC DEAD / MIC ERR.
 */
import { AudioCapture } from "@cornfield/natives";

const SAMPLE_RATE = 24_000;
const WINDOW_MS = 5_000;
const TICK_MS = 200;

const stats = {
	startedAt: 0,
	chunks: 0,
	errors: 0,
	firstError: null as Error | null,
	totalSamples: 0,
	peak: 0,
	zeroChunksInARow: 0,
	peakSinceLastTick: 0,
};

const capture = new AudioCapture(SAMPLE_RATE, (err, samples) => {
	if (err) {
		stats.errors += 1;
		if (stats.firstError === null) stats.firstError = err;
		return;
	}
	stats.chunks += 1;
	stats.totalSamples += samples.length;
	// Compute peak RMS in this chunk.
	let max = 0;
	for (let i = 0; i < samples.length; i++) {
		const v = samples[i]!;
		const a = v < 0 ? -v : v;
		if (a > max) max = a;
	}
	if (max > stats.peak) stats.peak = max;
	if (max === 0) {
		stats.zeroChunksInARow += 1;
	} else {
		stats.zeroChunksInARow = 0;
		stats.peakSinceLastTick = Math.max(stats.peakSinceLastTick, max);
	}
});

// ANSI helpers
const clear = "\x1b[2K\r";
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function levelBar(level: number, width = 40): string {
	const filled = Math.round(level * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

stats.startedAt = Date.now();
const deadline = stats.startedAt + WINDOW_MS;

console.log(cyan("=== Voice mic smoke test ==="));
console.log(dim(`  Sample rate: ${SAMPLE_RATE} Hz`));
console.log(dim(`  Window:      ${WINDOW_MS} ms`));
console.log(dim(`  Speak into the mic NOW.\n`));

const tickInterval = setInterval(() => {
	const elapsed = Date.now() - stats.startedAt;
	const remaining = Math.max(0, deadline - Date.now());
	const bar = levelBar(stats.peakSinceLastTick);
	const level = stats.peakSinceLastTick.toFixed(3);
	process.stdout.write(
		`${clear}${dim(`${(elapsed / 1000).toFixed(1)}s`)} ${bar} ${level}  ` +
			`${dim(`chunks=${stats.chunks} samples=${stats.totalSamples} errors=${stats.errors}`)} ` +
			`${dim(`(remaining ${(remaining / 1000).toFixed(1)}s)`)}`,
	);
	stats.peakSinceLastTick = 0;
}, TICK_MS);

async function sleep(ms: number) {
	return new Promise(r => setTimeout(r, ms));
}

await sleep(WINDOW_MS);
clearInterval(tickInterval);

// Drain pending callbacks so the final stats are accurate.
await sleep(50);

capture.stop();
const elapsedMs = Date.now() - stats.startedAt;

process.stdout.write("\n\n");
console.log(cyan("=== Result ==="));
console.log(`  Elapsed:        ${elapsedMs} ms`);
console.log(`  Chunks:         ${stats.chunks}`);
console.log(`  Samples:        ${stats.totalSamples}`);
console.log(`  Errors:         ${stats.errors}`);
if (stats.firstError) {
	console.log(`  First error:    ${stats.firstError.message}`);
}
console.log(`  Peak sample:    ${stats.peak.toFixed(4)} (0..1, where 1 = full scale)`);
console.log(`  Longest zero run: ${stats.zeroChunksInARow} chunks`);
console.log("");

// Verdict
type Verdict = "OK" | "DEAD" | "ERR";
let verdict: Verdict;
let detail: string;
if (stats.errors > 0 && stats.chunks === 0) {
	verdict = "ERR";
	detail = "device open failed before any samples arrived";
} else if (stats.chunks === 0) {
	verdict = "DEAD";
	detail =
		"no chunks ever delivered — mic source is open but the OS is not feeding it audio. " +
		"This is the macOS sandbox / permission / phantom-device case. PTT or any other " +
		"audio path cannot recover from this — switch terminals (Homebrew Ghostty, iTerm2).";
} else if (stats.peak < 0.001) {
	verdict = "DEAD";
	detail = `device delivered ${stats.chunks} chunks but all samples are zero`;
} else {
	verdict = "OK";
	detail = `device delivered ${stats.chunks} chunks with peak ${stats.peak.toFixed(3)}`;
}

const color = verdict === "OK" ? green : verdict === "DEAD" ? yellow : red;
console.log(color(`  Verdict: ${verdict} — ${detail}`));
process.exit(verdict === "OK" ? 0 : 1);
