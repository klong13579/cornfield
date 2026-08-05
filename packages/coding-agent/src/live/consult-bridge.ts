/**
 * LiveConsultBridge — the "brain" behind omp_agent_consult.
 *
 * Owns a lean, read-only AgentSession. Voice-originated tasks are injected via
 * sendUserMessage; the bridge awaits agent_end and returns the final assistant
 * text for the realtime model to verbalize.
 *
 * Read-only is a HARD guarantee, not a prompt suggestion: after session
 * creation the tool set is replaced with a whitelist (read/search/find/
 * ast_grep/calc/web_search/list_models + a custom read-only git_status tool).
 * Ambient room noise can and does trigger consults (proven in the P0b E2E), so
 * nothing here may be able to mutate anything.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "../extensibility/extensions/types";
import consultInstructions from "../prompts/live/consult-instructions.md" with { type: "text" };
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";

/** Tools the voice consult session is allowed to keep. Everything else is dropped. */
const READONLY_TOOL_WHITELIST = new Set([
	"read",
	"search",
	"find",
	"ast_grep",
	"calc",
	"web_search",
	"list_models",
	"weather",
]);

const DEFAULT_CONSULT_TIMEOUT_MS = 120_000;

/** Fixed read-only git commands — covers the "看下 git status" voice case with zero write surface. */
const GIT_READONLY_COMMANDS = {
	status: "git status --short --branch",
	diffstat: "git diff --stat HEAD",
	log: "git log --oneline -5",
} as const;

type GitReadonlyCommand = keyof typeof GIT_READONLY_COMMANDS;

/** Direct weather lookup — keeps the most common voice query to one fast call instead of a search spiral. */
async function fetchWeather(city: string): Promise<string> {
	const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
	const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) return `weather lookup failed: HTTP ${response.status}`;
	const data = (await response.json()) as {
		current_condition?: Array<{
			temp_C?: string;
			FeelsLikeC?: string;
			humidity?: string;
			windspeedKmph?: string;
			winddir16Point?: string;
			weatherDesc?: Array<{ value?: string }>;
			lang_zh?: Array<{ value?: string }>;
		}>;
		nearest_area?: Array<{ areaName?: Array<{ value?: string }> }>;
	};
	const current = data.current_condition?.[0];
	if (!current) return "weather lookup failed: no current conditions in response";
	const description = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || "unknown";
	const area = data.nearest_area?.[0]?.areaName?.[0]?.value ?? city;
	return [
		`城市: ${area}`,
		`天气: ${description}`,
		`气温: ${current.temp_C}°C（体感 ${current.FeelsLikeC}°C）`,
		`湿度: ${current.humidity}%`,
		`风: ${current.winddir16Point} ${current.windspeedKmph} km/h`,
	].join("\n");
}

export interface ConsultEvent {
	type: string;
	messages?: unknown;
	toolName?: string;
	args?: unknown;
}

/** Narrow session surface the bridge relies on (keeps tests honest and small). */
export interface ConsultSession {
	sendUserMessage(text: string): Promise<void>;
	subscribe(listener: (event: ConsultEvent) => void): () => void;
	abort(): Promise<void>;
	readonly isStreaming: boolean;
	agent: {
		state: { tools: Array<{ name: string }> };
		setTools(tools: unknown[]): void;
	};
}

export type ConsultSessionFactory = () => Promise<ConsultSession>;

export interface LiveConsultBridgeOptions {
	cwd?: string;
	timeoutMs?: number;
	/** Tool-call activity lines for the TUI thinking state (e.g. "read: TODO.md"). */
	onActivity?: (line: string) => void;
	/** Design §5: fires when a timed-out task eventually finishes in the background. */
	onBackgroundResult?: (task: string, text: string) => void;
	/** Test seam — production uses the default createAgentSession-backed factory. */
	sessionFactory?: ConsultSessionFactory;
}

/** Shared with LiveTaskRouter (voice tasks reuse the same extraction). */
export function extractAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			const text = message.content
				.filter((part): part is { type: "text"; text: string } => {
					const p = part as { type?: string; text?: unknown };
					return p.type === "text" && typeof p.text === "string";
				})
				.map(part => part.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}

/** Shared with LiveTaskRouter — one-line tool activity for the panel. */
export function summarizeActivity(toolName: string, args: unknown): string {
	if (args && typeof args === "object") {
		for (const value of Object.values(args as Record<string, unknown>)) {
			if (typeof value === "string" && value.length > 0) {
				return `${toolName}: ${value.length > 60 ? `${value.slice(0, 60)}…` : value}`;
			}
		}
	}
	return toolName;
}

async function defaultSessionFactory(cwd: string | undefined): Promise<ConsultSession> {
	const result = await createAgentSession({
		cwd,
		systemPrompt: consultInstructions,
		enableLsp: false,
		enableMCP: false,
		skipPythonPreflight: true,
		// Voice waits on this session: reasoning latency is pure dead air here.
		thinkingLevel: "off",
		customTools: [
			{
				name: "git_status",
				label: "Git Status (read-only)",
				description:
					"Read-only git queries for the current repository: working-tree status, diff stat, or recent log. No other git operations are available in voice mode.",
				parameters: Type.Object({
					query: Type.Union([Type.Literal("status"), Type.Literal("diffstat"), Type.Literal("log")], {
						description: "status = working tree + branch, diffstat = change summary, log = last 5 commits",
					}),
				}),
				async execute(_toolCallId: string, params: { query: GitReadonlyCommand }): Promise<AgentToolResult> {
					const command = GIT_READONLY_COMMANDS[params.query] ?? GIT_READONLY_COMMANDS.status;
					try {
						const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
						const stdout = await new Response(proc.stdout).text();
						const stderr = await new Response(proc.stderr).text();
						await proc.exited;
						const text = stdout.trim() || stderr.trim() || "(no output)";
						return { content: [{ type: "text", text }] };
					} catch (err) {
						return { content: [{ type: "text", text: `git query failed: ${String(err)}` }] };
					}
				},
			},
			{
				name: "weather",
				label: "Weather (read-only)",
				description:
					"Current weather for a city. ALWAYS use this for weather questions — one call returns temperature, conditions, humidity and wind; no web_search or page reads needed.",
				parameters: Type.Object({
					city: Type.String({ description: "City name, e.g. Shenzhen or 深圳" }),
				}),
				async execute(_toolCallId: string, params: { city: string }): Promise<AgentToolResult> {
					try {
						const text = await fetchWeather(params.city);
						return { content: [{ type: "text", text }] };
					} catch (err) {
						return { content: [{ type: "text", text: `weather lookup failed: ${String(err)}` }] };
					}
				},
			},
		],
	});
	const session = result.session as unknown as AgentSession;
	// Hard read-only guarantee: drop every tool outside the whitelist.
	const kept = session.agent.state.tools.filter(
		tool => READONLY_TOOL_WHITELIST.has(tool.name) || tool.name === "git_status",
	);
	session.agent.setTools(kept);
	logger.info("voice consult session ready", { tools: kept.map(t => t.name) });
	return session as unknown as ConsultSession;
}

/** Per-invocation cancel state — survives later consults starting/failing. */
interface ConsultInvocation {
	cancelled: boolean;
	abort(): Promise<void>;
}

export class LiveConsultBridge {
	readonly #options: LiveConsultBridgeOptions;
	#session: ConsultSession | undefined;
	#pending: Promise<ConsultSession> | undefined;
	/** The in-flight consult invocation (undefined when idle). */
	#active: ConsultInvocation | undefined;
	#activity: string | undefined;

	constructor(options: LiveConsultBridgeOptions = {}) {
		this.#options = options;
	}

	/** Whether a consult is currently executing. */
	get busy(): boolean {
		return this.#active !== undefined;
	}

	/** Last tool activity line of the in-flight consult (status material). */
	get activity(): string | undefined {
		return this.#activity;
	}

	/**
	 * Cancel the in-flight consult (P1 voice "stop"). The aborted agent_end
	 * resolves consult() with a cancellation closure instead of the result, so
	 * the late result can never be spoken after the user cancelled. Note: abort
	 * lands at the next loop boundary — a running tool (e.g. a slow web_search)
	 * drains first; the busy-session handling in consult() covers that window.
	 */
	abortCurrent(): boolean {
		if (!this.#active) return false;
		this.#active.cancelled = true;
		void this.#active.abort();
		return true;
	}

	async consult(task: string): Promise<string> {
		let session = await this.#ensureSession();
		if (session.isStreaming) {
			// A previous turn (usually a cancelled one whose tool is still draining
			// — abort lands at the next loop boundary) holds the session. Consult
			// queries are stateless read-only: take a fresh session instead of
				// queueing behind a corpse and surfacing AgentBusyError to the user.
			logger.info("voice consult session busy, spinning up a fresh one");
			session = await this.#replaceSession();
		}
		const timeoutMs = this.#options.timeoutMs ?? DEFAULT_CONSULT_TIMEOUT_MS;
		const invocation: ConsultInvocation = { cancelled: false, abort: () => session.abort() };
		this.#activity = undefined;
		this.#active = invocation;

		const { promise, resolve } = Promise.withResolvers<string>();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			// Design §5: the task keeps running in the background; the late result
			// reaches the user via onBackgroundResult (spoken if the voice session
			// is still alive, otherwise text in the chat stream).
			resolve("（任务比较重，执行超时了，已转后台继续处理，结果出来后给你。）");
		}, timeoutMs);

		const releaseActive = (): void => {
			if (this.#active === invocation) {
				this.#active = undefined;
				this.#activity = undefined;
			}
		};

		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName) {
				const line = summarizeActivity(event.toolName, event.args);
				if (this.#active === invocation) this.#activity = line;
				if (!timedOut) this.#options.onActivity?.(line);
				return;
			}
			if (event.type === "agent_end") {
				clearTimeout(timer);
				unsubscribe();
				releaseActive();
				if (invocation.cancelled) {
					const closure =
						"（注意：这个查询已被用户取消，没有结果。如果你还没告诉用户，简短说一句已取消；如果已经说过，不必重复，也不要播报任何结果。）";
					if (timedOut) {
						this.#options.onBackgroundResult?.(task, closure);
						return;
					}
					resolve(closure);
					return;
				}
				const text = extractAssistantText(event.messages) || "（任务完成了，但没有产生可播报的结果。）";
				if (timedOut) {
					this.#options.onBackgroundResult?.(task, text);
					return;
				}
				resolve(text);
			}
		});

		// sendUserMessage awaits the whole turn; the race above (agent_end vs
		// timeout) must not be gated behind it, or a slow turn makes the timeout
		// text unreachable and the voice session stalls in silence.
		session.sendUserMessage(task).catch(err => {
			clearTimeout(timer);
			unsubscribe();
			releaseActive();
			logger.warn("voice consult send failed", { error: String(err) });
			resolve(`（任务发送失败：${err instanceof Error ? err.message : String(err)}）`);
		});
		return promise;
	}

	async #ensureSession(): Promise<ConsultSession> {
		if (this.#session) return this.#session;
		this.#pending ??= (this.#options.sessionFactory ?? (() => defaultSessionFactory(this.#options.cwd)))();
		this.#session = await this.#pending;
		return this.#session;
	}

	/** Drop the busy cached session and create a fresh one. */
	async #replaceSession(): Promise<ConsultSession> {
		this.#pending = (this.#options.sessionFactory ?? (() => defaultSessionFactory(this.#options.cwd)))();
		this.#session = await this.#pending;
		return this.#session;
	}
}
