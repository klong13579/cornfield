/**
 * AB harness: control (no nudge context injection) vs treatment (inject pending nudges).
 */
import { buildNudgeContextUserMessage } from "./nudge-context-injector";
import { TraceRecorder } from "./trace";
import type { Nudge, QueuedAgentNudge, TraceEntry } from "./types";

export type NudgeAbArm = "control" | "treatment";

export interface ContextMessage {
	role: string;
	content: string;
}

export interface NudgeAbArmMetrics {
	arm: NudgeAbArm;
	nudgeDetected: boolean;
	nudgeInjected: boolean;
	contextMessageCount: number;
	hasEvolutionNudgeMarker: boolean;
	mockNextTool: string;
	expectedBetterTool: string;
	mockToolMatchesGuidance: boolean;
}

export interface NudgeAbScenarioResult {
	scenarioId: string;
	description: string;
	nudgeType: string | null;
	control: NudgeAbArmMetrics;
	treatment: NudgeAbArmMetrics;
	treatmentWins: boolean;
}

export interface NudgeAbReport {
	scenarios: NudgeAbScenarioResult[];
	summary: {
		scenarioCount: number;
		nudgeTriggeredCount: number;
		injectionDeliveryRate: number;
		mockBehaviorWinRate: number;
	};
}

const NUDGE_MARKER = "Evolution Nudge";

function toQueued(nudges: Nudge[], prefix: string): QueuedAgentNudge[] {
	return nudges.map((nudge, i) => ({
		nudge,
		historyId: `${prefix}-${nudge.type}-${i}`,
	}));
}

export function applyNudgeContextArm(
	baseMessages: ContextMessage[],
	pendingNudges: Nudge[],
	arm: NudgeAbArm,
): ContextMessage[] {
	const messages = baseMessages.map(m => ({ ...m }));
	if (arm === "treatment" && pendingNudges.length > 0) {
		const nudgeMsg = buildNudgeContextUserMessage(toQueued(pendingNudges, "ab"));
		if (nudgeMsg) {
			messages.push(nudgeMsg);
		}
	}
	return messages;
}

/**
 * Heuristic stand-in for "agent read the nudge and changed strategy".
 * Without a live LLM, treatment wins when context contains a nudge and the mock picks the guided tool.
 */
export function mockAgentNextToolAfterContext(messages: ContextMessage[]): string {
	const userTexts = messages
		.filter(m => m.role === "user")
		.map(m => m.content)
		.join("\n");
	if (!userTexts.includes(NUDGE_MARKER)) {
		return "read";
	}
	if (/do not guess paths|Use find to list|find to list matching files/i.test(userTexts)) {
		return "find";
	}
	if (/ast_grep for structural|narrowing your search/i.test(userTexts)) {
		return "ast_grep";
	}
	if (/Fix the edit|check anchors|before verifying/i.test(userTexts)) {
		return "edit";
	}
	if (/Verify paths exist|missing files\/paths/i.test(userTexts)) {
		return "find";
	}
	if (/verification is complete|wrapping up/i.test(userTexts)) {
		return "bash";
	}
	return "read";
}

export function expectedBetterToolForNudge(nudge: Nudge | undefined): string {
	if (!nudge) return "read";
	switch (nudge.type) {
		case "search-misled-read":
		case "error-cascade":
			return "find";
		case "redundant-search":
		case "slow-loop":
			return "ast_grep";
		case "cascade-read-verify-failure":
		case "edit-verify-path-mismatch":
			return "edit";
		case "read-only-after-write":
			return "bash";
		default:
			return "find";
	}
}

export function scorePostNudgeToolCompliance(nudge: Nudge, nextTool: string): boolean {
	return nextTool === expectedBetterToolForNudge(nudge);
}

function runArm(
	baseMessages: ContextMessage[],
	recorder: TraceRecorder,
	arm: NudgeAbArm,
	nudge: Nudge | undefined,
): NudgeAbArmMetrics {
	let pending: Nudge[] = [];
	if (arm === "control") {
		for (const _ of recorder.drainPendingAgentNudges()) {
			/* discard without injecting */
		}
	} else {
		pending = recorder.drainPendingAgentNudges().map(q => q.nudge);
	}
	const contextMessages = applyNudgeContextArm(baseMessages, pending, arm);
	const mockNextTool = mockAgentNextToolAfterContext(contextMessages);
	const expectedBetterTool = expectedBetterToolForNudge(nudge);
	return {
		arm,
		nudgeDetected: nudge !== undefined,
		nudgeInjected: contextMessages.some(m => m.role === "user" && m.content.includes(NUDGE_MARKER)),
		contextMessageCount: contextMessages.length,
		hasEvolutionNudgeMarker: contextMessages.some(m => m.content.includes(NUDGE_MARKER)),
		mockNextTool,
		expectedBetterTool,
		mockToolMatchesGuidance: nudge ? scorePostNudgeToolCompliance(nudge, mockNextTool) : false,
	};
}

function replayTool(
	recorder: TraceRecorder,
	toolName: string,
	args: Record<string, unknown>,
	isError: boolean,
	result: string,
): void {
	const id = `${toolName}-${recorder.getTrace()?.toolCallCount ?? 0}`;
	recorder.onToolExecutionStart({
		type: "tool_execution_start",
		toolCallId: id,
		toolName,
		args,
	} as never);
	recorder.onToolExecutionEnd({
		type: "tool_execution_end",
		toolCallId: id,
		toolName,
		result,
		isError,
	} as never);
}

function runScenario(
	scenarioId: string,
	description: string,
	setup: (recorder: TraceRecorder) => void,
): NudgeAbScenarioResult {
	const baseMessages: ContextMessage[] = [
		{ role: "user", content: "Fix the failing file read loop" },
		{ role: "assistant", content: "I'll investigate." },
	];

	const controlRecorder = new TraceRecorder();
	controlRecorder.onAgentStart(
		{ type: "agent_start" } as never,
		{
			cwd: "/ab",
			sessionManager: { getSessionId: () => `ab-${scenarioId}-control` },
		} as never,
	);
	setup(controlRecorder);
	const controlNudge = controlRecorder.checkForNudges();
	if (controlNudge) {
		controlRecorder.enqueuePendingAgentNudge(controlNudge, `ab-control-${scenarioId}`);
	}

	const treatmentRecorder = new TraceRecorder();
	treatmentRecorder.onAgentStart(
		{ type: "agent_start" } as never,
		{
			cwd: "/ab",
			sessionManager: { getSessionId: () => `ab-${scenarioId}-treatment` },
		} as never,
	);
	setup(treatmentRecorder);
	const treatmentNudge = treatmentRecorder.checkForNudges();
	if (treatmentNudge) {
		treatmentRecorder.enqueuePendingAgentNudge(treatmentNudge, `ab-treatment-${scenarioId}`);
	}

	const nudge = controlNudge ?? treatmentNudge;
	const control = runArm(baseMessages, controlRecorder, "control", nudge);
	const treatment = runArm(baseMessages, treatmentRecorder, "treatment", nudge);

	return {
		scenarioId,
		description,
		nudgeType: nudge?.type ?? null,
		control,
		treatment,
		treatmentWins:
			nudge !== undefined &&
			!control.mockToolMatchesGuidance &&
			treatment.mockToolMatchesGuidance &&
			treatment.nudgeInjected,
	};
}

export function runNudgeContextAbReport(): NudgeAbReport {
	const scenarios: NudgeAbScenarioResult[] = [
		runScenario("error-cascade", "3 consecutive tool failures", recorder => {
			for (let i = 0; i < 3; i++) {
				replayTool(recorder, "read", { path: "/missing.ts" }, true, "ENOENT: no such file");
			}
		}),
		runScenario("cascade-read-verify", "two failed edits each followed by verify read", recorder => {
			replayTool(recorder, "edit", { path: "src/x.ts" }, true, "anchor mismatch");
			replayTool(recorder, "read", { path: "src/x.ts" }, true, "ENOENT: no such file");
			replayTool(recorder, "edit", { path: "src/y.ts" }, true, "anchor mismatch");
			replayTool(recorder, "read", { path: "src/y.ts" }, true, "ENOENT: no such file");
		}),
		runScenario("search-misled-read", "search fails then guessed read fails", recorder => {
			replayTool(recorder, "search", { pattern: "foo" }, true, "no matches");
			replayTool(recorder, "read", { path: "guessed/wrong.ts" }, true, "Path not found");
		}),
		runScenario("redundant-search", "3 consecutive reads without writes", recorder => {
			replayTool(recorder, "read", { path: "a.ts" }, false, "ok");
			replayTool(recorder, "read", { path: "b.ts" }, false, "ok");
			replayTool(recorder, "read", { path: "c.ts" }, false, "ok");
		}),
		runScenario("slow-loop", "many tools without file modification", recorder => {
			for (let i = 0; i < 5; i++) {
				replayTool(recorder, "grep", { pattern: "x" }, false, "matches");
			}
		}),
	];

	const nudgeTriggered = scenarios.filter(s => s.nudgeType !== null);
	const injectionOk = nudgeTriggered.filter(s => s.treatment.nudgeInjected);
	const wins = nudgeTriggered.filter(s => s.treatmentWins);

	return {
		scenarios,
		summary: {
			scenarioCount: scenarios.length,
			nudgeTriggeredCount: nudgeTriggered.length,
			injectionDeliveryRate: nudgeTriggered.length === 0 ? 0 : injectionOk.length / nudgeTriggered.length,
			mockBehaviorWinRate: nudgeTriggered.length === 0 ? 0 : wins.length / nudgeTriggered.length,
		},
	};
}

export function formatNudgeAbReportMarkdown(report: NudgeAbReport): string {
	const lines: string[] = [
		"# Nudge Context Injection A/B Report",
		"",
		"| Metric | Value |",
		"|--------|-------|",
		`| Scenarios | ${report.summary.scenarioCount} |`,
		`| Nudge triggered | ${report.summary.nudgeTriggeredCount} |`,
		`| Treatment injection delivery | ${(report.summary.injectionDeliveryRate * 100).toFixed(0)}% |`,
		`| Mock agent behavior win (treatment) | ${(report.summary.mockBehaviorWinRate * 100).toFixed(0)}% |`,
		"",
		"## Per scenario",
		"",
		"| Scenario | Nudge | Control next tool | Treatment next tool | Expected | Treatment wins |",
		"|----------|-------|-------------------|---------------------|----------|----------------|",
	];

	for (const s of report.scenarios) {
		lines.push(
			`| ${s.scenarioId} | ${s.nudgeType ?? "—"} | ${s.control.mockNextTool} | ${s.treatment.mockNextTool} | ${s.treatment.expectedBetterTool} | ${s.treatmentWins ? "yes" : "no"} |`,
		);
	}

	lines.push(
		"",
		"## Interpretation",
		"",
		"- **Injection delivery**: treatment context must include `Evolution Nudge` after pending drain.",
		"- **Mock agent win**: heuristic policy picks the guided tool only when nudge text is present (simulates post-change behavior).",
		"- Live OMP sessions still need `/evolution` episode metrics or manual review; this AB does not call an LLM.",
		"",
	);

	return lines.join("\n");
}

/** Post-nudge trace compliance for replay fixtures (unit tests). */
export function scorePostNudgeTraceEntries(
	nudge: Nudge,
	entries: TraceEntry[],
): {
	compliant: boolean;
	nextTool: string | undefined;
} {
	const nextCall = entries.find(e => e.type === "tool_call");
	const nextTool = nextCall?.toolName;
	if (!nextTool) {
		return { compliant: false, nextTool: undefined };
	}
	return {
		nextTool,
		compliant: scorePostNudgeToolCompliance(nudge, nextTool),
	};
}
