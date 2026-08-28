import type { ToolChoice } from "@cornfield/ai";

// ── Callback types ──────────────────────────────────────────────────────────

export interface ResolveInfo {
	/** The ToolChoice that was served to the LLM. */
	choice: ToolChoice;
}

export interface RejectInfo {
	/** The ToolChoice that was yielded but never (or unsuccessfully) served. */
	choice: ToolChoice;
	reason: "aborted" | "error" | "cleared" | "removed";
}

/** "requeue" replays the lost yield next turn; "drop" (or void/undefined) discards it. */
export type RejectOutcome = "requeue" | "drop";

export interface DirectiveCallbacks {
	/** Fires when the yield was served (LLM call completed). The directive is consumed. */
	onResolved?: (info: ResolveInfo) => void;
	/**
	 * Fires when the yield is being discarded. Return "requeue" to replay the
	 * same value at the head of the queue for the next turn. Default: "drop".
	 */
	onRejected?: (info: RejectInfo) => RejectOutcome | undefined;
	/**
	 * Handler invoked when the model actually calls the forced tool. The queue
	 * directive carries the real execution logic; the tool's own execute() is
	 * bypassed. Returns the tool result directly.
	 */
	onInvoked?: (input: unknown) => Promise<unknown> | unknown;
}

// ── Directive ───────────────────────────────────────────────────────────────

export interface ToolChoiceDirective {
	generator: Iterator<ToolChoice>;
	/** Stable label for targeted removal and debugging (e.g. "user-force"). */
	label: string;
	callbacks: DirectiveCallbacks;
	/**
	 * Consecutive-rejection cap for the requeue path. When the in-flight yield has
	 * been rejected `maxRejections` times (counting replays), a "requeue" outcome
	 * is forcibly downgraded to "drop" so a provider that rejects the forced
	 * tool choice cannot lock the session in an infinite replay loop. Default:
	 * Infinity (preserves the historical replay-forever semantics).
	 */
	maxRejections?: number;
	/** Number of times this directive's yield has been rejected so far. */
	rejectCount: number;
}

export interface PushOptions {
	/** Prepend to head instead of appending to tail. Default: false. */
	now?: boolean;
	label?: string;
	/** Lifecycle callbacks for this directive. */
	onResolved?: DirectiveCallbacks["onResolved"];
	onRejected?: DirectiveCallbacks["onRejected"];
	onInvoked?: DirectiveCallbacks["onInvoked"];
	/** Consecutive-rejection cap for the requeue path; see ToolChoiceDirective. */
	maxRejections?: number;
}

// ── Generators ──────────────────────────────────────────────────────────────

export function* onceGen(choice: ToolChoice): Generator<ToolChoice, void, unknown> {
	yield choice;
}

// ── In-flight state ─────────────────────────────────────────────────────────

interface InFlight {
	directive: ToolChoiceDirective;
	yielded: ToolChoice;
}

// ── Queue ───────────────────────────────────────────────────────────────────

export class ToolChoiceQueue {
	#queue: ToolChoiceDirective[] = [];
	#inFlight: InFlight | undefined;
	/**
	 * Label of the directive whose last yield was resolved this turn.
	 * Consumers (e.g. todo reminder suppression) read via consumeLastServedLabel().
	 */
	#lastResolvedLabel: string | undefined;

	// ── Push ──────────────────────────────────────────────────────────────

	pushOnce(choice: ToolChoice, options?: PushOptions): void {
		this.push(onceGen(choice), options);
	}

	pushSequence(choices: ToolChoice[], options?: PushOptions): void {
		this.push(choices, options);
	}

	push(generator: Iterable<ToolChoice>, options?: PushOptions): void {
		const directive: ToolChoiceDirective = {
			generator: generator[Symbol.iterator](),
			label: options?.label ?? "anonymous",
			callbacks: {
				onResolved: options?.onResolved,
				onRejected: options?.onRejected,
				onInvoked: options?.onInvoked,
			},
			maxRejections: options?.maxRejections,
			rejectCount: 0,
		};
		if (options?.now) {
			this.#queue.unshift(directive);
		} else {
			this.#queue.push(directive);
		}
	}

	// ── Consume ───────────────────────────────────────────────────────────

	/**
	 * Advance the head directive and return its next yield. Records the value
	 * as in-flight until resolve() or reject() is called.
	 */
	nextToolChoice(): ToolChoice | undefined {
		while (this.#queue.length > 0) {
			const head = this.#queue[0]!;
			const result = head.generator.next();
			if (result.done) {
				this.#queue.shift();
				continue;
			}
			this.#inFlight = { directive: head, yielded: result.value };
			return result.value;
		}
		return undefined;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	/**
	 * The in-flight yield was served — the LLM call completed normally.
	 * Fires onResolved, then clears in-flight state. The directive's generator
	 * remains in the queue if it has more values to yield.
	 */
	resolve(): void {
		const inFlight = this.#inFlight;
		this.#inFlight = undefined;
		if (!inFlight) return;

		this.#lastResolvedLabel = inFlight.directive.label;
		inFlight.directive.callbacks.onResolved?.({ choice: inFlight.yielded });
	}

	/**
	 * The in-flight yield was not served, or the turn aborted/errored.
	 * Fires onRejected to let the caller decide: "requeue" replays the exact
	 * lost value at the head of the queue; anything else drops it.
	 */
	reject(reason: RejectInfo["reason"]): void {
		const inFlight = this.#inFlight;
		this.#inFlight = undefined;
		if (!inFlight) return;

		const outcome = inFlight.directive.callbacks.onRejected?.({
			choice: inFlight.yielded,
			reason,
		});

		if (outcome === "requeue") {
			const nextRejectCount = inFlight.directive.rejectCount + 1;
			// Circuit breaker: cap consecutive requeues so a provider that rejects
			// the forced tool choice (e.g. DeepSeek V4 in thinking mode returns 400
			// for `tool_choice`) cannot replay the same yield forever, deadlocking
			// the session. On cap, drop the yield silently — the steering reminder
			// text is already in the conversation, so the model can still invoke the
			// tool on its own via ordinary tool calling.
			if (nextRejectCount >= (inFlight.directive.maxRejections ?? Infinity)) {
				return;
			}
			// Re-queue only the lost yield, not the rest of the sequence. Carry forward
			// onInvoked, onRejected, the reject cap, and the running count so the
			// replayed yield still executes correctly and the breaker keeps counting.
			this.#queue.unshift({
				generator: onceGen(inFlight.yielded),
				label: `${inFlight.directive.label}-requeued`,
				callbacks: {
					onInvoked: inFlight.directive.callbacks.onInvoked,
					onRejected: inFlight.directive.callbacks.onRejected,
				},
				maxRejections: inFlight.directive.maxRejections,
				rejectCount: nextRejectCount,
			});
		}
	}

	/** True if there is an in-flight yield that hasn't been resolved or rejected. */
	get hasInFlight(): boolean {
		return this.#inFlight !== undefined;
	}

	/** Peek the in-flight directive's onInvoked handler, if any. */
	peekInFlightInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#inFlight?.directive.callbacks.onInvoked;
	}

	// ── Cleanup ───────────────────────────────────────────────────────────

	/** Remove all directives with the given label. Rejects in-flight if it matches. */
	removeByLabel(label: string): void {
		if (this.#inFlight?.directive.label === label) {
			this.reject("removed");
		}
		this.#queue = this.#queue.filter(d => d.label !== label);
	}

	/** Empty the queue and reject any in-flight yield. */
	clear(): void {
		if (this.#inFlight) {
			this.reject("cleared");
		}
		this.#queue = [];
		this.#lastResolvedLabel = undefined;
	}

	// ── Observation ───────────────────────────────────────────────────────

	/** Return the label of the most recently resolved directive, then clear it. */
	consumeLastServedLabel(): string | undefined {
		const label = this.#lastResolvedLabel;
		this.#lastResolvedLabel = undefined;
		return label;
	}

	/** For tests/debug: labels of currently queued directives in order. */
	inspect(): readonly string[] {
		return this.#queue.map(d => d.label);
	}
}
