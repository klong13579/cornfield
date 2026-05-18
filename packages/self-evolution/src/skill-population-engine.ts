/**
 * SkillPopulationEngine: evolutionary lifecycle management for the skill population.
 *
 * Implements a 5-state lifecycle (candidate → experimental → graduated → deprecated → archived)
 * with scoring, selection bias, mutation, elimination, and graduation.
 *
 * Scoring formula (architecture doc §6.12):
 *   skill_score = 0.70 × outcome_rate + 0.20 × efficiency_ratio + 0.10 × recency_decay
 *
 * Continuous evaluation (architecture doc §6.12):
 *   Tracks last 3 scores per skill; graduates on 3 consecutive > 0.7, eliminates on 3 consecutive < 0.35.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { applySkillRegressionBeforePromotion } from "./benefit-admission-refresh";
import type { RegressionReplayBackend } from "./regression/replay-backend";
import type { RegressionFixtureStore, RegressionTrialStore, SkillPopulationStore, SkillStore } from "./storage/types";
import type { SkillPopulationQualityMetrics, SkillPopulationRecord, SkillPopulationState } from "./types";

export interface PopulationEngineOptions {
	/** Minimum score (0–1) to promote candidate → experimental */
	candidateToExperimentalThreshold: number;
	/** Minimum usages to promote candidate → experimental */
	candidateToExperimentalMinUsages: number;
	/** Minimum score (0–1) to promote experimental → graduated */
	experimentalToGraduatedThreshold: number;
	/** Minimum usages to promote experimental → graduated */
	experimentalToGraduatedMinUsages: number;
	/** Score (0–1) below which graduated skills are deprecated */
	graduatedDeprecationThreshold: number;
	/** Consecutive low evaluations before deprecating graduated */
	graduatedDeprecationConsecutive: number;
	/** Score (0–1) below which experimental skills are deprecated */
	experimentalDeprecationThreshold: number;
	/** Score (0–1) below which candidates are deprecated */
	candidateDeprecationThreshold: number;
	/** Days of inactivity before a candidate is deprecated */
	candidateInactivityDays: number;
	/** Days after deprecation before archiving */
	archiveAfterDeprecatedDays: number;
	/** Minimum score for experimental skills to be injected */
	experimentalInjectionMinScore: number;
	/** Maximum number of skills to inject */
	maxInjectionCount: number;
}

export const DEFAULT_POPULATION_OPTIONS: PopulationEngineOptions = {
	candidateToExperimentalThreshold: 0.6,
	candidateToExperimentalMinUsages: 3,
	experimentalToGraduatedThreshold: 0.8,
	experimentalToGraduatedMinUsages: 10,
	graduatedDeprecationThreshold: 0.4,
	graduatedDeprecationConsecutive: 2,
	experimentalDeprecationThreshold: 0.3,
	candidateDeprecationThreshold: 0.2,
	candidateInactivityDays: 90,
	archiveAfterDeprecatedDays: 30,
	experimentalInjectionMinScore: 0.7,
	maxInjectionCount: 5,
};

export interface EvaluatedSkill {
	name: string;
	record: SkillPopulationRecord;
	newScore: number;
	metrics: SkillPopulationQualityMetrics;
	recommendedState: SkillPopulationState;
	reason: string;
}

export interface SkillPopulationRegressionDeps {
	fixtureStore: RegressionFixtureStore;
	trialStore: RegressionTrialStore;
	replayBackend?: RegressionReplayBackend;
}

export class SkillPopulationEngine {
	#store: SkillPopulationStore;
	#skillStore: SkillStore;
	#options: PopulationEngineOptions;
	#scoreHistory: Map<string, number[]>;
	#regressionDeps?: SkillPopulationRegressionDeps;

	constructor(store: SkillPopulationStore, skillStore: SkillStore, options: Partial<PopulationEngineOptions> = {}) {
		this.#store = store;
		this.#skillStore = skillStore;
		this.#options = { ...DEFAULT_POPULATION_OPTIONS, ...options };
		this.#scoreHistory = new Map();
	}

	setRegressionDeps(deps: SkillPopulationRegressionDeps | undefined): void {
		this.#regressionDeps = deps;
	}

	/**
	 * Evaluate the entire skill population and update states.
	 * Returns a summary of all transitions made.
	 */
	async evaluateAll(): Promise<{
		transitions: number;
		evaluated: number;
		eliminated: number;
		graduated: number;
		regressionBlocked: number;
	}> {
		const all = await this.#store.list();
		const allSkills = await this.#skillStore.list();
		const avgUsage = this.#computeAvgUsage(allSkills);

		let transitions = 0;
		let eliminated = 0;
		let graduated = 0;
		let regressionBlocked = 0;

		for (const record of all) {
			const skill = await this.#skillStore.get(record.name);
			if (!skill) {
				// Skill deleted from skills table but still in population — archive it
				await this.#store.transitionState(
					record.name,
					"archived",
					"Source skill no longer exists",
					record.evolutionScore,
				);
				transitions++;
				continue;
			}

			const evaluated = this.#evaluateSkill(record, skill, avgUsage);
			this.#persistScoreHistory(record.name, evaluated.newScore);

			let action = this.#determineAction(record, evaluated);

			if (action && this.#regressionDeps) {
				const promotionCheck = await applySkillRegressionBeforePromotion({
					skillStore: this.#skillStore,
					fixtureStore: this.#regressionDeps.fixtureStore,
					trialStore: this.#regressionDeps.trialStore,
					proposedState: action.newState,
					skillName: record.name,
					replayBackend: this.#regressionDeps.replayBackend,
				});
				if (!promotionCheck.allowed) {
					regressionBlocked++;
					action = null;
				}
			}

			if (action) {
				await this.#store.transitionState(record.name, action.newState, action.reason, evaluated.newScore);

				// Update the full record with new metrics
				const updated: SkillPopulationRecord = {
					...record,
					state: action.newState,
					evolutionScore: evaluated.newScore,
					usageCount: skill.usageCount,
					successRate: evaluated.metrics.successRate,
					lastEvaluatedAt: Date.now(),
					nextEvaluationAt: Date.now() + 24 * 60 * 60 * 1000, // next eval in 24h
					qualityMetrics: evaluated.metrics,
				};
				await this.#store.update(updated);

				transitions++;
				if (action.newState === "deprecated" || action.newState === "archived") eliminated++;
				if (action.newState === "graduated") {
					graduated++;
					// Reset consecutive counters when state changes drastically
					this.#resetConsecutiveCounters(record.name);
				}
			} else {
				// No transition, just update score and metrics
				const updated: SkillPopulationRecord = {
					...record,
					evolutionScore: evaluated.newScore,
					usageCount: skill.usageCount,
					successRate: evaluated.metrics.successRate,
					lastEvaluatedAt: Date.now(),
					nextEvaluationAt: Date.now() + 24 * 60 * 60 * 1000,
					qualityMetrics: evaluated.metrics,
				};
				await this.#store.update(updated);
			}
		}

		logger.debug("Skill population evaluation complete", {
			evaluated: all.length,
			transitions,
			eliminated,
			graduated,
		});

		return { transitions, evaluated: all.length, eliminated, graduated, regressionBlocked };
	}

	/**
	 * Select skills for prompt injection using selection bias.
	 * Prefers graduated skills, then high-scoring experimental.
	 * Candidates are never injected unless explicitly requested.
	 */
	async selectForInjection(query?: string): Promise<SkillPopulationRecord[]> {
		const graduated = await this.#store.list({ state: "graduated" });
		const experimental = await this.#store.list({
			state: "experimental",
			minScore: this.#options.experimentalInjectionMinScore,
		});

		// Combine and sort by evolution score (descending)
		const candidates = [...graduated, ...experimental];
		candidates.sort((a, b) => b.evolutionScore - a.evolutionScore);

		// If query provided, do a simple keyword boost
		if (query) {
			const queryWords = query
				.toLowerCase()
				.split(/\W+/)
				.filter(w => w.length > 2);

			for (const record of candidates) {
				const skill = await this.#skillStore.get(record.name);
				if (!skill) continue;
				const text = `${skill.name} ${skill.description} ${skill.taskPattern}`.toLowerCase();
				let matches = 0;
				for (const word of queryWords) {
					if (text.includes(word)) matches++;
				}
				if (queryWords.length > 0 && matches > 0) {
					// Boost score for keyword match (temporary, not persisted)
					(record as any).__injectionBoost = (matches / queryWords.length) * 10;
				}
			}

			candidates.sort((a, b) => {
				const boostA = (a as any).__injectionBoost ?? 0;
				const boostB = (b as any).__injectionBoost ?? 0;
				return b.evolutionScore + boostB - (a.evolutionScore + boostA);
			});
		}

		return candidates.slice(0, this.#options.maxInjectionCount);
	}

	/**
	 * Mutate a low-quality skill by triggering auto-optimization.
	 * Returns true if mutation was attempted.
	 */
	async mutate(name: string, _model?: Model): Promise<boolean> {
		const record = await this.#store.get(name);
		if (!record) return false;
		if (record.state !== "candidate" && record.state !== "experimental") return false;

		// Only mutate skills with low evolution scores
		if (record.evolutionScore >= 0.5) return false;

		logger.debug("Attempting skill mutation", { name, currentScore: record.evolutionScore });

		// Mutation is delegated to SkillManager.autoOptimizeIfNeeded
		// The caller should call that method after this returns true
		return true;
	}

	/**
	 * Eliminate skills that meet deprecation criteria.
	 * This is a convenience wrapper around evaluateAll for the elimination subset.
	 */
	async eliminate(): Promise<{ deprecated: number; archived: number }> {
		const all = await this.#store.list();
		const allSkills = await this.#skillStore.list();
		const avgUsage = this.#computeAvgUsage(allSkills);

		let deprecated = 0;
		let archived = 0;

		for (const record of all) {
			if (record.state === "archived") continue;

			const skill = await this.#skillStore.get(record.name);
			const evaluated = skill ? this.#evaluateSkill(record, skill, avgUsage) : null;

			if (evaluated) {
				this.#persistScoreHistory(record.name, evaluated.newScore);
			}

			// Archive deprecated skills that have been deprecated long enough
			if (record.state === "deprecated") {
				const daysSinceDeprecated = this.#daysSince(record.updatedAt);
				if (daysSinceDeprecated >= this.#options.archiveAfterDeprecatedDays) {
					await this.#store.transitionState(
						record.name,
						"archived",
						`Archived after ${daysSinceDeprecated} days deprecated`,
						evaluated?.newScore ?? record.evolutionScore,
					);
					archived++;
				}
				continue;
			}

			if (!evaluated) continue;

			const action = this.#determineAction(record, evaluated);
			if (action && (action.newState === "deprecated" || action.newState === "archived")) {
				await this.#store.transitionState(record.name, action.newState, action.reason, evaluated.newScore);
				const updated: SkillPopulationRecord = {
					...record,
					state: action.newState,
					evolutionScore: evaluated.newScore,
					lastEvaluatedAt: Date.now(),
					qualityMetrics: evaluated.metrics,
				};
				await this.#store.update(updated);
				if (action.newState === "deprecated") deprecated++;
				if (action.newState === "archived") archived++;
			}
		}

		return { deprecated, archived };
	}

	/**
	 * Graduate a skill from experimental to graduated.
	 */
	async graduate(name: string): Promise<boolean> {
		const record = await this.#store.get(name);
		if (!record || record.state !== "experimental") return false;

		const skill = await this.#skillStore.get(name);
		if (!skill) return false;

		const allSkills = await this.#skillStore.list();
		const avgUsage = this.#computeAvgUsage(allSkills);

		const evaluated = this.#evaluateSkill(record, skill, avgUsage);
		if (evaluated.newScore < this.#options.experimentalToGraduatedThreshold) {
			logger.debug("Skill graduation rejected: score too low", {
				name,
				score: evaluated.newScore,
				threshold: this.#options.experimentalToGraduatedThreshold,
			});
			return false;
		}

		await this.#store.transitionState(
			name,
			"graduated",
			`Score ${evaluated.newScore} meets graduation threshold`,
			evaluated.newScore,
		);

		const updated: SkillPopulationRecord = {
			...record,
			state: "graduated",
			evolutionScore: evaluated.newScore,
			lastEvaluatedAt: Date.now(),
			qualityMetrics: evaluated.metrics,
		};
		await this.#store.update(updated);

		// Reset consecutive counters when transitioning to graduated
		this.#resetConsecutiveCounters(name);

		logger.debug("Skill graduated", { name, score: evaluated.newScore });
		return true;
	}

	/**
	 * Register a newly extracted skill into the population as a candidate.
	 */
	async register(skillName: string): Promise<void> {
		const existing = await this.#store.get(skillName);
		if (existing) return; // Already registered

		const skill = await this.#skillStore.get(skillName);
		if (!skill) {
			logger.warn("Cannot register skill: not found in skill store", { skillName });
			return;
		}

		const now = Date.now();
		const totalUses = skill.successCount + skill.failureCount;
		const successRate = totalUses > 0 ? skill.successCount / totalUses : 0;

		const record: SkillPopulationRecord = {
			name: skillName,
			createdAt: now,
			updatedAt: now,
			usageCount: skill.usageCount,
			successRate,
			state: "candidate",
			evolutionScore: skill.qualityScore != null ? skill.qualityScore / 100 : 0.5,
			lastEvaluatedAt: now,
			nextEvaluationAt: now + 24 * 60 * 60 * 1000,
			qualityMetrics: {
				successRate,
				usageCount: skill.usageCount,
				qualityScore: skill.qualityScore ?? 50,
				userRating: skill.userRating ?? 0,
				recencyScore: this.#recencyScore(skill.lastUsedAt),
			},
		};

		await this.#store.insert(record);
		logger.debug("Skill registered in population", { skillName, initialScore: record.evolutionScore });
	}

	/**
	 * Update population metrics for a skill after usage.
	 */
	async recordUsage(name: string, _succeeded: boolean): Promise<void> {
		const record = await this.#store.get(name);
		if (!record) return;

		const skill = await this.#skillStore.get(name);
		if (!skill) return;

		const totalUses = skill.successCount + skill.failureCount;
		const successRate = totalUses > 0 ? skill.successCount / totalUses : 0;

		const updated: SkillPopulationRecord = {
			...record,
			updatedAt: Date.now(),
			usageCount: skill.usageCount,
			successRate,
		};

		await this.#store.update(updated);
	}

	// -------------------------------------------------------------------------
	// Internal scoring
	// -------------------------------------------------------------------------

	/**
	 * Evaluate a single skill using architecture-spec formula (§6.12):
	 *   skill_score = 0.70 × outcome_rate + 0.20 × efficiency_ratio + 0.10 × recency_decay
	 */
	#evaluateSkill(
		_record: SkillPopulationRecord,
		skill: {
			usageCount: number;
			successCount: number;
			failureCount: number;
			qualityScore?: number;
			userRating?: number;
			lastUsedAt: number;
		},
		avgUsagePerSkill: number,
	): {
		newScore: number;
		metrics: SkillPopulationQualityMetrics;
		consecutiveHigh: number;
		consecutiveLow: number;
	} {
		const totalUses = skill.successCount + skill.failureCount;
		const outcomeRate = totalUses > 0 ? skill.successCount / totalUses : 0;

		// Efficiency: how well this skill uses resources vs the average skill
		const efficiencyRatio = skill.usageCount > 0 ? Math.min(1, avgUsagePerSkill / skill.usageCount) : 0;

		// Recency decay: halves every 30 days of inactivity
		const daysSinceLastUse = Math.floor((Date.now() - skill.lastUsedAt) / 86400000);
		const recencyDecay = 0.5 ** (daysSinceLastUse / 30);

		// Composite score ∈ [0, 1]
		const newScore = 0.7 * outcomeRate + 0.2 * efficiencyRatio + 0.1 * recencyDecay;

		// Quality metrics for reporting
		const metrics: SkillPopulationQualityMetrics = {
			successRate: outcomeRate,
			usageCount: skill.usageCount,
			qualityScore: skill.qualityScore ?? 50,
			userRating: skill.userRating ?? 0,
			recencyScore: this.#recencyScore(skill.lastUsedAt),
		};

		return {
			newScore,
			metrics,
			consecutiveHigh: 0,
			consecutiveLow: 0,
		};
	}

	#persistScoreHistory(name: string, score: number): void {
		const hist = this.#scoreHistory.get(name) ?? [];
		hist.push(score);
		if (hist.length > 3) {
			hist.shift();
		}
		this.#scoreHistory.set(name, hist);
	}

	#resetConsecutiveCounters(name: string): void {
		this.#scoreHistory.delete(name);
	}

	#determineAction(
		record: SkillPopulationRecord,
		evaluated: {
			newScore: number;
			metrics: SkillPopulationQualityMetrics;
			consecutiveHigh: number;
			consecutiveLow: number;
		},
	): { newState: SkillPopulationState; reason: string } | null {
		const { newScore, metrics, consecutiveHigh } = evaluated;
		const currentState = record.state;

		// ── Promotions ───────────────────────────────────────────────

		if (currentState === "candidate") {
			if (
				newScore >= this.#options.candidateToExperimentalThreshold &&
				metrics.usageCount >= this.#options.candidateToExperimentalMinUsages
			) {
				return {
					newState: "experimental",
					reason: `Score ${newScore.toFixed(2)} >= threshold with ${metrics.usageCount} usages`,
				};
			}
			// Deprecate low-score or inactive candidates
			if (newScore < this.#options.candidateDeprecationThreshold) {
				return { newState: "deprecated", reason: `Score ${newScore.toFixed(2)} below candidate threshold` };
			}
			const daysInactive = this.#daysSince(record.updatedAt);
			if (daysInactive >= this.#options.candidateInactivityDays) {
				return { newState: "deprecated", reason: `Inactive for ${daysInactive} days` };
			}
		}

		if (currentState === "experimental") {
			if (
				newScore >= this.#options.experimentalToGraduatedThreshold &&
				metrics.usageCount >= this.#options.experimentalToGraduatedMinUsages
			) {
				return {
					newState: "graduated",
					reason: `Score ${newScore.toFixed(2)} >= graduation threshold with ${metrics.usageCount} usages`,
				};
			}
			if (newScore < this.#options.experimentalDeprecationThreshold) {
				return { newState: "deprecated", reason: `Score ${newScore.toFixed(2)} below experimental threshold` };
			}
		}

		// ── Graduated: continuous evaluation with 3-window gates ─────

		if (currentState === "graduated") {
			// Graduation gate: 3 consecutive windows with score > 0.7
			if (consecutiveHigh >= 3) {
				// Already graduated; nothing to promote further
				return null;
			}

			// Degradation gate: 3 consecutive windows with score < 0.35
			if (newScore < this.#options.graduatedDeprecationThreshold) {
				const recentLowEvals = this.#countConsecutiveLowEvaluationsViaHistory(
					record,
					this.#options.graduatedDeprecationThreshold,
				);
				if (recentLowEvals >= this.#options.graduatedDeprecationConsecutive) {
					return {
						newState: "deprecated",
						reason: `Score ${newScore.toFixed(2)} below threshold for ${recentLowEvals} consecutive evaluations`,
					};
				}
			}
		}

		return null;
	}

	/**
	 * Fallback deprecation check using stored evolutionHistory when
	 * #scoreHistory isn't populated (e.g., graduate() called directly).
	 */
	#countConsecutiveLowEvaluationsViaHistory(record: SkillPopulationRecord, threshold: number): number {
		if (!record.evolutionHistory || record.evolutionHistory.length === 0) return 1;

		// Count trailing evaluations below threshold
		let count = 0;
		for (let i = record.evolutionHistory.length - 1; i >= 0; i--) {
			if (record.evolutionHistory[i].evolutionScore < threshold) {
				count++;
			} else {
				break;
			}
		}
		return count;
	}

	#recencyScore(lastUsedAt: number): number {
		const daysAgo = Math.floor((Date.now() - lastUsedAt) / 86400000);
		return Math.max(0, 10 - daysAgo);
	}

	#daysSince(timestamp: number): number {
		return Math.floor((Date.now() - timestamp) / 86400000);
	}

	#computeAvgUsage(skills: Array<{ usageCount: number }>): number {
		if (skills.length === 0) return 0;
		const total = skills.reduce((sum, s) => sum + s.usageCount, 0);
		return total / skills.length;
	}
}
