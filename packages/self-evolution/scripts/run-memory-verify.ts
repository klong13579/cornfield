#!/usr/bin/env bun
/**
 * Run memory ops without interactive omp: refresh-summary, enqueue, optional Phase2 via omp -p.
 *
 * Usage:
 *   bun packages/self-evolution/scripts/run-memory-verify.ts [--cwd <repo>] [--run-omp]
 */
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { enqueueMemoryConsolidation } from "../src/memory/index";
import { ensureMemorySummaryFromMemory } from "../src/memory/summary";
import { getMemoryRoot } from "../src/paths";

const cwdIdx = process.argv.indexOf("--cwd");
const repoCwd = cwdIdx >= 0 ? (process.argv[cwdIdx + 1] ?? process.cwd()) : process.cwd();
const runOmp = process.argv.includes("--run-omp");

const agentDir = getAgentDir();
const memoryRoot = getMemoryRoot(agentDir, repoCwd);

async function checkSummary(label: string): Promise<void> {
	const summaryPath = `${memoryRoot}/memory_summary.md`;
	let body = "";
	try {
		body = (await Bun.file(summaryPath).text()).trim();
	} catch {
		console.log(`\n[${label}] missing ${summaryPath}`);
		return;
	}
	const legacyHits = [
		/ConventionExtractor\.extract/i.test(body) ? "ConventionExtractor.extract" : null,
		/Convention Extraction Pipeline/i.test(body) ? "Convention Extraction Pipeline" : null,
		/Produces conventions\.md/i.test(body) ? "Produces conventions.md" : null,
		/confidence\s*>=\s*80.*convention/i.test(body) ? "confidence>=80 convention inject" : null,
	].filter((x): x is string => x !== null);
	console.log(`\n[${label}] ${summaryPath} (${body.length} chars)`);
	if (legacyHits.length > 0) {
		console.log("  WARN: legacy V2 patterns:", legacyHits.join(", "));
		console.log(body.slice(0, 600));
	} else {
		console.log("  OK: no legacy V2 injection patterns");
		console.log(body.split("\n").slice(0, 10).join("\n"));
	}
}

const refresh = await ensureMemorySummaryFromMemory(memoryRoot);
console.log("refresh-summary:", refresh);

enqueueMemoryConsolidation(agentDir, repoCwd);
console.log("enqueue: Phase2 job dirtied for", repoCwd);

await checkSummary("after refresh");

if (runOmp) {
	const authStorage = await discoverAuthStorage(agentDir);
	const registry = new ModelRegistry(authStorage);
	const available = registry.getAvailable();
	const model = available.find(m => m.provider === "alibaba-coding-plan");
	if (!model) {
		console.error("No model for omp -p (need alibaba-coding-plan)");
		process.exit(1);
	}
	console.log("\nRunning omp -p to trigger memory startup (Phase2 if job claimed)...");
	const cli = `${import.meta.dir}/../../coding-agent/src/cli.ts`;
	const result = await $`bun ${cli} -p ${"Reply with exactly: ok"}`.cwd(repoCwd).nothrow().quiet();
	console.log("omp exit:", result.exitCode);
	if (result.exitCode !== 0) {
		console.error(result.stderr.toString().slice(0, 800));
	}
}

await Bun.sleep(500);
await checkSummary(runOmp ? "after omp" : "skipped omp");
