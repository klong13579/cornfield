import { logger } from "@oh-my-pi/pi-utils";
import type { RetrievedEpisode } from "./context-aware-retriever";
import type { Learning } from "./types";

export interface InjectionFormatOptions {
	/** Maximum tokens for the injection block. Default: 2000. */
	maxTokens?: number;
	/** Pre-formatted memory summary block to prepend to the injection. */
	memorySummary?: string;
}

export class InjectionFormatter {
	formatInjection(
		_episodes: RetrievedEpisode[],
		skills: Array<{ name: string; taskPattern: string; approach: string; qualityScore?: number }>,
		_options: InjectionFormatOptions = {},
		learnings: Learning[] = [],
	): string {
		const maxTokens = _options.maxTokens ?? 2000;
		const charsPerToken = 4;
		const totalChars = maxTokens * charsPerToken;

		const parts: string[] = [];
		let cumulativeChars = 0;

		// Single block: Project Context
		if (learnings.length > 0) {
			const lines: string[] = [
				"<!-- INJECTED RULES: These are hard rules learned from past sessions. Follow them precisely. -->",
				"## Injected Rules (must follow)",
				"These rules were learned from past sessions. They override default behavior. Non-compliance will be flagged.",
			];

			// Group by kind
			const identity = learnings.filter(l => l.kind === "fact" && l.source === "agent_written");
			const facts = learnings.filter(l => l.kind === "fact" && l.source !== "agent_written");
			const prefs = learnings.filter(l => l.kind === "preference");
			const procedures = learnings.filter(l => l.kind === "procedure");

			if (identity.length > 0) {
				lines.push("");
				lines.push("### User Identity");
				for (const l of identity) {
					lines.push(`- ${l.content}`);
				}
			}

			if (facts.length > 0) {
				lines.push("");
				lines.push("### Project Facts");
				for (const l of facts) {
					lines.push(`- ${l.content}`);
				}
			}

			if (prefs.length > 0) {
				lines.push("");
				lines.push("### RULES (behavioral constraints — must obey)");
				let ruleNum = 1;
				for (const l of prefs) {
					lines.push(`${ruleNum}. ${l.content}`);
					ruleNum++;
				}
			}

			if (procedures.length > 0) {
				lines.push("");
				lines.push("### PROCEDURES (step-by-step workflows — follow exactly)");
				let procNum = 1;
				for (const l of procedures) {
					lines.push(`${procNum}. ${l.content}`);
					procNum++;
				}
			}

			parts.push(`${lines.join("\n")}\n`);
			cumulativeChars += 400; // estimate
		}

		if (skills.length > 0) {
			const skillBudget = Math.floor(totalChars * 0.3);
			const remaining = totalChars - cumulativeChars;
			const usedChars = Math.min(skillBudget, remaining);
			if (usedChars > 0) {
				const sortedSkills = [...skills].sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
				const lines: string[] = ["## Skills"];
				for (const s of sortedSkills.slice(0, 5)) {
					lines.push(`- ${s.name}: ${s.taskPattern.slice(0, 200)}`);
				}
				parts.push(`${lines.join("\n")}\n`);
				cumulativeChars += usedChars;
			}
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
}
