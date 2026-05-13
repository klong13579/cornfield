/**
 * Context Assembler
 *
 * Phase 1.5 / Phase 2: Builds the unified context injection for the Agent.
 * Replaces the dual injection path (Memory + Evolution) with a single,
 * priority-aware, token-bounded context block.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { ImplicitConvention, UnifiedSkill } from "./types";

export interface AssemblerOptions {
	maxTokens: number;
	/** Estimated tokens per character. 4.0 is a safe average for English/Code mix. */
	tokensPerChar?: number;
}

const DEFAULT_TOKENS_PER_CHAR = 4.0;

/**
 * Assembles skills and conventions into a markdown context block.
 *
 * Priority order:
 * 1. Conventions (High signal, safety rules)
 * 2. Skills (sorted by confidence_score)
 *
 * @param skills - Unified skill list
 * @param conventions - Implicit conventions list
 * @param options - Token budget options
 */
export function assembleContext(
	skills: UnifiedSkill[],
	conventions: ImplicitConvention[],
	options: AssemblerOptions = { maxTokens: 2000 },
): string {
	const { maxTokens, tokensPerChar = DEFAULT_TOKENS_PER_CHAR } = options;
	const maxChars = Math.floor(maxTokens * tokensPerChar);

	const parts: string[] = [];

	// 1. Conventions (Top Priority)
	if (conventions.length > 0) {
		parts.push("## Active Conventions");
		for (const c of conventions) {
			parts.push(`- [Rule] ${c.rule} (Confidence: ${c.confidence.toFixed(2)})`);
		}
		parts.push("");
	}

	// 2. Skills (Sorted by Confidence)
	const sortedSkills = [...skills]
		.filter(s => s.status === "active")
		.sort((a, b) => b.confidenceScore - a.confidenceScore);

	if (sortedSkills.length > 0) {
		parts.push("## Relevant Skills");
		for (const s of sortedSkills) {
			parts.push(`### ${s.name} (v${s.version})`);
			parts.push(`Source: ${s.source} | Confidence: ${s.confidenceScore.toFixed(2)}`);
			parts.push(s.content);
			parts.push("");
		}
	}

	let result = parts.join("\n").trim();

	// Token/Char Guard
	if (result.length > maxChars) {
		logger.debug("ContextAssembler: trimming context to fit token budget", {
			originalChars: result.length,
			maxChars,
		});
		// Simple truncation with newline preservation
		const cutPoint = result.lastIndexOf("\n", maxChars);
		if (cutPoint > maxChars * 0.8) {
			result = `${result.slice(0, cutPoint)}\n... [truncated due to token limit]`;
		} else {
			result = `${result.slice(0, maxChars)}... [truncated]`;
		}
	}

	return result;
}
