#!/usr/bin/env bun
/**
 * Measure rendered system prompt size for before/after prompt edits.
 *
 * Usage:
 *   bun packages/coding-agent/scripts/measure-system-prompt.ts
 */
import * as os from "node:os";
import * as path from "node:path";
import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import { countTokens } from "@oh-my-pi/pi-natives";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const SAMPLE_NEVER_RULE = "- NEVER commit untracked secrets to the repository";
const agentsMd = ["# Agents", "", SAMPLE_NEVER_RULE, "- MUST NOT use console.log in coding-agent"].join("\n");

function hardConstraintsBlock(rendered: string): string {
	return /<hard-constraints>[\s\S]*?<\/hard-constraints>/u.exec(rendered)?.[0] ?? "";
}

async function measure(label: string, rendered: string): Promise<void> {
	const hard = hardConstraintsBlock(rendered);
	process.stdout.write(`${label}\n`);
	process.stdout.write(`  chars:  ${rendered.length}\n`);
	process.stdout.write(`  tokens: ${countTokens(rendered)}\n`);
	process.stdout.write(`  sample NEVER in whole prompt: ${rendered.split(SAMPLE_NEVER_RULE).length - 1}\n`);
	process.stdout.write(`  sample NEVER in hard-constraints only: ${hard.split(SAMPLE_NEVER_RULE).length - 1}\n`);
	process.stdout.write(`  has <hard-constraints>: ${hard.length > 0}\n`);
	process.stdout.write(`  has <no-yield-rules> (should be false): ${rendered.includes("<no-yield-rules>")}\n\n`);
}

const minimal = await buildSystemPrompt({
	cwd: os.tmpdir(),
	contextFiles: [],
	skills: [],
	rules: [],
	toolNames: ["read"],
});

const full = await buildSystemPrompt({
	cwd: os.tmpdir(),
	contextFiles: [{ path: path.join(os.tmpdir(), "AGENTS.md"), content: agentsMd }],
	skills: [{ name: "system-prompts", description: "Prompt design skill" }],
	rules: [{ name: "rs-no-unwrap", description: "Avoid unwrap", path: "/tmp/rule.md", globs: ["**/*.rs"] }],
	toolNames: ["read", "search", "find", "edit", "task", "lsp", "bash", "python"],
	appendSystemPrompt: "Appendix instructions",
	alwaysApplyRules: [{ name: "validate-boundaries", content: "Validate inputs at boundaries.", path: "/tmp/rule.md" }],
	intentField: INTENT_FIELD,
	mcpDiscoveryMode: true,
	mcpDiscoveryServerSummaries: ["github (2 tools)"],
	eagerTasks: true,
});

await measure("minimal (read only)", minimal);
await measure("full (typical dev session)", full);
