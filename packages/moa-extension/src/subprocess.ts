import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createActivityTimeout } from "./activity-timeout";
import { extractResearchUrls } from "./tco";
import {
	createWebSearchToolBudget,
	RESEARCH_EARLY_SOFT_ABORT_MS,
	RESEARCH_ENOUGH_URLS,
	RESEARCH_SOFT_ABORT_MS,
} from "./tool-budget";

/**
 * Out-of-process moa worker / synthesis spawn.
 *
 * Aligned with pi-fusion 0.8.0 (extensions/pi-fusion/fusion.ts:737-745):
 *   - Workers run as `omp --mode json -p --no-session` subprocesses
 *   - `PI_FUSION_SUBAGENT=1` env prevents recursive fusion
 *   - Output is captured from stdout JSONL, never written to the main
 *     session log
 *
 * The single difference: pi-fusion uses `--append-system-prompt @file` to
 * inject the worker's system prompt, since the OMP CLI does not load a
 * dynamic agent from a temp path. We use the same approach so that workers
 * stay stateless and the main session log never sees worker tool calls.
 */

export interface SpawnWorkerInput {
	cwd: string;
	/** OMP model string (e.g. "sonnet", "p-openai/gpt-5.2"). Undefined = use default. */
	model?: string;
	/** OMP thinking level (off/minimal/low/medium/high/xhigh). */
	thinkingLevel?: string;
	/** Tool list to scope the worker to. "all" = use OMP defaults, "none" = no tools. */
	tools: string[] | "all" | "none";
	/** Worker system prompt. */
	systemPrompt: string;
	/** The user task to send as the message. */
	task: string;
	/** Abort signal forwarded to the subprocess. */
	signal?: AbortSignal;
	/** Extra env vars merged on top of `process.env`. */
	env?: Record<string, string>;
	/** Per-worker timeout in ms. Default: 10 minutes. */
	timeoutMs?: number;
	/**
	 * Idle (no-progress) timeout in ms. Reset on streaming / tool progress.
	 * 0 or unset = disabled. Only used by engines that support activity tracking.
	 */
	idleTimeoutMs?: number;
	/**
	 * Soft/hard budget on `web_search` starts (research stage).
	 * 0 or unset = unlimited. Non-search tools do not count unless
	 * `countAllTools` is true (plan-worker round caps).
	 */
	maxToolRounds?: number;
	/**
	 * When true, every tool start counts toward `maxToolRounds` (plan workers).
	 * Default false → only `web_search` counts (research stage).
	 */
	countAllTools?: boolean;
	/**
	 * Streaming callback (once-right P5). Invoked with the cumulative
	 * assistant text so far as `message_update` / `message_end` events arrive
	 * on the JSONL stdout stream. Optional — existing callers unchanged.
	 */
	onPartial?: (partial: { text: string }) => void;
	/** Research progress: fired on each `web_search` start (`count` / `max`). */
	onWebSearch?: (info: { count: number; max: number }) => void;
	/**
	 * Soft-stop after this many web_search starts (research). When set below
	 * maxToolRounds, further searches soft-trip then hard-abort.
	 */
	earlyStopAt?: number;
	/** Soft window ms when earlyStopAt trips (defaults to RESEARCH_EARLY_SOFT_ABORT_MS). */
	earlySoftAbortMs?: number;
	/** Captures tool result text for research salvage when the model emits no pack. */
	onToolResult?: (info: { toolName: string; resultText: string }) => void;
	/**
	 * When true (plan workers after Research), block `read` of http(s) URLs so
	 * workers cannot re-fetch pages already covered by research_pack.
	 */
	blockRemoteReads?: boolean;
}

export interface WorkerOutput {
	ok: boolean;
	output: string;
	stderr: string;
	exitCode: number | null;
	aborted: boolean;
	timedOut: boolean;
	/** True when the kill was due to idleTimeoutMs (no progress), not hard timeout. */
	idleTimedOut?: boolean;
	/** True when aborted because maxToolRounds was exceeded. */
	toolBudgetExceeded?: boolean;
	/** Concatenated tool_execution_end payloads (research salvage). */
	toolTraceText?: string;
	model?: string;
	stopReason?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	durationMs: number;
}

const MOA_SUBAGENT_ENV = "PI_MOA_SUBAGENT";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

interface AssistantLike {
	role: "assistant";
	content: Array<{ type: string; text?: string }>;
	model?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number };
	};
	stopReason?: string;
}

interface MessageEndEvent {
	type: "message_end";
	message: AssistantLike;
}

interface AgentEndEvent {
	type: "agent_end";
	messages: AssistantLike[];
}

type WorkerEvent = { type: string; [key: string]: unknown } | MessageEndEvent | AgentEndEvent;

function formatToolResultText(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return result.slice(0, 12_000);
	try {
		return JSON.stringify(result).slice(0, 12_000);
	} catch {
		return String(result).slice(0, 12_000);
	}
}

function isAssistantMessage(value: unknown): value is AssistantLike {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { role?: unknown };
	return candidate.role === "assistant";
}

function buildEnv(input: Pick<SpawnWorkerInput, "env">): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) out[k] = v;
	}
	// Prevent recursive moa in worker subprocesses.
	out[MOA_SUBAGENT_ENV] = "1";
	if (input.env) {
		for (const [k, v] of Object.entries(input.env)) out[k] = v;
	}
	return out;
}

function buildArgs(input: SpawnWorkerInput, systemPromptPath: string, taskPath: string): string[] {
	const args: string[] = [];
	// OMP binary selection:
	//   - $MOA_OMP_BIN allows the user / test harness to override (e.g. for dev
	//     runs that want `bun --cwd=packages/coding-agent src/cli.ts`).
	//   - Otherwise prefer `omp` from PATH.
	// The CLI args below are appended after the binary.
	args.push("--mode", "json", "-p", "--no-session", "--no-lsp");
	if (input.model) args.push("--model", input.model);
	if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
	if (input.tools === "none") {
		args.push("--no-tools");
	} else if (input.tools !== "all") {
		args.push("--tools", input.tools.join(","));
	}
	args.push(`--append-system-prompt`, `@${systemPromptPath}`);
	args.push(`@${taskPath}`);
	return args;
}

function pickOmpBin(): string {
	return process.env.MOA_OMP_BIN ?? Bun.which("omp") ?? "omp";
}

function assembleOmpCommand(input: SpawnWorkerInput, systemPromptPath: string, taskPath: string): string[] {
	const bin = pickOmpBin();
	const argv = buildArgs(input, systemPromptPath, taskPath);
	// If the user pointed MOA_OMP_BIN at a binary that needs extra argv
	// (e.g. `bun --cwd=packages/coding-agent src/cli.ts`), allow space-
	// separated splitting. Otherwise it's a single binary path.
	if (bin.includes(" ")) {
		return [...bin.split(/\s+/), ...argv];
	}
	return [bin, ...argv];
}

async function writeTempFile(content: string, prefix: string, suffix: string): Promise<string> {
	const dir = path.join(os.tmpdir(), "moa-extension");
	await Bun.write(path.join(dir, ".keep"), "").catch(() => {});
	const filePath = path.join(dir, `${prefix}-${Date.now()}-${randomBytes(6).toString("hex")}${suffix}`);
	await Bun.write(filePath, content);
	return filePath;
}

async function safeUnlink(p: string): Promise<void> {
	try {
		const file = Bun.file(p);
		if (await file.exists()) await Bun.$`rm -f ${p}`.quiet();
	} catch {
		// best-effort cleanup; ignore failures
	}
}

async function readStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let result = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) result += decoder.decode(value, { stream: true });
	}
	result += decoder.decode();
	return result;
}

function extractAssistantText(message: unknown): string {
	if (!isAssistantMessage(message)) return "";
	return message.content
		.filter(part => part && part.type === "text" && typeof part.text === "string")
		.map(part => part.text ?? "")
		.join("")
		.trim();
}

/** Mutable accumulator for streaming JSONL events. */
export interface WorkerStreamState {
	text: string;
}

/**
 * Apply one parsed JSONL worker event to the stream state. Pure enough for
 * unit tests: updates `state.text` and invokes `onPartial` when the
 * cumulative assistant text changes.
 */
export function applyWorkerStreamEvent(
	event: WorkerEvent | { type: string; [key: string]: unknown },
	state: WorkerStreamState,
	onPartial?: (text: string) => void,
): void {
	if (!onPartial) return;
	if (event.type === "message_update" || event.type === "message_end") {
		const text = extractAssistantText((event as { message?: unknown }).message);
		if (text && text !== state.text) {
			state.text = text;
			onPartial(text);
		}
	}
}

/**
 * Read a stdout stream as UTF-8, invoking `onLine` for each complete line
 * (streaming). Returns the full concatenated string (same as readStreamToString).
 */
async function readStreamLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let result = "";
	let pending = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		const chunk = decoder.decode(value, { stream: true });
		result += chunk;
		pending += chunk;
		for (;;) {
			const nl = pending.indexOf("\n");
			if (nl < 0) break;
			const line = pending.slice(0, nl);
			pending = pending.slice(nl + 1);
			onLine(line);
		}
	}
	result += decoder.decode();
	if (pending.length > 0) onLine(pending);
	return result;
}

function extractOutput(events: WorkerEvent[]): {
	output: string;
	model?: string;
	stopReason?: string;
	usage: WorkerOutput["usage"];
} {
	let output = "";
	let model: string | undefined;
	let stopReason: string | undefined;
	let lastUsage: WorkerOutput["usage"] | undefined;
	let turns = 0;

	for (const event of events) {
		if (event.type === "message_end" && isAssistantMessage(event.message)) {
			turns += 1;
			const text = event.message.content
				.filter(part => part && part.type === "text" && typeof part.text === "string")
				.map(part => part.text ?? "")
				.join("\n");
			if (text.trim().length > 0) {
				output = text;
				model = event.message.model;
				stopReason = event.message.stopReason;
			}
			if (event.message.usage) {
				lastUsage = {
					input: event.message.usage.input,
					output: event.message.usage.output,
					cacheRead: event.message.usage.cacheRead,
					cacheWrite: event.message.usage.cacheWrite,
					cost: event.message.usage.cost.total,
					turns: 0,
				};
			}
		} else if (event.type === "agent_end" && Array.isArray(event.messages)) {
			for (const msg of event.messages) {
				if (isAssistantMessage(msg) && msg.usage) {
					lastUsage = {
						input: msg.usage.input,
						output: msg.usage.output,
						cacheRead: msg.usage.cacheRead,
						cacheWrite: msg.usage.cacheWrite,
						cost: msg.usage.cost.total,
						turns: 0,
					};
				}
			}
		}
	}

	return {
		output,
		model,
		stopReason,
		usage: lastUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns },
	};
}

function parseJsonl(stdout: string): WorkerEvent[] {
	const events: WorkerEvent[] = [];
	const lines = stdout.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as WorkerEvent);
		} catch {
			// Tolerate non-JSONL noise (shouldn't happen with --mode json).
		}
	}
	return events;
}

/**
 * Spawn a single moa worker / synthesis as an OMP subprocess with
 * `--no-session`. The subprocess writes no session log and never pollutes
 * the parent's session. The full assistant text + usage is captured from
 * the subprocess's stdout JSONL stream.
 */
export async function spawnMoaWorker(input: SpawnWorkerInput): Promise<WorkerOutput> {
	const startTime = Date.now();
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const systemPromptPath = await writeTempFile(input.systemPrompt, "moa-system", ".md");
	const taskPath = await writeTempFile(input.task, "moa-task", ".md");

	const cmd = assembleOmpCommand(input, systemPromptPath, taskPath);
	const env = buildEnv(input);

	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let timedOut = false;
	let idleTimedOut = false;
	let toolBudgetExceeded = false;
	let activity: ReturnType<typeof createActivityTimeout> | undefined;
	let toolBudget: ReturnType<typeof createWebSearchToolBudget> | undefined;

	try {
		proc = Bun.spawn(cmd, {
			cwd: input.cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});

		const killProc = () => {
			try {
				proc?.kill("SIGTERM");
			} catch {
				// ignore
			}
		};

		activity = createActivityTimeout({
			timeoutMs,
			idleTimeoutMs: input.idleTimeoutMs ?? 0,
			onAbort: () => {
				timedOut = true;
				idleTimedOut = activity?.idleTimedOut ?? false;
				killProc();
			},
		});

		if (input.signal) {
			const onAbort = () => killProc();
			if (input.signal.aborted) onAbort();
			else input.signal.addEventListener("abort", onAbort, { once: true });
		}

		const streamState: WorkerStreamState = { text: "" };
		const maxToolRounds = Math.max(0, Math.floor(input.maxToolRounds ?? 0));
		const earlyStopAt = Math.max(0, Math.floor(input.earlyStopAt ?? 0));
		const toolTraceParts: string[] = [];
		const evidenceUrls = new Set<string>();
		toolBudget = createWebSearchToolBudget({
			maxWebSearches: maxToolRounds,
			earlyStopAt: earlyStopAt > 0 ? earlyStopAt : undefined,
			softAbortMs: RESEARCH_SOFT_ABORT_MS,
			earlySoftAbortMs: input.earlySoftAbortMs ?? RESEARCH_EARLY_SOFT_ABORT_MS,
			countedTool: input.countAllTools ? "*" : "web_search",
			onSoftAbort: () => {
				toolBudgetExceeded = true;
				killProc();
			},
			onWebSearch: input.onWebSearch,
		});
		const onLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const event = JSON.parse(trimmed) as WorkerEvent;
				activity?.bump();
				if (event.type === "tool_execution_start") {
					const toolName = typeof event.toolName === "string" ? event.toolName : "";
					const decision = toolBudget?.onToolStart(toolName) ?? "ok";
					if (decision === "soft_trip") {
						toolBudgetExceeded = true;
					} else if (decision === "hard_abort") {
						toolBudgetExceeded = true;
						killProc();
					}
				}
				if (event.type === "tool_execution_end") {
					const toolName = typeof event.toolName === "string" ? event.toolName : "";
					const resultText = formatToolResultText((event as { result?: unknown }).result);
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
				if (input.onPartial) {
					applyWorkerStreamEvent(event, streamState, text => input.onPartial!({ text }));
				}
			} catch {
				// Tolerate non-JSONL noise.
			}
		};

		const [stdout, stderr, exitCode] = await Promise.all([
			readStreamLines(proc.stdout as unknown as ReadableStream<Uint8Array>, onLine),
			readStreamToString(proc.stderr as unknown as ReadableStream<Uint8Array>),
			proc.exited,
		]);

		const events = parseJsonl(stdout);
		const { output, model, stopReason, usage } = extractOutput(events);
		let stderrOut = stderr;
		if (toolBudgetExceeded) {
			const note = input.countAllTools
				? `plan worker tool budget exceeded after ${maxToolRounds} tool calls`
				: `research web_search budget exceeded after ${maxToolRounds} searches`;
			stderrOut = stderrOut.trim() ? `${stderrOut.trim()}\n(${note})` : note;
		} else if (idleTimedOut) {
			stderrOut = stderrOut.trim()
				? `${stderrOut.trim()}\n(idle timeout: no progress)`
				: "idle timeout: no progress";
		}

		return {
			ok: exitCode === 0 && output.trim().length > 0,
			output,
			stderr: stderrOut,
			exitCode,
			aborted: input.signal?.aborted ?? false,
			timedOut,
			idleTimedOut,
			toolBudgetExceeded,
			toolTraceText: toolTraceParts.length > 0 ? toolTraceParts.join("\n\n") : undefined,
			model,
			stopReason,
			usage,
			durationMs: Date.now() - startTime,
		};
	} finally {
		toolBudget?.dispose();
		activity?.dispose();
		await safeUnlink(systemPromptPath);
		await safeUnlink(taskPath);
	}
}
