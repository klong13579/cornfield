/**
 * write_memory tool — agent writes learnings during conversation.
 *
 * Single write entry point for all durable memory. Writes directly to
 * learnings table (source='agent_written', lifecycle='active').
 * Tool return value visible to agent in the same turn.
 *
 * Two targets:
 * - 'user': user identity, preferences, personal details
 * - 'memory': project facts, conventions, environment knowledge
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import writeMemoryDescription from "./prompts/write-memory-tool.md" with { type: "text" };
import type { SqliteLearningStore } from "./storage/learnings";
import type { Learning, LearningKind, LearningScope } from "./types";

const writeMemorySchema = Type.Object({
	action: Type.String({
		description: "Action: add (new entry), replace (update), remove (delete)",
	}),
	target: Type.String({
		description: "'user' for user profile/preferences, 'memory' for project facts/conventions",
	}),
	content: Type.Optional(
		Type.String({
			description: "Entry content. Required for add/replace. At least 20 characters.",
		}),
	),
	kind: Type.Optional(
		Type.String({
			description: "Optional kind hint: 'preference', 'fact', 'procedure'. Auto-detected from target when omitted.",
		}),
	),
	old_text: Type.Optional(
		Type.String({
			description: "Substring to identify entry for replace/remove actions.",
		}),
	),
});

export interface WriteMemoryToolDetails {
	action: string;
	target: string;
	success: boolean;
	entryCount: number;
}

export interface WriteMemoryToolDeps {
	getStore(): SqliteLearningStore;
	getCwd(): string;
	ensureInit(cwd: string): void;
}

export class WriteMemoryTool implements AgentTool<typeof writeMemorySchema, WriteMemoryToolDetails> {
	readonly name = "write_memory";
	readonly label = "Write Memory";
	readonly description: string;
	readonly parameters = writeMemorySchema;
	readonly strict = true;

	readonly #deps: WriteMemoryToolDeps;

	constructor(deps: WriteMemoryToolDeps) {
		this.#deps = deps;
		this.description = prompt.render(writeMemoryDescription);
	}

	async execute(
		toolCallId: string,
		params: Static<typeof writeMemorySchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<WriteMemoryToolDetails>> {
		this.#deps.ensureInit(this.#deps.getCwd());
		const store = this.#deps.getStore();
		if (!store) {
			throw new Error("Memory store not initialized. Start a coding session first.");
		}

		const { action, target, content, kind, old_text } = params;

		if (!target || (target !== "user" && target !== "memory")) {
			throw new Error("target must be 'user' or 'memory'");
		}

		switch (action) {
			case "add":
				return this.#handleAdd(store, target, content ?? "", kind);
			case "replace":
				return this.#handleReplace(store, target, content ?? "", old_text ?? "", kind);
			case "remove":
				return this.#handleRemove(store, target, old_text ?? "");
			default:
				throw new Error(`Unknown action: ${action}. Use add, replace, or remove.`);
		}
	}

	async #handleAdd(
		store: SqliteLearningStore,
		target: string,
		content: string,
		kind?: string,
	): Promise<AgentToolResult<WriteMemoryToolDetails>> {
		if (!content || content.trim().length < 20) {
			throw new Error("Content must be at least 20 characters.");
		}

		const resolvedKind = this.#resolveKind(target, kind);
		const now = Date.now();

		const learning: Learning = {
			id: `lrn_${Bun.hash(`agent_written:${resolvedKind}:${content}`).toString(36)}`,
			cwd: this.#deps.getCwd(),
			kind: resolvedKind,
			content: content.trim(),
			source: "agent_written",
			confidence: 5,
			lifecycle: "active",
			scope: "project" as LearningScope,
			sessionId: "",
			createdAt: now,
			updatedAt: now,
			timesInjected: 0,
			timesHelped: 0,
			timesIgnored: 0,
		};

		await store.insert(learning);

		const text = `Memory saved [${target}/${resolvedKind}]: ${content.slice(0, 80)}`;
		return {
			content: [{ type: "text", text }],
			details: {
				action: "add",
				target,
				success: true,
				entryCount: 1,
			},
		};
	}

	async #handleReplace(
		store: SqliteLearningStore,
		target: string,
		content: string,
		oldText: string,
		kind?: string,
	): Promise<AgentToolResult<WriteMemoryToolDetails>> {
		if (!content || content.trim().length < 20) {
			throw new Error("Content must be at least 20 characters.");
		}
		if (!oldText) {
			throw new Error("old_text is required for replace.");
		}

		const resolvedKind = this.#resolveKind(target, kind);

		// Find matching entry by content substring
		const all = await store.listAll();
		const matches = all.filter(
			l => l.source === "agent_written" && l.kind === resolvedKind && l.content.includes(oldText),
		);

		if (matches.length === 0) {
			return {
				content: [{ type: "text", text: `No matching entry found for '${oldText}'.` }],
				details: { action: "replace", target, success: false, entryCount: 0 },
			};
		}

		// Archive old entries, insert new one
		for (const match of matches) {
			await store.archive(match.id);
		}

		return this.#handleAdd(store, target, content, kind);
	}

	async #handleRemove(
		store: SqliteLearningStore,
		target: string,
		oldText: string,
	): Promise<AgentToolResult<WriteMemoryToolDetails>> {
		if (!oldText) {
			throw new Error("old_text is required for remove.");
		}

		const all = await store.listAll();
		const matches = all.filter(l => l.source === "agent_written" && l.content.includes(oldText));

		if (matches.length === 0) {
			return {
				content: [{ type: "text", text: `No matching entry found for '${oldText}'.` }],
				details: { action: "remove", target, success: false, entryCount: 0 },
			};
		}

		let removed = 0;
		for (const match of matches) {
			await store.archive(match.id);
			removed++;
		}

		const text = `Removed ${removed} memory entr${removed === 1 ? "y" : "ies"}.`;
		return {
			content: [{ type: "text", text }],
			details: {
				action: "remove",
				target,
				success: true,
				entryCount: removed,
			},
		};
	}

	#resolveKind(target: string, kind?: string): LearningKind {
		if (kind && ["preference", "fact", "procedure", "skill_hint"].includes(kind)) {
			return kind as LearningKind;
		}
		// Auto-detect based on target
		return target === "user" ? "preference" : "fact";

	}
	}