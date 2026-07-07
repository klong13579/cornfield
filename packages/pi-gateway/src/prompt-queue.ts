/**
 * PromptQueue — owns the per-account prompt lifecycle.
 *
 * Responsibilities (and ONLY these):
 * - Serialize operations via a promise-chain tail (`#runExclusive`).
 * - Track pending prompts keyed by id, with streaming handlers, text
 *   accumulation, and last-activity timestamps.
 * - Dispatch streaming handlers (`#fireStreamHandler`) for text/thinking/
 *   toolcall/toolresult/agent_end events.
 * - Manage per-prompt long-task watchers (threshold timer + ping interval).
 * - Resolve prompts on `agent_end`, timeout, or abort.
 *
 * Non-responsibilities (owned by AgentBridge):
 * - Process lifecycle, JSON-line protocol (owned by RpcTransport).
 * - Session switching, model overrides.
 * - Public API surface (`forward`, `forwardWithMeta`, `executePrompt`).
 * - Circuit breaker, crash recovery.
 * - Attachment extraction, prompt formatting.
 *
 * The queue receives events from AgentBridge (which receives them from
 * RpcTransport). The queue never touches the transport directly — that
 * keeps the transport ↔ queue seam one-directional.
 */

import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ForwardStreamHandlers } from "./agent-bridge";
import type { AgentEvent, RpcTransport } from "./agent-transport";

/** Long-task watcher configuration. */
export interface LongTaskConfig {
	/** Threshold in ms before the first `onLongTask` fires (0 = disabled). */
	thresholdMs: number;
	/** Interval in ms for subsequent `onLongTask` pings. */
	pingMs: number;
}

interface PendingPrompt {
	promptId: string;
	resolve: (result: { events: AgentEvent[]; aborted: boolean }) => void;
	reject: (error: Error) => void;
	events: AgentEvent[];
	timeout: NodeJS.Timeout;
	/** Rolling inactivity watchdog — see `enqueue`. May be undefined if
	 *  the prompt was constructed by a caller that did not opt in. */
	inactivityWatchdog?: NodeJS.Timeout;
	handlers?: ForwardStreamHandlers;
	textCumulative?: string;
	lastActivityAt: number;
}

interface LongTaskWatcher {
	toolName: string;
	startedAt: number;
	thresholdTimer: NodeJS.Timeout;
	pingInterval: NodeJS.Timeout | null;
	thresholdFired: boolean;
}

/**
 * PromptQueue — per-account prompt lifecycle and streaming dispatch.
 *
 * Constructed with a transport reference (to send frames) and a
 * long-task config. The bridge calls `enqueue()` to submit a prompt,
 * forwards `onCommandResponse` and `onSessionEvent` from the transport,
 * and calls `clearAll()` on `stop()`.
 */
export class PromptQueue {
	#transport: RpcTransport;
	#longTaskConfig: LongTaskConfig;
	#pendingPrompts = new Map<string, PendingPrompt>();
	#activePromptId: string | undefined;
	#operationTail: Promise<void> = Promise.resolve();
	#promptIdCounter = 0;

	constructor(transport: RpcTransport, longTaskConfig: LongTaskConfig) {
		this.#transport = transport;
		this.#longTaskConfig = longTaskConfig;
	}

	// ═══════════════════════════════════════════════════════════════
	// Serialization
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Run an operation under the queue's exclusive lock. Operations are
	 * serialized via a promise tail — the next operation waits for the
	 * previous to settle (success or failure) before starting.
	 *
	 * `queueTimeoutMs` bounds how long the caller is willing to WAIT for
	 * the lock. If the previous operation is still running when the
	 * timeout fires, this call throws and the operation is never invoked.
	 * The chain still receives a resolved `current` slot (so the next
	 * caller's `previous` is the running op + a no-op step), preventing
	 * the chain from deadlocking on callers that bailed out.
	 *
	 * Default `queueTimeoutMs = 0` preserves the legacy "wait forever"
	 * behaviour for callers that don't opt in (LLM streaming sentinels,
	 * restart-sentinel recovery, BOOT.md self-check — all cold at
	 * startup with an empty queue).
	 */
	async runExclusive<T>(operation: () => Promise<T>, opts?: { queueTimeoutMs?: number }): Promise<T> {
		const previous = this.#operationTail;
		const { promise: current, resolve } = Promise.withResolvers<void>();
		this.#operationTail = previous.catch(() => {}).then(() => current);
		try {
			const queueTimeoutMs = opts?.queueTimeoutMs ?? 0;
			if (queueTimeoutMs > 0) {
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				const timeoutPromise = new Promise<never>((_, reject) => {
					timeoutHandle = setTimeout(
						() =>
							reject(
								new Error(
									`PromptQueue queue wait timed out after ${queueTimeoutMs}ms (previous operation still running)`,
								),
							),
						queueTimeoutMs,
					);
				});
				try {
					await Promise.race([previous.catch(() => {}), timeoutPromise]);
				} finally {
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
			} else {
				await previous.catch(() => {});
			}
			return await operation();
		} finally {
			resolve();
		}
	}

	/** Wait for all queued operations to settle. */
	async waitForIdle(): Promise<void> {
		await this.#operationTail;
	}

	// ═══════════════════════════════════════════════════════════════
	// Prompt submission
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Submit a prompt and return a promise that resolves when the agent
	 * completes the run (on `agent_end`) or rejects on timeout.
	 *
	 * The prompt is sent as a fire-and-forget `prompt` frame; subsequent
	 * session events are routed to this pending prompt via `onSessionEvent`.
	 * The `prompt` command response (confirming submission) is routed via
	 * `onCommandResponse` — it sets the active prompt id.
	 */
	enqueue(
		message: string,
		timeoutMs: number,
		handlers?: ForwardStreamHandlers,
		images?: ImageContent[],
		opts?: { inactivityMs?: number },
	): { promptId: string; promise: Promise<{ events: AgentEvent[]; aborted: boolean }> } {
		const promptId = `p_${++this.#promptIdCounter}`;

		const { promise, resolve, reject } = Promise.withResolvers<{
			events: AgentEvent[];
			aborted: boolean;
		}>();

		// Hard cap: a single prompt may not live longer than `timeoutMs`,
		// regardless of activity. This is the absolute maximum user wait
		// (defaults to 5 minutes upstream).
		const timeout = setTimeout(() => {
			this.#clearAllLongTaskWatchers(promptId);
			this.#pendingPrompts.delete(promptId);
			if (this.#activePromptId === promptId) this.#activePromptId = undefined;
			reject(new Error(`Agent RPC timed out after ${timeoutMs}ms (hard cap)`));
		}, timeoutMs);

		const pending: PendingPrompt = {
			promptId,
			resolve,
			reject,
			events: [],
			timeout,
			lastActivityAt: Date.now(),
		};
		if (handlers) pending.handlers = handlers;

		this.#pendingPrompts.set(promptId, pending);

		// Rolling inactivity timeout: OMP emits session events (token deltas,
		// tool calls, message_end) as it makes progress. As long as any event
		// arrives within `inactivityMs`, the prompt is considered alive and
		// the hard cap is what bounds it. When the LLM is mid-thought but
		// actively streaming tokens, the inactivity timer keeps resetting
		// and the hard cap is what eventually fires — not a 60s false
		// timeout. Defaults to 60s when not specified (matches the previous
		// single-timer behaviour for upstream callers that don't opt in).
		const inactivityMs = opts?.inactivityMs ?? 60_000;
		const inactivityWatchdog = setInterval(
			() => {
				const cur = this.#pendingPrompts.get(promptId);
				if (!cur) {
					clearInterval(inactivityWatchdog);
					return;
				}
				const idle = Date.now() - cur.lastActivityAt;
				if (idle >= inactivityMs) {
					clearInterval(inactivityWatchdog);
					clearTimeout(timeout);
					this.#clearAllLongTaskWatchers(promptId);
					this.#pendingPrompts.delete(promptId);
					if (this.#activePromptId === promptId) this.#activePromptId = undefined;
					reject(
						new Error(
							`Agent RPC inactive for ${idle}ms (no session event for ${inactivityMs}ms, hard cap ${timeoutMs}ms)`,
						),
					);
				}
			},
			Math.min(10_000, Math.max(1_000, Math.floor(inactivityMs / 6))),
		);

		try {
			this.#transport.sendFrame("prompt", {
				id: promptId,
				message,
				...(images && images.length > 0 ? { images } : {}),
			});
		} catch (err) {
			clearTimeout(timeout);
			clearInterval(inactivityWatchdog);
			this.#pendingPrompts.delete(promptId);
			const error = err instanceof Error ? err : new Error(String(err));
			reject(error);
		}

		return { promptId, promise };
	}

	// ═══════════════════════════════════════════════════════════════
	// Event routing (called by AgentBridge from transport events)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Route a `response` frame to the pending prompt (if this is a `prompt`
	 * command). Other command responses are handled by the transport's own
	 * pending-commands map and don't reach here.
	 */
	onCommandResponse(commandId: string, event: AgentEvent): void {
		if (event.command !== "prompt") return;
		const pending = this.#pendingPrompts.get(commandId);
		if (!pending) return;
		if (event.success) {
			pending.events.push(event);
			pending.lastActivityAt = Date.now();
			this.#activePromptId = commandId;
		} else {
			clearTimeout(pending.timeout);
			if (pending.inactivityWatchdog) clearInterval(pending.inactivityWatchdog);
			this.#pendingPrompts.delete(commandId);
			if (this.#activePromptId === commandId) this.#activePromptId = undefined;
			pending.reject(new Error(event.error ?? "RPC command failed: prompt"));
		}
	}

	/**
	 * Route a session event (no id) to the currently active prompt.
	 * Fires streaming handlers and resolves the promise on `agent_end`.
	 */
	onSessionEvent(event: AgentEvent): void {
		if (!this.#activePromptId) return;
		const pending = this.#pendingPrompts.get(this.#activePromptId);
		if (!pending) return;
		pending.events.push(event);
		pending.lastActivityAt = Date.now();

		if (pending.handlers) {
			this.#fireStreamHandler(pending, event);
		}

		if (event.type === "agent_end") {
			clearTimeout(pending.timeout);
			if (pending.inactivityWatchdog) clearInterval(pending.inactivityWatchdog);
			this.#pendingPrompts.delete(this.#activePromptId);
			this.#activePromptId = undefined;
			pending.resolve({ events: pending.events, aborted: false });
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// Abort / clear
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Force-resolve the active prompt as aborted. Called by `AgentBridge.abort()`
	 * and by the inactivity watchdog after sending the abort command.
	 */
	resolveActiveAsAborted(): boolean {
		if (!this.#activePromptId) return false;
		const promptId = this.#activePromptId;
		const pending = this.#pendingPrompts.get(promptId);
		if (!pending) return false;
		clearTimeout(pending.timeout);
		if (pending.inactivityWatchdog) clearInterval(pending.inactivityWatchdog);
		this.#clearAllLongTaskWatchers(promptId);
		this.#pendingPrompts.delete(promptId);
		this.#activePromptId = undefined;
		pending.resolve({
			events: [
				...pending.events,
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "（已停止）" }],
					},
				},
				{ type: "agent_end" },
			],
			aborted: true,
		});
		return true;
	}

	/** Reject all pending prompts (called from `stop()`). */
	rejectAll(error: Error): void {
		for (const pending of this.#pendingPrompts.values()) {
			clearTimeout(pending.timeout);
			if (pending.inactivityWatchdog) clearInterval(pending.inactivityWatchdog);
			pending.reject(error);
		}
		this.#pendingPrompts.clear();
		this.#clearAllLongTaskWatchersForAllPrompts();
		this.#activePromptId = undefined;
	}

	// ═══════════════════════════════════════════════════════════════
	// Introspection
	// ═══════════════════════════════════════════════════════════════

	get pendingCount(): number {
		return this.#pendingPrompts.size;
	}

	get activePromptId(): string | undefined {
		return this.#activePromptId;
	}

	hasPendingPrompts(): boolean {
		return this.#pendingPrompts.size > 0 || this.#activePromptId !== undefined;
	}

	/** Read the last-activity timestamp of the active prompt (for inactivity watchdog). */
	getActiveLastActivityAt(): number | undefined {
		if (!this.#activePromptId) return undefined;
		return this.#pendingPrompts.get(this.#activePromptId)?.lastActivityAt;
	}

	// ═══════════════════════════════════════════════════════════════
	// Streaming handler dispatch
	// ═══════════════════════════════════════════════════════════════

	#fireStreamHandler(pending: PendingPrompt, event: AgentEvent): void {
		const handlers = pending.handlers;
		if (!handlers) return;
		try {
			if (event.type === "message_update") {
				const ame = event.assistantMessageEvent;
				if (!ame) return;
				if (ame.type === "text_delta" && typeof ame.delta === "string") {
					pending.textCumulative = (pending.textCumulative ?? "") + ame.delta;
					handlers.onTextDelta?.(ame.delta, pending.textCumulative);
				} else if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
					handlers.onThinkingDelta?.(ame.delta);
				} else if (ame.type === "toolcall_end") {
					const tc = (ame as { toolCall?: { id?: string; name?: string; arguments?: unknown } }).toolCall;
					if (tc && typeof tc.id === "string" && typeof tc.name === "string") {
						logger.debug("[PromptQueue] toolcall_end — starting long-task watcher", {
							toolCallId: tc.id,
							toolName: tc.name,
							hasOnLongTask: typeof handlers.onLongTask === "function",
						});
						handlers.onToolCall?.({ id: tc.id, name: tc.name, args: tc.arguments ?? null });
						this.#startLongTaskWatcher(pending.promptId, tc.id, tc.name);
					}
				}
			} else if (event.type === "message_end" && event.message) {
				const role = event.message.role;
				if (role === "assistant") {
					handlers.onAssistantMessageEnd?.();
				} else if (role === "toolResult") {
					const tr = event.message as unknown as {
						toolCallId?: string;
						toolName?: string;
						isError?: boolean;
						content?: Array<{ type: string; text?: string }>;
					};
					if (typeof tr.toolCallId === "string") {
						const contentText = (tr.content ?? [])
							.filter(c => c.type === "text" && typeof c.text === "string")
							.map(c => c.text ?? "")
							.join("\n");
						handlers.onToolResult?.({
							id: tr.toolCallId,
							name: typeof tr.toolName === "string" ? tr.toolName : "tool",
							isError: tr.isError === true,
							contentText,
						});
						this.#clearLongTaskWatcher(pending.promptId, tr.toolCallId);
					}
				}
			} else if (event.type === "agent_end") {
				this.#clearAllLongTaskWatchers(pending.promptId);
				handlers.onAgentEnd?.();
			}
		} catch (err) {
			logger.warn("PromptQueue stream handler threw", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// Long-task watchers
	// ═══════════════════════════════════════════════════════════════

	#startLongTaskWatcher(promptId: string, toolCallId: string, toolName: string): void {
		const thresholdMs = this.#longTaskConfig.thresholdMs;
		if (thresholdMs <= 0) {
			logger.debug("[PromptQueue] long-task watcher disabled (threshold=0)", { promptId, toolCallId });
			return;
		}
		const pending = this.#pendingPrompts.get(promptId);
		if (!pending?.handlers?.onLongTask) {
			return;
		}
		let perPrompt = this.#longTaskWatchers.get(promptId);
		if (!perPrompt) {
			perPrompt = new Map();
			this.#longTaskWatchers.set(promptId, perPrompt);
		}
		if (perPrompt.has(toolCallId)) return;

		const pingMs = this.#longTaskConfig.pingMs;
		const startedAt = Date.now();
		const watcher: LongTaskWatcher = {
			toolName,
			startedAt,
			thresholdTimer: undefined as unknown as NodeJS.Timeout,
			pingInterval: null,
			thresholdFired: false,
		};

		const fire = (threshold: boolean): void => {
			try {
				pending.handlers?.onLongTask?.({
					toolCallId,
					toolName,
					elapsedMs: Date.now() - startedAt,
					threshold,
				});
			} catch (err) {
				logger.warn("PromptQueue onLongTask handler threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		watcher.thresholdTimer = setTimeout(() => {
			watcher.thresholdFired = true;
			fire(true);
			watcher.pingInterval = setInterval(() => {
				fire(false);
			}, pingMs);
		}, thresholdMs);

		perPrompt.set(toolCallId, watcher);
	}

	#clearLongTaskWatcher(promptId: string, toolCallId: string): void {
		const perPrompt = this.#longTaskWatchers.get(promptId);
		if (!perPrompt) return;
		const watcher = perPrompt.get(toolCallId);
		if (!watcher) return;
		clearTimeout(watcher.thresholdTimer);
		if (watcher.pingInterval) clearInterval(watcher.pingInterval);
		perPrompt.delete(toolCallId);
		if (perPrompt.size === 0) this.#longTaskWatchers.delete(promptId);
	}

	#clearAllLongTaskWatchers(promptId: string): void {
		const perPrompt = this.#longTaskWatchers.get(promptId);
		if (!perPrompt) return;
		for (const watcher of perPrompt.values()) {
			clearTimeout(watcher.thresholdTimer);
			if (watcher.pingInterval) clearInterval(watcher.pingInterval);
		}
		this.#longTaskWatchers.delete(promptId);
	}

	#clearAllLongTaskWatchersForAllPrompts(): void {
		for (const perPrompt of this.#longTaskWatchers.values()) {
			for (const watcher of perPrompt.values()) {
				clearTimeout(watcher.thresholdTimer);
				if (watcher.pingInterval) clearInterval(watcher.pingInterval);
			}
		}
		this.#longTaskWatchers.clear();
	}

	/** Per-prompt long-task watcher state. */
	#longTaskWatchers = new Map<string, Map<string, LongTaskWatcher>>();
}
