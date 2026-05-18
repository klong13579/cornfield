import type { FixtureReplayResult } from "./replay";

export type SubagentReplayStatus = "verdict" | "unparseable" | "timeout" | "spawn_error";

export interface SubagentReplayInterpretation {
	status: SubagentReplayStatus;
	result?: FixtureReplayResult;
}

interface ParsedReplayJson {
	passed?: unknown;
	reason?: unknown;
	addresses_dominant_error?: unknown;
	would_change_tool_chain?: unknown;
}

/**
 * Parse LLM/sub-agent regression output (JSON preferred, VERDICT line fallback).
 */
export function parseReplayVerdictFromResponse(text: string): FixtureReplayResult | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	const jsonMatch = trimmed.match(/\{[\s\S]*"passed"[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as ParsedReplayJson;
			if (typeof parsed.passed === "boolean") {
				let passed = parsed.passed;
				let reason =
					typeof parsed.reason === "string" && parsed.reason.length > 0
						? parsed.reason
						: passed
							? "Replay: would likely help."
							: "Replay: would not help.";

				if (passed && parsed.addresses_dominant_error === false) {
					passed = false;
					reason = `Replay rejected: does not address dominant error (${reason})`;
				}

				return { passed, reason };
			}
		} catch {
			// fall through to VERDICT line parsing
		}
	}

	const verdictLine = trimmed
		.split("\n")
		.map(l => l.trim())
		.findLast(l => /^VERDICT:\s*(KEEP|DISCARD)/i.test(l));
	if (verdictLine) {
		const keep = /KEEP/i.test(verdictLine);
		return {
			passed: keep,
			reason: keep ? "Sub-agent replay verdict: KEEP." : "Sub-agent replay verdict: DISCARD.",
		};
	}

	return undefined;
}

/**
 * Normalize sub-agent subprocess output into a replay verdict or a fallback reason.
 */
export function interpretSubagentReplayOutcome(opts: {
	exitCode: number;
	combinedOutput: string;
}): SubagentReplayInterpretation {
	if (opts.exitCode === -1) {
		return { status: "timeout" };
	}

	const trimmed = opts.combinedOutput.trim();
	if (opts.exitCode !== 0 && trimmed.length === 0) {
		return { status: "spawn_error" };
	}

	const verdict = parseReplayVerdictFromResponse(trimmed);
	if (verdict) {
		return { status: "verdict", result: verdict };
	}

	return { status: "unparseable" };
}

export function fixtureReplayResultFromInterpretation(
	interpretation: SubagentReplayInterpretation,
): FixtureReplayResult | undefined {
	if (interpretation.status === "verdict" && interpretation.result) {
		return interpretation.result;
	}
	return undefined;
}
