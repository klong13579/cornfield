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
import { Type } from "@sinclair/typebox";
import { logger } from "@oh-my-pi/pi-utils";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AgentToolResult } from "../extensibility/extensions/types";
import consultInstructions from "../prompts/live/consult-instructions.md" with { type: "text" };

/** Tools the voice consult session is allowed to keep. Everything else is dropped. */
const READONLY_TOOL_WHITELIST = new Set(["read", "search", "find", "ast_grep", "calc", "web_search", "list_models"]);

const DEFAULT_CONSULT_TIMEOUT_MS = 60_000;

/** Fixed read-only git commands — covers the "看下 git status" voice case with zero write surface. */
const GIT_READONLY_COMMANDS = {
	status: "git status --short --branch",
	diffstat: "git diff --stat HEAD",
	log: "git log --oneline -5",
} as const;

type GitReadonlyCommand = keyof typeof GIT_READONLY_COMMANDS;

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
	/** Test seam — production uses the default createAgentSession-backed factory. */
	sessionFactory?: ConsultSessionFactory;
}

function extractAssistantText(messages: unknown): string {
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

function summarizeActivity(toolName: string, args: unknown): string {
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
		],
	});
	const session = result.session as unknown as AgentSession;
	// Hard read-only guarantee: drop every tool outside the whitelist.
	const kept = session.agent.state.tools.filter(tool => READONLY_TOOL_WHITELIST.has(tool.name) || tool.name === "git_status");
	session.agent.setTools(kept);
	logger.info("voice consult session ready", { tools: kept.map(t => t.name) });
	return session as unknown as ConsultSession;
}

export class LiveConsultBridge {
	readonly #options: LiveConsultBridgeOptions;
	#session: ConsultSession | undefined;
	#pending: Promise<ConsultSession> | undefined;

	constructor(options: LiveConsultBridgeOptions = {}) {
		this.#options = options;
	}

	async consult(task: string): Promise<string> {
		const session = await this.#ensureSession();
		const timeoutMs = this.#options.timeoutMs ?? DEFAULT_CONSULT_TIMEOUT_MS;

		const { promise, resolve } = Promise.withResolvers<string>();
		const timer = setTimeout(() => {
			unsubscribe();
			resolve("（任务执行超时了，可能需要更长时间。你可以切到文字模式继续，或者让我重试。）");
		}, timeoutMs);

		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName) {
				this.#options.onActivity?.(summarizeActivity(event.toolName, event.args));
				return;
			}
			if (event.type === "agent_end") {
				clearTimeout(timer);
				unsubscribe();
				const text = extractAssistantText(event.messages);
				resolve(text || "（任务完成了，但没有产生可播报的结果。）");
			}
		});

		try {
			await session.sendUserMessage(task);
		} catch (err) {
			clearTimeout(timer);
			unsubscribe();
			logger.warn("voice consult send failed", { error: String(err) });
			return `（任务发送失败：${err instanceof Error ? err.message : String(err)}）`;
		}
		return promise;
	}

	async #ensureSession(): Promise<ConsultSession> {
		if (this.#session) return this.#session;
		this.#pending ??= (this.#options.sessionFactory ?? (() => defaultSessionFactory(this.#options.cwd)))();
		this.#session = await this.#pending;
		return this.#session;
	}
}
