import type { SqliteLearningStore } from "./storage/learnings";
import type { EffectivenessStore, EpisodeStore, SkillStore } from "./storage/types";
import type { DailyReport, Episode, EpisodeEffectiveness, ErrorPattern, EvolvedSkill, Learning } from "./types";

const CORRECTION_KEYWORDS = [
	"fix",
	"correct",
	"wrong",
	"not working",
	"error",
	"bug",
	"issue",
	"broken",
	"repair",
	"resolve",
	"debug",
	"fail",
	"failed",
];

interface SkillDayEntry {
	skill: EvolvedSkill;
	wasCreatedToday: boolean;
	wasUpdatedToday: boolean;
	effectiveness?: {
		timesInjected: number;
		timesHelped: number;
		helpRate: number | null;
	};
}

export class DailyReportGenerator {
	#episodeStore: EpisodeStore;
	#learningStore: SqliteLearningStore;
	#effectivenessStore: EffectivenessStore;
	#skillStore: SkillStore;

	constructor(
		episodeStore: EpisodeStore,
		learningStore: SqliteLearningStore,
		effectivenessStore: EffectivenessStore,
		skillStore: SkillStore,
	) {
		this.#episodeStore = episodeStore;
		this.#learningStore = learningStore;
		this.#effectivenessStore = effectivenessStore;
		this.#skillStore = skillStore;
	}

	async generate(date?: Date): Promise<DailyReport> {
		const targetDate = date ?? new Date();
		const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()).getTime();
		const endOfDay = startOfDay + 86_400_000;

		const episodes = await this.#episodeStore.listRecent(1000);
		const dayEpisodes = episodes.filter(e => e.timestamp >= startOfDay && e.timestamp < endOfDay);

		// Fetch effectiveness data for episodes (batched query)
		const effectivenessMap = new Map<string, EpisodeEffectiveness | undefined>();
		const allEff = await this.#effectivenessStore.getMany(dayEpisodes.map(e => e.id));
		for (const eff of allEff) {
			effectivenessMap.set(eff.episodeId, eff);
		}
		const effectivenessResults = dayEpisodes.map(e => effectivenessMap.get(e.id));

		const sessions = dayEpisodes.map((e, i) => ({
			sessionId: e.sessionId,
			userPrompt: e.userPrompt,
			toolCallCount: e.toolCallCount,
			errorCount: e.errorCount,
			completedSuccessfully: e.completedSuccessfully,
			errors: this.#extractErrors(e),
			highlights: this.#extractHighlights(e, effectivenessResults[i]),
		}));

		const topErrorPatterns = this.#buildErrorPatterns(dayEpisodes);
		const topTools = this.#buildTopTools(dayEpisodes);
		const keyMoments = this.#buildKeyMoments(dayEpisodes);

		const allLearnings = await this.#learningStore.listAll();
		const newLearnings = allLearnings.filter(l => l.createdAt >= startOfDay && l.createdAt < endOfDay);

		const allSkills = await this.#skillStore.list();
		const skillsToday = allSkills
			.filter(
				s =>
					(s.createdAt >= startOfDay && s.createdAt < endOfDay) ||
					(s.lastOptimizedAt !== undefined && s.lastOptimizedAt >= startOfDay && s.lastOptimizedAt < endOfDay),
			)
			.map(s => {
				const wasCreated = s.createdAt >= startOfDay && s.createdAt < endOfDay;
				const wasUpdated =
					s.lastOptimizedAt !== undefined && s.lastOptimizedAt >= startOfDay && s.lastOptimizedAt < endOfDay;
				return { skill: s, wasCreatedToday: wasCreated, wasUpdatedToday: wasUpdated } as SkillDayEntry;
			});

		const totalSessions = dayEpisodes.length;
		const successfulSessions = dayEpisodes.filter(e => e.completedSuccessfully).length;
		const failedSessions = dayEpisodes.filter(e => !e.completedSuccessfully && e.errorCount > 0).length;
		const emptySessions = dayEpisodes.filter(
			e => !e.completedSuccessfully && e.errorCount === 0 && e.toolCallCount === 0,
		).length;
		const partialSessions = dayEpisodes.filter(
			e => !e.completedSuccessfully && e.errorCount === 0 && e.toolCallCount > 0,
		).length;

		return {
			date: this.#formatDate(targetDate),
			totalSessions,
			successfulSessions,
			failedSessions,
			emptySessions,
			partialSessions,
			sessions,
			topErrorPatterns,
			newLearnings,
			topTools,
			keyMoments,
			skillsToday: skillsToday as DailyReport["skillsToday"],
			injectionEffectiveness: await this.#computeInjectionEffectiveness(allSkills, allLearnings),
		};
	}

	async #computeInjectionEffectiveness(
		skills: EvolvedSkill[],
		learnings: Learning[],
	): Promise<DailyReport["injectionEffectiveness"]> {
		const injectedSkills = skills.filter(s => s.usageCount > 0);
		const skillHelpRates = injectedSkills.map(s => {
			const total = s.successCount + s.failureCount;
			const rate = total > 0 ? s.successCount / total : null;
			return {
				name: s.name,
				version: s.version,
				qualityScore: s.qualityScore,
				usageCount: s.usageCount,
				helpRate: rate !== null ? `${(rate * 100).toFixed(0)}%` : "N/A",
			};
		});

		const injectedLearnings = learnings.filter(l => l.timesInjected > 0);
		const learningHelpRates = injectedLearnings.map(l => ({
			content: l.content.slice(0, 60),
			confidence: l.confidence,
			timesInjected: l.timesInjected,
			helpRate: l.timesInjected > 0 ? `${((l.timesHelped / l.timesInjected) * 100).toFixed(0)}%` : "N/A",
		}));

		return {
			skillCount: injectedSkills.length,
			skillRates: skillHelpRates,
			learningCount: injectedLearnings.length,
			learningRates: learningHelpRates,
		};
	}

	formatReport(report: DailyReport): string {
		const lines: string[] = [];

		// ── Header ──
		lines.push(`# 进化日报: ${report.date}`);
		lines.push("");
		lines.push(
			`## 会话概览: ${report.totalSessions} 次会话 = ${report.successfulSessions} 成功 + ${report.failedSessions} 失败 + ${report.emptySessions} 空 + ${report.partialSessions} 部分完成`,
		);
		lines.push("");

		// ── 1. 今日采纳的进化 ──
		lines.push("## 1. 今日采纳的进化");
		const created = report.skillsToday.filter(s => s.wasCreatedToday);
		const updated = report.skillsToday.filter(s => !s.wasCreatedToday && s.wasUpdatedToday);

		if (created.length === 0 && updated.length === 0 && report.newLearnings.length === 0) {
			lines.push("_今日无新采纳的进化。_");
		}

		if (created.length > 0) {
			lines.push("### 新提取的技能");
			for (const entry of created) {
				const s = entry.skill;
				lines.push(`- **${s.name}** v${s.version} (质量: ${s.qualityScore ?? "N/A"})`);
				lines.push(`  - **做什么**: ${s.taskPattern.slice(0, 200)}`);
				lines.push(`  - **怎么做**: ${s.approach.slice(0, 300)}`);
				if (s.tools.length > 0) {
					lines.push(`  - **使用工具**: ${s.tools.join(", ")}`);
				}
				if (s.pitfalls.length > 0) {
					lines.push(`  - **注意陷阱**: ${s.pitfalls.join("; ")}`);
				}
			}
		}

		if (updated.length > 0) {
			lines.push("### 优化的技能");
			for (const entry of updated) {
				const s = entry.skill;
				lines.push(
					`- **${s.name}** v${s.version} (自上次优化后使用 ${s.usageCount}x, 质量: ${s.qualityScore ?? "N/A"})`,
				);
				lines.push(`  - **优化后的做法**: ${s.approach.slice(0, 200)}`);
			}
		}

		if (report.newLearnings.length > 0) {
			lines.push("### 新提取的学习");
			for (const l of report.newLearnings) {
				lines.push(`- [${l.kind}] ${l.content} (置信度: ${l.confidence}/5, 状态: ${l.lifecycle})`);
			}
		}
		lines.push("");

		// ── 2. 已采纳进化的收益 ──
		lines.push("## 2. 已采纳进化的收益");

		const eff = report.injectionEffectiveness;
		if (eff.skillCount > 0) {
			lines.push(`### 技能注入表现 (${eff.skillCount} 个技能被注入过)`);
			for (const r of eff.skillRates) {
				lines.push(
					`- **${r.name}** v${r.version}: 注入 ${r.usageCount}x, 帮助率 ${r.helpRate}, 质量分 ${r.qualityScore ?? "?"}`,
				);
			}
		} else {
			lines.push("_尚无技能被注入过。_");
		}

		if (eff.learningCount > 0) {
			lines.push("");
			lines.push(`### 学习注入表现 (${eff.learningCount} 条学习被注入过)`);
			for (const r of eff.learningRates) {
				lines.push(`- "${r.content}...": 注入 ${r.timesInjected}x, 帮助率 ${r.helpRate}`);
			}
		} else {
			lines.push("");
			lines.push("_尚无学习被注入过。_");
		}
		lines.push("");

		// ── 3. 关键事件 ──
		lines.push("## 3. 关键事件");
		const moments = report.keyMoments.slice(0, 10);
		if (moments.length === 0) {
			lines.push("_今日无关键事件。_");
		} else {
			for (const m of moments) {
				const time = new Date(m.timestamp).toISOString();
				const label =
					m.type === "error" ? "失败" : m.type === "recovery" ? "恢复" : m.type === "success" ? "成功" : "修正";
				lines.push(`- **${label}** (${time}): ${m.description}`);
			}
		}
		lines.push("");

		// ── 4. 待解决问题 ──
		if (report.topErrorPatterns.length > 0) {
			lines.push("## 4. 待解决问题");
			for (const p of report.topErrorPatterns) {
				lines.push(`- **${p.name}**: ${p.description} (${p.count} 次, ${p.affectedSessions.length} 个会话)`);
			}
			lines.push("");
		}

		// ── 5. 会话明细 ──
		lines.push("## 5. 会话明细");
		for (const s of report.sessions) {
			const status = s.completedSuccessfully ? "OK" : s.errorCount > 0 ? "FAIL" : "PARTIAL";
			lines.push(`### ${status} ${s.sessionId.slice(0, 16)}...`);
			lines.push(`- **需求**: ${s.userPrompt.slice(0, 200)}${s.userPrompt.length > 200 ? "..." : ""}`);
			lines.push(`- **工具调用**: ${s.toolCallCount} 次`);
			if (s.errorCount > 0) {
				lines.push(`- **错误**: ${s.errorCount} 次`);
			}
			if (s.highlights.length > 0) {
				lines.push(`- **要点**: ${s.highlights.join(", ")}`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	#extractErrors(episode: Episode): string[] {
		if (episode.errorCount === 0) {
			return [];
		}
		const outcomeMatch = episode.summary.match(/Outcome: (.+)$/);
		if (outcomeMatch) {
			const outcome = outcomeMatch[1];
			if (outcome?.includes("error")) {
				return [outcome];
			}
		}
		return [`${episode.errorCount} error(s) occurred`];
	}

	#extractHighlights(episode: Episode, effectiveness?: import("./types").EpisodeEffectiveness): string[] {
		const highlights: string[] = [];
		if (episode.completedSuccessfully) {
			highlights.push("Completed successfully");
		}
		if (episode.hadRecovery) {
			highlights.push("Recovered from errors");
		}
		if (episode.errorCount > 0) {
			highlights.push(`${episode.errorCount} error(s)`);
		}
		if (episode.toolCallCount === 0) {
			highlights.push("No tool calls");
		}
		if (episode.toolsUsed.length > 5) {
			highlights.push("High tool variety");
		}
		if (effectiveness && effectiveness.timesHelped > 0) {
			highlights.push("Previously helped similar sessions");
		}
		return highlights;
	}

	#buildErrorPatterns(episodes: Episode[]): ErrorPattern[] {
		const errorEpisodes = episodes.filter(e => e.errorCount > 0);
		if (errorEpisodes.length === 0) {
			return [];
		}
		const patterns: ErrorPattern[] = [];
		const grouped = new Map<string, Episode[]>();
		for (const e of errorEpisodes) {
			const category = this.#categorizeError(e);
			const list = grouped.get(category) ?? [];
			list.push(e);
			grouped.set(category, list);
		}
		for (const [category, eps] of grouped) {
			const count = eps.reduce((sum, e) => sum + e.errorCount, 0);
			const timestamps = eps.map(e => e.timestamp);
			patterns.push({
				id: `daily-${category}-${Math.min(...timestamps)}`,
				name: `${this.#capitalize(category)} Error`,
				description: `Errors detected in ${eps.length} session(s) categorized as ${category}`,
				regex: `failed with \\d+ error\\(s\\)`,
				category: this.#mapCategory(category),
				affectedSessions: eps.map(e => e.sessionId),
				count,
				firstSeenAt: Math.min(...timestamps),
				lastSeenAt: Math.max(...timestamps),
				extractedConventions: [],
			});
		}
		return patterns.sort((a, b) => b.count - a.count);
	}

	#categorizeError(episode: Episode): string {
		const prompt = episode.userPrompt.toLowerCase();
		if (prompt.includes("type") || prompt.includes("typescript") || prompt.includes("typecheck")) return "type";
		if (prompt.includes("syntax") || prompt.includes("parse")) return "syntax";
		if (prompt.includes("not found") || prompt.includes("missing") || prompt.includes("cannot find"))
			return "not_found";
		if (prompt.includes("permission") || prompt.includes("access denied")) return "permission";
		if (prompt.includes("format") || prompt.includes("lint")) return "format";
		return "other";
	}

	#mapCategory(category: string): ErrorPattern["category"] {
		switch (category) {
			case "type":
				return "type";
			case "syntax":
				return "syntax";
			case "not_found":
				return "not_found";
			case "permission":
				return "permission";
			case "format":
				return "format";
			default:
				return "other";
		}
	}

	#capitalize(s: string): string {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}

	#buildTopTools(episodes: Episode[]): Array<{ tool: string; count: number }> {
		const counts = new Map<string, number>();
		for (const e of episodes) {
			for (const tool of e.toolsUsed) {
				counts.set(tool, (counts.get(tool) ?? 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.map(([tool, count]) => ({ tool, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);
	}

	#buildKeyMoments(episodes: Episode[]): Array<{
		type: "error" | "recovery" | "success" | "correction";
		sessionId: string;
		description: string;
		timestamp: number;
	}> {
		const moments: Array<{
			type: "error" | "recovery" | "success" | "correction";
			sessionId: string;
			description: string;
			timestamp: number;
		}> = [];
		for (const e of episodes) {
			if (e.errorCount > 0) {
				moments.push({
					type: "error",
					sessionId: e.sessionId,
					description: `Session failed with ${e.errorCount} error(s): ${e.userPrompt.slice(0, 100)}${e.userPrompt.length > 100 ? "..." : ""}`,
					timestamp: e.timestamp,
				});
			}
			if (e.hadRecovery) {
				moments.push({
					type: "recovery",
					sessionId: e.sessionId,
					description: `Session recovered from errors: ${e.userPrompt.slice(0, 100)}${e.userPrompt.length > 100 ? "..." : ""}`,
					timestamp: e.timestamp,
				});
			}
			if (e.completedSuccessfully) {
				moments.push({
					type: "success",
					sessionId: e.sessionId,
					description: `Session completed successfully: ${e.userPrompt.slice(0, 100)}${e.userPrompt.length > 100 ? "..." : ""}`,
					timestamp: e.timestamp,
				});
			}
			if (this.#isCorrectionPrompt(e.userPrompt)) {
				moments.push({
					type: "correction",
					sessionId: e.sessionId,
					description: `User requested correction: ${e.userPrompt.slice(0, 100)}${e.userPrompt.length > 100 ? "..." : ""}`,
					timestamp: e.timestamp,
				});
			}
		}
		return moments.sort((a, b) => a.timestamp - b.timestamp).slice(0, 10);
	}

	#isCorrectionPrompt(prompt: string): boolean {
		const lower = prompt.toLowerCase();
		return CORRECTION_KEYWORDS.some(kw => lower.includes(kw));
	}

	#formatDate(date: Date): string {
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
}
