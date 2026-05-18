import type { NudgeHistoryStore } from "./storage/types";
import type { Nudge, NudgeRecord } from "./types";

export function createNudgeHistoryId(sessionId: string, nudgeType: string): string {
	return `${sessionId}-${nudgeType}-${Date.now()}`;
}

export async function persistNudgeRecord(
	store: NudgeHistoryStore,
	params: {
		sessionId: string;
		project: string;
		nudge: Nudge;
	},
): Promise<string> {
	const id = createNudgeHistoryId(params.sessionId, params.nudge.type);
	const record: NudgeRecord = {
		id,
		sessionId: params.sessionId,
		project: params.project,
		type: params.nudge.type,
		severity: params.nudge.severity,
		message: params.nudge.message,
		suggestion: params.nudge.suggestion,
		detectedAt: Date.now(),
		contextInjected: false,
		postToolCalls: 0,
		patternRepeated: false,
	};
	await store.insert(record);
	return id;
}
