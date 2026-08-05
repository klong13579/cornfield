/**
 * LiveTaskRouter — routes voice tasks into the MAIN TUI session (P1 design §4).
 *
 * A voice task is injected via sendUserMessage and gets the exact same
 * execution semantics as a typed turn: full system prompt, all tools,
 * thinking, history, persistence. The router guards the entry (busy /
 * plan-mode / fail-closed gate check), tracks lifecycle events for the panel
 * and the spoken summary, and owns the "voice task in flight" window that
 * scopes the VoiceGate.
 *
 * The dispatch promise resolves with the summary text. The controller races
 * it against the handoff window: fast results return as function_call_output,
 * late results are delivered as a deferred conversation turn.
 *
 * P1b (§6): the router is also the control surface for a running task —
 * status reports, steer injections (deliverAs "steer"), and cancel (abort).
 */
import { logger } from "@oh-my-pi/pi-utils";
import { extractAssistantText, summarizeActivity } from "./consult-bridge";
import type { VoiceGate } from "./voice-gate";

export interface TaskRouterEvent {
	type: string;
	messages?: unknown;
	toolName?: string;
	args?: unknown;
}

/** Narrow session surface the router relies on (keeps tests honest and small). */
export interface TaskRouterSession {
	sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
	subscribe(listener: (event: TaskRouterEvent) => void): () => void;
	abort(): Promise<void>;
	readonly isStreaming: boolean;
}

export interface LiveTaskRouterOptions {
	session: TaskRouterSession;
	/** Scopes the confirmation gate; also the fail-closed availability check. */
	gate: VoiceGate;
	isPlanMode?(): boolean;
	/** Tool-call activity lines for the panel thinking state. */
	onActivity?(line: string): void;
	/** Spoken summaries are clipped to protect the realtime context. Default 500. */
	summaryMaxChars?: number;
}

const DEFAULT_SUMMARY_MAX_CHARS = 500;

function clipSummary(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export class LiveTaskRouter {
	readonly #options: LiveTaskRouterOptions;
	readonly #summaryMaxChars: number;
	#disposed = false;
	/** Last tool activity line — the material for spoken status reports. */
	#lastActivity: string | undefined;
	/** The in-flight task text — reconnect state material (undefined when idle). */
	#currentTask: string | undefined;

	constructor(options: LiveTaskRouterOptions) {
		this.#options = options;
		this.#summaryMaxChars = options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
	}

	/** Whether a voice task is currently running (the control scope). */
	get inFlight(): boolean {
		return this.#options.gate.inFlight;
	}

	/** The in-flight task text, if any. */
	get currentTask(): string | undefined {
		return this.#currentTask;
	}

	/**
	 * Dispatch one voice task into the main session. Returns the text the
	 * realtime model should verbalize (directly when fast, via a deferred
	 * conversation turn when the handoff already fired).
	 */
	async dispatch(task: string): Promise<string> {
		if (this.#disposed) return "（语音模式已退出。）";
		// Plan approval is a TUI-only flow — voice cannot participate (design §5).
		if (this.#options.isPlanMode?.()) {
			return "（当前会话处于 plan mode，语音任务无法执行。请切到文字模式操作。）";
		}
		// Fail-closed: without the tool_call interception the confirmation gate
		// cannot run, and the task path must not execute ungated writes.
		if (!this.#options.gate.armed) {
			return "（语音确认门不可用，无法执行会修改文件或系统的任务。只读查询请改用 omp_agent_consult。）";
		}
		// Busy means ANY running turn — a previous voice task or a typed one.
		// sendUserMessage without deliverAs would throw AgentBusyError anyway.
		if (this.#options.session.isStreaming) {
			return "（上一个任务还在执行中。请等它完成，或说「停」取消后再试。）";
		}

		this.#options.gate.beginTask();
		this.#lastActivity = undefined;
		this.#currentTask = task;
		try {
			// Delivery of the summary is owned by the controller's handoff path
			// (function_call_output when fast, deferred conversation turn when late).
			return await this.#run(task);
		} finally {
			this.#currentTask = undefined;
			this.#options.gate.endTask();
		}
	}

	dispose(): void {
		this.#disposed = true;
	}
	/**
	 * P1b §6: spoken progress report. Falls back gracefully — no tool events
	 * yet means the model is still thinking.
	 */
	status(): string {
		if (!this.inFlight) return "（现在没有在跑的任务。）";
		if (!this.#lastActivity) return "（任务刚开始，还在思考。）";
		return `（正在执行：${this.#lastActivity}）`;
	}

	/**
	 * P1b §6: inject a mid-task course correction. Uses the same steer delivery
	 * as typing during streaming — the agent loop sees it between tool calls.
	 */
	async steer(text: string): Promise<string> {
		if (!this.inFlight) return "（现在没有在跑的任务，直接说你要做什么就行。）";
		try {
			await this.#options.session.sendUserMessage(text, { deliverAs: "steer" });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("voice steer inject failed", { error: message });
			return `（补充指示没能送达：${message}）`;
		}
		return "（已把补充指示转给正在执行的任务。）";
	}

	/** P1b §6: abort the running task. The agent_end it produces carries the summary. */
	async cancel(): Promise<string> {
		if (!this.inFlight) return "（现在没有在跑的任务。）";
		await this.#options.session.abort();
		return "（已停止。）";
	}

	async #run(task: string): Promise<string> {
		const { promise, resolve } = Promise.withResolvers<string>();
		let settled = false;
		const finish = (text: string): void => {
			if (settled) return;
			settled = true;
			unsubscribe();
			resolve(text);
		};

		const unsubscribe = this.#options.session.subscribe(event => {
			if (this.#disposed) return;
			if (event.type === "tool_execution_start" && event.toolName) {
				const line = summarizeActivity(event.toolName, event.args);
				this.#lastActivity = line;
				this.#options.onActivity?.(line);
				return;
			}
			if (event.type === "agent_end") {
				const text = extractAssistantText(event.messages);
				finish(text ? clipSummary(text, this.#summaryMaxChars) : "（任务结束了，但没有产生可播报的结果。）");
			}
		});

		try {
			await this.#options.session.sendUserMessage(task);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("voice task send failed", { error: message });
			finish(`（任务发送失败：${message}）`);
		}
		return promise;
	}
}
