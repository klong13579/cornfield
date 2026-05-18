/**
 * Formats pending session nudges for injection into the next LLM context.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import nudgeContextTemplate from "./prompts/nudge-context.md" with { type: "text" };
import type { Nudge, QueuedAgentNudge } from "./types";

export function formatNudgeContextContent(nudge: Nudge): string {
	const severityLabel = nudge.severity === "warn" ? "Warning" : "Tip";
	return prompt.render(nudgeContextTemplate, {
		severity_label: severityLabel,
		nudge_type: nudge.type,
		message: nudge.message,
		suggestion: nudge.suggestion,
	});
}

export function formatPendingNudgesContextContent(nudges: Nudge[]): string {
	return nudges.map(formatNudgeContextContent).join("\n\n");
}

export function buildNudgeContextUserMessage(
	queued: QueuedAgentNudge[],
): { role: "user"; content: string } | undefined {
	if (queued.length === 0) return undefined;
	const nudges = queued.map(q => q.nudge);
	return {
		role: "user",
		content: formatPendingNudgesContextContent(nudges),
	};
}
