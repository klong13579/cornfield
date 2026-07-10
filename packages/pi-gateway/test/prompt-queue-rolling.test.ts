/**
 * PromptQueue inactivity watchdog.
 *
 * OMP emits session events as it makes progress (token deltas, tool
 * calls, message_end). As long as any event arrives within
 * `inactivityMs`, the prompt is considered alive. Previously the queue
 * also enforced a wall-clock hard cap (5 min default) regardless of
 * activity; that cap was removed 2026-07-08 because it killed
 * legitimate long-but-active turns (e.g. hr-agent update-interview-record
 * doing 30+ dws lookups). The inactivity watchdog is the only give-up
 * condition now. This suite covers:
 *  - inactivity watchdog fires after inactivityMs without an event
 *  - watchdog is reset by session_event arrivals
 *  - agent_end resolves cleanly and clears the watchdog
 *  - rejectAll cleans up the watchdog
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent, RpcTransport } from "../src/agent-transport";
import { PromptQueue } from "../src/prompt-queue";

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

describe("PromptQueue inactivity watchdog", () => {
	test("rejects after inactivityMs with no session event", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", undefined, undefined, { inactivityMs: 100 });
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
		const { promise, promptId } = queue.enqueue("hi", undefined, undefined, { inactivityMs: 200 });
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
		const { promise, promptId } = queue.enqueue("hi", undefined, undefined, { inactivityMs: 100 });
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

	test("constant activity keeps the prompt alive indefinitely (no hard cap)", async () => {
		// Regression: previously a wall-clock hard cap (default 5 min, here
		// forced to 200ms) would reject the prompt even with constant event
		// arrivals. With the hard cap removed (2026-07-08), the prompt must
		// stay alive as long as events keep coming.
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", undefined, undefined, { inactivityMs: 5_000 });
		queue.onCommandResponse(promptId, {
			type: "response",
			command: "prompt",
			success: true,
		});
		// Fire events every 30ms for 300ms (10x the previous 200ms hard cap).
		const interval = setInterval(() => {
			queue.onSessionEvent({ type: "message_update" });
		}, 30);
		try {
			await Bun.sleep(300);
			expect(queue.hasPendingPrompts()).toBe(true);
		} finally {
			clearInterval(interval);
		}
		// Resolve cleanly via agent_end so the test doesn't leave a hanging promise.
		queue.onSessionEvent({ type: "agent_end" });
		const result = await promise;
		expect(result.aborted).toBe(false);
	});

	test("rejectAll cleans up the watchdog timer", async () => {
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, { thresholdMs: 0, pingMs: 0 });
		const { promise, promptId } = queue.enqueue("hi", undefined, undefined, { inactivityMs: 100 });
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
		const { promise, promptId } = queue.enqueue("hi", undefined, undefined, { inactivityMs: 200 });
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
		const { promise, promptId } = queue.enqueue("hi", undefined, undefined, { inactivityMs: 500 });
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

	test("long-task pings update lastActivityAt (7-10 bug fix)", async () => {
		// 2026-07-10 incident: hr agent ran `pip install mlx-whisper` (62s of
		// no session events) and the gateway's 60s inactivity watchdog killed
		// it. The OMP session-event stream produces no events while a bash
		// subprocess is running, so the inactivity timer was ticking down
		// to zero during a perfectly legitimate long-running tool. The fix:
		// the long-task watcher's `fire()` callback updates
		// `pending.lastActivityAt = Date.now()`, so every ping keeps the
		// watchdog reset. This test verifies the unit-level behavior —
		// without the fix, `lastActivityAt` would freeze at the toolcall_end
		// event and the watchdog would treat the prompt as inactive.
		const transport = new FakeTransport();
		const queue = new PromptQueue(transport as unknown as RpcTransport, {
			thresholdMs: 50,
			pingMs: 30,
		});
		const { promise, promptId } = queue.enqueue(
			"long bash",
			{ onLongTask: () => {} }, // handler presence enables the watcher
			undefined,
			{ inactivityMs: 5_000 }, // long enough not to fire during the test
		);
		queue.onCommandResponse(promptId, { type: "response", command: "prompt", success: true });

		const initialActivity = queue.getActiveLastActivityAt()!;
		expect(initialActivity).toBeGreaterThan(0);

		// Emit a toolcall_end to start the long-task watcher.
		queue.onSessionEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "tc1", name: "bash", arguments: { command: "sleep 10" } },
			},
		});

		// Wait for threshold (50ms) + several pings (30ms each). Without the
		// fix, lastActivityAt freezes at the toolcall_end time. With the fix,
		// the pings update lastActivityAt to each fire time, well past 100ms.
		await Bun.sleep(200);

		const updatedActivity = queue.getActiveLastActivityAt()!;
		expect(updatedActivity - initialActivity).toBeGreaterThan(100);

		// Resolve cleanly so the test doesn't leave a hanging promise.
		queue.onSessionEvent({ type: "agent_end" });
		const result = await promise;
		expect(result.aborted).toBe(false);
	});
});
