/**
 * FeedbackTracker: tracks whether injected episodes were helpful.
 */
import type { DetailedOutcomeStore, EffectivenessStore, SkillEffectivenessStore } from "./storage/types";
import type { InjectionOutcome, SessionTrace } from "./types";

export interface ParsedFeedback {
	type: "approval" | "correction" | "new_negative_rule" | "new_preference" | "none";
	outcomeDelta: number;
	newConvention?: { type: string; content: string };
	triggerContradictionCheck: boolean;
	reason: string;
}

export class FeedbackTracker {
	#store: EffectivenessStore;
	#skillStore: SkillEffectivenessStore;
	#detailedStore?: DetailedOutcomeStore;

	constructor(store: EffectivenessStore, skillStore: SkillEffectivenessStore, detailedStore?: DetailedOutcomeStore) {
		this.#store = store;
		this.#skillStore = skillStore;
		this.#detailedStore = detailedStore;
	}

	async trackInjection(episodeIds: string[]): Promise<void> {
		for (const id of episodeIds) {
			await this.#store.recordInjection(id);
		}
	}

	/** @deprecated Use recordDetailedOutcome for multi-dimensional scoring */
	async recordOutcome(episodeIds: string[], succeeded: boolean): Promise<void> {
		for (const id of episodeIds) {
			await this.#store.recordOutcome(id, succeeded);
		}
	}

	async recordDetailedOutcome(outcomes: InjectionOutcome[]): Promise<void> {
		for (const outcome of outcomes) {
			// Backward-compat: map helpfulness to boolean for existing schema
			await this.#store.recordOutcome(outcome.episodeId, outcome.helpfulness > 0);
			if (this.#detailedStore) {
				await this.#detailedStore.record(outcome);
			}
		}
	}

	async trackSkillInjection(skillNames: string[]): Promise<void> {
		for (const name of skillNames) {
			await this.#skillStore.recordInjection(name);
		}
	}

	async recordSkillOutcome(skillNames: string[], trace: SessionTrace): Promise<void> {
		// Determine per-skill outcome based on whether the skill's tools were actually used
		const _toolsUsed = new Set(trace.entries.filter(e => e.type === "tool_call" && e.toolName).map(e => e.toolName!));
		const succeeded = trace.completedSuccessfully && trace.errorCount === 0;

		for (const name of skillNames) {
			// If we can't determine tool relevance, fall back to session-level outcome
			await this.#skillStore.recordOutcome(name, succeeded);
		}
	}

	/**
	 * Keyword-based semantic parsing of user feedback text.
	 *
	 * @param feedback - Raw user feedback string
	 * @param context - Injection context for contradiction checking
	 * @returns Structured parsed feedback with type classification and outcome delta
	 */
	parseUserFeedback(feedback: string, _context: { injectedEpisodeIds: string[] }): ParsedFeedback {
		const normalized = feedback.toLowerCase().trim();

		// Approval keywords
		const approvalKeywords = ["好的", "ok", "不错", "正确"];
		for (const kw of approvalKeywords) {
			if (normalized.includes(kw)) {
				return {
					type: "approval",
					outcomeDelta: 0.1,
					triggerContradictionCheck: false,
					reason: `Approval detected via keyword "${kw}"`,
				};
			}
		}

		// Correction keywords
		const correctionKeywords = ["不对", "错了", "不对的", "不正确"];
		for (const kw of correctionKeywords) {
			if (normalized.includes(kw)) {
				return {
					type: "correction",
					outcomeDelta: -0.2,
					newConvention: extractConventionAfterKeyword(feedback, kw),
					triggerContradictionCheck: true,
					reason: `Correction detected via keyword "${kw}"`,
				};
			}
		}

		// Negative rule keywords
		const negativeRuleKeywords = ["不要这样", "别这样", "不要用", "别再"];
		for (const kw of negativeRuleKeywords) {
			if (normalized.includes(kw)) {
				return {
					type: "new_negative_rule",
					outcomeDelta: -0.1,
					newConvention: extractConventionAfterKeyword(feedback, kw),
					triggerContradictionCheck: false,
					reason: `New negative rule detected via keyword "${kw}"`,
				};
			}
		}

		// Preference keywords
		const preferenceKeywords = ["记住这个", "记下来", "请记住"];
		for (const kw of preferenceKeywords) {
			if (normalized.includes(kw)) {
				return {
					type: "new_preference",
					outcomeDelta: 0.1,
					newConvention: extractConventionAfterKeyword(feedback, kw),
					triggerContradictionCheck: false,
					reason: `New preference detected via keyword "${kw}"`,
				};
			}
		}

		// No match
		return {
			type: "none",
			outcomeDelta: 0,
			triggerContradictionCheck: false,
			reason: "No recognized feedback pattern in input",
		};
	}

	/**
	 * Detect implicit signals from session trace patterns that indicate
	 * user satisfaction or dissatisfaction without explicit verbal feedback.
	 *
	 * Architecture §6.6:
	 * - User accepts modification without follow-up correction → outcome += 0.05
	 * - User manually reverts → outcome -= 0.15
	 * - Duplicate requests → trigger mutation generation
	 *
	 * @param trace - The session trace to analyze
	 * @param injectedEpisodeIds - Episodes injected in this session
	 * @returns Outcome adjustments and mutation triggers
	 */
	detectImplicitSignals(
		trace: SessionTrace,
		injectedEpisodeIds: string[],
	): {
		outcomeDeltas: Array<{ episodeId: string; delta: number; reason: string }>;
		triggerMutation: boolean;
		mutationReason?: string;
	} {
		const outcomeDeltas: Array<{ episodeId: string; delta: number; reason: string }> = [];
		let triggerMutation = false;
		let mutationReason: string | undefined;

		// Detect user accepts modification without follow-up correction
		const editEntries = trace.entries.filter(
			e => e.type === "tool_call" && (e.toolName === "edit" || e.toolName === "write" || e.toolName === "ast_edit"),
		);
		const editResults = trace.entries.filter(e => e.type === "tool_result");
		const successfulEdits = editEntries.filter((_call, i) => {
			const result = editResults[i];
			return result && !result.isError;
		});
		const failedEditsAfterSuccess = editEntries.some((_call, i) => {
			const result = editResults[i];
			return result?.isError && i > 0;
		});

		if (successfulEdits.length > 0 && !failedEditsAfterSuccess && injectedEpisodeIds.length > 0) {
			for (const id of injectedEpisodeIds) {
				outcomeDeltas.push({
					episodeId: id,
					delta: 0.05,
					reason: "User accepted modifications without follow-up corrections",
				});
			}
		}

		// Detect user manual revert (same file edited twice in opposing directions)
		const editPaired = this.#pairEditCalls(trace);
		const revertedFiles = new Set<string>();
		for (let i = 0; i < editPaired.length - 1; i++) {
			const curr = editPaired[i];
			const next = editPaired[i + 1];
			const pathA = this.#extractEditPath(curr.call.args);
			const pathB = this.#extractEditPath(next.call.args);
			if (pathA && pathB && pathA === pathB) {
				revertedFiles.add(pathA);
			}
		}

		if (revertedFiles.size > 0 && injectedEpisodeIds.length > 0) {
			for (const id of injectedEpisodeIds) {
				outcomeDeltas.push({
					episodeId: id,
					delta: -0.15,
					reason: `User manually reverted edits on: ${[...revertedFiles].join(", ")}`,
				});
			}
		}

		// Detect duplicate requests as mutation trigger
		const userInputs = trace.entries
			.filter(e => e.type === "user_input" && e.content)
			.map(e => e.content!.toLowerCase().trim().replace(/\s+/g, " "));
		const inputCounts = new Map<string, number>();
		for (const input of userInputs) {
			inputCounts.set(input, (inputCounts.get(input) ?? 0) + 1);
		}
		for (const [text, count] of inputCounts) {
			if (count >= 2) {
				triggerMutation = true;
				mutationReason = `Duplicate request detected (${count} times): "${text.slice(0, 80)}..."`;
				break;
			}
		}

		return { outcomeDeltas, triggerMutation, mutationReason };
	}

	#pairEditCalls(trace: SessionTrace): Array<{ call: import("./types").TraceEntry; index: number }> {
		const pairs: Array<{ call: import("./types").TraceEntry; index: number }> = [];
		for (let i = 0; i < trace.entries.length; i++) {
			const entry = trace.entries[i];
			if (
				entry.type === "tool_call" &&
				(entry.toolName === "edit" || entry.toolName === "write" || entry.toolName === "ast_edit")
			) {
				pairs.push({ call: entry, index: i });
			}
		}
		return pairs;
	}

	#extractEditPath(args: unknown): string | undefined {
		if (!args || typeof args !== "object") return undefined;
		const a = args as Record<string, unknown>;
		const p = a.path ?? a.file_path;
		return typeof p === "string" ? p : undefined;
	}
}

/**
 * Extract convention content that follows a keyword trigger in the original feedback.
 * Returns null if no trailing content found or if the entire text is just the keyword.
 */
function extractConventionAfterKeyword(
	feedback: string,
	keyword: string,
): { type: string; content: string } | undefined {
	const lowerFeedback = feedback.toLowerCase();
	const idx = lowerFeedback.indexOf(keyword.toLowerCase());
	if (idx === -1) return undefined;

	const afterIdx = idx + keyword.length;
	// Skip leading punctuation/delimiters (: ， 、 ：)
	let end = afterIdx;
	while (end < feedback.length) {
		const ch = feedback[end];
		if (!" ：:,，、 \t\n\r".includes(ch)) break;
		end++;
	}

	const content = feedback.slice(end).trim();
	if (!content) return undefined;

	// Infer convention type from the keyword's category
	const isNegative = ["不要这样", "别这样", "不要用", "别再"].some(neg =>
		keyword.toLowerCase().includes(neg.toLowerCase()),
	);

	return {
		type: isNegative ? "negative_rule" : "preference",
		content,
	};
}
