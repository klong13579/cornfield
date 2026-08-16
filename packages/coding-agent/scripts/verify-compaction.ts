#!/usr/bin/env bun
/**
 * Compaction verification — unit tests (no LLM calls needed).
 *
 * Tests:
 * 1. resolveThresholdTokens: 50% threshold vs 85% default
 * 2. resolveKeepRecentTokens: dynamic vs fixed
 * 3. shouldCompact: compaction triggers at correct threshold
 * 4. estimateMessagesTokens: large context estimation
 * 5. Per-model threshold overrides
 */
import {
	type CompactionSettings,
	estimateMessagesTokens,
	resolveKeepRecentTokens,
	resolveThresholdTokens,
	shouldCompact,
} from "@oh-my-pi/pi-coding-agent/session/compaction";

const DEFAULT_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: -1, // uses contextWindow - 15%
	thresholdTokens: -1,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	autoContinue: true,
	remoteEnabled: true,
};

const OPTIMIZED_SETTINGS: CompactionSettings = {
	...DEFAULT_SETTINGS,
	thresholdPercent: 50, // 50% threshold
	keepRecentTokens: 0, // dynamic
	targetRatio: 0.2,
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✅ ${msg}`);
	} else {
		failed++;
		console.log(`  ❌ ${msg}`);
	}
}

// ─── Test 1: resolveThresholdTokens ───
console.log("\n═══════════════════════════════════");
console.log("Test 1: resolveThresholdTokens");
console.log("═══════════════════════════════════\n");

// 128K context, default settings (85%)
const defaultThreshold = resolveThresholdTokens(128_000, DEFAULT_SETTINGS);
assert(defaultThreshold === 108_800, `Default (85%): ${defaultThreshold} (expected 108,800)`);

// 128K context, 50% threshold
const optThreshold = resolveThresholdTokens(128_000, OPTIMIZED_SETTINGS);
assert(optThreshold === 64_000, `Optimized (50%): ${optThreshold} (expected 64,000)`);

// 200K context, 50% threshold
const largeThreshold = resolveThresholdTokens(200_000, OPTIMIZED_SETTINGS);
assert(largeThreshold === 100_000, `Large (50%): ${largeThreshold} (expected 100,000)`);

// Per-model override
const withModelOverrides: CompactionSettings = {
	...OPTIMIZED_SETTINGS,
	modelThresholds: { "deepseek-v4-flash": 0.4, "deepseek-v4": 0.35 },
};
const flashThreshold = resolveThresholdTokens(128_000, withModelOverrides, "deepseek-v4-flash-202605");
assert(flashThreshold === 51_200, `Per-model (deepseek-v4-flash): ${flashThreshold} (expected 51,200)`);

const proThreshold = resolveThresholdTokens(128_000, withModelOverrides, "deepseek-v4-pro");
assert(proThreshold === 44_800, `Per-model (deepseek-v4): ${proThreshold} (expected 44,800)`);

// No match falls back to global
const noMatch = resolveThresholdTokens(128_000, withModelOverrides, "gpt-4o");
assert(noMatch === 64_000, `No match fallback: ${noMatch} (expected 64,000)`);

// ─── Test 2: resolveKeepRecentTokens ───
console.log("\n═══════════════════════════════════");
console.log("Test 2: resolveKeepRecentTokens");
console.log("═══════════════════════════════════\n");

// Fixed keepRecentTokens
const fixed = resolveKeepRecentTokens(64_000, { ...OPTIMIZED_SETTINGS, keepRecentTokens: 20000 });
assert(fixed === 20_000, `Fixed: ${fixed} (expected 20,000)`);

// Dynamic (keepRecentTokens = 0)
const dynamic = resolveKeepRecentTokens(64_000, OPTIMIZED_SETTINGS);
assert(dynamic === 12_800, `Dynamic: ${dynamic} (expected 12,800 = 64,000 × 0.20)`);

// Different threshold
const dynamicLarge = resolveKeepRecentTokens(100_000, OPTIMIZED_SETTINGS);
assert(dynamicLarge === 20_000, `Dynamic large: ${dynamicLarge} (expected 20,000 = 100,000 × 0.20)`);

// Custom targetRatio
const customRatio = resolveKeepRecentTokens(64_000, { ...OPTIMIZED_SETTINGS, targetRatio: 0.3 });
assert(customRatio === 19_200, `Custom ratio: ${customRatio} (expected 19,200 = 64,000 × 0.30)`);

// ─── Test 3: shouldCompact ───
console.log("\n═══════════════════════════════════");
console.log("Test 3: shouldCompact");
console.log("═══════════════════════════════════\n");

// Default: 60K tokens < 108.8K → no
assert(!shouldCompact(60_000, 128_000, DEFAULT_SETTINGS), `Default 60K < 108.8K → no compact`);

// Default: 110K tokens > 108.8K → yes
assert(shouldCompact(110_000, 128_000, DEFAULT_SETTINGS), `Default 110K > 108.8K → compact`);

// Optimized: 50K tokens < 64K → no
assert(!shouldCompact(50_000, 128_000, OPTIMIZED_SETTINGS), `Optimized 50K < 64K → no compact`);

// Optimized: 70K tokens > 64K → yes
assert(shouldCompact(70_000, 128_000, OPTIMIZED_SETTINGS), `Optimized 70K > 64K → compact`);

// ─── Test 4: estimateMessagesTokens ───
console.log("\n═══════════════════════════════════");
console.log("Test 4: estimateMessagesTokens");
console.log("═══════════════════════════════════\n");

const largeBlock = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(500);
const messages = [
	{ role: "user" as const, content: [{ type: "text" as const, text: `Context: ${largeBlock}` }] },
	{ role: "assistant" as const, content: [{ type: "text" as const, text: "Response to large context" }] },
	{ role: "user" as const, content: [{ type: "text" as const, text: `More context: ${largeBlock}` }] },
	{ role: "assistant" as const, content: [{ type: "text" as const, text: "Another response" }] },
];

const estimated = estimateMessagesTokens(messages as unknown as import("@oh-my-pi/pi-agent-core").AgentMessage[]);
console.log(`  Estimated tokens: ${estimated}`);
assert(estimated > 10_000, `Large context: ${estimated} > 10,000`);

// 10 copies = 100K+ tokens
const bigMessages = Array.from({ length: 10 }, (_, i) => [
	{ role: "user" as const, content: [{ type: "text" as const, text: `Block ${i}: ${largeBlock}` }] },
	{ role: "assistant" as const, content: [{ type: "text" as const, text: `Response ${i}` }] },
]).flat();
const bigEstimated = estimateMessagesTokens(bigMessages as unknown as import("@oh-my-pi/pi-agent-core").AgentMessage[]);
console.log(`  Very large context: ${bigEstimated} tokens`);
assert(bigEstimated > 40_000, `Very large: ${bigEstimated} > 40,000`);

// ─── Test 5: Compaction triggers at 50% ───
console.log("\n═══════════════════════════════════");
console.log("Test 5: End-to-end compaction trigger");
console.log("═══════════════════════════════════\n");

// Simulate a growing session
const contextGrowth = [
	{ tokens: 40_000, desc: "Cold start (40K)" },
	{ tokens: 45_000, desc: "After 5 turns (45K)" },
	{ tokens: 55_000, desc: "After 10 turns (55K)" },
	{ tokens: 65_000, desc: "After 15 turns (65K) → should trigger at 50%" },
];

for (const { tokens, desc } of contextGrowth) {
	const shouldOld = shouldCompact(tokens, 128_000, DEFAULT_SETTINGS);
	const shouldNew = shouldCompact(tokens, 128_000, OPTIMIZED_SETTINGS);

	const oldMark = shouldOld ? "⚠️ compaction" : "✓ ok";
	const newMark = shouldNew ? "⚠️ compaction" : "✓ ok";
	console.log(`  ${desc.padEnd(40)} old(85%): ${oldMark.padEnd(14)} new(50%): ${newMark}`);

	if (tokens === 65_000) {
		assert(!shouldOld, `Old threshold (85%): 65K < 108.8K → no compaction`);
		assert(shouldNew, `New threshold (50%): 65K > 64K → compaction triggered ✅`);
	}
}

// ─── Summary ───
console.log(`\n═══════════════════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log(`═══════════════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
