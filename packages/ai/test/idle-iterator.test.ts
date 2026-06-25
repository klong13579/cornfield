import { describe, expect, it } from "bun:test";
import { iterateWithIdleTimeout } from "../src/utils/idle-iterator";

/**
 * A fake async iterable whose `next()` never resolves — simulates an LLM stream
 * on a half-open connection (TCP established, TLS done, but no SSE data ever
 * arrives).  This is exactly the failure mode where a user-triggered abort must
 * break the blocked promise instead of waiting for the idle/first-event timeout.
 */
function createNeverYieldingIterable<T>(): AsyncIterable<T> & { returnCalled: boolean } {
	let returnCalled = false;
	const iterable: AsyncIterable<T> & { returnCalled: boolean } = {
		[Symbol.asyncIterator]() {
			return {
				next: () => new Promise<IteratorResult<T>>(() => {}), // never resolves
				return: () => {
					returnCalled = true;
					return Promise.resolve({ done: true, value: undefined as unknown as T });
				},
			};
		},
		get returnCalled() {
			return returnCalled;
		},
	};
	return iterable;
}

describe("iterateWithIdleTimeout — caller abort", () => {
	it("breaks immediately when signal aborts while the iterable is blocked (timeout enabled)", async () => {
		const controller = new AbortController();
		const iterable = createNeverYieldingIterable<number>();

		const gen = iterateWithIdleTimeout(iterable, {
			idleTimeoutMs: 60_000, // long timeout; abort must beat it
			errorMessage: "should not fire",
			signal: controller.signal,
		});

		// Start consuming — this blocks on the never-resolving next()
		const consumePromise = (async () => {
			for await (const _ of gen) {
				// should never reach here
			}
		})();

		// Give the loop a tick to enter the blocked await, then abort
		await Bun.sleep(10);
		const abortStart = Date.now();
		controller.abort();

		let thrown: unknown;
		try {
			await consumePromise;
		} catch (err) {
			thrown = err;
		}

		const elapsed = Date.now() - abortStart;
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("Request was aborted");
		// Must resolve near-instantly, not wait for the 60s timeout
		expect(elapsed).toBeLessThan(1000);
		// iterator.return() must be called for cleanup
		expect(iterable.returnCalled).toBe(true);
	});

	it("breaks immediately when signal aborts while the iterable is blocked (timeout disabled)", async () => {
		const controller = new AbortController();
		const iterable = createNeverYieldingIterable<number>();

		const gen = iterateWithIdleTimeout(iterable, {
			idleTimeoutMs: 0, // disable watchdog — pure no-timeout path
			errorMessage: "should not fire",
			signal: controller.signal,
		});

		const consumePromise = (async () => {
			for await (const _ of gen) {
			}
		})();

		await Bun.sleep(10);
		const abortStart = Date.now();
		controller.abort();

		let thrown: unknown;
		try {
			await consumePromise;
		} catch (err) {
			thrown = err;
		}

		const elapsed = Date.now() - abortStart;
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("Request was aborted");
		expect(elapsed).toBeLessThan(1000);
		expect(iterable.returnCalled).toBe(true);
	});

	it("breaks immediately when signal is already aborted before first next()", async () => {
		const controller = new AbortController();
		controller.abort(); // pre-aborted

		const iterable = createNeverYieldingIterable<number>();
		const gen = iterateWithIdleTimeout(iterable, {
			idleTimeoutMs: 60_000,
			errorMessage: "should not fire",
			signal: controller.signal,
		});

		let thrown: unknown;
		try {
			for await (const _ of gen) {
			}
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("Request was aborted");
		expect(iterable.returnCalled).toBe(true);
	});

	it("still yields items normally when signal is not aborted", async () => {
		const controller = new AbortController();
		const items = [1, 2, 3];
		const iterable: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				let i = 0;
				return {
					next: async () => ({ done: i >= items.length, value: items[i++] }),
				};
			},
		};

		const gen = iterateWithIdleTimeout(iterable, {
			idleTimeoutMs: 60_000,
			errorMessage: "should not fire",
			signal: controller.signal,
		});

		const collected: number[] = [];
		for await (const item of gen) {
			collected.push(item);
		}
		expect(collected).toEqual([1, 2, 3]);
	});

	it("does not abort when no signal is provided (backwards compatibility)", async () => {
		const iterable: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				let i = 0;
				return {
					next: async () => {
						i++;
						if (i > 2) return { done: true, value: undefined };
						return { done: false, value: i };
					},
				};
			},
		};

		const gen = iterateWithIdleTimeout(iterable, {
			idleTimeoutMs: 60_000,
			errorMessage: "should not fire",
			// no signal
		});

		const collected: number[] = [];
		for await (const item of gen) {
			collected.push(item);
		}
		expect(collected).toEqual([1, 2]);
	});
});
