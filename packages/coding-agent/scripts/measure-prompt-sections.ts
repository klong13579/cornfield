#!/usr/bin/env bun
/**
 * Measure token breakdown by section in the system prompt.
 *
 * Usage:
 *   bun packages/coding-agent/scripts/measure-prompt-sections.ts
 */
import * as os from "node:os";
import * as path from "node:path";
import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { countTokens } from "@oh-my-pi/pi-natives";
import contractPartial from "../src/prompts/system/_contract.md" with { type: "text" };
import environmentPartial from "../src/prompts/system/_environment.md" with { type: "text" };
import identityPartial from "../src/prompts/system/_identity.md" with { type: "text" };
import nowPartial from "../src/prompts/system/_now.md" with { type: "text" };
// Import partials
import preamblePartial from "../src/prompts/system/_preamble.md" with { type: "text" };
import procedurePartial from "../src/prompts/system/_procedure.md" with { type: "text" };
import workspacePartial from "../src/prompts/system/_workspace.md" with { type: "text" };

const SAMPLE_NEVER_RULE = "- NEVER commit untracked secrets to the repository";
const agentsMd = ["# Agents", "", SAMPLE_NEVER_RULE, "- MUST NOT use console.log in coding-agent"].join("\n");

async function measureSection(label: string, content: string): Promise<number> {
	const tokens = countTokens(content);
	process.stdout.write(
		`${label.padEnd(20)} ${content.length.toString().padStart(6)} chars  ${tokens.toString().padStart(5)} tokens\n`,
	);
	return tokens;
}

// Build full prompt
const full = await buildSystemPrompt({
	cwd: os.tmpdir(),
	contextFiles: [{ path: path.join(os.tmpdir(), "AGENTS.md"), content: agentsMd }],
	skills: [
		{ name: "system-prompts", description: "Prompt design skill", filePath: "", baseDir: "", source: "custom" },
	],
	rules: [{ name: "rs-no-unwrap", description: "Avoid unwrap", path: "/tmp/rule.md", globs: ["**/*.rs"] }],
	toolNames: ["read", "search", "find", "edit", "task", "lsp", "bash", "python"],
	appendSystemPrompt: "Appendix instructions",
	alwaysApplyRules: [{ name: "validate-boundaries", content: "Validate inputs at boundaries.", path: "/tmp/rule.md" }],
	intentField: INTENT_FIELD,
	mcpDiscoveryMode: true,
	mcpDiscoveryServerSummaries: ["github (2 tools)"],
	eagerTasks: true,
});

process.stdout.write("\n=== Full Prompt Breakdown ===\n\n");

const totalTokens = countTokens(full);
process.stdout.write(
	`Total prompt:          ${full.length.toString().padStart(6)} chars  ${totalTokens.toString().padStart(5)} tokens\n\n`,
);

// Extract sections by looking for SECTION_SEPARATOR markers
const sectionPattern = /<!--\s*SECTION_SEPARATOR\s+"([^"]+)"\s*-->/g;
const sections: Array<{ name: string; start: number; end: number }> = [];
let match: RegExpExecArray | null;

for (match = sectionPattern.exec(full); match !== null; match = sectionPattern.exec(full)) {
	sections.push({
		name: match[1]!,
		start: match.index + match[0].length,
		end: -1,
	});
}

// Set end positions
for (let i = 0; i < sections.length - 1; i++) {
	sections[i].end = sections[i + 1].start - sections[i + 1].name.length - 30; // approximate
}
if (sections.length > 0) {
	sections[sections.length - 1].end = full.length;
}

// Measure each section
let accountedTokens = 0;
for (const section of sections) {
	const content = full.slice(section.start, section.end);
	const tokens = await measureSection(`[${section.name}]`, content);
	accountedTokens += tokens;
}

process.stdout.write(
	`\nSection separators:      ${(full.length - accountedTokens).toString().padStart(6)} chars  ${(totalTokens - accountedTokens).toString().padStart(5)} tokens\n`,
);

// Now measure individual partials (unrendered templates)
process.stdout.write("\n=== Partial Templates (unrendered) ===\n\n");

await measureSection("preamble", preamblePartial);
await measureSection("workspace", workspacePartial);
await measureSection("identity", identityPartial);
await measureSection("environment", environmentPartial);
await measureSection("contract", contractPartial);
await measureSection("procedure", procedurePartial);
await measureSection("now", nowPartial);

// Measure with realistic data
process.stdout.write("\n=== Realistic Scenario (hr3 agent) ===\n\n");

// Simulate hr3-like context
const hr3AgentsMd = `# HR3 Agent Guidelines

## Core Responsibilities
- Handle employee relations queries
- Process leave requests and approvals
- Manage recruitment workflows
- Answer policy questions

## NEVER Rules
- NEVER share employee personal data without authorization
- NEVER approve leave without manager confirmation
- MUST NOT bypass compliance checks

## MUST Rules
- MUST log all sensitive operations
- MUST verify employee ID before processing
`;

const hr3Skills = Array.from({ length: 60 }, (_, i) => ({
	name: `skill-${i}`,
	description: `Description for skill ${i} - handles ${["HR", "payroll", "recruitment", "compliance", "benefits"][i % 5]} workflows`,
	filePath: "",
	baseDir: "",
	source: "custom",
}));

const hr3Prompt = await buildSystemPrompt({
	cwd: os.tmpdir(),
	contextFiles: [{ path: path.join(os.tmpdir(), "AGENTS.md"), content: hr3AgentsMd }],
	skills: hr3Skills,
	rules: [],
	toolNames: ["read", "search", "find", "edit", "write", "bash", "python", "task", "lsp", "ast_grep", "ast_edit"],
	appendSystemPrompt: "",
	alwaysApplyRules: [],
	intentField: INTENT_FIELD,
	mcpDiscoveryMode: false,
	mcpDiscoveryServerSummaries: [],
	eagerTasks: true,
});

const hr3Tokens = countTokens(hr3Prompt);
process.stdout.write(
	`\nHR3-like prompt:         ${hr3Prompt.length.toString().padStart(6)} chars  ${hr3Tokens.toString().padStart(5)} tokens\n`,
);

// Estimate breakdown for 69K token scenario
process.stdout.write("\n=== 69K Token Scenario Estimation ===\n\n");
process.stdout.write(`Framework overhead:      ~${totalTokens} tokens (this script's "full" scenario)\n`);
process.stdout.write(`hr3 AGENTS.md:           ~${countTokens(hr3AgentsMd)} tokens\n`);
process.stdout.write(
	`60 skills (name+desc):   ~${countTokens(hr3Skills.map(s => `- ${s.name}: ${s.description}`).join("\n"))} tokens\n`,
);
process.stdout.write(`Tool descriptions:       ~${countTokens(full) - 6105} tokens (estimated from tool count)\n`);
process.stdout.write(`\nEstimated total:         ~${totalTokens + countTokens(hr3AgentsMd) + 2000} tokens\n`);
process.stdout.write(`Actual hr3 measurement:  69,534 tokens\n`);
process.stdout.write(
	`Gap:                     ~${69534 - (totalTokens + countTokens(hr3AgentsMd) + 2000)} tokens (likely from evolution injection, memory, extensions)\n`,
);
