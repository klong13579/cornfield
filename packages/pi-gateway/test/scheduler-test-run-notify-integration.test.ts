/**
 * scheduler-test-run-notify-integration.test.ts
 *
 * Verifies that `CronLifecycle.notifyOriginSessionIfPending` correctly:
 *   1. No-ops when no `origin` is passed (regular cron fire, not a test-run).
 *   2. No-ops when the bridge is not running.
 *   3. No-ops (logs warn) when bridge.executePrompt throws.
 *   4. Dispatches bridge.executePrompt with the correct sessionPath and
 *      rendered prompt on the happy path.
 *
 * The origin is passed in directly (B 方案 fix) — the notifier no
 * longer reads the test-run marker. This avoids the race where the
 * orphan recovery consumes the marker during a long agent run.
 *
 * Uses real CronLifecycle with a fake bridge. The fake bridge records
 * every executePrompt call so the assertions are observable.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CronLifecycle } from "../src/gateway-cron-lifecycle";

interface FakeBridge {
	isRunning: boolean;
	executePrompt: ReturnType<typeof mock>;
	setModel: ReturnType<typeof mock>;
	setDisabledToolsets: ReturnType<typeof mock>;
}

const sampleOrigin = { sessionPath: "/path/to/origin_session.jsonl", accountId: "algorithm" };

function makeBridge(opts: { running?: boolean; throwOnExecute?: Error } = {}): FakeBridge {
	return {
		isRunning: opts.running ?? true,
		executePrompt: mock(async () => {
			if (opts.throwOnExecute) throw opts.throwOnExecute;
			return "ok";
		}),
		setModel: mock(async () => {}),
		setDisabledToolsets: mock(async () => {}),
	};
}

function makeLifecycle(bridge: FakeBridge): CronLifecycle {
	const fakeRegistry = { sendMessage: mock(async () => {}) };
	const fakeConfig = {
		cron: { deliveryMode: "text" },
		agent: { ompPath: "/usr/bin/true" },
	} as any;
	return new CronLifecycle({
		config: fakeConfig,
		bridge: bridge as any,
		accountBridges: new Map([["algorithm", bridge as any]]),
		accountAgentDirs: new Map(),
		registry: fakeRegistry as any,
		getAccountBridge: (id: string) => (id === "algorithm" ? (bridge as any) : undefined),
		writeStatusFile: async () => {},
	});
}

describe("notifyOriginSessionIfPending", () => {
	test("no origin supplied → no bridge call (not a test-run)", () => {
		const bridge = makeBridge();
		const lifecycle = makeLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: "3 warnings",
			},
			true,
			undefined, // no origin
		);
		expect(bridge.executePrompt).not.toHaveBeenCalled();
	});

	test("bridge not running → no bridge call (logs warn)", () => {
		const bridge = makeBridge({ running: false });
		const lifecycle = makeLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: "3 warnings",
			},
			true,
			sampleOrigin,
		);
		expect(bridge.executePrompt).not.toHaveBeenCalled();
	});

	test("bridge.executePrompt throws (session closed / circuit open) → log warn, no crash", async () => {
		const bridge = makeBridge({ throwOnExecute: new Error("Failed to switch to cron session: ENOENT") });
		const lifecycle = makeLifecycle(bridge);
		expect(() =>
			(lifecycle as any).notifyOriginSessionIfPending(
				{
					taskName: "weekly-kb-lint",
					taskId: "task_001",
					slug: "weekly-kb-lint",
					status: "success",
					exitCode: 0,
					durationMs: 124_000,
					output: "3 warnings",
				},
				true,
				sampleOrigin,
			),
		).not.toThrow();
		await new Promise(r => setTimeout(r, 20));
		expect(bridge.executePrompt).toHaveBeenCalledTimes(1);
	});

	test("happy path — bridge.executePrompt called with origin sessionPath + rendered prompt", async () => {
		const bridge = makeBridge();
		const lifecycle = makeLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: "3 warnings found in lint",
			},
			true,
			sampleOrigin,
		);
		await new Promise(r => setTimeout(r, 20));
		expect(bridge.executePrompt).toHaveBeenCalledTimes(1);
		const [promptText, opts] = bridge.executePrompt.mock.calls[0];
		expect(opts.sessionPath).toBe(sampleOrigin.sessionPath);
		expect(opts.timeoutMs).toBe(60_000);
		expect(promptText).toContain("weekly-kb-lint");
		expect(promptText).toContain("success");
		expect(promptText).toContain("124.0s");
		expect(promptText).toContain("3 warnings found in lint");
	});

	test("happy path — failure status renders error block", async () => {
		const bridge = makeBridge();
		const lifecycle = makeLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "failure",
				exitCode: 1,
				durationMs: 30_000,
				output: "",
				error: "command not found: ripgrep",
			},
			true,
			sampleOrigin,
		);
		await new Promise(r => setTimeout(r, 20));
		const [promptText] = bridge.executePrompt.mock.calls[0];
		expect(promptText).toContain("failure");
		expect(promptText).toContain("command not found: ripgrep");
	});

	test("happy path — card delivery failure surfaces in prompt", async () => {
		const bridge = makeBridge();
		const lifecycle = makeLifecycle(bridge);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: "ok",
			},
			false, // cardOk=false
			sampleOrigin,
		);
		await new Promise(r => setTimeout(r, 20));
		const [promptText] = bridge.executePrompt.mock.calls[0];
		expect(promptText).toContain("推送失败");
	});

	test("output preview is truncated to 200 chars", async () => {
		const bridge = makeBridge();
		const lifecycle = makeLifecycle(bridge);
		const longOutput = "x".repeat(500);
		(lifecycle as any).notifyOriginSessionIfPending(
			{
				taskName: "weekly-kb-lint",
				taskId: "task_001",
				slug: "weekly-kb-lint",
				status: "success",
				exitCode: 0,
				durationMs: 124_000,
				output: longOutput,
			},
			true,
			sampleOrigin,
		);
		await new Promise(r => setTimeout(r, 20));
		const [promptText] = bridge.executePrompt.mock.calls[0];
		expect(promptText).toContain("x".repeat(200));
		expect(promptText).toContain("…");
		expect(promptText).not.toContain("x".repeat(201));
	});
});
