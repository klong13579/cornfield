import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

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
}

export interface WorkerOutput {
	ok: boolean;
	output: string;
	stderr: string;
	exitCode: number | null;
	aborted: boolean;
	timedOut: boolean;
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
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;

	try {
		proc = Bun.spawn(cmd, {
			cwd: input.cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});

		timeoutHandle = setTimeout(() => {
			timedOut = true;
			try {
				proc?.kill("SIGTERM");
			} catch {
				// ignore
			}
		}, timeoutMs);

		if (input.signal) {
			const onAbort = () => {
				try {
					proc?.kill("SIGTERM");
				} catch {
					// ignore
				}
			};
			if (input.signal.aborted) onAbort();
			else input.signal.addEventListener("abort", onAbort, { once: true });
		}

		const [stdout, stderr, exitCode] = await Promise.all([
			readStreamToString(proc.stdout as unknown as ReadableStream<Uint8Array>),
			readStreamToString(proc.stderr as unknown as ReadableStream<Uint8Array>),
			proc.exited,
		]);

		const events = parseJsonl(stdout);
		const { output, model, stopReason, usage } = extractOutput(events);

		return {
			ok: exitCode === 0 && output.trim().length > 0,
			output,
			stderr,
			exitCode,
			aborted: input.signal?.aborted ?? false,
			timedOut,
			model,
			stopReason,
			usage,
			durationMs: Date.now() - startTime,
		};
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		await safeUnlink(systemPromptPath);
		await safeUnlink(taskPath);
	}
}
