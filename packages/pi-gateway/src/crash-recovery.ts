/**
 * CrashRecovery — tracks agent process crashes and orchestrates restart with backoff.
 *
 * State machine (3 states, borrowed from openclaw's agent_lifecycle_manager):
 *   active    — normal operation; failures count up within a sliding window
 *   timeout   — soft-warning band (5+ crashes in window); transport keeps
 *               restarting but the bridge surfaces the warning to status
 *               and crash log so an operator can see instability before
 *               the bridge is fully suppressed
 *   suppressed — hard-stop (10+ crashes in window); bridge refuses
 *               further restarts until `reset()` is called or a new
 *               transport is started
 *
 * Recovery uses exponential backoff with a hard cap (60s) so a long-lived
 * agent doesn't grow its backoff to multi-minute waits. A restart callback
 * is supplied by the bridge because restart touches transport-level
 * concerns.
 */

import { logger } from "@oh-my-pi/pi-utils";

export type CrashState = "active" | "timeout" | "suppressed";

export interface CrashRecoveryConfig {
	windowMs: number;
	windowLimit: number;
	timeoutThreshold: number;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export interface CrashRecoverySnapshot {
	count: number;
	windowCount: number;
	state: CrashState;
	suppressed: boolean;
	timeout: boolean;
}

type RestartFn = () => Promise<void>;

const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_WINDOW_LIMIT = 10;
const DEFAULT_TIMEOUT_THRESHOLD = 5;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

/**
 * Compute the backoff delay for the Nth retry.
 *
 * Formula: min(baseDelay * 2^(n-1), maxDelay)
 * Sequence (base=2s, max=60s): 2, 4, 8, 16, 32, 60, 60, ...
 *
 * Mirrors openclaw's `RETRY_BACKOFF_BASE ** retry_count` shape (with a cap
 * to bound long-term backoff growth).
 */
export function computeBackoffMs(retryIndex: number, baseDelayMs: number, maxDelayMs: number): number {
	if (retryIndex < 1) return baseDelayMs;
	const delay = baseDelayMs * 2 ** (retryIndex - 1);
	return Math.min(delay, maxDelayMs);
}

export class CrashRecovery {
	#count = 0;
	#timestamps: number[] = [];
	#suppressed = false;
	#ready = false;
	#lastActivityAt = 0;
	readonly #windowMs: number;
	readonly #windowLimit: number;
	readonly #timeoutThreshold: number;
	readonly #maxRetries: number;
	readonly #baseDelayMs: number;
	readonly #maxDelayMs: number;
	readonly #restart: RestartFn;

	constructor(restart: RestartFn, config?: Partial<CrashRecoveryConfig>) {
		this.#restart = restart;
		this.#windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
		this.#windowLimit = config?.windowLimit ?? DEFAULT_WINDOW_LIMIT;
		this.#timeoutThreshold = config?.timeoutThreshold ?? DEFAULT_TIMEOUT_THRESHOLD;
		this.#maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.#baseDelayMs = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
		this.#maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	}

	/** Current 3-state classification. `suppressed` is a strict subset. */
	get state(): CrashState {
		if (this.#suppressed) return "suppressed";
		if (this.#windowCount() >= this.#timeoutThreshold) return "timeout";
		return "active";
	}

	/** Whether the bridge should refuse to start. */
	get suppressed(): boolean {
		return this.#suppressed;
	}

	/** Whether the bridge is in the soft-warning band. */
	get timeout(): boolean {
		return this.state === "timeout";
	}

	/** Set the bridge's ready flag (e.g. when transport emits `ready`). */
	setReady(ready: boolean): void {
		this.#ready = ready;
		if (ready) {
			// Reaching ready counts as liveness — record the timestamp so
			// operators can see how long the agent has been alive.
			this.#lastActivityAt = Date.now();
		}
	}

	get ready(): boolean {
		return this.#ready;
	}

	get lastActivityAt(): number {
		return this.#lastActivityAt;
	}

	/** Classify an error as a crash (process exited, not ready, not running). */
	static isCrashError(err: unknown): boolean {
		if (err instanceof Error) {
			const msg = err.message;
			return msg.includes("exited") || msg.includes("before ready") || msg.includes("not running");
		}
		return false;
	}

	/** Record a crash event. May transition to suppressed state. */
	recordCrash(): boolean {
		const now = Date.now();
		this.#timestamps.push(now);
		this.#timestamps = this.#timestamps.filter(t => now - t <= this.#windowMs);
		const windowCount = this.#timestamps.length;
		if (windowCount > this.#windowLimit) {
			this.#suppressed = true;
			this.#ready = false;
			logger.error("Agent bridge entered ERROR state after repeated crashes", {
				crashes: windowCount,
				windowMs: this.#windowMs,
			});
			return true;
		}
		if (windowCount >= this.#timeoutThreshold) {
			logger.warn("Agent bridge entered timeout band — repeated crashes detected", {
				crashes: windowCount,
				threshold: this.#timeoutThreshold,
				limit: this.#windowLimit,
			});
		}
		return false;
	}

	/** Attempt to restart the agent process with exponential backoff. */
	async attemptRecovery(): Promise<void> {
		if (this.#suppressed) {
			logger.error("Agent bridge recovery suppressed after repeated crashes", {
				crashes: this.#timestamps.length,
			});
			return;
		}
		if (this.#count >= this.#maxRetries) {
			logger.error("Max crash retries exceeded, giving up", {
				crashCount: this.#count,
				maxRetries: this.#maxRetries,
			});
			return;
		}

		this.#count++;
		const delay = computeBackoffMs(this.#count, this.#baseDelayMs, this.#maxDelayMs);
		logger.warn("Agent process crashed, restarting", {
			crashCount: this.#count,
			delayMs: delay,
		});

		if (this.#suppressed) return;
		await Bun.sleep(delay);
		await this.#restart();
	}

	reset(): void {
		this.#count = 0;
		this.#timestamps = [];
		this.#suppressed = false;
		this.#ready = false;
		this.#lastActivityAt = Date.now();
	}

	snapshot(): CrashRecoverySnapshot {
		const windowCount = this.#windowCount();
		const state = this.state;
		return {
			count: this.#count,
			windowCount,
			state,
			suppressed: state === "suppressed",
			timeout: state === "timeout",
		};
	}

	#windowCount(): number {
		const now = Date.now();
		this.#timestamps = this.#timestamps.filter(t => now - t <= this.#windowMs);
		return this.#timestamps.length;
	}
}
