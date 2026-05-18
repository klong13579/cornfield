/**
 * Composite model scoring with recency decay.
 *
 * Scoring formula:
 *   0.35 * successRate + 0.30 * efficiency + 0.20 * recency + 0.15 * consistency
 *
 * Components:
 *   - successRate: ratio of successful sessions to total
 *   - efficiency: inverse of (avgTokens/1000 + avgDurationSec/10), capped at 1.0
 *   - recency: exponential decay based on days since last use (half-life: 7 days)
 *   - consistency: ratio of productive sessions to total, clamped by min sample size
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { SqliteSessionModelStatsStore } from "./storage/session-model-stats";

const DECAY_HALF_LIFE_DAYS = 7;
const RECENCY_HALF_LIFE_DAYS = 7;
const MIN_SAMPLE_SIZE = 20;

export interface ModelScore {
	modelName: string;
	overallScore: number;
	dimensions: {
		successRate: number;
		efficiency: number;
		recency: number;
		consistency: number;
	};
	decayFactor: number;
	totalSessions: number;
	scoredAt: number;
}

export class ModelScorer {
	#statsStore: SqliteSessionModelStatsStore;

	constructor(statsStore: SqliteSessionModelStatsStore) {
		this.#statsStore = statsStore;
	}

	/**
	 * Compute a composite score for a single model.
	 * Returns null if no data exists for the model.
	 */
	async scoreModel(modelName: string): Promise<ModelScore | null> {
		const aggs = await this.#statsStore.getAggregates(modelName);
		if (aggs.totalSessions === 0) {
			return null;
		}

		const successRate = aggs.successRate;
		const efficiency = this.#computeEfficiency(aggs.avgTokens, aggs.avgDuration);
		const daysSinceLastUse = await this.#daysSinceLastUse(modelName);
		const recency = 0.5 ** (daysSinceLastUse / RECENCY_HALF_LIFE_DAYS);
		const consistency = this.#computeConsistency(aggs);

		const baseScore = 0.35 * successRate + 0.3 * efficiency + 0.2 * recency + 0.15 * consistency;

		const decayFactor = 0.5 ** (daysSinceLastUse / DECAY_HALF_LIFE_DAYS);

		const overallScore = Math.round(baseScore * 100 * decayFactor);

		logger.debug("Model scored", {
			modelName,
			overallScore,
			totalSessions: aggs.totalSessions,
		});

		return {
			modelName,
			overallScore,
			dimensions: {
				successRate,
				efficiency,
				recency,
				consistency,
			},
			decayFactor,
			totalSessions: aggs.totalSessions,
			scoredAt: Date.now(),
		};
	}

	#computeEfficiency(avgTokens: number, avgDurationMs: number): number {
		const score = 1 / (avgTokens / 1000 + avgDurationMs / 10000 + 0.1);
		return Math.min(1, score);
	}

	async #daysSinceLastUse(modelName: string): Promise<number> {
		const recent = await this.#statsStore.listByModel(modelName, 1);
		if (recent.length === 0) {
			return 365;
		}
		const msSinceLast = Date.now() - recent[0].timestamp;
		const daysSince = msSinceLast / (24 * 60 * 60 * 1000);
		return Math.max(0, daysSince);
	}

	#computeConsistency(aggs: { totalSessions: number }): number {
		if (aggs.totalSessions === 0) {
			return 0;
		}
		// Consistency is proportion of sessions that reached minimum sample threshold
		return Math.min(1, aggs.totalSessions / MIN_SAMPLE_SIZE);
	}
}
