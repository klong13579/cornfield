import type { AssistantMessage, TextContent } from "@cornfield/ai";
import {
	type AgentSession,
	type AuthStorage,
	createAgentSession,
	type ModelRegistry,
	SessionManager,
	type Settings,
} from "@cornfield/coding-agent";
import { untilAborted } from "@cornfield/utils";
import { createActivityTimeout } from "./activity-timeout";
import { createBlockRemoteReadExtension } from "./block-remote-read";
import { type SpawnWorkerInput, spawnMoaWorker, type WorkerOutput } from "./subprocess";
import { extractResearchUrls } from "./tco";
import {
	createWebSearchToolBudget,
	RESEARCH_EARLY_SOFT_ABORT_MS,
	RESEARCH_ENOUGH_URLS,
	RESEARCH_SOFT_ABORT_MS,
} from "./tool-budget";
import type { MoaWorkerExecutionMode } from "./types";

// ----------------------------------------------------------------------------
// Shared context passed to every engine
// ----------------------------------------------------------------------------

export interface WorkerEngineSharedContext {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
}

// ----------------------------------------------------------------------------
// Engine seam — one adapter per execution mode
// ----------------------------------------------------------------------------

export interface MoaWorkerEngine {
	execute(input: SpawnWorkerInput): Promise<WorkerOutput>;
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

export function createWorkerEngine(mode: MoaWorkerExecutionMode, shared: WorkerEngineSharedContext): MoaWorkerEngine {
	switch (mode) {
		case "subprocess":
			return new SubprocessWorkerEngine();
		case "in-process":
			return new InProcessWorkerEngine(shared);
	}
}

// ----------------------------------------------------------------------------
// Subprocess adapter — delegates to existing spawnMoaWorker, unchanged
// ----------------------------------------------------------------------------

class SubprocessWorkerEngine implements MoaWorkerEngine {
	async execute(input: SpawnWorkerInput): Promise<WorkerOutput> {
		return spawnMoaWorker(input);
	}
}

// ----------------------------------------------------------------------------
// In-process adapter — creates an AgentSession in the current process
// ----------------------------------------------------------------------------

/**
 * Read-only tool set enforced by the in-process engine.
 *
 * Previously declared but never applied (dead code). Now actually wired into
 * `toolNames` so the "in-process = read-only" contract from
 * `extension.ts:status note` holds. Subprocess mode is unchanged.
 */
export const IN_PROCESS_TOOLS = ["read", "search", "find", "web_search", "ast_grep"] as const;

const IN_PROCESS_TOOL_SET: ReadonlySet<string> = new Set(IN_PROCESS_TOOLS);

/**
 * Resolve the in-process tool allow-list.
 *
 * - `"none"` → ephemeral (no tools)
 * - `"all"` → full `IN_PROCESS_TOOLS` (read-only ceiling)
 * - explicit list → **intersection** with `IN_PROCESS_TOOLS` (never escalate;
 *   also never re-add tools the caller deliberately omitted — e.g. Phase 7
 *   strips `web_search` after the Research stage)
 */
export function resolveInProcessToolNames(tools: SpawnWorkerInput["tools"]): string[] {
	if (tools === "none") return [];
	if (tools === "all" || tools === undefined) return [...IN_PROCESS_TOOLS];
	return tools.filter(t => IN_PROCESS_TOOL_SET.has(t));
}

const DISPOSE_TIMEOUT_MS = 5_000;

class InProcessWorkerEngine implements MoaWorkerEngine {
	readonly #shared: WorkerEngineSharedContext;

	constructor(shared: WorkerEngineSharedContext) {
		this.#shared = shared;
	}

	async execute(input: SpawnWorkerInput): Promise<WorkerOutput> {
		const startTime = Date.now();
		const timeoutMs = input.timeoutMs ?? 10 * 60_000;

		// Merge external signal with hard + idle timeout controllers.
		const abortController = new AbortController();
		let timedOut = false;
		let idleTimedOut = false;
		let toolBudgetExceeded = false;
		let toolBudget: ReturnType<typeof createWebSearchToolBudget> | undefined;
		const toolTraceParts: string[] = [];
		const evidenceUrls = new Set<string>();

		if (input.signal) {
			if (input.signal.aborted) {
				abortController.abort();
			} else {
				input.signal.addEventListener("abort", () => abortController.abort(), { once: true });
			}
		}

		const activity = createActivityTimeout({
			timeoutMs,
			idleTimeoutMs: input.idleTimeoutMs ?? 0,
			onAbort: () => {
				timedOut = true;
				idleTimedOut = activity.idleTimedOut;
				try {
					abortController.abort();
				} catch {
					// ignore — abort may already be settled
				}
			},
		});

		const signal = abortController.signal;

		// Tool set: enforce read-only ceiling via intersection with
		// IN_PROCESS_TOOLS. Explicit allow-lists are honored (so Phase 7 can
		// strip web_search); unknown/side-effect tools are never escalated in.
		// `tools: "none"` runs an ephemeral turn with no tools.
		const toolNames = resolveInProcessToolNames(input.tools);
		const ephemeral = toolNames.length === 0;
		const maxToolRounds = Math.max(0, Math.floor(input.maxToolRounds ?? 0));
		const earlyStopAt = Math.max(0, Math.floor(input.earlyStopAt ?? 0));
		toolBudget = createWebSearchToolBudget({
			maxWebSearches: maxToolRounds,
			earlyStopAt: earlyStopAt > 0 ? earlyStopAt : undefined,
			softAbortMs: RESEARCH_SOFT_ABORT_MS,
			earlySoftAbortMs: input.earlySoftAbortMs ?? RESEARCH_EARLY_SOFT_ABORT_MS,
			countedTool: input.countAllTools ? "*" : "web_search",
			onSoftAbort: () => {
				toolBudgetExceeded = true;
				try {
					abortController.abort();
				} catch {
					// ignore
				}
			},
			onWebSearch: input.onWebSearch,
		});

		// Settings isolation: not implemented.
		// The swarm executor isolates settings via `createSubagentSettings`
		// to defend against in-session mutations. moa in-process mode runs
		// with `disableExtensionDiscovery: true` + `IN_PROCESS_TOOLS` (no
		// bash/python/async), so there is no code path in the worker session
		// that can mutate settings. Isolation is defensive, not a known fix.
		// If we ever expand IN_PROCESS_TOOLS to include side-effect tools,
		// revisit and import the schema to do a full snapshot.
		const isolatedSettings = this.#shared.settings;

		// Usage accumulator: subscribe to message_end events across the full
		// run. Previously only the last assistant message was captured and
		// `turns` was hardcoded to 1, which made multi-turn worker traces
		// under-report cost and turns in MoaTraceDetails.
		const usage: WorkerOutput["usage"] = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		};
		let lastAssistant: AssistantMessage | undefined;
		let lastErrorMessage: string | undefined;
		let lastStopReason: string | undefined;

		const recordAssistant = (msg: AssistantMessage | undefined) => {
			if (msg?.role !== "assistant") return;
			lastAssistant = msg;
			lastStopReason = msg.stopReason;
			if (msg.errorMessage) lastErrorMessage = msg.errorMessage;
		};

		const accumulateUsage = (msg: AssistantMessage | undefined) => {
			if (msg?.role !== "assistant") return;
			usage.turns += 1;
			const u = msg.usage;
			if (u) {
				usage.input += u.input ?? 0;
				usage.output += u.output ?? 0;
				usage.cacheRead += u.cacheRead ?? 0;
				usage.cacheWrite += u.cacheWrite ?? 0;
				usage.cost += readCost(u.cost);
			}
		};

		const eventFilter = (e: { type: string; [k: string]: unknown }) => {
			activity.bump();
			if (e.type === "tool_execution_start") {
				const toolName = typeof e.toolName === "string" ? e.toolName : "";
				const decision = toolBudget?.onToolStart(toolName) ?? "ok";
				if (decision === "soft_trip") {
					toolBudgetExceeded = true;
				} else if (decision === "hard_abort") {
					toolBudgetExceeded = true;
					try {
						abortController.abort();
					} catch {
						// ignore
					}
				}
			}
			if (e.type === "tool_execution_end") {
				const toolName = typeof e.toolName === "string" ? e.toolName : "";
				const resultText = formatInProcessToolResult(e.result);
				if (resultText) {
					toolTraceParts.push(`[${toolName}]\n${resultText}`);
					input.onToolResult?.({ toolName, resultText });
					// Only web_search evidence counts — plan workers may read docs with URLs.
					if (toolName.trim() === "web_search") {
						for (const url of extractResearchUrls(resultText)) evidenceUrls.add(url);
						if (evidenceUrls.size >= RESEARCH_ENOUGH_URLS) {
							toolBudget?.signalEnoughEvidence();
							if (toolBudget?.exceeded) toolBudgetExceeded = true;
						}
					}
				}
			}
			if (e.type === "message_update") {
				const msg = (e as { message?: AssistantMessage }).message;
				if (msg && input.onPartial) {
					const text = extractText(msg);
					if (text) input.onPartial({ text });
				}
			} else if (e.type === "message_end") {
				const msg = (e as { message?: AssistantMessage }).message;
				recordAssistant(msg);
				accumulateUsage(msg);
				if (msg && input.onPartial) {
					const text = extractText(msg);
					if (text) input.onPartial({ text });
				}
			} else if (e.type === "agent_end") {
				// agent_end re-emits the assistant messages already counted in
				// message_end. The swarm executor uses both events for the same
				// purpose (text extraction from message_end + final fallback
				// from agent_end), but accumulates usage only from message_end.
				// Mirroring that prevents double-counting when both fire for
				// the same message.
				const messages = (e as { messages?: AssistantMessage[] }).messages;
				if (Array.isArray(messages)) {
					for (const m of messages) recordAssistant(m);
				}
			}
		};

		let session: AgentSession | undefined;
		let unsubscribe: (() => void) | null = null;

		try {
			const { session: created } = await createAgentSession({
				cwd: this.#shared.cwd,
				authStorage: this.#shared.authStorage,
				modelRegistry: this.#shared.modelRegistry,
				settings: isolatedSettings,
				modelPattern: input.model,
				thinkingLevel: input.thinkingLevel as any,
				systemPrompt: input.systemPrompt
					? (defaultPrompt: string) => `${defaultPrompt}\n\n${input.systemPrompt}`
					: undefined,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skills: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				hasUI: false,
				toolNames,
				extensions: input.blockRemoteReads ? [createBlockRemoteReadExtension()] : undefined,
				// Propagate subagent metadata for session log / agent registry
				// traceability. In-memory session writes no JSONL, but these
				// fields still flow into AgentRegistry and event payloads.
				parentTaskPrefix: "moa-worker",
				taskDepth: 1,
				agentDisplayName: "moa-worker",
			});
			session = created;

			// createAgentSession leaves model unset when modelPattern does not
			// resolve (no fallback when an explicit pattern was requested). Surface
			// a clear config error instead of the generic "No model selected" from
			// AgentSession.prompt — typical cause: stale moa.yml model ids.
			if (!session.model) {
				const pattern = input.model?.trim() || "(default)";
				return {
					ok: false,
					output: "",
					stderr:
						`Model not found for pattern "${pattern}". ` +
						`Check moa.yml worker/synthesis model strings against the registry ` +
						`(e.g. /model list). alibaba-coding-plan currently has no deepseek-v4-* ids.`,
					exitCode: null,
					aborted: signal.aborted,
					timedOut: false,
					model: input.model,
					stopReason: "error",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					durationMs: Date.now() - startTime,
				};
			}

			// Connect external timeout/abort to the agent session. Without this,
			// session.prompt() (full agent loop with tools) ignores the external
			// AbortController — the worker could hang past its timeout.
			signal.addEventListener("abort", () => session!.abort(), { once: true });

			unsubscribe = session.subscribe(eventFilter);

			if (ephemeral) {
				// Single LLM call, no tool loop, no event subscription needed.
				// `runEphemeralTurn` does NOT emit `message_end`, so we must
				// call `accumulateUsage` manually here — otherwise the
				// discovery / rewrite / synthesis stages report 0 input /
				// output / cost / turns, which silently breaks cost attribution
				// in `MoaTraceDetails`. One assistant message, one accumulation,
				// no double-count risk.
				const result = await session.runEphemeralTurn({
					promptText: input.task,
					signal,
				});
				const ephemeralMessage = result.assistantMessage as AssistantMessage;
				recordAssistant(ephemeralMessage);
				accumulateUsage(ephemeralMessage);
			} else {
				await session.prompt(input.task, { attribution: "agent" });
				// waitForIdle ensures all trailing tool_execution_end /
				// message_end events have fired before we read state. Without
				// this, the lastAssistant capture above can race the agent
				// loop's final turn.
				await session.waitForIdle();
			}

			const output = lastAssistant ? extractText(lastAssistant) : "";
			const exitCode = resolveExitCode(lastStopReason);
			let stderr = lastErrorMessage ?? "";
			if (toolBudgetExceeded) {
				const note = input.countAllTools
					? `plan worker tool budget exceeded after ${maxToolRounds} tool calls`
					: `research web_search budget exceeded after ${maxToolRounds} searches`;
				stderr = stderr.trim() ? `${stderr.trim()}\n(${note})` : note;
			} else if (idleTimedOut) {
				const note = "idle timeout: no progress";
				stderr = stderr.trim() ? `${stderr.trim()}\n(${note})` : note;
			}

			return {
				ok: output.trim().length > 0,
				output,
				stderr,
				exitCode,
				aborted: signal.aborted,
				timedOut,
				idleTimedOut,
				toolBudgetExceeded,
				toolTraceText: toolTraceParts.length > 0 ? toolTraceParts.join("\n\n") : undefined,
				model: lastAssistant?.model,
				stopReason: lastStopReason,
				usage,
				durationMs: Date.now() - startTime,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				output: "",
				stderr: message,
				exitCode: null,
				aborted: signal.aborted,
				timedOut,
				idleTimedOut,
				toolBudgetExceeded,
				toolTraceText: toolTraceParts.length > 0 ? toolTraceParts.join("\n\n") : undefined,
				model: input.model,
				stopReason: "error",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				durationMs: Date.now() - startTime,
			};
		} finally {
			toolBudget?.dispose();
			activity.dispose();
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// best-effort cleanup
				}
				unsubscribe = null;
			}
			if (session) {
				try {
					// Bound the cleanup so a stuck session can't hang the
					// whole moa run. Mirrors swarm's `runSubprocess` dispose
					// contract.
					await untilAborted(AbortSignal.timeout(DISPOSE_TIMEOUT_MS), () => session!.dispose());
				} catch {
					// best-effort cleanup; ignore timeout/cancel
				}
			}
		}
	}
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function formatInProcessToolResult(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return result.slice(0, 12_000);
	try {
		return JSON.stringify(result).slice(0, 12_000);
	} catch {
		return String(result).slice(0, 12_000);
	}
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("")
		.trim();
}

function readCost(cost: unknown): number {
	if (typeof cost === "number" && Number.isFinite(cost)) return cost;
	if (cost && typeof cost === "object") {
		const total = (cost as { total?: unknown }).total;
		if (typeof total === "number" && Number.isFinite(total)) return total;
	}
	return 0;
}

function resolveExitCode(stopReason: string | undefined): number {
	// "stop" = natural finish (the LLM emitted text and stopped).
	// "aborted" = external signal or timeout aborted the run.
	// "error" = the provider / transport errored.
	// "tool_calls" / "length" / "max_steps" / unknown: treat as success if
	// the assistant produced content; the caller has the raw output to
	// decide what to do.
	if (stopReason === "aborted" || stopReason === "error") return 1;
	return 0;
}
