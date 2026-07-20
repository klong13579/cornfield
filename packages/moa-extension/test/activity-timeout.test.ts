import { describe, expect, it, vi } from "bun:test";
import { createActivityTimeout } from "../src/activity-timeout";

describe("createActivityTimeout (Phase 7 idle)", () => {
	it("fires hard timeout after timeoutMs even with activity", async () => {
		const onAbort = vi.fn();
		const ctl = createActivityTimeout({
			timeoutMs: 40,
			idleTimeoutMs: 1000,
			onAbort,
		});
		const tick = setInterval(() => ctl.bump(), 5);
		await Bun.sleep(70);
		clearInterval(tick);
		expect(onAbort).toHaveBeenCalled();
		expect(ctl.timedOut).toBe(true);
		expect(ctl.idleTimedOut).toBe(false);
		ctl.dispose();
	});

	it("fires idle timeout when no bump within idleTimeoutMs", async () => {
		const onAbort = vi.fn();
		const ctl = createActivityTimeout({
			timeoutMs: 5_000,
			idleTimeoutMs: 30,
			onAbort,
		});
		await Bun.sleep(60);
		expect(onAbort).toHaveBeenCalled();
		expect(ctl.idleTimedOut).toBe(true);
		expect(ctl.timedOut).toBe(true);
		ctl.dispose();
	});

	it("does not idle-fire when bumped regularly", async () => {
		const onAbort = vi.fn();
		const ctl = createActivityTimeout({
			timeoutMs: 5_000,
			idleTimeoutMs: 40,
			onAbort,
		});
		const tick = setInterval(() => ctl.bump(), 10);
		await Bun.sleep(90);
		clearInterval(tick);
		expect(onAbort).not.toHaveBeenCalled();
		expect(ctl.idleTimedOut).toBe(false);
		ctl.dispose();
	});

	it("idleTimeoutMs=0 disables idle killing", async () => {
		const onAbort = vi.fn();
		const ctl = createActivityTimeout({
			timeoutMs: 5_000,
			idleTimeoutMs: 0,
			onAbort,
		});
		await Bun.sleep(50);
		expect(onAbort).not.toHaveBeenCalled();
		ctl.dispose();
	});
});
