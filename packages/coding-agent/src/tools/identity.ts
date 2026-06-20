import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { getConfigRootDir, isEnoent, prompt, VERSION } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import identityDescription from "../prompts/tools/identity.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

/**
 * `identity` — query and update identity information.
 *
 * Three actions:
 * - `whoRu`:      return the current agent's operational identity (model, cwd, version).
 * - `whoisme`:    return the user's declarative persona from `~/.omp/user.md`.
 * - `update_persona`: update one section of `user.md`.
 *
 * Boundary: `user.md` holds hand-authored, stable user identity (name, role, timezone,
 * standing instructions) — the user-side analog of `mission.md`. Learned behavioral
 * preferences discovered at runtime belong in `write_memory` (target: "user"), not here.
 */

const VALID_SECTIONS = [
	"basics",
	"career",
	"interests",
	"preferences",
	"interaction",
	"thinking",
	"constraints",
] as const;
type SectionName = (typeof VALID_SECTIONS)[number];

const identitySchema = Type.Object({
	action: Type.Union([Type.Literal("whoRu"), Type.Literal("whoisme"), Type.Literal("update_persona")], {
		description: "操作类型",
	}),
	section: Type.Optional(
		Type.String({
			description: `要更新的段名（update_persona 时必填）: ${VALID_SECTIONS.join(" | ")}`,
		}),
	),
	data: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "要合并进该段的部分对象（update_persona 时必填）",
		}),
	),
});

type IdentityParams = Static<typeof identitySchema>;

/** Path to the user-level declarative persona file (~/.omp/user.md, shared across all agentDirs). */
function userPersonaPath(): string {
	return `${getConfigRootDir()}/user.md`;
}

/** Read user.md; returns null when absent (optional file — never an error). */
async function readUserPersona(): Promise<string | null> {
	try {
		return await Bun.file(userPersonaPath()).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Render a data object as markdown bullet lines (one level deep). */
function renderDataAsMarkdown(data: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (value === null || value === undefined) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			lines.push(`- ${key}:`);
			for (const item of value) {
				lines.push(`  - ${String(item)}`);
			}
		} else if (typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>);
			if (entries.length === 0) continue;
			lines.push(`- ${key}:`);
			for (const [subKey, subVal] of entries) {
				if (subVal === null || subVal === undefined) continue;
				lines.push(`  - ${subKey}: ${String(subVal)}`);
			}
		} else {
			lines.push(`- ${key}: ${String(value)}`);
		}
	}
	return lines.join("\n");
}

/** A `- key: value` bullet plus its indented continuation lines. */
interface BulletBlock {
	key: string;
	lines: string[];
}

const BULLET_RE = /^- ([^:]+):\s*(.*)$/;

/** Parse markdown into pre-bullet lines, ordered bullet blocks (keyed), and trailing lines. */
function parseBulletBlocks(body: string): { pre: string[]; blocks: BulletBlock[]; trailing: string[] } {
	const lines = body.split("\n");
	const pre: string[] = [];
	const blocks: BulletBlock[] = [];
	const trailing: string[] = [];
	let current: BulletBlock | null = null;
	let seenBullet = false;
	for (const line of lines) {
		if (line.startsWith("  ")) {
			// indented continuation of the current block
			if (current) current.lines.push(line);
			else if (seenBullet) trailing.push(line);
			else pre.push(line);
			continue;
		}
		const m = BULLET_RE.exec(line);
		if (m) {
			seenBullet = true;
			current = { key: m[1]!.trim(), lines: [line] };
			blocks.push(current);
		} else {
			current = null;
			if (seenBullet) trailing.push(line);
			else pre.push(line);
		}
	}
	return { pre, blocks, trailing };
}

/** Merge new bullet blocks into an existing section body by key (replace, not duplicate). */
function mergeBulletBlocks(existingBody: string, newRendered: string): string {
	const existing = parseBulletBlocks(existingBody);
	const incoming = parseBulletBlocks(newRendered);
	const byKey = new Map<string, BulletBlock>();
	for (const block of existing.blocks) byKey.set(block.key, block);
	for (const block of incoming.blocks) byKey.set(block.key, block);
	// Preserve existing order, append new keys at the end of the block run.
	const merged: BulletBlock[] = [];
	const seen = new Set<string>();
	for (const block of existing.blocks) {
		if (seen.has(block.key)) continue;
		merged.push(byKey.get(block.key)!);
		seen.add(block.key);
	}
	for (const block of incoming.blocks) {
		if (!seen.has(block.key)) {
			merged.push(block);
			seen.add(block.key);
		}
	}
	const parts: string[] = [];
	if (existing.pre.length > 0) parts.push(existing.pre.join("\n"));
	parts.push(...merged.map(b => b.lines.join("\n")));
	if (existing.trailing.length > 0) parts.push(existing.trailing.join("\n"));
	return parts
		.filter(p => p.length > 0)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}
interface ParsedSections {
	/** Content before the first `## ` section header (preserved verbatim). */
	preamble: string;
	/** Ordered list of [sectionName, bodyLines]. */
	sections: Array<{ name: string; body: string }>;
}

/** Parse markdown into preamble + `## <name>` sections. Non-section content is preserved. */
function parseSections(content: string): ParsedSections {
	const lines = content.split("\n");
	const preamble: string[] = [];
	const sections: Array<{ name: string; body: string }> = [];
	let current: { name: string; body: string[] } | null = null;

	const sectionHeaderRe = /^##\s+(\S+)\s*$/;

	for (const line of lines) {
		const match = sectionHeaderRe.exec(line);
		if (match) {
			if (current) {
				sections.push({ name: current.name, body: current.body.join("\n") });
			}
			current = { name: match[1]!, body: [] };
		} else if (current) {
			current.body.push(line);
		} else {
			preamble.push(line);
		}
	}
	if (current) {
		sections.push({ name: current.name, body: current.body.join("\n") });
	}
	return { preamble: preamble.join("\n"), sections };
}

function serializeSections(parsed: ParsedSections): string {
	const parts: string[] = [];
	if (parsed.preamble.trim().length > 0) {
		parts.push(parsed.preamble);
	}
	for (const section of parsed.sections) {
		parts.push(`## ${section.name}`);
		parts.push(section.body);
	}
	return (
		parts
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim() + "\n"
	);
}

const EMPTY_TEMPLATE = `# User

> Declarative user identity. Hand-authored via the \`identity\` tool or directly.
> Stable facts: name, role, timezone, standing instructions.
> Learned preferences belong in write_memory (target: "user"), not here.

## basics
- name:
- role:

## career

## preferences
`;

export class IdentityTool implements AgentTool<typeof identitySchema> {
	readonly name = "identity";
	readonly label = "Identity";
	readonly description: string;
	readonly parameters = identitySchema;
	readonly strict = true;
	readonly intent = "omit";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(identityDescription);
	}

	async execute(
		_toolCallId: string,
		params: IdentityParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		switch (params.action) {
			case "whoRu":
				return this.whoRu();
			case "whoisme":
				return this.whoisme();
			case "update_persona":
				return this.updatePersona(params);
		}
	}

	private async whoRu(): Promise<AgentToolResult> {
		const model = this.session.getActiveModelDetails?.();
		const sessionId = this.session.getSessionId?.();
		const lines: string[] = [
			"# Agent Identity",
			"",
			`- name: Oh My Pi (OMP) coding agent`,
			`- version: ${VERSION}`,
			`- working directory: ${this.session.cwd}`,
		];
		if (model) {
			lines.push(`- model: ${model.name} (${model.id})`);
			lines.push(`- provider: ${model.provider} — ${model.api}`);
		} else {
			const modelStr = this.session.getActiveModelString?.();
			if (modelStr) lines.push(`- model: ${modelStr}`);
		}
		if (sessionId) lines.push(`- session: ${sessionId}`);
		lines.push("");
		lines.push(
			"Role, principles, and working style are defined in the system prompt. " +
				"Invoke tools to act; ask me what I can do for specifics.",
		);
		return { content: [{ type: "text", text: lines.join("\n") }] };
	}

	private async whoisme(): Promise<AgentToolResult> {
		const content = await readUserPersona();
		if (content === null) {
			return {
				content: [
					{
						type: "text",
						text: `No user persona found at ${userPersonaPath()}.\n\n` + EMPTY_TEMPLATE,
					},
				],
			};
		}
		return { content: [{ type: "text", text: content }] };
	}

	private async updatePersona(params: IdentityParams): Promise<AgentToolResult> {
		const section = params.section?.trim();
		if (!section) {
			throw new ToolError("section is required for update_persona.");
		}
		if (!VALID_SECTIONS.includes(section as SectionName)) {
			throw new ToolError(`Invalid section "${section}". Valid sections: ${VALID_SECTIONS.join(", ")}.`);
		}
		const data = params.data;
		if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
			throw new ToolError("data is required for update_persona and must be a non-empty object.");
		}

		const existing = await readUserPersona();
		const parsed = parseSections(existing ?? EMPTY_TEMPLATE);
		const rendered = renderDataAsMarkdown(data as Record<string, unknown>);

		const idx = parsed.sections.findIndex(s => s.name === section);
		if (idx >= 0) {
			// Merge by key: existing bullets preserved, matching keys replaced, new keys appended.
			parsed.sections[idx]!.body = mergeBulletBlocks(parsed.sections[idx]!.body, rendered);
		} else {
			// Insert in canonical order.
			const canonicalIdx = VALID_SECTIONS.indexOf(section as SectionName);
			let insertAt = parsed.sections.length;
			for (let i = 0; i < parsed.sections.length; i++) {
				const sectCanonical = VALID_SECTIONS.indexOf(parsed.sections[i]!.name as SectionName);
				if (sectCanonical > canonicalIdx) {
					insertAt = i;
					break;
				}
			}
			parsed.sections.splice(insertAt, 0, { name: section, body: rendered });
		}

		const serialized = serializeSections(parsed);
		await Bun.write(userPersonaPath(), serialized);

		return {
			content: [
				{
					type: "text",
					text: `Updated section "${section}" in ${userPersonaPath()}.\n\nAdded:\n${rendered}`,
				},
			],
		};
	}
}
