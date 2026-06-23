/**
 * ActionRegistry — maps DingTalk AI Card instance IDs to the
 * session / bridge that owns the card, so a TOPIC_CARD action
 * callback (user clicked a button) can be routed back to the right
 * bridge for processing.
 *
 * The registry is populated by the channel's `streamCard` (via the
 * `registerCardAction` context callback) and consulted by the
 * gateway's card-action handler when the channel's TOPIC_CARD
 * listener fires.
 *
 * Entries auto-expire after `expiryMs` (default 30 min) so a stale
 * card action for a long-dead card doesn't accidentally abort a
 * fresh prompt. The `expire()` method returns the number of entries
 * pruned and is meant to be called periodically (e.g. once per
 * minute) by the gateway.
 */
import { logger } from "@oh-my-pi/pi-utils";

/** Per-card routing info stored in the registry. */
export interface CardActionInfo {
	/** Account that owns the card (multi-account routing). */
	accountId: string;
	/** Conversation / session ID the card was sent into. */
	sessionId: string;
	/** Tool that triggered the long-task affordance (e.g. "bash"). */
	toolName?: string;
	/** Wall-clock ms when the card was registered. */
	createdAt: number;
}

/** Input to `register` — the registry fills in `createdAt`. */
export type CardActionInput = Omit<CardActionInfo, "createdAt">;

const DEFAULT_EXPIRY_MS = 30 * 60_000;

export class ActionRegistry {
	readonly #cards = new Map<string, CardActionInfo>();
	readonly #expiryMs: number;

	constructor(expiryMs: number = DEFAULT_EXPIRY_MS) {
		this.#expiryMs = expiryMs;
	}

	/**
	 * Add or replace an entry. Idempotent — re-registering the same
	 * `cardInstanceId` (e.g. when the stop block is pushed and we want
	 * to patch in the toolName) overwrites the previous entry but
	 * keeps `createdAt` stable so expiry is from the first registration.
	 */
	register(cardInstanceId: string, info: CardActionInput): void {
		const existing = this.#cards.get(cardInstanceId);
		this.#cards.set(cardInstanceId, {
			...info,
			createdAt: existing?.createdAt ?? Date.now(),
		});
	}

	/**
	 * Look up an entry by `cardInstanceId`. Returns `undefined` if
	 * missing or expired (also prunes the expired entry on lookup).
	 */
	lookup(cardInstanceId: string): CardActionInfo | undefined {
		const info = this.#cards.get(cardInstanceId);
		if (!info) return undefined;
		if (this.#isExpired(info)) {
			this.#cards.delete(cardInstanceId);
			logger.debug("[ActionRegistry] pruned expired entry on lookup", {
				cardInstanceId,
				accountId: info.accountId,
			});
			return undefined;
		}
		return info;
	}

	/** Remove an entry. Returns whether an entry was present. */
	unregister(cardInstanceId: string): boolean {
		return this.#cards.delete(cardInstanceId);
	}

	/** Prune all expired entries. Returns the count pruned. */
	expire(): number {
		const now = Date.now();
		let count = 0;
		for (const [id, info] of this.#cards.entries()) {
			if (now - info.createdAt > this.#expiryMs) {
				this.#cards.delete(id);
				count++;
			}
		}
		if (count > 0) {
			logger.debug("[ActionRegistry] pruned expired entries", { count, remaining: this.#cards.size });
		}
		return count;
	}

	/** Total entries (including expired-but-not-yet-pruned). */
	get size(): number {
		return this.#cards.size;
	}

	/** Expiry window in ms. */
	get expiryMs(): number {
		return this.#expiryMs;
	}

	#isExpired(info: CardActionInfo): boolean {
		return Date.now() - info.createdAt > this.#expiryMs;
	}
}
