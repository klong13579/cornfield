/**
 * TraceRecorder: consumes agent events and builds a SessionTrace in memory.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionContext,
	MessageEndEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { NudgeDetector } from "./nudge-detector";
import type { Nudge, QueuedAgentNudge, SessionTrace } from "./types";

export class TraceRecorder {
	#trace: SessionTrace | undefined;
	#sessionId: string | undefined;
	#pendingPrompt: string | undefined;
	#pendingBackgroundModel: Model | undefined;

	#injectedEpisodeIds: string[] = [];
	#injectedSkillNames: string[] = [];
	#injectedConventionIds: string[] = [];
	#injectedLearningIds: string[] = [];
	#pendingAgentNudges: QueuedAgentNudge[] = [];
	#deliveredNudgeTypesThisTurn = new Set<string>();
	#nudgeDetector = new NudgeDetector();

	getTrace(): SessionTrace | undefined {
		return this.#trace;
	}

	/**
	 * Seed the user prompt before the trace is created (e.g. from before_agent_start).
	 */
	seedPrompt(prompt: string): void {
		if (this.#trace) {
			this.#trace.userPrompt = prompt;
		} else {
			this.#pendingPrompt = prompt;
		}
	}

	seedBackgroundModel(model: Model | undefined): void {
		if (this.#trace) {
			this.#trace.backgroundModel = model;
		} else {
			this.#pendingBackgroundModel = model;
		}
	}

	setInjectedEpisodes(ids: string[]): void {
		this.#injectedEpisodeIds = ids;
	}
	setInjectedSkills(names: string[]): void {
		this.#injectedSkillNames = names;
	}
	setInjectedConventions(ids: string[]): void {
		this.#injectedConventionIds = ids;
	}
	setInjectedLearnings(ids: string[]): void {
		this.#injectedLearningIds = ids;
	}
	onAgentStart(_event: AgentStartEvent, ctx: ExtensionContext): void {
		this.#sessionId = ctx.sessionManager.getSessionId();
		// Use pending prompt if set by before_agent_start before trace existed
		const userPrompt = this.#pendingPrompt ?? this.#trace?.userPrompt ?? "";
		const backgroundModel = this.#pendingBackgroundModel;
		this.#pendingPrompt = undefined;
		this.#pendingBackgroundModel = undefined;
		this.#trace = {
			sessionId: this.#sessionId,
			cwd: ctx.cwd,
			backgroundModel,
			userPrompt,
			startTime: Date.now(),
			endTime: 0,
			entries: [],
			toolCallCount: 0,
			errorCount: 0,
			hadRecovery: false,
			completedSuccessfully: false,
		};
	}

	onInput(text: string): void {
		if (!this.#trace) return;
		this.#trace.userPrompt = text;
		this.#trace.entries.push({
			type: "user_input",
			timestamp: Date.now(),
			content: text,
		});
	}

	onToolExecutionStart(event: ToolExecutionStartEvent): void {
		if (!this.#trace) return;
		this.#trace.toolCallCount++;
		this.#trace.entries.push({
			type: "tool_call",
			timestamp: Date.now(),
			toolName: event.toolName,
			args: event.args,
		});
	}

	onToolExecutionEnd(event: ToolExecutionEndEvent): void {
		if (!this.#trace) return;
		if (event.isError) {
			this.#trace.errorCount++;
			this.#trace.errorDetails ??= [];
			const detail = this.#extractErrorDetail(event);
			if (detail) this.#trace.errorDetails.push(detail);
		}
		// Recovery = error followed by non-error within same session
		if (this.#trace.errorCount > 0 && !event.isError) {
			this.#trace.hadRecovery = true;
		}
		this.#trace.entries.push({
			type: "tool_result",
			timestamp: Date.now(),
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		});
	}

	#extractErrorDetail(event: ToolExecutionEndEvent): string | undefined {
		if (!event.result) return undefined;
		let text: string;
		try {
			text = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
		} catch {
			return `${event.toolName}: error (non-serializable result)`;
		}
		const firstLine = text.split("\n")[0]?.trim();
		if (!firstLine || firstLine.length < 5) return undefined;
		return `${event.toolName}: ${firstLine.slice(0, 300)}`;
	}

	onMessageEnd(event: MessageEndEvent): void {
		if (!this.#trace) return;
		const msg = event.message;
		if (msg.role !== "assistant") return;

		// Capture model API failures (429, 401, timeout, etc.)
		if (msg.stopReason === "error" && msg.errorMessage) {
			this.#trace.errorCount++;
			this.#trace.errorDetails ??= [];
			this.#trace.errorDetails.push(msg.errorMessage);
			this.#trace.completedSuccessfully = false;
			this.#trace.entries.push({
				type: "model_error",
				timestamp: Date.now(),
				content: msg.errorMessage,
			});
			return;
		}

		if (typeof msg.content === "string") {
			this.#trace.entries.push({
				type: "assistant_message",
				timestamp: Date.now(),
				content: msg.content,
			});
		}
	}

	/** Start of a new user turn: allow nudge types again (pending queue unchanged). */
	beginTurn(): void {
		this.#deliveredNudgeTypesThisTurn.clear();
	}

	enqueuePendingAgentNudge(nudge: Nudge, historyId: string): boolean {
		if (this.#deliveredNudgeTypesThisTurn.has(nudge.type)) return false;
		this.#deliveredNudgeTypesThisTurn.add(nudge.type);
		this.#pendingAgentNudges.push({ nudge, historyId });
		return true;
	}

	/** Detect only; caller persists history and calls enqueuePendingAgentNudge. */
	checkForNudges(isTypeAllowed?: (type: string) => boolean): Nudge | undefined {
		if (!this.#trace) return undefined;
		const allowed = (type: string) => {
			if (this.#deliveredNudgeTypesThisTurn.has(type)) return false;
			return isTypeAllowed ? isTypeAllowed(type) : true;
		};
		const nudge = this.#nudgeDetector.check(this.#trace, allowed);
		if (!nudge) return undefined;
		this.#trace.nudges ??= [];
		this.#trace.nudges.push(nudge);
		return nudge;
	}

	/** Nudges queued since the last LLM call; consumed by the context hook. */
	drainPendingAgentNudges(): QueuedAgentNudge[] {
		if (this.#pendingAgentNudges.length === 0) return [];
		const drained = [...this.#pendingAgentNudges];
		this.#pendingAgentNudges = [];
		return drained;
	}

	onAgentEnd(_event: AgentEndEvent): SessionTrace | undefined {
		if (!this.#trace) return undefined;
		this.#trace.endTime = Date.now();
		// Heuristic: completed successfully if no errors and at least one tool call
		this.#trace.completedSuccessfully = this.#trace.errorCount === 0 && this.#trace.toolCallCount > 0;
		const result = this.#trace;
		this.#trace.injectedEpisodeIds = this.#injectedEpisodeIds;
		this.#trace.injectedSkillNames = this.#injectedSkillNames;
		this.#trace.injectedConventionIds = this.#injectedConventionIds;
		this.#trace.injectedLearningIds = this.#injectedLearningIds;
		this.#injectedSkillNames = [];
		this.#injectedEpisodeIds = [];
		this.#injectedConventionIds = [];
		this.#injectedLearningIds = [];
		this.#trace = undefined;
		return result;
	}

	reset(): void {
		this.#trace = undefined;
		this.#pendingPrompt = undefined;
		this.#pendingBackgroundModel = undefined;
		this.#injectedSkillNames = [];
		this.#injectedEpisodeIds = [];
		this.#injectedConventionIds = [];
		this.#injectedLearningIds = [];
		this.#pendingAgentNudges = [];
		this.#deliveredNudgeTypesThisTurn.clear();
	}
}

/**
 * Build a concise summary from a SessionTrace for episode storage.
 */
export function summarizeTrace(trace: SessionTrace): {
	summary: string;
	toolsUsed: string[];
	filesModified: string[];
} {
	const toolsUsed = new Set<string>();
	const filesModified = new Set<string>();

	for (const entry of trace.entries) {
		if (entry.type === "tool_call" && entry.toolName) {
			toolsUsed.add(entry.toolName);
			// Heuristic: detect file-modifying tools
			if (entry.toolName === "write" || entry.toolName === "edit" || entry.toolName === "ast_edit") {
				const path = (entry.args as Record<string, unknown>)?.path;
				if (typeof path === "string") {
					filesModified.add(path);
				}
			}
		}
	}

	const toolList = Array.from(toolsUsed).join(", ");
	const outcome = trace.completedSuccessfully
		? trace.hadRecovery
			? "completed with recovery"
			: "completed successfully"
		: trace.errorCount > 0
			? `failed with ${trace.errorCount} error(s)`
			: "no tool calls";

	const summary = `Task: ${trace.userPrompt.slice(0, 120)}${trace.userPrompt.length > 120 ? "..." : ""} | Tools: ${toolList} | Outcome: ${outcome}`;

	return {
		summary,
		toolsUsed: Array.from(toolsUsed),
		filesModified: Array.from(filesModified),
	};
}
