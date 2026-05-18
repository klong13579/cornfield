#!/usr/bin/env bun
/**
 * Run Memory Phase1+Phase2 with the same auth path as omp (ModelRegistry + AuthStorage).
 * Inherits ALIBABA_API_KEY / ALIBABA_BASE_URL from the environment (same as the omp process).
 *
 * Usage:
 *   bun packages/self-evolution/scripts/run-memory-phase2-once.ts [--cwd <repo>] [--no-enqueue] [--phase2-only]
 */
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { enqueueMemoryConsolidation, runMemoryMaintenanceOnce } from "../src/memory/index";
import { getMemoryRoot } from "../src/paths";

const cwdIdx = process.argv.indexOf("--cwd");
const repoCwd = cwdIdx >= 0 ? (process.argv[cwdIdx + 1] ?? process.cwd()) : process.cwd();
const forceEnqueue = !process.argv.includes("--no-enqueue");
const phase2Only = process.argv.includes("--phase2-only");

function maskKey(key: string | undefined): string {
	if (!key) return "(none)";
	if (key.length <= 12) return `${key.slice(0, 4)}…`;
	return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

const agentDir = getAgentDir();
const settings = await Settings.init({ cwd: repoCwd, agentDir });
const authStorage = await discoverAuthStorage(agentDir);
const registry = new ModelRegistry(authStorage);

const available = registry.getAvailable();
const settingsModel = settings.getModelRole("default");
const model = available.find(m => m.provider === "alibaba-coding-plan") ?? available[0];
if (!model) {
	console.error("No model available in registry");
	process.exit(1);
}

const apiKey = await registry.getApiKey(model, "memory-phase2-script");
console.log("settings default:", settingsModel ?? "(none)");
console.log("resolved for maintenance:", `${model.provider}/${model.id}`, model.baseUrl);
console.log("apiKey:", maskKey(apiKey), "(from AuthStorage — set ALIBABA_API_KEY like omp)");
console.log("ALIBABA_API_KEY env:", maskKey(process.env.ALIBABA_API_KEY));

if (!apiKey) {
	console.error("No API key — export ALIBABA_API_KEY (sk-sp-*) before running");
	process.exit(1);
}

const sessionDir = path.join(agentDir, "sessions");
const session = {
	settings,
	model,
	sessionManager: {
		getCwd: () => repoCwd,
		getSessionId: () => "memory-phase2-script",
		getSessionDir: () => sessionDir,
		getSessionFile: () => path.join(sessionDir, "memory-phase2-script.jsonl"),
	},
	refreshBaseSystemPrompt: async () => {},
} as unknown as AgentSession;

if (forceEnqueue) {
	enqueueMemoryConsolidation(agentDir, repoCwd);
	console.log("enqueued global consolidation");
}

const memoryRoot = getMemoryRoot(agentDir, repoCwd);
const memoryMdBefore = await Bun.file(path.join(memoryRoot, "MEMORY.md"))
	.text()
	.catch(() => "");

console.log(`\nRunning memory maintenance (${phase2Only ? "Phase2 LLM only" : "Phase1 + Phase2"})…`);
const started = Date.now();
try {
	await runMemoryMaintenanceOnce({
		session,
		settings,
		modelRegistry: registry,
		agentDir,
		phase: phase2Only ? "phase2" : "all",
	});
} catch (err) {
	console.error("Memory maintenance failed:", err);
	process.exit(1);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const memoryMdAfter = await Bun.file(path.join(memoryRoot, "MEMORY.md")).text();
const summary = (await Bun.file(path.join(memoryRoot, "memory_summary.md")).text()).trim();

console.log(`\nDone in ${elapsed}s`);
console.log(`MEMORY.md: ${memoryMdBefore.length} → ${memoryMdAfter.length} chars`);
console.log(`memory_summary: ${summary.length} chars`);
console.log("\n--- memory_summary (first 15 lines) ---");
console.log(summary.split("\n").slice(0, 15).join("\n"));

const legacy = [/ConventionExtractor\.extract/i, /Convention Extraction Pipeline/i, /Produces conventions\.md/i].filter(
	r => r.test(summary),
);
console.log(legacy.length ? "\nWARN: legacy V2 patterns in summary" : "\nOK: no legacy V2 patterns in summary");

const usedLlm = memoryMdAfter !== memoryMdBefore && !memoryMdAfter.includes("[STALE - LLM consolidation failed]");
console.log(usedLlm ? "MEMORY.md changed (likely LLM consolidation applied)" : "MEMORY.md unchanged or stale marker");
