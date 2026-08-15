/**
 * IM skill picker — intercepts `/skills` and `/skill` slash commands
 * in the IM chat, replies with a plain markdown list of the available
 * skills, and remembers the user's selection so the next inbound
 * message can be augmented with the skill's content as system
 * context.
 *
 * Lifecycle:
 * 1. User types `/skills` (or `/skill`, any case) → `handle()`
 *    intercepts, replies with a markdown list of skill names only
 *    (no description — keeps the IM message compact), returns true
 *    (message consumed).
 * 2. User types `/skill <name>` (exact) → `handle()` directly sets
 *    the pending skill and posts a "✅ 已选择技能" confirmation.
 *    No card, no extra click, no schema upgrade.
 * 3. User types `/skill <filter>` (substring, not an exact name) →
 *    `handle()` replies with the filtered markdown list.
 * 4. `setPendingSkill()` stashes the skill in a per-conversation map
 *    keyed by (accountId|conversationId).
 * 5. User's next message → `MessageHandler` calls
 *    `applyPendingSkillContext()` BEFORE forwarding to the agent.
 *    The skill content is prepended to the message so the LLM sees
 *    `[System note: ...] <skill>...</skill> <user message>` and
 *    applies the skill naturally.
 *
 * Pending state is one-shot: consumed on the next inbound message.
 * TTL is 30 min so a stale selection doesn't haunt the next session.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { SkillCache } from "./skill-cache";
import type { InboundMessage, MessageContent } from "./types";

const PENDING_SKILL_TTL_MS = 30 * 60_000;

export interface SkillCommandDeps {
	skillCache: SkillCache;
	sendAgentResponse: (msg: InboundMessage, text: string) => Promise<void>;
	extractMessageText: (msg: InboundMessage) => string;
}

interface PendingSkill {
	name: string;
	expireAt: number;
}

const SKILL_INJECTION_HEADER = (name: string): string =>
	`[System note: User explicitly selected the skill "${name}" via the IM skill picker. ` +
	`Apply this skill to handle the user's next request. Skill content follows.]\n\n` +
	`<skill name="${name}">\n`;

const SKILL_INJECTION_FOOTER = "\n</skill>\n\n";

export class SkillCommand {
	readonly #deps: SkillCommandDeps;
	/** Pending skill per (accountId|conversationId). One-shot — consumed on next user message. */
	readonly #pending = new Map<string, PendingSkill>();

	constructor(deps: SkillCommandDeps) {
		this.#deps = deps;
	}

	/** Test seam: prune expired pending entries. Cheap; called from applyPendingSkillContext. */
	#pruneExpiredPending(): void {
		const now = Date.now();
		for (const [key, entry] of this.#pending) {
			if (now > entry.expireAt) this.#pending.delete(key);
		}
	}

	/**
	 * Does the message text look like a `/skill` or `/skills` command?
	 *
	 * Case-insensitive. Accepts both the singular and plural form
	 * (`/skill` is an alias for `/skills`). The arg-bearing form
	 * (`/skill <name>`) is matched the same way — this method only
	 * identifies the command; the arg is parsed by `handle()`.
	 */
	isSkillCommand(text: string): boolean {
		const t = text.trim().toLowerCase();
		return t === "/skill" || t === "/skills" || t.startsWith("/skill ") || t.startsWith("/skills ");
	}

	/**
	 * Intercept `/skills` (or `/skill`) slash command. Returns true if
	 * the message was consumed.
	 *
	 * Three dispatch modes:
	 * 1. No arg (`/skills` or `/skill`) → reply with markdown list of
	 *    all skills
	 * 2. Exact skill name (`/skill <name>`) → directly set pending
	 *    skill + reply with confirmation (no list, no extra click)
	 * 3. Filter (`/skill <substring>` not matching any name) → reply
	 *    with the filtered markdown list
	 * 4. No match at all → reply with helpful error
	 */
	async handle(msg: InboundMessage, accountId: string): Promise<boolean> {
		const text = this.#deps.extractMessageText(msg).trim();
		if (!this.isSkillCommand(text)) return false;

		// Parse arg: first space separates the trigger from the rest.
		// Works for both `/skill` and `/skills` regardless of case.
		const spaceIdx = text.search(/\s/);
		const arg = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

		const skills = await this.#deps.skillCache.getSkills(accountId);

		if (skills.length === 0) {
			await this.#deps.sendAgentResponse(
				msg,
				"当前没有可用的技能。请检查 .omp/skills 或 ~/.omp/agent/skills 目录。",
			);
			return true;
		}

		// No arg → show the full list.
		if (arg === "") {
			await this.#sendTextList(msg, skills);
			return true;
		}

		// Exact-name arg → direct invocation (no list, no extra click).
		const exact = skills.find(s => s.name === arg);
		if (exact) {
			this.setPendingSkill(accountId, msg.conversationId, exact.name);
			await this.#deps.sendAgentResponse(
				msg,
				`✅ 已选择技能: **${exact.name}**\n\n现在告诉我你要处理什么,我会用此技能处理。`,
			);
			return true;
		}

		// Substring filter → narrowed list.
		const filtered = skills.filter(
			s =>
				s.name.toLowerCase().includes(arg.toLowerCase()) || s.description.toLowerCase().includes(arg.toLowerCase()),
		);

		if (filtered.length === 0) {
			await this.#deps.sendAgentResponse(msg, `没有匹配 "${arg}" 的技能。发送 \`/skills\` 查看当前可用列表。`);
			return true;
		}

		await this.#sendTextList(msg, filtered);
		return true;
	}

	/**
	 * Reply with a markdown list of skills. Sorted by name for stable
	 * output across calls (users see the same order each time).
	 */
	async #sendTextList(msg: InboundMessage, skills: Awaited<ReturnType<SkillCache["getSkills"]>>): Promise<void> {
		const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
		const lines = sorted.map(s => `- 📚 **${s.name}**`);
		await this.#deps.sendAgentResponse(
			msg,
			`📚 可用技能 (${sorted.length}):\n\n${lines.join("\n")}\n\n` +
				`使用技能: 输入 \`/skill <name>\` 直接调用,或描述你的需求让 agent 自动选择。`,
		);
	}

	/**
	 * If a pending skill exists for this conversation, read its content
	 * and prepend it to the inbound message as a system note + skill
	 * block. The pending entry is consumed (one-shot).
	 *
	 * Returns true if the message was modified.
	 */
	async applyPendingSkillContext(msg: InboundMessage, accountId: string, conversationId: string): Promise<boolean> {
		this.#pruneExpiredPending();
		const name = this.consumePendingSkill(accountId, conversationId);
		if (!name) return false;

		const content = await this.#deps.skillCache.getSkillContent(name, accountId);
		if (!content) {
			logger.warn("[SkillCommand] pending skill content not found", { name, accountId });
			return false;
		}

		const prefix = SKILL_INJECTION_HEADER(name) + content + SKILL_INJECTION_FOOTER;
		prependToContent(msg.content, prefix);
		return true;
	}

	/**
	 * Test seam: directly set a pending skill without going through
	 * the slash command. Useful for tests and admin tools.
	 */
	setPendingSkill(accountId: string, conversationId: string, name: string): void {
		this.#pending.set(`${accountId}|${conversationId}`, {
			name,
			expireAt: Date.now() + PENDING_SKILL_TTL_MS,
		});
	}

	/** Read + clear the pending skill entry. Returns null if none. */
	consumePendingSkill(accountId: string, conversationId: string): string | null {
		const key = `${accountId}|${conversationId}`;
		const entry = this.#pending.get(key);
		if (!entry) return null;
		if (Date.now() > entry.expireAt) {
			this.#pending.delete(key);
			return null;
		}
		this.#pending.delete(key);
		return entry.name;
	}
}

/**
 * Mutate `content` in place to prepend a string prefix. Mirrors the
 * helper in `gateway-new-session.ts:prependSystemNote` (kept private
 * there because it was only used for rotation). Handles text + markdown;
 * voice is a no-op (its `text` transcription is left untouched — the
 * skill context is silently dropped, which is rare in practice since
 * users don't typically follow `/skills` with a voice message).
 */
function prependToContent(content: MessageContent, note: string): void {
	if (content.type === "text") {
		content.text = note + content.text;
	} else if (content.type === "markdown") {
		content.markdown = note + content.markdown;
	} else if (content.type === "voice") {
		content.text = note + (content.text ?? "");
	}
}
