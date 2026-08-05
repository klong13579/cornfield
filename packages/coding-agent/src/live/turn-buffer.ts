/**
 * LiveTurnBuffer — dedup buffer for finalized user voice turns (P1 design §7).
 *
 * One utterance = one record in the main session. query/chat utterances are
 * recorded by the transcript recorder; task utterances are recorded by the
 * main-session injection itself (and confirmation answers are consumed by the
 * gate). The buffer holds a finalized user transcript until intent
 * classification resolves, then flushes (record) or drops (suppress).
 */

export interface TurnBufferTarget {
	record(transcript: { role: "user" | "assistant"; text: string; final: boolean }): void;
}

const DEFAULT_FLUSH_AFTER_MS = 5_000;

export class LiveTurnBuffer {
	readonly #target: TurnBufferTarget;
	readonly #flushAfterMs: number;
	#pending: { text: string; timer: ReturnType<typeof setTimeout> } | undefined;

	constructor(target: TurnBufferTarget, flushAfterMs: number = DEFAULT_FLUSH_AFTER_MS) {
		this.#target = target;
		this.#flushAfterMs = flushAfterMs;
	}

	get pending(): boolean {
		return this.#pending !== undefined;
	}

	/** Hold a finalized user utterance until intent classification resolves. */
	hold(text: string): void {
		this.drop();
		const timer = setTimeout(() => this.flush(), this.#flushAfterMs);
		timer.unref?.();
		this.#pending = { text, timer };
	}

	/** Record the held utterance (query/chat path, direct-answer signal, shutdown). */
	flush(): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		clearTimeout(pending.timer);
		this.#target.record({ role: "user", text: pending.text, final: true });
	}

	/** Discard the held utterance (task injection / confirm answer is the canonical record). */
	drop(): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		clearTimeout(pending.timer);
	}
}
