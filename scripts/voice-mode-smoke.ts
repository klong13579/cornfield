/**
 * Voice-mode mic smoke — exercises the SAME AudioCapture + callback chain
 * the live voice mode uses, but in a standalone script. Isolates whether
 * the wrapping is the issue vs. the TUI environment.
 *
 * Run: bun scripts/voice-mode-smoke.ts
 */
import { createNativeAudioSource } from "../packages/coding-agent/src/live/natives-audio";
import { rmsLevel } from "../packages/coding-agent/src/stt/pcm";

const SAMPLE_RATE = 24_000;
const WINDOW_MS = 6_000;
const TICK_MS = 200;

const stats = {
	startedAt: 0,
	chunks: 0,
	errors: 0,
	totalSamples: 0,
	peak: 0,
	peakSinceLastTick: 0,
};

const source = createNativeAudioSource();
source.start(samples => {
	stats.chunks += 1;
	stats.totalSamples += samples.length;
	const level = rmsLevel(samples) / 32768;
	if (level > stats.peak) stats.peak = level;
	if (level > stats.peakSinceLastTick) stats.peakSinceLastTick = level;
});

const clear = "\x1b[2K\r";
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function levelBar(level: number, width = 40): string {
	const filled = Math.round(level * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

stats.startedAt = Date.now();
const deadline = stats.startedAt + WINDOW_MS;

console.log(cyan("=== Voice-mode smoke (uses createNativeAudioSource) ==="));
console.log(dim("  Speak into the mic NOW.\n"));

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

await new Promise(r => setTimeout(r, WINDOW_MS));
clearInterval(tickInterval);
await new Promise(r => setTimeout(r, 50));
source.stop();

process.stdout.write("\n\n");
console.log(cyan("=== Result ==="));
console.log(`  Chunks:    ${stats.chunks}`);
console.log(`  Peak:      ${stats.peak.toFixed(4)}`);
console.log(`  Errors:    ${stats.errors}`);
console.log("");

type Verdict = "OK" | "DEAD" | "ERR";
let verdict: Verdict;
let detail: string;
if (stats.chunks === 0) {
	verdict = "DEAD";
	detail = "no chunks — even through createNativeAudioSource wrapping. The native binding may be the issue.";
} else if (stats.peak < 0.001) {
	verdict = "DEAD";
	detail = `chunks delivered but peak 0`;
} else {
	verdict = "OK";
	detail = `peak ${stats.peak.toFixed(3)}`;
}
const color = verdict === "OK" ? green : verdict === "DEAD" ? yellow : red;
console.log(color(`  Verdict: ${verdict} — ${detail}`));
process.exit(verdict === "OK" ? 0 : 1);
