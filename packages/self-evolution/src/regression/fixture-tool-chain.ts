import type { RegressionFixture, TraceEntry } from "../types";

/**
 * Compact, ordered tool-chain summary for regression replay prompts (fixture entries only).
 */
export function formatFixtureToolChainSummary(fixture: RegressionFixture): string {
	const lines: string[] = [];
	for (const entry of fixture.entries) {
		appendToolChainLine(lines, entry);
	}
	if (lines.length === 0) {
		return "(no tool_call / tool_result entries in fixture)";
	}
	return lines.join("\n");
}

function appendToolChainLine(lines: string[], entry: TraceEntry): void {
	if (entry.type === "tool_call") {
		const name = entry.toolName ?? "unknown";
		const argsPreview = summarizeArgs(entry.args);
		lines.push(`→ ${name}${argsPreview ? ` ${argsPreview}` : ""}`);
		return;
	}
	if (entry.type === "tool_result") {
		const name = entry.toolName ?? "?";
		const flag = entry.isError ? "ERROR" : "ok";
		const body = truncateOneLine(String(entry.result ?? ""), 140);
		lines.push(`  ← ${name} [${flag}] ${body}`);
		return;
	}
	if (entry.type === "model_error" && entry.content) {
		lines.push(`  ← model_error ${truncateOneLine(entry.content, 140)}`);
	}
}

function summarizeArgs(args: unknown): string {
	if (args === null || args === undefined) return "";
	if (typeof args === "string") return truncateOneLine(args, 80);
	if (typeof args === "object") {
		try {
			return truncateOneLine(JSON.stringify(args), 100);
		} catch {
			return "";
		}
	}
	return truncateOneLine(String(args), 80);
}

function truncateOneLine(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 3)}...`;
}
