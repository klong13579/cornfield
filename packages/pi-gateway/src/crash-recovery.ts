/**
 * CrashRecovery — tracks agent process crashes and orchestrates restart with backoff.
 *
 * Sliding-window tracking: each crash is timestamped; old timestamps are pruned.
 * If the window contains more than `windowLimit` crashes, the bridge enters
 * the suppressed state and refuses further restarts.
 *
 * Recovery uses exponential backoff. A restart callback is supplied by the
 * bridge because restart touches transport-level concerns.
 */

import { logger } from "@oh-my-pi/pi-utils";

export interface CrashRecoveryConfig {
	windowMs: number;
	windowLimit: number;
	maxRetries: number;
	baseDelayMs: number;
}

export interface CrashRecoverySnapshot {
	count: number;
	windowCount: number;
	suppressed: boolean;
}

type RestartFn = () => Promise<void>;

const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_WINDOW_LIMIT = 5;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

export class CrashRecovery {
	#count = 0;
	#timestamps: number[] = [];
	#suppressed = false;
	#ready = false;
	readonly #windowMs: number;
	readonly #windowLimit: number;
	readonly #maxRetries: number;
	readonly #baseDelayMs: number;
	readonly #restart: RestartFn;

	constructor(restart: RestartFn, config?: Partial<CrashRecoveryConfig>) {
		this.#restart = restart;
		this.#windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
		this.#windowLimit = config?.windowLimit ?? DEFAULT_WINDOW_LIMIT;
		this.#maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.#baseDelayMs = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	}

	/** Whether the bridge should refuse to start. */
	get suppressed(): boolean {
		return this.#suppressed;
	}

	/** Set the bridge's ready flag (e.g. when transport emits `ready`). */
	setReady(ready: boolean): void {
		this.#ready = ready;
	}

	get ready(): boolean {
		return this.#ready;
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
		if (this.#timestamps.length > this.#windowLimit) {
			this.#suppressed = true;
			this.#ready = false;
			logger.error("Agent bridge entered ERROR state after repeated crashes", {
				crashes: this.#timestamps.length,
			});
			return true;
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
		const delay = this.#baseDelayMs * 2 ** (this.#count - 1);
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
	}

	snapshot(): CrashRecoverySnapshot {
		return {
			count: this.#count,
			windowCount: this.#timestamps.length,
			suppressed: this.#suppressed,
		};
	}
}
