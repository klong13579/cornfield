import type { UserPersona } from "@oh-my-pi/pi-coding-agent/persona/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { RetrievedEpisode } from "./context-aware-retriever";
import type { Learning, UserProfile } from "./types";

/** Options for controlling injection formatting behavior. */
export interface InjectionFormatOptions {
	/** Maximum tokens for the injection block. Default: 2000. */
	maxTokens?: number;
	/** Task type for dynamic token budget allocation. */
	taskType?: "refactoring" | "bugfix" | "feature-add" | "exploration" | "documentation";
	/** Content for the Memory Summary layer (from memory_summary.md). */
	memorySummary?: string;
}

/** Task-type allocation maps for dynamic token budget (architecture §7.5). */
const TASK_ALLOCATIONS: Record<string, Record<string, number>> = {
	refactoring: { learnings: 25, skills: 25, memory: 10, profile: 15, episodic: 5, buffer: 20 },
	bugfix: { learnings: 25, skills: 25, memory: 10, profile: 15, episodic: 5, buffer: 20 },
	exploration: { memory: 25, learnings: 20, skills: 10, profile: 15, episodic: 5, buffer: 25 },
	documentation: { memory: 25, learnings: 20, skills: 10, profile: 15, episodic: 5, buffer: 25 },
	"feature-add": { skills: 30, learnings: 15, memory: 15, profile: 10, episodic: 5, buffer: 25 },
};

export class InjectionFormatter {
	formatInjection(
		episodes: RetrievedEpisode[],
		skills: Array<{ name: string; taskPattern: string; approach: string; qualityScore?: number }>,
		profile?: UserProfile,
		persona?: UserPersona,
		options: InjectionFormatOptions = {},
		learnings: Learning[] = [],
	): string {
		const maxTokens = options.maxTokens ?? 2000;
		const charsPerToken = 4;
		const totalChars = maxTokens * charsPerToken;

		const allocation =
			options.taskType && TASK_ALLOCATIONS[options.taskType] ? TASK_ALLOCATIONS[options.taskType] : undefined;

		const parts: string[] = [];
		let cumulativeChars = 0;

		parts.push("## AGENTS.md\nStatic project guidelines and coding standards.\n");
		cumulativeChars += 100;

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
			const learnBudget = allocation
				? Math.floor((totalChars * (allocation.learnings ?? 20)) / 100)
				: Math.floor(totalChars * 0.15);
			const remaining = totalChars - cumulativeChars;
			const usedChars = Math.min(learnBudget, remaining);
			if (usedChars > 0) {
				const lines: string[] = ["## Project Learnings"];
				for (const l of learnings) {
					lines.push(`- [${l.kind}] ${l.content}`);
				}
				parts.push(`${lines.join("\n")}\n`);
				cumulativeChars += usedChars;
			}
		}

		if (skills.length > 0) {
			const skillBudget = allocation
				? Math.floor((totalChars * allocation.skills) / 100)
				: Math.floor(totalChars * 0.3);
			const remaining = totalChars - cumulativeChars;
			const usedChars = Math.min(skillBudget, remaining);
			if (usedChars > 0) {
				const sortedSkills = [...skills].sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
				const lines: string[] = ["## Relevant Skills"];
				for (const s of sortedSkills) {
					lines.push(`- ${s.name}: ${s.taskPattern.slice(0, 200)}`);
				}
				parts.push(`${lines.join("\n")}\n`);
				cumulativeChars += usedChars;
			}
		}

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

		const pastBudget = Math.floor(totalChars * 0.02);
		if (cumulativeChars + pastBudget <= totalChars) {
			parts.push("## Past Episodes\nHistorical summaries from earlier sessions.\n");
		}

		return this.#applyTokenGuard(parts.join(""), totalChars);
	}

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

		if (lines.length <= 1) return undefined;
		return `${lines.join("\n")}\n`;
	}
}
