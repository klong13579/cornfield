/**
 * ActionRegistry unit tests.
 *
 * The registry maps DingTalk AI Card instance IDs to the session /
 * bridge that owns the card, so a TOPIC_CARD action callback (user
 * clicked a button) can be routed back. Tests pin:
 *   - basic register + lookup
 *   - expiry: stale entries return undefined and are pruned
 *   - expire() prunes in bulk and returns the count
 *   - re-registering preserves `createdAt` (idempotent for the
 *     "patch with toolName after onLongTask fires" flow)
 *   - unregister removes a single entry
 *   - size reflects the current count
 */
import { describe, expect, test } from "bun:test";
import { ActionRegistry } from "../src/action-registry";

describe("ActionRegistry", () => {
	test("register + lookup returns the registered info", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		const info = reg.lookup("card_1");
		expect(info).toBeDefined();
		expect(info?.accountId).toBe("hr");
		expect(info?.sessionId).toBe("conv-1");
		expect(info?.toolName).toBeUndefined();
		expect(typeof info?.createdAt).toBe("number");
	});

	test("register accepts and stores toolName", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1", toolName: "bash" });
		const info = reg.lookup("card_1");
		expect(info?.toolName).toBe("bash");
	});

	test("lookup returns undefined for missing card", () => {
		const reg = new ActionRegistry(60_000);
		expect(reg.lookup("nope")).toBeUndefined();
	});

	test("lookup returns undefined and prunes expired entries", () => {
		// 1ms expiry is effectively "expired by the time we look"
		const reg = new ActionRegistry(1);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		// Wait for the entry to be past expiry. We use 10ms to give
		// the timer a generous margin on slow runners.
		return new Promise<void>(resolve =>
			setTimeout(() => {
				expect(reg.lookup("card_1")).toBeUndefined();
				expect(reg.size).toBe(0);
				resolve();
			}, 10),
		);
	});

	test("expire() prunes all expired entries and returns the count", () => {
		const reg = new ActionRegistry(1);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		reg.register("card_2", { accountId: "ops", sessionId: "conv-2" });
		reg.register("card_3", { accountId: "opencode", sessionId: "conv-3" });
		expect(reg.size).toBe(3);
		return new Promise<void>(resolve =>
			setTimeout(() => {
				const pruned = reg.expire();
				expect(pruned).toBe(3);
				expect(reg.size).toBe(0);
				resolve();
			}, 10),
		);
	});

	test("expire() does not prune entries that are still within the window", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		reg.register("card_2", { accountId: "ops", sessionId: "conv-2" });
		expect(reg.expire()).toBe(0);
		expect(reg.size).toBe(2);
	});

	test("re-registering the same cardInstanceId preserves createdAt", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		const first = reg.lookup("card_1");
		expect(first?.createdAt).toBeGreaterThan(0);
		const firstCreatedAt = first!.createdAt;
		// Wait a tick so a fresh `Date.now()` would differ
		return new Promise<void>(resolve =>
			setTimeout(() => {
				reg.register("card_1", { accountId: "hr", sessionId: "conv-1", toolName: "bash" });
				const second = reg.lookup("card_1");
				expect(second?.toolName).toBe("bash");
				expect(second?.createdAt).toBe(firstCreatedAt);
				resolve();
			}, 5),
		);
	});

	test("unregister removes a single entry and returns whether it existed", () => {
		const reg = new ActionRegistry(60_000);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		expect(reg.unregister("card_1")).toBe(true);
		expect(reg.size).toBe(0);
		expect(reg.lookup("card_1")).toBeUndefined();
		// Removing a non-existent entry returns false
		expect(reg.unregister("card_1")).toBe(false);
	});

	test("size reflects current entry count", () => {
		const reg = new ActionRegistry(60_000);
		expect(reg.size).toBe(0);
		reg.register("card_1", { accountId: "hr", sessionId: "conv-1" });
		expect(reg.size).toBe(1);
		reg.register("card_2", { accountId: "ops", sessionId: "conv-2" });
		expect(reg.size).toBe(2);
		reg.unregister("card_1");
		expect(reg.size).toBe(1);
	});

	test("expiryMs exposes the configured window", () => {
		expect(new ActionRegistry().expiryMs).toBe(30 * 60_000);
		expect(new ActionRegistry(123_456).expiryMs).toBe(123_456);
	});
});
