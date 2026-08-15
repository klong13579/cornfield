/**
 * CircuitBreaker — protects AgentBridge from cascading failures.
 *
 * Three states:
 *   closed   — normal operation; failures count up
 *   open     — fast-fail; after COOLDOWN_MS, transitions to half-open
 *   half-open — probe; next success closes, next failure re-opens
 *
 * Pure state machine. No I/O, no side effects beyond logging.
 * The bridge holds an instance and calls canAttempt() before each prompt,
 * recordSuccess() / recordFailure() after each prompt.
 */

import { logger } from "@oh-my-pi/pi-utils";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
	/** Number of consecutive failures before opening. */
	failureThreshold: number;
	/** Cooldown before transitioning open → half-open. */
	cooldownMs: number;
}

export interface CircuitBreakerSnapshot {
	state: CircuitState;
	failures: number;
	openedAt?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 20;
const DEFAULT_COOLDOWN_MS = 60_000;

export class CircuitBreaker {
	#state: CircuitState = "closed";
	#failures = 0;
	#openedAt = 0;
	readonly #failureThreshold: number;
	readonly #cooldownMs: number;

	constructor(config?: Partial<CircuitBreakerConfig>) {
		this.#failureThreshold = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
		this.#cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	/** Whether a new prompt may be attempted. */
	canAttempt(now: number = Date.now()): boolean {
		if (this.#state !== "open") return true;
		if (now - this.#openedAt >= this.#cooldownMs) {
			this.#state = "half-open";
			return true;
		}
		return false;
	}

	/** Mark a successful prompt — closes the circuit. */
	recordSuccess(): void {
		this.#state = "closed";
		this.#failures = 0;
		this.#openedAt = 0;
	}

	/** Mark a failed prompt — may open the circuit. */
	recordFailure(): void {
		this.#failures++;
		if (this.#failures >= this.#failureThreshold || this.#state === "half-open") {
			this.#state = "open";
			this.#openedAt = Date.now();
			logger.warn("Circuit breaker opened", { failures: this.#failures });
		}
	}

	reset(): void {
		this.#state = "closed";
		this.#failures = 0;
		this.#openedAt = 0;
	}

	snapshot(): CircuitBreakerSnapshot {
		return {
			state: this.#state,
			failures: this.#failures,
			openedAt: this.#openedAt || undefined,
		};
	}

	get state(): CircuitState {
		return this.#state;
	}
}
