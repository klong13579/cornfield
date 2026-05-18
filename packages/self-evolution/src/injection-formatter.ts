import type { UserPersona } from "@oh-my-pi/pi-coding-agent/persona/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { RetrievedEpisode } from "./context-aware-retriever";
import type { Convention, Learning, UserProfile } from "./types";

/** Options for controlling injection formatting behavior. */
export interface InjectionFormatOptions {
	/** Maximum tokens for the injection block. Default: 2000. */
	maxTokens?: number;
	/** Whether to use 7-layer priority injection (AGENTS.md → Memory → Conventions → Skills → Profile → Episodic → Past Episodes). Default: false (legacy 4-layer). */
	useSevenLayer?: boolean;
	/** Task type for dynamic token budget allocation. */
	taskType?: "refactoring" | "bugfix" | "feature-add" | "exploration" | "documentation";
	/** Content for the Memory Summary layer (from memory_summary.md). */
	memorySummary?: string;
}

/** Layer weights for the 7-layer injection (architecture §7.5). */
const _LAYER_WEIGHTS: Record<string, number> = {
	agents: 0.02,
	memory: 0.08,
	conventions: 0.15,
	skills: 0.3,
	profile: 0.05,
	episodic: 0.05,
	past_episodes: 0.02,
	buffer: 0.33,
};

/** Task-type allocation maps for dynamic token budget (architecture §7.5). */
const TASK_ALLOCATIONS: Record<string, Record<string, number>> = {
	refactoring: { conventions: 30, skills: 20, memory: 10, profile: 15, episodic: 5, buffer: 20 },
	bugfix: { conventions: 30, skills: 20, memory: 10, profile: 15, episodic: 5, buffer: 20 },
	exploration: { memory: 25, conventions: 20, skills: 10, profile: 15, episodic: 5, buffer: 25 },
	documentation: { memory: 25, conventions: 20, skills: 10, profile: 15, episodic: 5, buffer: 25 },
	"feature-add": { skills: 25, conventions: 15, memory: 15, profile: 10, episodic: 5, buffer: 30 },
};

export class InjectionFormatter {
	/**
	 * Format the full injection block for system prompt augmentation.
	 *
	 * @param options - Formatting options for token budget and injection mode
	 */
	formatInjection(
		episodes: RetrievedEpisode[],
		conventions: Convention[],
		skills: Array<{ name: string; taskPattern: string; approach: string; qualityScore?: number }>,
		profile?: UserProfile,
		persona?: UserPersona,
		options: InjectionFormatOptions = {},
		learnings: Learning[] = [],
	): string {
		if (options.useSevenLayer) {
			return this.#formatSevenLayer(episodes, conventions, skills, options, profile, persona, learnings);
		}
		return this.#formatLegacy(episodes, conventions, skills, profile, persona, options, learnings);
	}

	/**
	 * Legacy 4-layer format (Profile → Conventions → Episodes → Skills).
	 * Preserved for backward compatibility.
	 */
	#formatLegacy(
		episodes: RetrievedEpisode[],
		conventions: Convention[],
		skills: Array<{ name: string; taskPattern: string; approach: string }>,
		profile?: UserProfile,
		persona?: UserPersona,
		options: InjectionFormatOptions = {},
		learnings: Learning[] = [],
	): string {
		const parts: string[] = [];
		// Legacy mode uses character count directly (backward compat),
		// matching the original 2000-char limit.
		const maxChars = options.maxTokens ?? 2000;

		// User Profile (semantic memory)
		const profileText = this.#formatProfile(profile, persona);
		if (profileText) {
			parts.push(profileText);
		}

		if (options.memorySummary?.trim()) {
			parts.push("## Memory Summary");
			parts.push(options.memorySummary.trim());
			parts.push("");
		}

		if (learnings.length > 0) {
			parts.push("## Project Learnings");
			for (const l of learnings) {
				const pin = l.source === "manual_pin" ? " [pinned]" : "";
				parts.push(`[${l.kind}] ${l.content}${pin}`);
			}
			parts.push("");
		}

		// Project Conventions (legacy path only)
		if (conventions.length > 0) {
			parts.push("## Project Conventions");
			for (const c of conventions) {
				const observed = c.timesApplied + c.timesViolated;
				parts.push(`[${c.type}] ${c.content} (confidence: ${c.confidence}%, observed ${observed} times)`);
			}
			parts.push("");
		}

		// Relevant Past Experiences — filter out low-quality episodes
		const filteredEpisodes = episodes.filter(e => e.relevanceScore >= 40 || e.helpRate > 0.5);
		if (filteredEpisodes.length > 0) {
			parts.push("## Relevant Past Experiences");
			for (const e of filteredEpisodes) {
				parts.push(`[score: ${e.relevanceScore.toFixed(2)}] ${e.episode.summary} (${e.reason})`);
			}
			parts.push("");
		}

		// Relevant Skills
		if (skills.length > 0) {
			parts.push("## Relevant Skills");
			for (const s of skills) {
				parts.push(`${s.name}: ${s.taskPattern}`);
				parts.push(s.approach);
			}
			parts.push("");
		}

		return this.#applyTokenGuard(parts.join("\n").trim(), maxChars);
	}

	/**
	 * 7-layer priority injection (architecture §7.1 Stage 6):
	 * 1. AGENTS.md (always included)
	 * 2. Memory Summary (consolidated memories)
	 * 3. Conventions (established team/project rules)
	 * 4. Relevant Skills (active skills sorted by quality)
	 * 5. User Profile (preferred patterns)
	 * 6. Episodic Context (recent session fragments)
	 * 7. Past Episodes (historical summaries, lowest priority)
	 * + Buffer (flexible space)
	 */
	#formatSevenLayer(
		episodes: RetrievedEpisode[],
		conventions: Convention[],
		skills: Array<{ name: string; taskPattern: string; approach: string; qualityScore?: number }>,
		options: InjectionFormatOptions,
		profile?: UserProfile,
		persona?: UserPersona,
		learnings: Learning[] = [],
	): string {
		const maxTokens = options.maxTokens ?? 2000;
		const charsPerToken = 4;
		const totalChars = maxTokens * charsPerToken;

		// Dynamic token allocation by task type
		const allocation =
			options.taskType && TASK_ALLOCATIONS[options.taskType] ? TASK_ALLOCATIONS[options.taskType] : undefined;

		const parts: string[] = [];
		let cumulativeChars = 0;

		// Layer 1: AGENTS.md (always included, even if budget tight)
		parts.push("## AGENTS.md\nStatic project guidelines and coding standards.\n");
		cumulativeChars += 100; // fixed cost

		// Layer 2: Memory Summary
		const memoryBudget = allocation
			? Math.floor((totalChars * allocation.memory) / 100)
			: Math.floor(totalChars * 0.08);
		const remainingForMemory = totalChars - cumulativeChars;
		const memoryChars = Math.min(memoryBudget, remainingForMemory);
		if (memoryChars > 0) {
			if (options.memorySummary) {
				const truncated =
					options.memorySummary.length > memoryChars
						? `${options.memorySummary.slice(0, memoryChars - 20)}... (truncated)`
						: options.memorySummary;
				parts.push(`## Memory Summary\n${truncated}\n`);
			} else {
				parts.push("## Memory Summary\nConsolidated memories from previous sessions.\n");
			}
			cumulativeChars += memoryChars;
		}

		if (learnings.length > 0) {
			const lines: string[] = ["## Project Learnings"];
			for (const l of learnings) {
				lines.push(`- [${l.kind}] ${l.content}`);
			}
			parts.push(`${lines.join("\n")}\n`);
		}

		// Layer 3: Conventions (legacy; highest signal, safety rules)
		if (conventions.length > 0) {
			const convBudget = allocation
				? Math.floor((totalChars * allocation.conventions) / 100)
				: Math.floor(totalChars * 0.15);
			const remaining = totalChars - cumulativeChars;
			const usedChars = Math.min(convBudget, remaining);
			if (usedChars > 0) {
				const lines: string[] = ["## Conventions"];
				for (const c of conventions) {
					const line = `- [${c.type}] ${c.content} (confidence: ${c.confidence}%)`;
					lines.push(line);
				}
				parts.push(`${lines.join("\n")}\n`);
				cumulativeChars += usedChars;
			}
		}

		// Layer 4: Relevant Skills (sorted by qualityScore descending)
		if (skills.length > 0) {
			const skillBudget = allocation
				? Math.floor((totalChars * allocation.skills) / 100)
				: Math.floor(totalChars * 0.3);
			const remaining = totalChars - cumulativeChars;
			const usedChars = Math.min(skillBudget, remaining);
			if (usedChars > 0) {
				// Sort by qualityScore descending (composite_score truncation)
				const sortedSkills = [...skills].sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
				const lines: string[] = ["## Relevant Skills"];
				for (const s of sortedSkills) {
					const line = `- ${s.name}: ${s.taskPattern.slice(0, 200)}`;
					lines.push(line);
				}
				parts.push(`${lines.join("\n")}\n`);
				cumulativeChars += usedChars;
			}
		}

		// Layer 5: User Profile
		const profileBudget = allocation
			? Math.floor((totalChars * allocation.profile) / 100)
			: Math.floor(totalChars * 0.05);
		if (cumulativeChars + profileBudget <= totalChars && (profile || persona)) {
			const profileText = this.#formatProfile(profile, persona);
			if (profileText) {
				parts.push(profileText);
				cumulativeChars += profileBudget;
			}
		}

		// Layer 6: Episodic Context (filtered, top-N by relevanceScore)
		const episodicBudget = allocation
			? Math.floor((totalChars * allocation.episodic) / 100)
			: Math.floor(totalChars * 0.05);
		const filteredEpisodes = episodes
			.filter(e => e.relevanceScore >= 40 || e.helpRate > 0.5)
			.sort((a, b) => b.relevanceScore - a.relevanceScore)
			.slice(0, 3);
		if (filteredEpisodes.length > 0 && cumulativeChars + episodicBudget <= totalChars) {
			const lines: string[] = ["## Episodic Context"];
			for (const e of filteredEpisodes) {
				lines.push(`- [score: ${e.relevanceScore.toFixed(2)}] ${e.episode.summary.slice(0, 200)}`);
			}
			parts.push(`${lines.join("\n")}\n`);
			cumulativeChars += episodicBudget;
		}

		// Layer 7: Past Episodes (lowest priority, rarely includes)
		const pastBudget = Math.floor(totalChars * 0.02);
		if (cumulativeChars + pastBudget <= totalChars) {
			parts.push("## Past Episodes\nHistorical summaries from earlier sessions.\n");
			cumulativeChars += pastBudget;
		}

		return this.#applyTokenGuard(parts.join(""), totalChars);
	}

	/** Apply token guard with smart truncation at newline boundaries. */
	#applyTokenGuard(result: string, maxChars: number): string {
		if (result.length > maxChars) {
			const cutPoint = result.lastIndexOf("\n", maxChars);
			if (cutPoint > maxChars * 0.8) {
				result = `${result.slice(0, cutPoint)}\n... (truncated due to token limit)`;
			} else {
				result = `${result.slice(0, maxChars)}... (truncated)`;
			}
		}

		logger.debug("injection formatted", {
			chars: result.length,
		});

		return result;
	}

	#formatProfile(profile?: UserProfile, persona?: UserPersona): string | undefined {
		if (!profile && !persona) return undefined;

		const lines: string[] = [];
		lines.push("## User Profile");

		// Persona data (manual)
		if (persona) {
			if (persona.career.role) lines.push(`- Role: ${persona.career.role}`);
			if (persona.career.expertise?.length) lines.push(`- Expertise: ${persona.career.expertise.join(", ")}`);
			if (persona.preferences.communicationStyle)
				lines.push(`- Communication style: ${persona.preferences.communicationStyle}`);
			if (persona.preferences.outputFormat) lines.push(`- Output format: ${persona.preferences.outputFormat}`);
			if (persona.thinking.workStyle) lines.push(`- Work style: ${persona.thinking.workStyle}`);
			if (persona.interaction.proactive !== undefined)
				lines.push(`- Allows proactive extension: ${persona.interaction.proactive ? "yes" : "no"}`);
			if (persona.constraints.forbidden.length)
				lines.push(`- Forbidden: ${persona.constraints.forbidden.join(", ")}`);
		}

		// Profile data (auto-derived)
		if (profile && profile.sessionCount > 0) {
			lines.push(`- Sessions analyzed: ${profile.sessionCount}`);
			lines.push(`- Avg tool calls/session: ${profile.avgToolCallsPerSession.toFixed(1)}`);
			if (profile.preferredLanguages.length)
				lines.push(`- Preferred languages: ${profile.preferredLanguages.join(", ")}`);

			const topIntents = Object.entries(profile.intentDistribution)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([i, c]) => `${i}(${c})`)
				.join(", ");
			if (topIntents) lines.push(`- Top intents: ${topIntents}`);

			const topTools = Object.entries(profile.toolFrequency)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5)
				.map(([t, c]) => `${t}(${c})`)
				.join(", ");
			if (topTools) lines.push(`- Top tools: ${topTools}`);
		}

		if (lines.length <= 1) return undefined; // Only header, no content
		return `${lines.join("\n")}\n`;
	}
}
