/**
 * PromptQueue rolling inactivity timeout.
 *
 * Plan v2 Fix E: OMP emits session events as it makes progress (token
 * deltas, tool calls, message_end). As long as any event arrives within
 * `inactivityMs`, the prompt is considered alive. The hard `timeoutMs`
 * cap remains as an absolute upper bound. This suite covers:
 *  - inactivity watchdog fires after inactivityMs without an event
 *  - watchdog is reset by session_event arrivals
 *  - hard cap fires even if events keep coming
 *  - agent_end resolves cleanly and clears both timers
 *  - rejectAll cleans up both timers
 */
import { describe, expect, test } from "bun:test";
import { PromptQueue } from "../src/prompt-queue";
import type { AgentEvent, RpcTransport, RpcTransportEvent } from "../src/agent-transport";

class FakeTransport implements Pick<RpcTransport, "sendFrame"> {
	frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
	sendFrame(type: string, payload: Record<string, unknown>): void {
		this.frames.push({ type, payload });
	}
}

function activePromptId(queue: PromptQueue): string {
	const id = queue.activePromptId;
	if (!id) throw new Error("no active prompt");
	return id;
}

describe("PromptQueue rolling inactivity timeout", () => {
	test("rejects after inactivityMs with no session event", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", 10_000, undefined, undefined, { inactivityMs: 100 });
		// Simulate the prompt command response (success) so prompt becomes active.
		queue.onCommandResponse(promptId, {
			type: "response",
			command: "prompt",
			success: true,
		});
		expect(activePromptId(queue)).toBe(promptId);
		await expect(promise).rejects.toThrow(/inactive/);
	});

	test("session events reset the inactivity watchdog", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", 10_000, undefined, undefined, { inactivityMs: 200 });
		queue.onCommandResponse(promptId, {
			type: "response",
			command: "prompt",
			success: true,
		});
		// Fire session events faster than the watchdog interval (interval = inactivityMs/6 = 33ms).
		for (let i = 0; i < 3; i++) {
			await Bun.sleep(50);
			queue.onSessionEvent({ type: "message_update" });
		}
		// Should still be pending.
		expect(queue.hasPendingPrompts()).toBe(true);
		// Now stop firing events and let the watchdog fire.
		await Bun.sleep(300);
		await expect(promise).rejects.toThrow(/inactive/);
	});

	test("agent_end resolves the promise cleanly and clears the watchdog", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", 10_000, undefined, undefined, { inactivityMs: 100 });
		queue.onCommandResponse(promptId, {
			type: "response",
			command: "prompt",
			success: true,
		});
		queue.onSessionEvent({ type: "message_update" });
		queue.onSessionEvent({ type: "agent_end" });
		const result = await promise;
		expect(result.aborted).toBe(false);
		expect(queue.hasPendingPrompts()).toBe(false);
		// After agent_end, no later inactivity timer should fire.
		await Bun.sleep(200);
		expect(queue.hasPendingPrompts()).toBe(false);
	});

	test("hard cap fires even with constant activity", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		// inactivityMs (5s) longer than hard cap (200ms) — hard cap should win.
		const { promise, promptId } = queue.enqueue("hi", 200, undefined, undefined, { inactivityMs: 5_000 });
		queue.onCommandResponse(promptId, {
			type: "response",
			command: "prompt",
			success: true,
		});
		// Fire events every 30ms to keep the watchdog happy.
		const interval = setInterval(() => {
			queue.onSessionEvent({ type: "message_update" });
		}, 30);
		try {
			await expect(promise).rejects.toThrow(/hard cap/);
		} finally {
			clearInterval(interval);
		}
	});

	test("rejectAll cleans up both hard-cap and watchdog timers", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", 10_000, undefined, undefined, { inactivityMs: 100 });
		queue.onCommandResponse(promptId, {
			type: "response",
			command: "prompt",
			success: true,
		});
		queue.rejectAll(new Error("shutdown"));
		await expect(promise).rejects.toThrow("shutdown");
		expect(queue.hasPendingPrompts()).toBe(false);
		// No stray timer should fire after rejectAll.
		await Bun.sleep(200);
		expect(queue.hasPendingPrompts()).toBe(false);
	});

	test("abort() resolves as aborted and clears the watchdog", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", 10_000, undefined, undefined, { inactivityMs: 200 });
		queue.onCommandResponse(promptId, {
			type: "response",
			command: "prompt",
			success: true,
		});
		const ok = queue.resolveActiveAsAborted();
		expect(ok).toBe(true);
		const result = await promise;
		expect(result.aborted).toBe(true);
		expect(queue.hasPendingPrompts()).toBe(false);
	});

	test("prompt command failure rejects the promise and clears timers", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", 10_000, undefined, undefined, { inactivityMs: 500 });
		queue.onCommandResponse(promptId, {
			type: "response",
			command: "prompt",
			success: false,
			error: "permission denied",
		});
		await expect(promise).rejects.toThrow("permission denied");
		expect(queue.hasPendingPrompts()).toBe(false);
		// Watchdog should NOT fire later.
		await Bun.sleep(600);
		expect(queue.hasPendingPrompts()).toBe(false);
	});
});
