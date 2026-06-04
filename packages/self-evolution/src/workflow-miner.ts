/**
 * WorkflowMiner: extracts deduplicated tool sequences as workflow patterns.
 *
 * Mines two levels of sequence from a session trace:
 * - toolSequence: tool names (e.g., ["bash", "search", "bash"])
 * - commandSequence: tool-specific command names extracted from args
 *   (e.g., ["bash:which", "bash:dws", "bash:dws"] for bash commands)
 *
 * Command-level sequences enable the pipeline to converge skills like
 * "correct dws access pattern for DingTalk URLs" from tool argument data.
 */
import type { SessionTrace, WorkflowPattern } from "./types";

/**
 * Extract a command name from a tool call entry.
 * For bash tools, parses the first word of the command string.
 * For all other tools, returns the tool name itself.
 */
export function extractCommandName(entry: { toolName?: string; args?: unknown }): string {
	const tool = entry.toolName ?? "unknown";
	if (tool === "bash" && entry.args) {
		const args = entry.args as Record<string, unknown>;
		if (typeof args.command === "string") {
			const trimmed = args.command.trim();
			if (trimmed.length > 0) {
				const firstWord = trimmed.split(/\s+/)[0];
				if (firstWord) return `${tool}:${firstWord}`;
			}
		}
	}
	return tool;
}

export class WorkflowMiner {
	/**
	 * Extract a workflow pattern from a session trace.
	 * Returns undefined if no tool calls exist or sequence is too short.
	 */
	mine(trace: SessionTrace, intent: string): WorkflowPattern | undefined {
		const toolCalls = trace.entries.filter(e => e.type === "tool_call" && e.toolName);
		if (toolCalls.length === 0) return undefined;

		// Build both tool-level and command-level sequences
		const toolSequence: string[] = [];
		const commandSequence: string[] = [];

		for (const entry of toolCalls) {
			const tool = entry.toolName!;
			const cmdName = extractCommandName(entry);

			// Tool-level dedup: consecutive identical tools merge
			if (toolSequence.length === 0 || toolSequence[toolSequence.length - 1] !== tool) {
				toolSequence.push(tool);
			}

			// Command-level dedup: consecutive identical command names merge
			if (commandSequence.length === 0 || commandSequence[commandSequence.length - 1] !== cmdName) {
				commandSequence.push(cmdName);
			}
		}

		// Check if command-level adds info beyond tool-level
		const hasCommandInfo = commandSequence.length > 0 && commandSequence.some(cmd => cmd.includes(":"));

		// Require at least 2 distinct entries (tool or command level) to form a meaningful pattern
		const minLength = hasCommandInfo ? commandSequence.length : toolSequence.length;
		if (minLength < 2) return undefined;

		const id = hasCommandInfo
			? `${intent}:${toolSequence.join("→")}|cmd:${commandSequence.join("→")}`
			: `${intent}:${toolSequence.join("→")}`;

		return {
			id,
			intent: intent as WorkflowPattern["intent"],
			toolSequence,
			commandSequence: hasCommandInfo ? commandSequence : undefined,
			occurrenceCount: 1,
			avgQualityScore: 0,
			lastSeenAt: Date.now(),
		};
	}
}
