/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */
import type { AgentMessage } from "@cornfield/agent";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
} from "@cornfield/ai";
import { prompt } from "@cornfield/utils";
import branchSummaryContextPrompt from "../prompts/compaction/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "../prompts/compaction/compaction-summary-context.md" with { type: "text" };
import type { OutputMeta } from "../tools/output-meta";
import { formatOutputNotice } from "../tools/output-meta";

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

// ═══════════════════════════════════════════════════════════════════════════
// History windowing (context hygiene — phase A of tool-output cleanup)
// ═══════════════════════════════════════════════════════════════════════════
// Keeps the most recent N turns verbatim and replaces older turns with a
// one-line archive note, so long sessions stop paying context tokens for
// tool results the model can no longer use. Turn pairing is preserved: a turn
// (user → assistant toolCalls → toolResults) is archived whole or kept whole —
// never split, because a bare tool_use without its tool_result is rejected by
// providers. Off by default (A/B validated before enabling).

const TURN_START_ROLES = new Set(["user", "bashExecution", "pythonExecution", "custom", "hookMessage"]);

function turnUserText(turn: AgentMessage[]): string {
	for (const m of turn) {
		if (!TURN_START_ROLES.has(m.role)) continue;
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") return content;
	}
	return "";
}

function turnToolNames(turn: AgentMessage[]): string[] {
	const names: string[] = [];
	for (const m of turn) {
		if (m.role !== "assistant") continue;
		const content = (m as { content?: Array<{ type?: string; name?: string }> }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block.type === "toolCall" && block.name) names.push(block.name);
		}
	}
	return names;
}

function summarizeTurn(turn: AgentMessage[], seq: number): string {
	const text = turnUserText(turn).replace(/\s+/g, " ").trim();
	const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
	const tools = [...new Set(turnToolNames(turn))];
	return `[会话归档 #${seq}] ${clipped || "(无文本)"}${tools.length > 0 ? ` · 工具: ${tools.join(", ")}` : ""}`;
}

export interface WindowingOptions {
	enabled: boolean;
	keepRecentTurns: number;
}

/**
 * Replace turns older than the recent window with archive notes.
 * Non-archivable messages (developer, compactionSummary, branchSummary) pass
 * through verbatim. Returns the input unchanged when disabled or when there
 * are fewer turns than the window.
 */
export function applyWindowing(messages: AgentMessage[], options: WindowingOptions): AgentMessage[] {
	if (!options.enabled || messages.length === 0 || options.keepRecentTurns <= 0) return messages;

	// Count turn starts from the end; boundary = index of the keepRecentTurns-th start.
	let turns = 0;
	let boundary = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (TURN_START_ROLES.has(messages[i].role)) {
			turns++;
			if (turns === options.keepRecentTurns) {
				boundary = i;
				break;
			}
		}
	}
	if (boundary <= 0) return messages; // no older history to archive

	const old = messages.slice(0, boundary);
	const kept = messages.slice(boundary);

	const replacements: AgentMessage[] = [];
	let current: AgentMessage[] = [];
	const flush = () => {
		if (current.length === 0) return;
		const first = current[0];
		const seq = replacements.length + 1;
		replacements.push(
			createCustomMessage(
				"windowing",
				summarizeTurn(current, seq),
				false,
				undefined,
				new Date(typeof first.timestamp === "number" ? first.timestamp : Date.now()).toISOString(),
				"agent",
			),
		);
		current = [];
	};

	for (const m of old) {
		if (TURN_START_ROLES.has(m.role)) {
			flush();
			current = [m];
		} else if (m.role === "developer" || m.role === "compactionSummary" || m.role === "branchSummary") {
			flush();
			replacements.push(m); // pass through verbatim
		} else {
			current.push(m); // assistant / toolResult belonging to the open turn
		}
	}
	flush();

	return [...replacements, ...kept];
}

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
}

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for user-initiated Python executions via the $ command.
 * Shares the same kernel session as the agent's Python tool.
 */
export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context ($$ prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/**
 * Legacy hook message type (pre-extensions). Kept for session migration.
 */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	providerPayload?: ProviderPayload;
	timestamp: number;
}

/**
 * Message type for auto-read file mentions via @filepath syntax.
 */
export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;
		/** File size in bytes, if known. */
		byteSize?: number;
		/** Why the file contents were omitted from auto-read. */
		skippedReason?: "tooLarge";
		image?: ImageContent;
	}>;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
// Legacy hookMessage is kept for migration; new code should use custom.
declare module "@cornfield/agent" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		pythonExecution: PythonExecutionMessage;
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		fileMention: FileMentionMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

/**
 * Convert a PythonExecutionMessage to user message text for LLM context.
 */
export function pythonExecutionToText(msg: PythonExecutionMessage): string {
	let text = `Ran Python:\n\`\`\`python\n${msg.code}\n\`\`\`\n`;
	if (msg.output) {
		text += `Output:\n\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(execution cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nExecution failed with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	shortSummary?: string,
	providerPayload?: ProviderPayload,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		providerPayload,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function sanitizeRehydratedOpenAIResponsesAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.providerPayload?.type !== "openaiResponsesHistory") {
		return message;
	}

	let didSanitizeContent = false;
	const sanitizedContent = message.content.map(block => {
		if (block.type !== "thinking" || block.thinkingSignature === undefined) {
			return block;
		}

		didSanitizeContent = true;
		return { ...block, thinkingSignature: undefined };
	});

	// Strip the assistant-side native replay payload entirely.
	// After rehydration it belongs to a previous live provider connection and
	// replaying it on a warmed session causes 401 rejections from GitHub Copilot.
	// User/developer payloads are preserved separately by the caller.
	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "pythonExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: pythonExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "custom":
				case "hookMessage": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					const role = "user";
					const attribution = m.attribution;
					return {
						role,
						content,
						attribution,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [
							{
								type: "text" as const,
								text: prompt.render(BRANCH_SUMMARY_TEMPLATE, { summary: m.summary }),
							},
						],
						attribution: "agent",
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{
								type: "text" as const,
								text: prompt.render(COMPACTION_SUMMARY_TEMPLATE, { summary: m.summary }),
							},
						],
						attribution: "agent",
						providerPayload: m.providerPayload,
						timestamp: m.timestamp,
					};
				case "fileMention": {
					const fileContents = m.files
						.map(file => {
							const inner = file.content ? `\n${file.content}\n` : "\n";
							return `<file path="${file.path}">${inner}</file>`;
						})
						.join("\n\n");
					const content: (TextContent | ImageContent)[] = [
						{ type: "text" as const, text: `<system-reminder>\n${fileContents}\n</system-reminder>` },
					];
					for (const file of m.files) {
						if (file.image) {
							content.push(file.image);
						}
					}
					return {
						role: "user",
						content,
						attribution: "user",
						timestamp: m.timestamp,
					};
				}
				case "user":
					return { ...m, attribution: m.attribution ?? "user" };
				case "developer":
					return { ...m, attribution: m.attribution ?? "agent" };
				case "assistant":
					return m;
				case "toolResult":
					return {
						...m,
						content: getPrunedToolResultContent(m as ToolResultMessage),
						attribution: m.attribution ?? "agent",
					};
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter(m => m !== undefined);
}
