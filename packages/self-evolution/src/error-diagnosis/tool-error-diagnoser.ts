/**
 * LLM-based tool error diagnosis.
 *
 * Diagnoses tool failures in real-time and generates injectable procedure learnings.
 */
import type { SqliteLearningStore } from "../storage/learnings";
import type { Learning } from "../types";
import { completeWithSchema } from "./llm-factory";

export interface ToolErrorContext {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
	errorMessage: string;
	sessionId: string;
	cwd: string;
}

export interface ToolErrorDiagnosis {
	/** Root cause description */
	rootCause: string;
	/** Actionable fix procedure */
	fixProcedure: string;
	/** Confidence 1-5 */
	confidence: number;
	/** Scope for the learning */
	scope: "global" | "project" | "ephemeral";
	/** Error category */
	category: "timeout" | "fuzzy-match" | "parse-error" | "permission" | "unknown";
}

/**
 * Diagnose a tool execution error and optionally create a procedure learning.
 */
export async function diagnoseToolError(
	store: SqliteLearningStore | undefined,
	context: ToolErrorContext,
): Promise<ToolErrorDiagnosis | null> {
	if (!store) return null;

	try {
		const diagnosis = await completeWithSchema<ToolErrorDiagnosis>(
			DIAGNOSIS_SYSTEM_PROMPT,
			buildDiagnosisInput(context),
			DIAGNOSIS_RESPONSE_SCHEMA,
		);

		if (!diagnosis) return null;

		// Store the diagnosis as a procedure learning
		const learning: Learning = {
			id: `error-diagnosis-${context.toolCallId}-${Date.now()}`,
			cwd: context.cwd,
			kind: "procedure" as const,
			content: diagnosis.fixProcedure,
			source: "session_llm" as const,
			confidence: diagnosis.confidence,
			lifecycle: "active" as const,
			sessionId: context.sessionId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			timesInjected: 0,
			timesHelped: 0,
			timesIgnored: 0,
			scope: diagnosis.scope,
		};
		await store.insert(learning);

		return diagnosis;
	} catch (_err) {
		return null;
	}
}

function buildDiagnosisInput(ctx: ToolErrorContext): string {
	const argsStr = JSON.stringify(ctx.args, null, 2);
	const resultStr = typeof ctx.result === "string" ? ctx.result : JSON.stringify(ctx.result, null, 2);

	return `Tool: ${ctx.toolName}
Session: ${ctx.sessionId}
Working Dir: ${ctx.cwd}

Tool Arguments:
${argsStr}

Error Result:
${resultStr}

Analyze the error and provide a fix procedure.`;
}

const DIAGNOSIS_SYSTEM_PROMPT = `You are a tool error diagnostic assistant. Analyze tool execution failures and provide actionable fix procedures.

Analyze the error and output a JSON object with:
- rootCause: What actually went wrong (1-2 sentences)
- fixProcedure: Specific steps to avoid/fix this error in future sessions (imperative, practical)
- confidence: 1-5 rating based on how certain you are about the diagnosis
- scope: "global" (applies everywhere), "project" (project-specific), or "ephemeral" (one-time)
- category: "timeout" | "fuzzy-match" | "parse-error" | "permission" | "unknown"

Output ONLY valid JSON, no markdown formatting.`;

const DIAGNOSIS_RESPONSE_SCHEMA = {
	type: "object" as const,
	properties: {
		rootCause: { type: "string" as const },
		fixProcedure: { type: "string" as const },
		confidence: { type: "number" as const, minimum: 1, maximum: 5 },
		scope: { enum: ["global", "project", "ephemeral"] as const },
		category: { enum: ["timeout", "fuzzy-match", "parse-error", "permission", "unknown"] as const },
	},
	required: ["rootCause", "fixProcedure", "confidence", "scope", "category"],
};
