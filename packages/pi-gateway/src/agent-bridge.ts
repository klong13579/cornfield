/**
 * Agent Bridge — forwards IM messages to OMP via RPC mode.
 *
 * Architecture:
 *   [IM Message] → AgentBridge.forward() → omp --mode rpc → JSON-line protocol → [Reply]
 *
 * Spawns `omp --mode rpc` as a long-running child process. Communicates via
 * the RPC JSON-line protocol (stdin/stdout). Handles process lifecycle: spawn,
 * crash detection, and recovery with exponential backoff.
 *
 * Key improvement over polling-based approach:
 * - Event-driven promise latching: each prompt gets a unique `id`,
 *   and `agent_end` with matching id immediately resolves the pending promise.
 * - No polling (no 100ms setInterval overhead).
 * - Collects all `message_end` events with `role: "assistant"` between prompt and end.
 */

import type { AssistantMessage, ImageContent, ToolCall, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import * as path from "node:path";
import { extractPdfText } from "./channels/dingtalk-media";
import { resolveCredentialEnvVars } from "./credential-resolver";
import type {
	AgentResponseMeta,
	AgentResponseToolCall,
	AgentResponseToolResult,
	InboundAttachment,
	InboundMessage,
	SessionRecord,
} from "./types";

// Inline types for RPC protocol messages the bridge handles
type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

type RpcHostToolResult = {
	type: "host_tool_result";
	id: string;
	result: {
		type: "tool_result";
		tool_use_id: string;
		content: Array<{ type: "text"; text: string }>;
	};
	isError?: boolean;
};

type CircuitState = "closed" | "open" | "half-open";

const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_WINDOW_LIMIT = 5;
const CIRCUIT_FAILURE_THRESHOLD = 10;
const CIRCUIT_COOLDOWN_MS = 30_000;
const CIRCUIT_OPEN_MESSAGE = "系统繁忙，请稍后再试。";

/**
 * Default long-task threshold (3 min). Overridable via env var for
 * testing — e.g. `DINGTALK_LONG_TASK_THRESHOLD_MS=30000 omp gateway start`
 * fires the watcher 30 s into a tool call instead of 3 min. Set to 0
 * to disable the watcher entirely.
 */
const DEFAULT_LONG_TASK_THRESHOLD_MS = 180_000;
/**
 * Default progress-ping interval (5 min). After the threshold fires,
 * `onLongTask` re-fires every N ms until the tool returns or the
 * prompt ends. Overridable via `DINGTALK_LONG_TASK_PROGRESS_PING_MS`.
 */
const DEFAULT_LONG_TASK_PROGRESS_PING_MS = 300_000;

/** Resolved once at module load — env reads are stable for the
 * process lifetime (gateway is a daemon; restarts reload). */
function readEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 0) {
		logger.warn(`[AgentBridge] Invalid ${name}=${raw}, using default ${fallback}`);
		return fallback;
	}
	return parsed;
}
const LONG_TASK_THRESHOLD_MS = readEnvInt("DINGTALK_LONG_TASK_THRESHOLD_MS", DEFAULT_LONG_TASK_THRESHOLD_MS);
const LONG_TASK_PROGRESS_PING_MS = readEnvInt(
	"DINGTALK_LONG_TASK_PROGRESS_PING_MS",
	DEFAULT_LONG_TASK_PROGRESS_PING_MS,
);

/** Exported for test introspection — production code should consume
 * `LONG_TASK_THRESHOLD_MS` / `LONG_TASK_PROGRESS_PING_MS` directly. */
export const __TEST_LONG_TASK_THRESHOLD_MS = LONG_TASK_THRESHOLD_MS;
export const __TEST_LONG_TASK_PROGRESS_PING_MS = LONG_TASK_PROGRESS_PING_MS;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type AgentBridgeLifecycleState = "stopped" | "starting" | "idle" | "busy" | "restarting" | "degraded" | "error";

export interface AgentBridgeSnapshot {
	state: AgentBridgeLifecycleState;
	running: boolean;
	ready: boolean;
	pid?: number;
	activeSessionPath?: string;
	activePromptId?: string;
	pendingPrompts: number;
	pendingCommands: number;
	circuitState: CircuitState;
	circuitFailures: number;
	circuitOpenedAt?: number;
	crashCount: number;
	crashWindowCount: number;
	crashSuppressed: boolean;
	reconnecting: boolean;
	lastError?: string;
}

export interface AgentBridgeOptions {
	/** Path to omp binary (default: "omp") */
	ompPath?: string;
	/** Model to use (default: undefined = omp default) */
	model?: string;
	/** Maximum time to wait for agent response in ms (default: 120000) */
	timeoutMs?: number;
	/** Working directory for agent execution (default: process.cwd()) */
	cwd?: string;
	/** Max retries for RPC process crash recovery (default: 3) */
	maxCrashRetries?: number;
	/** Base delay for crash recovery backoff in ms (default: 1000) */
	crashBackoffMs?: number;
	/** How long a single tool call can run before the bridge fires
	 * `onLongTask` with `threshold: true` (default: 180000 = 3 min,
	 * overridable via `DINGTALK_LONG_TASK_THRESHOLD_MS` env var).
	 * Set to 0 to disable the watcher. */
	longTaskThresholdMs?: number;
	/** Interval between subsequent `onLongTask` fires after the threshold
	 * is reached (default: 300000 = 5 min, overridable via
	 * `DINGTALK_LONG_TASK_PROGRESS_PING_MS` env var). */
	progressPingIntervalMs?: number;
	/** Tool names to deny for this agent. Applied via setDisabledToolsets on start. */
	deniedTools?: string[];
}

/** Inline-shape RPC event (subset of @oh-my-pi/pi-agent AgentEvent). */
interface AgentEvent {
	type: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: Array<{ type: string; text?: string }>;
	};
	text?: string;
	/** For `message_update` events: the streaming sub-event from the agent
	 * loop. Carries incremental deltas (text/thinking/toolcall) plus lifecycle
	 * markers. Bridge consumers that want streaming chrome subscribe via
	 * `ForwardStreamHandlers` instead of parsing this shape directly. */
	assistantMessageEvent?: {
		type: string;
		delta?: string;
		contentIndex?: number;
		[key: string]: unknown;
	};
}

/**
 * Streaming callbacks fired by `AgentBridge.forwardWithMeta` as RPC events
 * arrive during a prompt run. Handlers are called synchronously on the
 * bridge's event-loop turn, so consumers should avoid blocking work in the
 * handler. The bridge does not await handlers — exceptions are logged and
 * the run continues.
 *
 * Use this when the caller wants to surface incremental progress (e.g.
 * streaming the answer text into a DingTalk AI Card as it arrives). The
 * full `AgentResponseMeta` is still returned at run end for callers that
 * also need a final reply.
 */
export interface ForwardStreamHandlers {
	/** Fired on every `text_delta` for the assistant text block. `cumulative`
	 * is the concatenated delta string since the prompt started. */
	onTextDelta?: (delta: string, cumulative: string) => void;
	/** Fired on every `thinking_delta` for the assistant thinking block. */
	onThinkingDelta?: (delta: string) => void;
	/** Fired when an assistant tool call completes (on `toolcall_end`). The
	 * bridge tracks tool calls / results internally for the final
	 * `AgentResponseMeta`; this handler exists so streaming consumers can
	 * pair the call with its result in real time. */
	onToolCall?: (call: { id: string; name: string; args: unknown }) => void;
	/** Fired on a user-side `message_end` whose `role === "toolResult"`.
	 * Pairs with a prior `onToolCall` via `id`. `contentText` is the joined
	 * `text` content (other content shapes are not currently extracted —
	 * tool results with images / files do not produce text). */
	onToolResult?: (result: { id: string; name: string; isError: boolean; contentText: string }) => void;
	/** Fired when the assistant `message_end` event arrives. The full
	 * assistant message is available on the meta returned by `forwardWithMeta`
	 * — this just signals the message is complete. */
	onAssistantMessageEnd?: () => void;
	/** Fired on `agent_end`. After this, the bridge will resolve
	 * `forwardWithMeta` with the final meta shortly (or it may already be
	 * resolved by the time the handler runs). */
	onAgentEnd?: () => void;
	/** Fired when a tool call has been running longer than the bridge's
	 * `longTaskThresholdMs`. The first fire happens once at the threshold;
	 * subsequent fires are spaced by `progressPingIntervalMs` while the
	 * tool is still pending. Stops firing when the matching `onToolResult`
	 * arrives or the prompt ends. Used by the AI Card path to surface a
	 * "still working" affordance on long-running tools. */
	onLongTask?: (event: {
		toolCallId: string;
		toolName: string;
		elapsedMs: number;
		/** True for the first fire (right at the threshold); false for
		 * subsequent interval pings. */
		threshold: boolean;
	}) => void;
}

/** Pending prompt state */
interface PendingPrompt {
	promptId: string;
	resolve: (events: AgentEvent[]) => void;
	reject: (error: Error) => void;
	events: AgentEvent[];
	timeout: NodeJS.Timeout;
	/** Streaming callbacks for this prompt. Set by `forwardWithMeta` when
	 * the caller passes `handlers`; left undefined for fire-and-wait callers. */
	handlers?: ForwardStreamHandlers;
	/** Cumulative text concatenated from `text_delta` events on this prompt.
	 * Updated as deltas arrive so `onTextDelta` can report the full string. */
	textCumulative?: string;
	/** Set to true if the prompt was resolved via `#resolveActivePromptAsAborted`
	 * (i.e. `bridge.abort()` was called, the RPC acknowledged the abort, and
	 * the active prompt was force-resolved with the appended "（已停止）"
	 * marker). `forwardWithMeta` reads this after `promptAndWait` resolves
	 * and passes it to `#buildMetaFromEvents` so the AgentResponseMeta's
	 * `aborted: true` field correctly reflects the user-initiated abort. */
	aborted: boolean;
	/** ms-since-epoch of the last event received from the RPC process for this prompt.
	 * Used to enforce `executePrompt({ inactivityMs })`. Bumped on every session
	 * event routed to this prompt (see the `pending.events.push(parsed)` site in
	 * the session-event branch of the event reader). */
	lastActivityAt: number;
}

interface PendingCommand {
	command: string;
	resolve: (event: AgentEvent) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

/** Per-tool-call long-task watcher. Created in `onToolCall`; cleared on
 * the matching `onToolResult` or on prompt end. Fires `onLongTask` at
 * the threshold (once) and on the interval (subsequent pings). */
interface LongTaskWatcher {
	toolName: string;
	startedAt: number;
	/** Fires once at `thresholdMs` to emit the first `onLongTask`. */
	thresholdTimer: NodeJS.Timeout;
	/** Repeating timer for pings after the threshold. */
	pingInterval: NodeJS.Timeout | null;
	/** Set to true after the first fire so subsequent pings report
	 * `threshold: false`. */
	thresholdFired: boolean;
}

export class AgentBridge {
	#proc: { pid: number; kill: () => void } | null = null;
	#stdinWriter?: { write: (data: Uint8Array) => void };
	#ready = false;
	/** Map of prompt IDs to pending prompts */
	#pendingPrompts = new Map<string, PendingPrompt>();
	#pendingCommands = new Map<string, PendingCommand>();
	/** Currently active prompt ID (for routing session.subscribe events) */
	#activePromptId: string | undefined;
	/** Set when `abort()` is called, so `forwardWithMeta` can distinguish an
	 *  abort-induced empty response (agent had no chance to output before the
	 *  reader resolved the pending prompt via agent_end) from a genuine empty
	 *  response. Reset after each `forwardWithMeta` completes. */
	#abortRequested = false;
	#activeSessionPath: string | undefined;
	#operationTail: Promise<void> = Promise.resolve();
	/** Model set via setModel() that must be re-applied after switchSession restores session context. */
	#pendingModelOverride: { provider: string; modelId: string } | undefined;
	/** Counter for generating unique prompt IDs */
	#promptIdCounter = 0;
	#commandIdCounter = 0;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced in stop() and #spawnAndWaitReady for stream-reader liveness
	#stderrReader?: Promise<void>;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced in stop() and #spawnAndWaitReady for stream-reader liveness
	#stdoutReader?: Promise<void>;
	#crashCount = 0;
	#crashTimestamps: number[] = [];
	#crashSuppressed = false;
	#circuitState: CircuitState = "closed";
	#circuitFailures = 0;
	#circuitOpenedAt = 0;
	#options: AgentBridgeOptions;
	#reconnectGuard = false;
	#lastError: string | undefined;
	/** Per-prompt long-task watcher state. Maps promptId -> (toolCallId ->
	 * watcher). Created when `onToolCall` fires; cleared on the matching
	 * `onToolResult` or on prompt end. */
	#longTaskWatchers = new Map<string, Map<string, LongTaskWatcher>>();

	constructor(options: AgentBridgeOptions = {}) {
		this.#options = options;
		const thresholdMs = options.longTaskThresholdMs ?? LONG_TASK_THRESHOLD_MS;
		const pingMs = options.progressPingIntervalMs ?? LONG_TASK_PROGRESS_PING_MS;
		logger.debug("[AgentBridge] long-task watcher configured", {
			thresholdMs,
			pingMs,
			disabled: thresholdMs <= 0,
		});
	}

	// ═══════════════════════════════════════════════════════════════
	// Process Lifecycle
	// ═══════════════════════════════════════════════════════════════

	async start(): Promise<void> {
		await this.#spawnAndWaitReady();
		this.#applyDeniedTools();
		this.#runBootCheck();
	}

	/**
	 * Fire-and-forget: apply deniedTools (from agent config) via
	 * setDisabledToolsets so this agent can't use those tools.
	 * Errors are logged but never thrown — tool restriction is
	 * best-effort and must not block startup.
	 */
	#applyDeniedTools(): void {
		const denied = this.#options.deniedTools;
		if (!denied || denied.length === 0) return;

		this.setDisabledToolsets(denied).catch(err => {
			logger.warn("[AgentBridge] Failed to apply deniedTools", {
				denied,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}



	/**
	 * Fire-and-forget: if a BOOT.md file exists in the agent's working
	 * directory, send its content as a prompt to the agent after startup.
	 * The agent runs the boot instructions (e.g. check notifications, report
	 * status) without blocking gateway startup or inbound message processing.
	 *
	 * Errors and empty responses are logged but never thrown — boot is
	 * best-effort and must not break the bridge.
	 */
	#runBootCheck(): void {
		const cwd = this.#options.cwd;
		if (!cwd) return;
		const bootPath = path.join(cwd, "BOOT.md");

		Bun.file(bootPath)
			.text()
			.then(content => {
				const trimmed = content.trim();
				if (!trimmed) {
					logger.debug("[AgentBridge] BOOT.md is empty, skipping", { bootPath });
					return;
				}
				logger.info("[AgentBridge] Running BOOT.md self-check", { bootPath, length: trimmed.length });
				this.executePrompt(trimmed, { timeoutMs: 60_000 })
					.then(result => {
						logger.info("[AgentBridge] BOOT.md completed", {
							bootPath,
							preview: result.slice(0, 200),
						});
					})
					.catch(err => {
						logger.warn("[AgentBridge] BOOT.md execution failed", {
							bootPath,
							error: err instanceof Error ? err.message : String(err),
						});
					});
			})
			.catch(err => {
				if (!isEnoent(err)) {
					logger.warn("[AgentBridge] Failed to read BOOT.md", {
						bootPath,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				// ENOENT is expected — most agents don't have BOOT.md.
			});
	}

	stop(): void {
		this.#crashCount = 0;
		this.#ready = false;
		this.#reconnectGuard = false;
		this.#activePromptId = undefined;
		this.#crashTimestamps = [];
		this.#crashSuppressed = false;
		this.#circuitState = "closed";
		this.#circuitFailures = 0;
		this.#circuitOpenedAt = 0;
		this.#activeSessionPath = undefined;

		if (this.#proc) {
			this.#proc.kill();
			this.#proc = null;
		}
		this.#stdinWriter = undefined;
		this.#stdoutReader = undefined;
		this.#stderrReader = undefined;

		const error = new Error("Agent bridge stopped");
		for (const pending of this.#pendingPrompts.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pendingPrompts.clear();
		for (const pending of this.#pendingCommands.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pendingCommands.clear();
		this.#clearAllLongTaskWatchersForAllPrompts();
	}

	// ───────────────────────────────────────────────────────────────
	// Long-task watcher
	// ───────────────────────────────────────────────────────────────

	/** Start watching a tool call for long-task threshold. Called from
	 * `#fireStreamHandler` when `onToolCall` fires. No-op if the watcher
	 * is disabled (`longTaskThresholdMs === 0`) or the prompt has no
	 * `onLongTask` handler. */
	#startLongTaskWatcher(promptId: string, toolCallId: string, toolName: string): void {
		const thresholdMs = this.#options.longTaskThresholdMs ?? LONG_TASK_THRESHOLD_MS;
		if (thresholdMs <= 0) {
			logger.debug("[AgentBridge] long-task watcher disabled (threshold=0)", { promptId, toolCallId });
			return;
		}
		const pending = this.#pendingPrompts.get(promptId);
		if (!pending?.handlers?.onLongTask) {
			logger.debug("[AgentBridge] long-task watcher skipped: no onLongTask handler", {
				promptId,
				toolCallId,
				hasPending: !!pending,
				hasHandlers: !!pending?.handlers,
				hasOnLongTask: !!pending?.handlers?.onLongTask,
			});
			return;
		}
		// Idempotent: if a watcher for this tool call already exists, don't
		// schedule a second one. The same id can come up if the bridge ever
		// re-emits (it shouldn't, but the watcher's state is per-call).
		let perPrompt = this.#longTaskWatchers.get(promptId);
		if (!perPrompt) {
			perPrompt = new Map();
			this.#longTaskWatchers.set(promptId, perPrompt);
		}
		if (perPrompt.has(toolCallId)) return;

		const pingMs = this.#options.progressPingIntervalMs ?? LONG_TASK_PROGRESS_PING_MS;
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
				logger.warn("AgentBridge onLongTask handler threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		watcher.thresholdTimer = setTimeout(() => {
			watcher.thresholdFired = true;
			logger.debug("[AgentBridge] long-task watcher FIRED threshold", {
				toolCallId,
				toolName,
				elapsedMs: Date.now() - startedAt,
				thresholdMs,
			});
			fire(true);
			// Subsequent pings
			watcher.pingInterval = setInterval(() => {
				logger.debug("[AgentBridge] long-task watcher PING", {
					toolCallId,
					toolName,
					elapsedMs: Date.now() - startedAt,
				});
				fire(false);
			}, pingMs);
		}, thresholdMs);

		perPrompt.set(toolCallId, watcher);
	}

	/** Clear the watcher for one tool call (called from `onToolResult`). */
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

	/** Clear all watchers for one prompt (called from `agent_end`). */
	#clearAllLongTaskWatchers(promptId: string): void {
		const perPrompt = this.#longTaskWatchers.get(promptId);
		if (!perPrompt) return;
		for (const watcher of perPrompt.values()) {
			clearTimeout(watcher.thresholdTimer);
			if (watcher.pingInterval) clearInterval(watcher.pingInterval);
		}
		this.#longTaskWatchers.delete(promptId);
	}

	/** Clear every watcher's timers (called from `stop()`). Keeps the map
	 * empty — stop is a hard reset, not a partial clear. */
	#clearAllLongTaskWatchersForAllPrompts(): void {
		for (const perPrompt of this.#longTaskWatchers.values()) {
			for (const watcher of perPrompt.values()) {
				clearTimeout(watcher.thresholdTimer);
				if (watcher.pingInterval) clearInterval(watcher.pingInterval);
			}
		}
		this.#longTaskWatchers.clear();
	}

	get isRunning(): boolean {
		return this.#ready && this.#proc !== null;
	}

	getSnapshot(): AgentBridgeSnapshot {
		const busy =
			this.#pendingPrompts.size > 0 || this.#pendingCommands.size > 0 || this.#activePromptId !== undefined;
		const state: AgentBridgeLifecycleState = this.#getLifecycleState(busy);
		return {
			state,
			running: this.isRunning,
			ready: this.#ready,
			pid: this.#proc?.pid,
			activeSessionPath: this.#activeSessionPath,
			activePromptId: this.#activePromptId,
			pendingPrompts: this.#pendingPrompts.size,
			pendingCommands: this.#pendingCommands.size,
			circuitState: this.#circuitState,
			circuitFailures: this.#circuitFailures,
			circuitOpenedAt: this.#circuitOpenedAt || undefined,
			crashCount: this.#crashCount,
			crashWindowCount: this.#crashTimestamps.length,
			crashSuppressed: this.#crashSuppressed,
			reconnecting: this.#reconnectGuard,
			lastError: this.#lastError,
		};
	}

	#getLifecycleState(busy: boolean): AgentBridgeLifecycleState {
		if (this.#crashSuppressed) return "error";
		if (this.#reconnectGuard) return this.#proc ? "restarting" : "starting";
		if (!this.#proc) return "stopped";
		if (!this.#ready) return "starting";
		if (busy) return "busy";
		if (this.#circuitState !== "closed") return "degraded";
		return "idle";
	}

	async waitForIdle(): Promise<void> {
		await this.#operationTail;
	}

	// ═══════════════════════════════════════════════════════════════
	// Message Forwarding
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Forward a message to OMP and return the assistant's response text.
	 *
	 * Backward-compatible thin wrapper around `forwardWithMeta` — returns just
	 * the formatted `text` field. New callers should prefer `forwardWithMeta`
	 * when they need tool/model/timing metadata for reply formatting.
	 */
	async forward(msg: InboundMessage, session: SessionRecord): Promise<string | null> {
		const meta = await this.forwardWithMeta(msg, session);
		return meta?.text ?? null;
	}

	/**
	 * Forward a message to OMP and return the full agent response metadata.
	 *
	 * Returns `null` for empty inbound text. For circuit-open / not-running /
	 * crash-recovery paths, returns a populated meta with `isFallback: true`
	 * and a localized `text` so the caller's user-facing reply still works
	 * (the caller can choose to suppress status-line chrome via `isFallback`).
	 *
	 * When `handlers` is provided, the bridge fires `onTextDelta` /
	 * `onThinkingDelta` / `onAssistantMessageEnd` / `onAgentEnd` as the
	 * corresponding RPC events arrive. The full `AgentResponseMeta` is
	 * still returned at run end — handlers are for incremental UI, not a
	 * replacement for the meta.
	 */
	async forwardWithMeta(
		msg: InboundMessage,
		session: SessionRecord,
		handlers?: ForwardStreamHandlers,
	): Promise<AgentResponseMeta | null> {
		const { text, images } = this.#extractPrompt(msg);
		if (!text.trim()) {
			logger.debug("Empty message, skipping agent");
			return null;
		}

		const startedAt = Date.now();

		return this.#runExclusive(async () => {
			if (!this.#canAttemptPrompt()) {
				logger.warn("Agent bridge circuit is open", { openedAt: this.#circuitOpenedAt });
				return this.#fallbackMeta(CIRCUIT_OPEN_MESSAGE, startedAt);
			}

			if (!this.isRunning) {
				logger.warn("Agent bridge not running, attempting restart");
				try {
					await this.#spawnAndWaitReady();
				} catch (err) {
					this.#recordPromptFailure();
					return this.#fallbackMeta(`系统错误：${err instanceof Error ? err.message : String(err)}`, startedAt);
				}
			}

			logger.debug("Forwarding to agent", {
				userId: msg.userId,
				conversationId: msg.conversationId,
				messageLength: text.length,
				sessionPath: session.ompSessionPath,
			});

			const timeoutMs = this.#options.timeoutMs ?? 120_000;

			try {
				if (session.ompSessionPath) {
					await this.#switchSession(session.ompSessionPath);
				}
				// switchSession restores session context (including model) from
				// the session file, which overwrites any model set via setModel().
				// Re-apply the pending override so the user's model choice survives.
				if (this.#pendingModelOverride) {
					await this.#sendCommandAndWait(
						"set_model",
						{ provider: this.#pendingModelOverride.provider, modelId: this.#pendingModelOverride.modelId },
						30_000,
					);
				}
				const events = await this.#promptAndWait(text, timeoutMs, handlers, images);
				// The active prompt's `aborted` flag was set by
				// `#resolveActivePromptAsAborted` before the await chain
				// unblocked. By the time we're back here, the pending
				// entry is gone (resolveActivePromptAsAborted deletes it),
				// so we read the flag from the just-resolved events: the
				// abort resolver appends a sentinel "（已停止）" assistant
				// message_end. We could plumb a side-channel, but the
				// sentinel is one extra branch on a cold path and avoids
				// reshaping the resolve signature.
				const aborted = events.some(
					e =>
						e.type === "message_end" &&
						e.message?.role === "assistant" &&
						Array.isArray(e.message.content) &&
						e.message.content.some(c => c.type === "text" && c.text === "（已停止）"),
				);
				const rawResponse = this.#extractAssistantText(events);

				if (!rawResponse) {
					if (this.#abortRequested) {
						logger.debug("Agent returned empty response after abort");
						return this.#fallbackMeta("（已停止）", startedAt, { aborted: true });
					}
					logger.warn("Agent returned empty response");
					return this.#fallbackMeta("（Agent 未返回内容）", startedAt);
				}

				const rawText = rawResponse.trim();
				const formatted = this.#formatResponse(rawText);
				logger.debug("Agent responded", {
					responseLength: formatted.length,
					preview: formatted.slice(0, 100),
				});
				this.#recordPromptSuccess();
				return this.#buildMetaFromEvents(events, rawText, formatted, startedAt, {
					isFallback: false,
					aborted,
				});
			} catch (err) {
				this.#recordPromptFailure();
				if (this.#isCrashError(err)) {
					logger.warn("Agent process crashed, attempting recovery");
					await this.#attemptRecovery();
					return this.#fallbackMeta("系统正在恢复中，请稍后再试。", startedAt);
				}
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Agent bridge failed", { error: message });
				return this.#fallbackMeta(`系统错误：${message}`, startedAt);
			} finally {
				this.#abortRequested = false;
			}
		});
	}

	/**
	 * Execute a plain-text prompt through the agent bridge.
	 *
	 * Unlike forward(), this does not need an InboundMessage or SessionRecord.
	 * It sends the prompt directly to the RPC process and returns the response text.
	 * Used by the cron scheduler to reuse the already-warm agent process.
	 *
	 * When `options.sessionPath` is provided, the bridge switches to that
	 * session before prompting and restores the previously-active session
	 * after the prompt completes. This is what the cron path needs: a cron
	 * task must not pollute the active IM session with its own conversation
	 * state, and the next IM message after the cron tick should land in its
	 * own session again. The whole switch/prompt/restore sequence runs
	 * under the bridge's `#runExclusive` lock, so it is atomic with respect
	 * to other IM traffic sharing the same bridge.
	 *
	 * Throws on failure (no Chinese fallback messages — caller decides error handling).
	 */
	async executePrompt(
		prompt: string,
		options?: { timeoutMs?: number; sessionPath?: string; inactivityMs?: number },
	): Promise<string> {
		if (!prompt.trim()) {
			throw new Error("Empty prompt");
		}

		return this.#runExclusive(async () => {
			if (!this.#canAttemptPrompt()) {
				throw new Error("Agent bridge circuit is open");
			}

			if (!this.isRunning) {
				await this.#spawnAndWaitReady();
			}

			const timeoutMs = options?.timeoutMs ?? this.#options.timeoutMs ?? 120_000;
			// Capture inactivityMs in a stable local; the watchdog closure
			// (setInterval) escapes the if-block below and TS loses the narrowing.
			const inactivityBudgetMs = options?.inactivityMs ?? 0;
			const sessionPath = options?.sessionPath;
			const previousSessionPath = this.#activeSessionPath;

			if (sessionPath) {
				try {
					await this.#switchSession(sessionPath);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Failed to switch to cron session: ${message}`);
				}
			}

			// Per-prompt inactivity watchdog. Wakes up every 500ms and checks
			// the prompt's `lastActivityAt` (bumped on every session event in the
			// reader). On inactivity limit exceeded, sends an abort so the RPC
			// process tries to cancel cleanly, then throws a tagged error.
			// Scoped to this executePrompt call: cleared in `finally`.
			//
			// NB: the watchdog must NOT call `this.abort()` because `abort()`
			// re-acquires `#runExclusive` and the lock is already held by this
			// `executePrompt` — it would deadlock. Instead we inline the abort
			// sequence (send abort command + resolve the active prompt as
			// aborted) using private members. Those private methods don't take
			// the lock, so it's safe to call them from the timer thread.
			let inactivityReason: { idleMs: number; lastEventAt: number } | null = null;
			let watchdog: NodeJS.Timeout | null = null;
			if (inactivityBudgetMs > 0) {
				const POLL_MS = 500;
				let abortInflight: Promise<void> | null = null;
				watchdog = setInterval(() => {
					if (inactivityReason) return; // already triggered
					const activeId = this.#activePromptId;
					if (!activeId) return;
					const active = this.#pendingPrompts.get(activeId);
					if (!active) return;
					const idleMs = Date.now() - active.lastActivityAt;
					if (idleMs < inactivityBudgetMs) return;
					inactivityReason = { idleMs, lastEventAt: active.lastActivityAt };
					if (abortInflight) return;
					abortInflight = (async () => {
						try {
							if (this.isRunning) {
								await this.#sendCommandAndWait("abort", {}, 30_000);
							}
						} catch (err) {
							logger.warn("Inactivity watchdog abort command failed", {
								error: err instanceof Error ? err.message : String(err),
							});
						} finally {
							this.#resolveActivePromptAsAborted();
						}
					})();
				}, POLL_MS);
			}

			try {
				const events = await this.#promptAndWait(prompt, timeoutMs);
				const response = this.#extractAssistantText(events);

				// inactivityReason is mutated by the watchdog's setInterval callback.
				// TS narrows the synchronous read to the declared initial value
				// (`null`), so `if (reason)` becomes `never` for the truthy branch.
				// We use a typed object lookup instead of relying on narrowing.
				const idleInfo = inactivityReason as { idleMs: number; lastEventAt: number } | null;
				if (idleInfo !== null) {
					throw new Error(
						`Agent cron prompt inactive for ${Math.round(idleInfo.idleMs)}ms (limit ${inactivityBudgetMs}ms)`,
					);
				}

				if (!response) {
					throw new Error("Agent returned empty response");
				}

				this.#recordPromptSuccess();
				return response.trim();
			} finally {
				if (watchdog) clearInterval(watchdog);
				// Restore the session that was active before this cron call so the
				// next IM message on this bridge lands back in its own session.
				// Only restore when (a) caller asked for a session switch and
				// (b) there was an actual prior session to restore. If there
				// wasn't, the bridge was idle — leave it on the cron session
				// (it's harmless because the next prompt will switch anyway).
				if (sessionPath && previousSessionPath && previousSessionPath !== this.#activeSessionPath) {
					try {
						await this.#switchSession(previousSessionPath);
					} catch (err) {
						logger.warn("Failed to restore prior session after cron prompt", {
							priorSession: previousSessionPath,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
		});
	}

	#canAttemptPrompt(): boolean {
		if (this.#circuitState !== "open") return true;
		if (Date.now() - this.#circuitOpenedAt >= CIRCUIT_COOLDOWN_MS) {
			this.#circuitState = "half-open";
			return true;
		}
		return false;
	}

	#recordPromptSuccess(): void {
		this.#circuitState = "closed";
		this.#circuitFailures = 0;
		this.#circuitOpenedAt = 0;
	}

	#recordPromptFailure(): void {
		this.#circuitFailures++;
		if (this.#circuitFailures >= CIRCUIT_FAILURE_THRESHOLD || this.#circuitState === "half-open") {
			this.#circuitState = "open";
			this.#circuitOpenedAt = Date.now();
			logger.warn("Agent bridge circuit opened", { failures: this.#circuitFailures });
		}
	}

	/**
	 * Clear the cached active session path so the next `forwardWithMeta`
	 * call re-switches to the session file even if the path hasn't changed.
	 *
	 * Used by the gateway after session rotation: the old jsonl file is
	 * deleted, and the bridge must re-switch so omp loads the (now missing)
	 * file and starts a fresh session at the same path.
	 */
	resetActiveSession(): void {
		this.#activeSessionPath = undefined;
	}

	async switchSession(sessionPath: string): Promise<void> {
		await this.#runExclusive(() => this.#switchSession(sessionPath));
	}

	async abort(): Promise<boolean> {
		if (!this.isRunning) {
			throw new Error("Agent process not running");
		}
		if (!this.#activePromptId && this.#pendingPrompts.size === 0) {
			return false;
		}
		this.#abortRequested = true;
		await this.#sendCommandAndWait("abort", {}, 30_000);
		this.#resolveActivePromptAsAborted();
		return true;
	}

	async #switchSession(sessionPath: string): Promise<void> {
		if (this.#activeSessionPath === sessionPath) return;
		const response = await this.#sendCommandAndWait("switch_session", { sessionPath }, 30_000);
		if (
			response.data &&
			typeof response.data === "object" &&
			"cancelled" in response.data &&
			response.data.cancelled
		) {
			throw new Error(`Switch session cancelled: ${sessionPath}`);
		}
		this.#activeSessionPath = sessionPath;
	}

	// ═══════════════════════════════════════════════════════════════
	// RPC Protocol
	// ═══════════════════════════════════════════════════════════════

	async #spawnAndWaitReady(): Promise<void> {
		if (this.#crashSuppressed) {
			throw new Error("Agent bridge is in ERROR state after repeated crashes");
		}
		if (this.#reconnectGuard) return;
		this.#reconnectGuard = true;

		try {
			if (this.#proc) {
				this.#proc.kill();
				this.#proc = null;
			}
			this.#ready = false;
			this.#activePromptId = undefined;
			this.#activeSessionPath = undefined;

			// Reject any pending prompts
			const error = new Error("Agent bridge restarting");
			for (const pending of this.#pendingPrompts.values()) {
				clearTimeout(pending.timeout);
				pending.reject(error);
			}
			this.#pendingPrompts.clear();
			for (const pending of this.#pendingCommands.values()) {
				clearTimeout(pending.timeout);
				pending.reject(error);
			}
			this.#pendingCommands.clear();

			const ompPath = this.#options.ompPath ?? "omp";
			const args = ["--mode", "rpc"];
			if (this.#options.model) {
				args.push("--model", this.#options.model);
			}

			logger.debug("Spawning agent RPC process", { ompPath, args });

			const proc = Bun.spawn([ompPath, ...args], {
				stdout: "pipe",
				stderr: "pipe",
				stdin: "pipe",
				cwd: this.#options.cwd ?? process.cwd(),
				env: { ...process.env, ...resolveCredentialEnvVars() },
			});

			const stdin = proc.stdin as FileSink;
			if (!stdin || typeof stdin.write !== "function") {
				logger.error("Invalid stdin for agent bridge");
				throw new Error("Failed to initialize agent bridge stdin");
			}

			this.#proc = { pid: proc.pid, kill: () => proc.kill() };
			this.#stdinWriter = {
				write: (data: Uint8Array) => {
					stdin.write(data);
				},
			};

			// Start stdout reader (processes events in real-time, resolving pending prompts)
			this.#stdoutReader = this.#startStdoutReader(proc.stdout as ReadableStream<Uint8Array>);

			// Drain stderr (non-blocking, prevent pipe from filling)
			this.#stderrReader = this.#drainStderr(proc.stderr as ReadableStream<Uint8Array>);

			// Wait for "ready" signal or process exit
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			let settled = false;

			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				proc.kill();
				reject(new Error("Agent RPC process timed out waiting for ready signal"));
			}, 30000);

			// Poll for ready state (stdout reader sets #ready when it sees "ready" event)
			const checkReady = setInterval(() => {
				if (settled) return;
				if (this.#ready) {
					settled = true;
					clearTimeout(timeout);
					clearInterval(checkReady);
					resolve();
				}
			}, 50);

			void proc.exited.then(exitCode => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				clearInterval(checkReady);
				reject(new Error(`Agent RPC process exited with code ${exitCode} before ready`));
			});

			try {
				await promise;
				this.#crashCount = 0;
				logger.debug("Agent RPC process ready", { pid: proc.pid });
				this.#lastError = undefined;
			} catch (err) {
				this.#recordCrash();
				proc.kill();
				this.#proc = null;
				this.#stdinWriter = undefined;
				this.#lastError = err instanceof Error ? err.message : String(err);
				throw err;
			}
		} finally {
			this.#reconnectGuard = false;
		}
	}

	/**
	 * Start async stdout reader that processes incoming JSON lines in real-time.
	 * When it sees an `agent_end` event with a matching prompt ID, it resolves
	 * the corresponding pending promise immediately.
	 */
	async #startStdoutReader(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				let idx = buffer.indexOf("\n");
				while (idx !== -1) {
					const line = buffer.slice(0, idx).trim();
					buffer = buffer.slice(idx + 1);

					if (line) {
						await this.#processRpcLine(line);
					}

					idx = buffer.indexOf("\n");
				}
			}

			// Process remaining buffer
			if (buffer.trim()) {
				await this.#processRpcLine(buffer.trim());
			}
		} catch {
			// Stream error — handle gracefully
		} finally {
			reader.releaseLock();
		}
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		try {
			while (true) {
				const { done } = await reader.read();
				if (done) break;
			}
		} catch {
			// ignore stderr errors
		} finally {
			reader.releaseLock();
		}
	}

	#processRpcLine(line: string): void {
		try {
			const parsed = JSON.parse(line) as AgentEvent;

			if (parsed.type === "ready") {
				this.#ready = true;
				return;
			}

			// Handle extension_ui_request: auto-respond to unblock the agent
			// The bridge is headless and cannot show UI, so we cancel all blocking requests.
			if (parsed.type === "extension_ui_request") {
				const method = (parsed as any).method as string;
				// Blocking methods that require user input: auto-cancel
				if (method === "confirm" || method === "select" || method === "input" || method === "editor") {
					const response: RpcExtensionUIResponse = {
						type: "extension_ui_response",
						id: (parsed as any).id,
						cancelled: true,
						timedOut: true,
					};
					this.#writeToStdin(`${JSON.stringify(response)}\n`);
				}
				// Fire-and-forget methods (notify, setWidget, setStatus, etc.) are ignored
				return;
			}

			// Handle host_tool_call: reject immediately — bridge has no host tools
			if (parsed.type === "host_tool_call") {
				const result: RpcHostToolResult = {
					type: "host_tool_result",
					id: (parsed as any).id,
					result: {
						type: "tool_result",
						tool_use_id: (parsed as any).toolCallId,
						content: [{ type: "text", text: "Host tool not available in gateway mode" }],
					},
					isError: true,
				};
				this.#writeToStdin(`${JSON.stringify(result)}\n`);
				return;
			}

			// Handle command responses: "prompt" response means prompt was submitted
			// These have an id matching the prompt we sent
			if (parsed.type === "response" && (parsed as any).command && (parsed as any).id) {
				const cmdId = (parsed as any).id;
				const command = (parsed as any).command;
				const cmdSuccess = (parsed as any).success;

				if (command === "prompt" && cmdSuccess) {
					// Mark the pending prompt as active (events coming via session.subscribe)
					// Store the reference so we can route subsequent session events to it
					const pending = this.#pendingPrompts.get(cmdId);
					if (pending) {
						pending.events.push(parsed);
						pending.lastActivityAt = Date.now();
						this.#activePromptId = cmdId;
					}
					return;
				}

				const pendingPrompt = this.#pendingPrompts.get(cmdId);
				if (pendingPrompt) {
					clearTimeout(pendingPrompt.timeout);
					this.#pendingPrompts.delete(cmdId);
					pendingPrompt.reject(new Error(parsed.error ?? `RPC command failed: ${command}`));
					return;
				}

				const pendingCommand = this.#pendingCommands.get(cmdId);
				if (pendingCommand) {
					clearTimeout(pendingCommand.timeout);
					this.#pendingCommands.delete(cmdId);
					if (cmdSuccess) {
						pendingCommand.resolve(parsed);
					} else {
						pendingCommand.reject(new Error(parsed.error ?? `RPC command failed: ${command}`));
					}
				}
				return;
			}

			// Handle session events (emitted via session.subscribe, no id field):
			// These include agent_start, agent_end, message_start, message_end, etc.
			// They are routed to the currently active prompt.
			if (!parsed.id && this.#activePromptId) {
				const pending = this.#pendingPrompts.get(this.#activePromptId);
				if (pending) {
					pending.events.push(parsed);
					pending.lastActivityAt = Date.now();

					// Fire streaming handlers. Handlers are synchronous; we
					// never await them. Exceptions are logged and the run
					// continues — a misbehaving handler must not break the
					// bridge's event pump.
					if (pending.handlers) {
						this.#fireStreamHandler(pending, parsed);
					}

					// agent_end event means the current agent turn is complete
					if (parsed.type === "agent_end") {
						clearTimeout(pending.timeout);
						this.#pendingPrompts.delete(this.#activePromptId);
						this.#activePromptId = undefined;
						pending.resolve(pending.events);
					}
				}
			}
		} catch {
			// Non-JSON line — ignore
		}
	}

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
					// toolcall_end carries the final ToolCall on `ame.toolCall`
					// (matching @oh-my-pi/pi-ai AssistantMessageEvent). The
					// bridge's inline `ame` shape is `Record<string, unknown>`
					// so we read via the literal key.
					const tc = (ame as { toolCall?: { id?: string; name?: string; arguments?: unknown } }).toolCall;
					if (tc && typeof tc.id === "string" && typeof tc.name === "string") {
						logger.debug("[AgentBridge] toolcall_end — starting long-task watcher", {
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
					// message_end for tool results carries the full
					// ToolResultMessage inline. The bridge's local
					// `AgentEvent.message` shape only captures the
					// `role` + `content` text, so cast to the richer
					// shape at the boundary (same pattern as
					// `#buildMetaFromEvents`).
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
			logger.warn("AgentBridge stream handler threw", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	#resolveActivePromptAsAborted(): void {
		if (!this.#activePromptId) return;
		const promptId = this.#activePromptId;
		const pending = this.#pendingPrompts.get(promptId);
		if (!pending) return;
		clearTimeout(pending.timeout);
		// Clear long-task watchers: the abort force-resolves the prompt
		// without waiting for the RPC's agent_end (which would normally
		// clear them via the reader loop). Without this, the watcher's
		// setInterval keeps firing onLongTask pings after the user has
		// already stopped the run, re-patching a finished card.
		this.#clearAllLongTaskWatchers(promptId);
		// Mark the pending prompt as aborted BEFORE resolving so
		// `forwardWithMeta` can read the flag in the same microtask
		// the await chain unblocks (the resolve() is sync; the
		// then-handler that calls buildMetaFromEvents is what reads it).
		pending.aborted = true;
		this.#pendingPrompts.delete(promptId);
		this.#activePromptId = undefined;
		pending.resolve([
			...pending.events,
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "（已停止）" }],
				},
			},
			{ type: "agent_end" },
		]);
	}

	async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#operationTail;
		const { promise: current, resolve } = Promise.withResolvers<void>();
		this.#operationTail = previous.catch(() => {}).then(() => current);
		await previous.catch(() => {});
		try {
			return await operation();
		} finally {
			resolve();
		}
	}

	async #sendCommandAndWait(
		command: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
	): Promise<AgentEvent> {
		const commandId = `c_${++this.#commandIdCounter}`;
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent>();
		const timeout = setTimeout(() => {
			this.#pendingCommands.delete(commandId);
			reject(new Error(`Agent RPC command ${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingCommands.set(commandId, { command, resolve, reject, timeout });

		try {
			this.#writeToStdin(`${JSON.stringify({ type: command, id: commandId, ...payload })}\n`);
		} catch (err) {
			clearTimeout(timeout);
			this.#pendingCommands.delete(commandId);
			reject(err instanceof Error ? err : new Error(String(err)));
		}

		return promise;
	}

	async #promptAndWait(
		message: string,
		timeoutMs: number,
		handlers?: ForwardStreamHandlers,
		images?: ImageContent[],
	): Promise<AgentEvent[]> {
		const promptId = `p_${++this.#promptIdCounter}`;

		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();

		const timeout = setTimeout(() => {
			// Clear long-task watchers BEFORE deleting the pending prompt.
			// The watcher's `fire()` closure captures `pending` directly, so
			// even after deletion the setInterval would keep calling the
			// channel's onLongTask handler — re-patching a card that's
			// already being finished with the timeout error, and showing a
			// stale elapsed time (the ping handler's
			// `blocks[blocks.length-1]` check fails once the error answer
			// block is appended, so the stop block text is never updated).
			this.#clearAllLongTaskWatchers(promptId);
			this.#pendingPrompts.delete(promptId);
			reject(new Error(`Agent RPC timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const pending: PendingPrompt = {
			promptId,
			resolve,
			reject,
			events: [],
			timeout,
			aborted: false,
			lastActivityAt: Date.now(),
		};
		if (handlers) pending.handlers = handlers;

		this.#pendingPrompts.set(promptId, pending);

		// Write prompt to stdin with unique id
		const frame = `${JSON.stringify({ type: "prompt", id: promptId, message, ...(images && images.length > 0 ? { images } : {}) })}\n`;
		if (this.#stdinWriter) {
			this.#stdinWriter.write(new TextEncoder().encode(frame));
		} else {
			clearTimeout(timeout);
			this.#pendingPrompts.delete(promptId);
			reject(new Error("Agent process not running"));
		}

		return promise;
	}

	#extractAssistantText(events: AgentEvent[]): string | null {
		const assistantEvents = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
		const last = assistantEvents[assistantEvents.length - 1];
		if (!last?.message?.content) return null;
		const textContent = last.message.content.find(c => c.type === "text");
		return textContent?.text ?? null;
	}

	/**
	 * Build a meta object for a successful agent run by mining the event list
	 * for model, provider, usage, duration, tool calls, and tool results.
	 *
	 * The bridge's inline `AgentEvent.message` is loosely typed (the wire
	 * carries a rich `@oh-my-pi/pi-ai` AssistantMessage / ToolResultMessage,
	 * but the bridge's local interface is a subset). We cast at the boundary
	 * via `as unknown as` so the rest of the function has real types and
	 * `useLiteralKeys` lint passes.
	 */
	#buildMetaFromEvents(
		events: AgentEvent[],
		rawText: string,
		formattedText: string,
		startedAt: number,
		overrides: { isFallback: boolean; error?: string | null; aborted?: boolean } = {
			isFallback: false,
		},
	): AgentResponseMeta {
		const wireEvents = events as unknown as Array<WireEvent>;

		const lastAssistant = lastAssistantMessage(wireEvents);
		const toolResults = collectToolResults(wireEvents);
		const toolCalls = lastAssistant ? collectToolCallsFromAssistant(lastAssistant) : [];

		const model = lastAssistant?.model ?? null;
		const provider = (lastAssistant?.provider as string | undefined) ?? null;
		const agentDurationMs = lastAssistant?.duration ?? null;
		const usage: AgentResponseMeta["usage"] = lastAssistant?.usage ? extractUsage(lastAssistant.usage) : null;

		return {
			text: formattedText,
			rawText,
			model,
			provider,
			usage,
			agentDurationMs,
			taskDurationMs: Date.now() - startedAt,
			effort: null,
			toolCalls,
			toolResults,
			error: overrides.error ?? null,
			aborted: overrides.aborted ?? false,
			isFallback: overrides.isFallback,
		};
	}

	#fallbackMeta(
		text: string,
		startedAt: number,
		overrides: { error?: string | null; aborted?: boolean } = {},
	): AgentResponseMeta {
		return {
			text,
			rawText: text,
			model: null,
			provider: null,
			usage: null,
			agentDurationMs: null,
			taskDurationMs: Date.now() - startedAt,
			effort: null,
			toolCalls: [],
			toolResults: [],
			error: overrides.error ?? null,
			aborted: overrides.aborted ?? false,
			isFallback: true,
		};
	}

	// ═══════════════════════════════════════════════════════════════
	// Crash Recovery
	// ═══════════════════════════════════════════════════════════════

	#isCrashError(err: unknown): boolean {
		if (err instanceof Error) {
			const msg = err.message;
			return msg.includes("exited") || msg.includes("before ready") || msg.includes("not running");
		}
		return false;
	}

	#recordCrash(): void {
		const now = Date.now();
		this.#crashTimestamps.push(now);
		this.#crashTimestamps = this.#crashTimestamps.filter(timestamp => now - timestamp <= CRASH_WINDOW_MS);
		if (this.#crashTimestamps.length > CRASH_WINDOW_LIMIT) {
			this.#crashSuppressed = true;
			this.#ready = false;
			logger.error("Agent bridge entered ERROR state after repeated crashes", {
				crashes: this.#crashTimestamps.length,
			});
			this.#lastError = "Agent bridge entered ERROR state after repeated crashes";
		}
	}

	async #attemptRecovery(): Promise<void> {
		if (this.#crashSuppressed) {
			logger.error("Agent bridge recovery suppressed after repeated crashes", {
				crashes: this.#crashTimestamps.length,
			});
			return;
		}
		const maxRetries = this.#options.maxCrashRetries ?? 3;
		const baseDelay = this.#options.crashBackoffMs ?? 1000;

		if (this.#crashCount >= maxRetries) {
			logger.error("Max crash retries exceeded, giving up", {
				crashCount: this.#crashCount,
				maxRetries,
			});
			return;
		}

		this.#crashCount++;
		const delay = baseDelay * 2 ** (this.#crashCount - 1);
		logger.warn("Agent process crashed, restarting", {
			crashCount: this.#crashCount,
			delayMs: delay,
		});

		if (this.#crashSuppressed) return;
		await Bun.sleep(delay);
		await this.#spawnAndWaitReady();
	}

	// ═══════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════

	/** Write data to the agent's stdin. */
	#writeToStdin(data: string): void {
		if (!this.#stdinWriter) {
			throw new Error("Agent process not running");
		}
		this.#stdinWriter.write(new TextEncoder().encode(data));
	}

	#extractPrompt(msg: InboundMessage): { text: string; images: ImageContent[] } {
		const images: ImageContent[] = [];

		// Extract image attachments for vision-capable models.
		// Use MIME type (not `kind`) because DingTalk sends images as
		// msgtype="file" — the `kind` will be "file" but mimeType will
		// be "image/png" etc. Any attachment whose MIME starts with
		// "image/" is treated as an inline image.
		// PDF attachments get text extracted and included in the prompt.
		const attachmentTexts: string[] = [];
		if (msg.attachments) {
			for (const att of msg.attachments) {
				if (att.mimeType.startsWith("image/")) {
					images.push({
						type: "image",
						data: Buffer.from(att.data).toString("base64"),
						mimeType: att.mimeType,
					});
				} else if (att.mimeType === "application/pdf") {
					const name = att.filename ?? "document.pdf";
					const pdfText = extractPdfText(att.data);
					if (pdfText) {
						attachmentTexts.push(`[PDF: ${name}]
${pdfText.slice(0, 10000)}`);
					} else {
						attachmentTexts.push(`[PDF: ${name} (${formatBytes(att.size)}) — scanned PDF, no extractable text]`);
					}
				}
			}
		}

		// If we extracted text from PDFs, include it in the prompt
		if (attachmentTexts.length > 0) {
			const baseText =
				msg.content.type === "text"
					? msg.content.text
					: msg.content.type === "markdown"
						? msg.content.markdown
						: msg.content.type === "voice" && msg.content.text
							? msg.content.text
							: "";
			return { text: [baseText, ...attachmentTexts].filter(Boolean).join("\n\n"), images };
		}

		if (msg.content.type === "text") return { text: msg.content.text, images };
		if (msg.content.type === "markdown") return { text: msg.content.markdown, images };
		if (msg.content.type === "voice" && msg.content.text) return { text: msg.content.text, images };

		// Video: frames may have been extracted by the gateway media layer
		// (ffmpeg key-frame extraction). If we got image attachments, they're
		// video frames — pass them to the agent with a descriptive label.
		// DingTalk sends videos as msgtype="file" with video extensions.
		const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"];
		const contentFilename = (msg.content as any).filename as string | undefined;
		const isVideoByName =
			contentFilename && VIDEO_EXTENSIONS.some(ext => contentFilename.toLowerCase().endsWith(ext));
		if (msg.content.type === "video" || (msg.content.type === "file" && isVideoByName)) {
			const name = contentFilename ?? "video";
			const size = msg.content.size ? formatBytes(msg.content.size) : "unknown size";
			if (images.length > 0) {
				return {
					text: `[用户发送了视频文件: ${name} (${size})。已从视频中提取 ${images.length} 个关键帧，请基于这些帧分析视频内容。]`,
					images,
				};
			}
			return {
				text: `[用户发送了视频文件: ${name} (${size})。视频帧提取失败，你无法查看视频内容。如果需要分析，请让用户截取关键帧图片重发。]`,
				images,
			};
		}

		// For image/file/video without ASR text, describe the attachment
		if (msg.attachments && msg.attachments.length > 0) {
			const descriptions = msg.attachments.map(att => {
				const name = att.filename ?? "file";
				return `[${att.kind}: ${name} (${att.mimeType}, ${formatBytes(att.size)})]`;
			});
			logger.info("[AgentBridge] Non-text message with attachments", {
				contentType: msg.content.type,
				attachmentCount: msg.attachments.length,
				imageCount: images.length,
				text: descriptions.join("\n"),
			});
			return { text: descriptions.join("\n"), images };
		}

		logger.info("[AgentBridge] Non-text message without attachments — degrading to placeholder", {
			contentType: msg.content.type,
			url: (msg.content as any).url?.slice(0, 80),
			hasAttachments: !!msg.attachments,
		});
		return { text: "[non-text message]", images };
	}

	#formatResponse(text: string): string {
		// Strip think blocks from model response
		const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

		const MAX_LENGTH = 4000;
		const TRUNCATE_NOTICE = "\n\n...(内容已截断，请使用终端查看完整输出)";
		if (cleaned.length <= MAX_LENGTH) return cleaned;
		let cutAt = cleaned.lastIndexOf("\n\n", MAX_LENGTH - TRUNCATE_NOTICE.length);
		if (cutAt < MAX_LENGTH * 0.5) {
			cutAt = cleaned.lastIndexOf("\n", MAX_LENGTH - TRUNCATE_NOTICE.length);
		}
		if (cutAt < MAX_LENGTH * 0.5) {
			cutAt = MAX_LENGTH - TRUNCATE_NOTICE.length;
		}
		return cleaned.slice(0, cutAt) + TRUNCATE_NOTICE;
	}

	// ═══════════════════════════════════════════════════════════════
	// RPC Commands (model management, state queries)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Get available models from the agent via RPC.
	 * Returns an array of model objects with provider, id, contextWindow, reasoning, thinking fields.
	 * Requires the agent process to be running.
	 */
	async getAvailableModels(): Promise<AgentEvent> {
		return this.#runExclusive(async () => {
			if (!this.isRunning) {
				throw new Error("Agent process not running");
			}
			return await this.#sendCommandAndWait("get_available_models", {}, 30_000);
		});
	}

	/**
	 * Switch the agent's active model via RPC.
	 * Returns the model object if successful.
	 * Requires the agent process to be running.
	 */
	async setModel(provider: string, modelId: string): Promise<AgentEvent> {
		return this.#runExclusive(async () => {
			if (!this.isRunning) {
				throw new Error("Agent process not running");
			}
			const response = await this.#sendCommandAndWait("set_model", { provider, modelId }, 30_000);
			if (response.success) {
				this.#pendingModelOverride = { provider, modelId };
			}
			return response;
		});
	}

	/**
	 * Get the agent's current session state via RPC.
	 * Returns model, thinkingLevel, isStreaming, and other state fields.
	 * Requires the agent process to be running.
	 */
	async getState(): Promise<AgentEvent> {
		return this.#runExclusive(async () => {
			if (!this.isRunning) {
				throw new Error("Agent process not running");
			}
			return await this.#sendCommandAndWait("get_state", {}, 30_000);
		});
	}

	/**
	 * Temporarily disable tool toolsets. Used by cron to prevent the agent from
	 * creating sub-tasks, sending messages, or asking clarifying questions.
	 * Pass empty array to restore all tools.
	 */
	async setDisabledToolsets(toolsets: string[]): Promise<void> {
		if (!this.isRunning) return;
		await this.#sendCommandAndWait("set_disabled_toolsets", { toolsets }, 30_000);
	}
}

// ═════════════════════════════════════════════════════════════════════
// Type-guarded event extraction
// ═════════════════════════════════════════════════════════════════════

/**
 * Wire-shape RPC event carrying a rich `@oh-my-pi/pi-ai` message. The bridge's
 * public `AgentEvent` type is narrower on purpose; these helpers cast at the
 * boundary so the rest of the code uses real types.
 */
type WireMessage = AssistantMessage | ToolResultMessage | { role: string; [k: string]: unknown };
type WireEvent = { type: string; message?: WireMessage; [k: string]: unknown };

function lastAssistantMessage(events: WireEvent[]): AssistantMessage | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev.type !== "message_end") continue;
		const msg = ev.message;
		if (msg && msg.role === "assistant") return msg as AssistantMessage;
	}
	return undefined;
}

function collectToolResults(events: WireEvent[]): AgentResponseToolResult[] {
	const out: AgentResponseToolResult[] = [];
	for (const ev of events) {
		if (ev.type !== "message_end") continue;
		const msg = ev.message;
		if (!msg || msg.role !== "toolResult") continue;
		const tr = msg as ToolResultMessage;
		out.push({
			id: tr.toolCallId,
			name: tr.toolName,
			isError: tr.isError === true,
		});
	}
	return out;
}

function collectToolCallsFromAssistant(assistant: AssistantMessage): AgentResponseToolCall[] {
	const out: AgentResponseToolCall[] = [];
	for (const item of assistant.content) {
		if (item.type !== "toolCall") continue;
		const tc = item as ToolCall;
		out.push({
			id: tc.id,
			name: tc.name,
			args: tc.arguments ?? null,
		});
	}
	return out;
}

function extractUsage(usage: Usage): NonNullable<AgentResponseMeta["usage"]> {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
	};
}
