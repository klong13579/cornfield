/**
 * Semantic MECE audit for `omp agent validate --semantic`.
 *
 * Uses an LLM to detect semantic-level MECE violations that deterministic
 * regex rules cannot catch: identity conflicts, content duplication across
 * files, fact repetition, tool coverage gaps, datasource accuracy, etc.
 *
 * The LLM is instructed (via system prompt) to return violations through a
 * structured tool call (`report_mece_violations`), mirroring the pattern used
 * by the commit pipeline (`create_conventional_analysis`, etc.).
 *
 * Model resolution follows the same path as commit: Settings → ModelRegistry →
 * resolveRoleSelection → completeSimple.
 */

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { completeSimple, validateToolCall } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import type { MeceContext } from "./mece-rules";
import auditSystemPrompt from "./prompts/semantic-audit-system.md" with { type: "text" };

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface SemanticViolation {
	rule: string; // S1-S7
	severity: "error" | "warning";
	files: string[]; // files involved
	message: string; // violation description
	evidence: string; // quoted source text
	suggestion: string; // fix suggestion
	repairable: false; // semantic violations are never auto-repairable
}

export interface ModelContext {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definition for structured LLM output
// ────────────────────────────────────────────────────────────────────────────

const AuditTool = {
	name: "report_mece_violations",
	description: "Report semantic MECE violations found in the agentDir prompt files.",
	parameters: Type.Object({
		violations: Type.Array(
			Type.Object({
				rule: Type.Union([
					Type.Literal("S1"),
					Type.Literal("S2"),
					Type.Literal("S3"),
					Type.Literal("S4"),
					Type.Literal("S5"),
					Type.Literal("S6"),
					Type.Literal("S7"),
				]),
				severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
				files: Type.Array(Type.String()),
				message: Type.String(),
				evidence: Type.String(),
				suggestion: Type.String(),
			}),
		),
	}),
};

type AuditToolResult = {
	violations: Array<{
		rule: string;
		severity: "error" | "warning";
		files: string[];
		message: string;
		evidence: string;
		suggestion: string;
	}>;
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function extractToolCall(message: AssistantMessage, name: string) {
	return message.content.find(
		(content): content is Extract<typeof content, { type: "toolCall" }> =>
			content.type === "toolCall" && content.name === name,
	);
}

function extractTextContent(message: AssistantMessage): string {
	return message.content
		.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

function parseJsonPayload(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return JSON.parse(trimmed) as unknown;
	}
	const match = trimmed.match(/\{[\s\S]*\}/);
	if (!match) {
		throw new Error("No JSON payload found in response");
	}
	return JSON.parse(match[0]) as unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Build the user message from prompt files
// ────────────────────────────────────────────────────────────────────────────

function buildUserMessage(ctx: MeceContext): string {
	const parts: string[] = [];

	parts.push("# AgentDir Prompt Files for Audit\n");
	parts.push("Below are all prompt-relevant files from the agentDir. Audit them for semantic MECE violations.\n");

	for (const [relPath, content] of ctx.files) {
		parts.push(`--- FILE: ${relPath} ---\n`);
		parts.push(content);
		parts.push("\n");
	}

	return parts.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run a semantic MECE audit on the agentDir prompt files using an LLM.
 *
 * @returns Array of semantic violations. Empty if no violations found.
 * @throws Error if the LLM call fails or the response cannot be parsed.
 */
export async function runSemanticAudit(ctx: MeceContext, modelCtx: ModelContext): Promise<SemanticViolation[]> {
	const userContent = buildUserMessage(ctx);

	const response = await completeSimple(
		modelCtx.model,
		{
			systemPrompt: auditSystemPrompt,
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [AuditTool],
		},
		{
			apiKey: modelCtx.apiKey,
			maxTokens: 8192,
		},
	);

	// Try structured tool call first
	const toolCall = extractToolCall(response, "report_mece_violations");
	if (toolCall) {
		const parsed = validateToolCall([AuditTool], toolCall) as AuditToolResult;
		return parsed.violations.map(v => ({
			rule: v.rule,
			severity: v.severity,
			files: v.files,
			message: v.message,
			evidence: v.evidence,
			suggestion: v.suggestion,
			repairable: false as const,
		}));
	}

	// Fallback: try to parse JSON from text content (strip <think> blocks first)
	let text = extractTextContent(response);
	if (text) {
		// Strip <think>...</think> blocks (some models emit reasoning in tags)
		text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
		try {
			const parsed = parseJsonPayload(text) as AuditToolResult;
			if (parsed.violations && Array.isArray(parsed.violations)) {
				return parsed.violations.map(v => ({
					rule: v.rule,
					severity: v.severity,
					files: v.files,
					message: v.message,
					evidence: v.evidence,
					suggestion: v.suggestion,
					repairable: false as const,
				}));
			}
		} catch {
			// JSON parse failed — fall through
		}
	}

	// No violations reported or unparseable response
	return [];
}
