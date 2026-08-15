/**
 * PromptQueue runExclusive queueTimeoutMs.
 *
 * P1 fix: bridge queue starvation — if a previous runExclusive op is
 * still running, the next caller waits forever. The new `queueTimeoutMs`
 * option bounds the wait. On timeout, the call throws a clear error
 * and the chain still receives a resolved `current` slot (so the next
 * caller can proceed once the previous op completes, instead of
 * deadlocking on a zombie "still waiting" entry).
 *
 * Covers:
 *  - throws after queueTimeoutMs when previous op is still running
 *  - caller's op is never invoked when wait times out
 *  - chain stays healthy: a fresh caller after the previous op
 *    completes can still acquire the lock
 *  - no-op step is visible (a third caller doesn't get stuck on the
 *    bailed-out entry)
 *  - zero / undefined queueTimeoutMs = legacy wait-forever behaviour
 *  - 0 explicitly disables the timeout (back-compat for callers
 *    that opt out)
 *  - the timed-out caller's chain step is properly cleaned up so
 *    `waitForIdle` does not hang
 */
import { describe, expect, test } from "bun:test";
import type { RpcTransport } from "../src/agent-transport";
import { PromptQueue } from "../src/prompt-queue";

class FakeTransport implements Pick<RpcTransport, "sendFrame"> {
	frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
	sendFrame(type: string, payload: Record<string, unknown>): void {
		this.frames.push({ type, payload });
	}
}

function makeQueue(): PromptQueue {
	const transport = new FakeTransport();
	return new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
}

describe("PromptQueue runExclusive queueTimeoutMs", () => {
	test("throws when previous op is still running and timeout fires", async () => {
		const queue = makeQueue();
		let firstOpResolved = false;
		// First op hangs until we let it finish.
		const firstAcquired = Promise.withResolvers<void>();
		const firstPromise = queue.runExclusive(async () => {
			firstAcquired.resolve();
			await Bun.sleep(200);
			firstOpResolved = true;
			return "first";
		});
		await firstAcquired.promise;
		// Second call has a tight timeout.
		await expect(
			queue.runExclusive(
				async () => {
					throw new Error("second op must not run when first holds the lock");
				},
				{ queueTimeoutMs: 30 },
			),
		).rejects.toThrow(/queue wait timed out after 30ms/);
		// Let the first op finish.
		await firstPromise;
		expect(firstOpResolved).toBe(true);
	});

	test("chain stays healthy after timeout: a third caller can still acquire the lock", async () => {
		const queue = makeQueue();
		let firstFinished = false;
		// First op holds the lock for a while.
		const firstAcquired = Promise.withResolvers<void>();
		const firstPromise = queue.runExclusive(async () => {
			firstAcquired.resolve();
			await Bun.sleep(150);
			firstFinished = true;
		});
		await firstAcquired.promise;
		// Second call times out and bails out.
		await expect(queue.runExclusive(async () => "should not run", { queueTimeoutMs: 20 })).rejects.toThrow(
			/queue wait timed out/,
		);
		// Third call (no timeout) should now wait patiently and
		// acquire the lock once the first op completes.
		const thirdResult = await queue.runExclusive(async () => "third");
		expect(thirdResult).toBe("third");
		expect(firstFinished).toBe(true);
		// First op's result was never observed by the second caller
		// because it bailed out — the chain's resolved `current`
		// step is a no-op pass-through.
		await firstPromise;
	});

	test("legacy: undefined queueTimeoutMs waits forever (no throw on lock wait)", async () => {
		const queue = makeQueue();
		const firstAcquired = Promise.withResolvers<void>();
		const firstPromise = queue.runExclusive(async () => {
			firstAcquired.resolve();
			await Bun.sleep(80);
			return "first";
		});
		await firstAcquired.promise;
		// No queueTimeoutMs — should acquire the lock when first finishes.
		const secondResult = await queue.runExclusive(async () => "second");
		expect(secondResult).toBe("second");
		await firstPromise;
	});

	test("legacy: queueTimeoutMs=0 means no timeout (opt-out)", async () => {
		const queue = makeQueue();
		const firstAcquired = Promise.withResolvers<void>();
		const firstPromise = queue.runExclusive(async () => {
			firstAcquired.resolve();
			await Bun.sleep(80);
			return "first";
		});
		await firstAcquired.promise;
		// queueTimeoutMs=0 explicitly — no timeout, wait forever.
		const secondResult = await queue.runExclusive(async () => "second", { queueTimeoutMs: 0 });
		expect(secondResult).toBe("second");
		await firstPromise;
	});

	test("waitForIdle settles after a timed-out caller's chain step is resolved", async () => {
		const queue = makeQueue();
		const firstAcquired = Promise.withResolvers<void>();
		const firstPromise = queue.runExclusive(async () => {
			firstAcquired.resolve();
			await Bun.sleep(120);
		});
		await firstAcquired.promise;
		// Second call times out.
		await expect(queue.runExclusive(async () => "should not run", { queueTimeoutMs: 20 })).rejects.toThrow(
			/queue wait timed out/,
		);
		// First op finishes.
		await firstPromise;
		// waitForIdle should settle promptly — the bailed-out caller's
		// chain step was resolved in the finally block, so the tail
		// does not dangle a pending promise.
		await Promise.race([
			queue.waitForIdle(),
			Bun.sleep(500).then(() => Promise.reject(new Error("waitForIdle hung after queue timeout"))),
		]);
	});

	test("concurrent timed-out callers do not corrupt the chain", async () => {
		const queue = makeQueue();
		const firstAcquired = Promise.withResolvers<void>();
		const firstPromise = queue.runExclusive(async () => {
			firstAcquired.resolve();
			await Bun.sleep(200);
			return "first";
		});
		await firstAcquired.promise;
		// Three concurrent timeouts while the first op runs.
		const bailResults = await Promise.allSettled([
			queue.runExclusive(async () => "a", { queueTimeoutMs: 25 }),
			queue.runExclusive(async () => "b", { queueTimeoutMs: 25 }),
			queue.runExclusive(async () => "c", { queueTimeoutMs: 25 }),
		]);
		for (const r of bailResults) {
			expect(r.status).toBe("rejected");
			if (r.status === "rejected") {
				expect((r.reason as Error).message).toMatch(/queue wait timed out/);
			}
		}
		// First op finishes; a fourth caller (no timeout) acquires the lock.
		const fourthResult = await queue.runExclusive(async () => "fourth");
		expect(fourthResult).toBe("fourth");
		await firstPromise;
	});
});
