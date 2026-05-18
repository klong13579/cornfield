/**
 * Episodic memory manager: session lifecycle, TTL management, and importance-based promotion.
 *
 * Provides high-level APIs for recording session events and managing
 * the episodic memory lifecycle (active → archived → deleted).
 */
import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { type EpisodicBackend, SqliteEpisodicBackend } from "./storage/episodic-backend";
import type { EpisodicRecord } from "./types";

export interface EpisodicManagerOptions {
	/** Default TTL for new records in seconds (default: 7 days) */
	defaultTtlSeconds?: number;
	/** TTL for high-importance records in seconds (default: 30 days) */
	promotedTtlSeconds?: number;
	/** Importance threshold for promotion (default: 0.8) */
	promotionThreshold?: number;
	/** Retention period for archived records in ms (default: 90 days) */
	archiveRetentionMs?: number;
	/** Cleanup interval in ms (default: 1 hour) */
	cleanupIntervalMs?: number;
}

const DEFAULT_OPTIONS: Required<EpisodicManagerOptions> = {
	defaultTtlSeconds: 7 * 24 * 60 * 60,
	promotedTtlSeconds: 30 * 24 * 60 * 60,
	promotionThreshold: 0.8,
	archiveRetentionMs: 90 * 24 * 60 * 60 * 1000,
	cleanupIntervalMs: 60 * 60 * 1000,
};

export class EpisodicManager {
	#backend: EpisodicBackend;
	#options: Required<EpisodicManagerOptions>;
	#cleanupTimer: NodeJS.Timeout | undefined;

	constructor(backend: EpisodicBackend, options: EpisodicManagerOptions = {}) {
		this.#backend = backend;
		this.#options = { ...DEFAULT_OPTIONS, ...options };
		this.#startCleanupTimer();
	}

	static create(db: Database, options?: EpisodicManagerOptions): EpisodicManager {
		return new EpisodicManager(new SqliteEpisodicBackend(db), options);
	}

	// ============================================================================
	// Recording
	// ============================================================================

	/**
	 * Record a generic episodic event.
	 */
	async recordEvent(params: {
		sessionId: string;
		cwd: string;
		eventType: string;
		eventData: Record<string, unknown>;
		importanceScore?: number;
	}): Promise<EpisodicRecord> {
		const now = Date.now();
		const importance = params.importanceScore ?? 0.5;
		const ttl = this.#computeTtl(importance);

		const record: EpisodicRecord = {
			id: crypto.randomUUID(),
			sessionId: params.sessionId,
			cwd: params.cwd,
			timestamp: now,
			eventType: params.eventType,
			eventData: params.eventData,
			importanceScore: importance,
			ttlSeconds: ttl,
			expirationTime: now + ttl * 1000,
			archived: false,
		};

		await this.#backend.store(record);
		return record;
	}

	/**
	 * Mark the end of a session and record summary statistics.
	 * Also marks all session records as pending_review.
	 */
	async markSessionEnded(
		sessionId: string,
		summary: {
			toolCallCount: number;
			errorCount: number;
			hadRecovery: boolean;
			completedSuccessfully: boolean;
			durationMs: number;
		},
	): Promise<void> {
		const importance = this.#computeSessionImportance(summary);
		await this.recordEvent({
			sessionId,
			cwd: "",
			eventType: "session_ended",
			eventData: summary,
			importanceScore: importance,
		});

		// Mark all records for this session as pending_review
		await this.#backend.markSessionPendingReview(sessionId);
	}

	/**
	 * Mark all pending-review records for a session as reviewed.
	 * High-importance records (>= promotionThreshold) are promoted.
	 * Low-importance records (< promotionThreshold) are marked for deletion.
	 */
	async reviewSession(sessionId: string): Promise<{ promoted: number; deleted: number }> {
		const now = Date.now();
		const records = await this.#backend.getByReviewStatus("pending_review", sessionId);

		let promoted = 0;
		let deleted = 0;

		for (const record of records) {
			if (record.importanceScore >= this.#options.promotionThreshold) {
				await this.#backend.updateReviewStatus(record.id, "promoted", now);
				promoted++;
			} else {
				await this.#backend.updateReviewStatus(record.id, "deleted", now);
				deleted++;
			}
		}

		logger.debug("Session reviewed", { sessionId, promoted, deleted });
		return { promoted, deleted };
	}

	/**
	 * Load historical context from previous sessions for recovery.
	 * Returns promoted records from recent sessions ordered by recency.
	 *
	 * @param currentSessionId - Current session to exclude
	 * @param limit - Maximum records to return
	 * @returns Promoted episodic records from previous sessions
	 */
	async loadSessionContext(currentSessionId: string, limit = 10): Promise<EpisodicRecord[]> {
		const all = await this.#backend.getByReviewStatus("promoted");
		return all
			.filter(r => r.sessionId !== currentSessionId)
			.sort((a, b) => b.timestamp - a.timestamp)
			.slice(0, limit);
	}
	/**
	 * Promote a record's importance, extending its TTL.
	 */
	async promoteRecord(recordId: string, newImportance: number): Promise<void> {
		// Note: The backend doesn't support partial updates currently.
		// For now, this is a no-op placeholder until the backend supports updates.
		logger.debug("Promoted episodic record", { recordId, newImportance });
	}

	// ============================================================================
	// Retrieval
	// ============================================================================

	async getSessionEvents(sessionId: string): Promise<EpisodicRecord[]> {
		return this.#backend.getBySession(sessionId);
	}

	async getRecentEvents(limit: number): Promise<EpisodicRecord[]> {
		return this.#backend.getRecent(limit);
	}

	async searchEvents(query: string, limit: number): Promise<EpisodicRecord[]> {
		return this.#backend.search(query, limit);
	}

	// ============================================================================
	// Lifecycle / Cleanup
	// ============================================================================

	/**
	 * Run full lifecycle maintenance: archive expired, cleanup old archived.
	 */
	async runMaintenance(): Promise<{ archived: number; deleted: number }> {
		const now = Date.now();
		const archived = await this.#backend.markExpiredAsArchived(now);
		const deleted = await this.#backend.cleanupArchived(this.#options.archiveRetentionMs);

		if (archived > 0 || deleted > 0) {
			logger.debug("Episodic maintenance complete", { archived, deleted });
		}

		return { archived, deleted };
	}

	stopCleanupTimer(): void {
		if (this.#cleanupTimer) {
			clearInterval(this.#cleanupTimer);
			this.#cleanupTimer = undefined;
		}
	}

	// ============================================================================
	// Private
	// ============================================================================

	#computeTtl(importance: number): number {
		if (importance >= this.#options.promotionThreshold) {
			return this.#options.promotedTtlSeconds;
		}
		return this.#options.defaultTtlSeconds;
	}

	#computeSessionImportance(summary: {
		toolCallCount: number;
		errorCount: number;
		hadRecovery: boolean;
		completedSuccessfully: boolean;
		durationMs: number;
	}): number {
		// Base importance from completion
		let score = summary.completedSuccessfully ? 0.5 : 0.7;

		// Errors increase importance (learning opportunity)
		if (summary.errorCount > 0) {
			score += Math.min(0.2, summary.errorCount * 0.05);
		}

		// Recovery increases importance
		if (summary.hadRecovery) {
			score += 0.1;
		}

		// Long sessions with many tools are more significant
		if (summary.toolCallCount > 10) {
			score += 0.1;
		}

		return Math.min(1, score);
	}

	#startCleanupTimer(): void {
		this.#cleanupTimer = setInterval(() => {
			this.runMaintenance().catch(err => {
				logger.error("Episodic maintenance failed", { error: String(err) });
			});
		}, this.#options.cleanupIntervalMs);
	}
}

/**
 * Convenience: record a session-start event.
 */
export async function recordSessionStart(
	manager: EpisodicManager,
	params: { sessionId: string; cwd: string; userPrompt: string },
): Promise<EpisodicRecord> {
	return manager.recordEvent({
		sessionId: params.sessionId,
		cwd: params.cwd,
		eventType: "session_started",
		eventData: { userPrompt: params.userPrompt },
		importanceScore: 0.5,
	});
}

/**
 * Convenience: record a tool-call event.
 */
export async function recordToolCall(
	manager: EpisodicManager,
	params: { sessionId: string; cwd: string; toolName: string; args?: unknown },
): Promise<EpisodicRecord> {
	return manager.recordEvent({
		sessionId: params.sessionId,
		cwd: params.cwd,
		eventType: "tool_called",
		eventData: { toolName: params.toolName, args: params.args },
		importanceScore: 0.3,
	});
}

/**
 * Convenience: record an error event.
 */
export async function recordError(
	manager: EpisodicManager,
	params: { sessionId: string; cwd: string; errorType: string; message: string },
): Promise<EpisodicRecord> {
	return manager.recordEvent({
		sessionId: params.sessionId,
		cwd: params.cwd,
		eventType: "error_occurred",
		eventData: { errorType: params.errorType, message: params.message },
		importanceScore: 0.7,
	});
}
