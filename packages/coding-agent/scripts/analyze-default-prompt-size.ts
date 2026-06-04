#!/usr/bin/env bun
/**
 * Measure default OMP first-turn context composition (system + tool schemas).
 *
 * Usage:
 *   bun packages/coding-agent/scripts/analyze-default-prompt-size.ts [--cwd <dir>] [--no-mcp]
 */
import * as path from "node:path";
import { countTokens } from "@oh-my-pi/pi-natives";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { computeContextBreakdown } from "../src/modes/utils/context-usage";
import { createAgentSession } from "../src/sdk";

const cwdIdx = process.argv.indexOf("--cwd");
const cwd = cwdIdx >= 0 ? path.resolve(process.argv[cwdIdx + 1] ?? process.cwd()) : getProjectDir();
const enableMCP = !process.argv.includes("--no-mcp");

function estimateToolEntry(tool: { name: string; description: string; parameters: unknown }): number {
	const fragments = [tool.name, tool.description];
	try {
		fragments.push(JSON.stringify(tool.parameters ?? {}));
	} catch {
		// ignore cyclic schemas
	}
	return countTokens(fragments);
}

function classifyTool(name: string): "builtin" | "mcp" | "extension" | "other" {
	if (name.startsWith("mcp__")) return "mcp";
	if (name.startsWith("extension_") || name.includes("__")) return "extension";
	return "builtin";
}

const { session } = await createAgentSession({
	cwd,
	enableMCP,
	hasUI: false,
});

const model = session.model;
const tools = [...session.agent.state.tools];
const breakdown = computeContextBreakdown(session);

const rawSystemTokens = countTokens(session.systemPrompt);
const toolRows = tools
	.map(tool => ({
		name: tool.name,
		kind: classifyTool(tool.name),
		tokens: estimateToolEntry(tool),
	}))
	.sort((a, b) => b.tokens - a.tokens);

const byKind = { builtin: 0, mcp: 0, extension: 0, other: 0 };
for (const row of toolRows) {
	byKind[row.kind] += row.tokens;
}

const estimatedWireInput = breakdown.usedTokens;
const maxOut = Math.min(model?.maxTokens ?? 0, 32_000);
const contextWindow = model?.contextWindow ?? 0;

console.log(
	JSON.stringify(
		{
			cwd,
			enableMCP,
			model: model ? `${model.provider}/${model.id}` : null,
			contextWindow,
			maxCompletionDefault: maxOut,
			toolCount: tools.length,
			categories: breakdown.categories.map(c => ({
				id: c.id,
				label: c.label,
				tokens: c.tokens,
				percentOfWire: contextWindow > 0 ? Math.round((c.tokens / contextWindow) * 1000) / 10 : null,
			})),
			rawSystemPromptTokens: rawSystemTokens,
			estimatedFirstTurnInputTokens: estimatedWireInput,
			estimatedInputPlusMaxOut: estimatedWireInput + maxOut,
			headroomAtMaxOut: contextWindow > 0 ? contextWindow - estimatedWireInput - maxOut : null,
			toolSchemaByKind: byKind,
			topToolsBySchemaTokens: toolRows.slice(0, 15).map(r => ({
				name: r.name,
				kind: r.kind,
				tokens: r.tokens,
			})),
			autoCompactBufferTokens: breakdown.autoCompactBufferTokens,
		},
		null,
		2,
	),
);

await session.dispose();
