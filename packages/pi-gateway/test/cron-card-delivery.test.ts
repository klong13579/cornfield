/**
 * Cron result delivery via DingTalk AI Card — unit tests.
 *
 * Covers:
 *   - Success path: card create + finish with correct block shape
 *   - Card-create failure: returns `{ ok: false }` (caller falls back to text)
 *   - Card-finish failure: returns `{ ok: false }` (caller falls back to text)
 *   - Status mapping: success / failure / timed_out produce the right
 *     header emoji and exit-code rendering
 *   - Output pass-through: the full agent text reaches the card body
 *     verbatim (no 2000-char truncation)
 *   - Action block: ButtonGroup with "查看执行日志" + "复制输出" buttons
 *
 * No network: the card SDK is exercised via `spyOn` on the imported
 * module object. Per AGENTS.md, `mock.module()` is banned; `spyOn` is
 * the only sanctioned mocking primitive.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as cardModule from "../src/channels/dingtalk-card";
import {
	type CronCardPayload,
	deliverCronResultAsCard,
} from "../src/scheduler/cron-card-delivery";
import type { DingTalkConfig } from "../src/types";

const DINGTALK_CONFIG: DingTalkConfig = {
	enabled: true,
	appKey: "test-app-key",
	appSecret: "test-app-secret",
	robotCode: "test-robot-code",
};

const FAKE_CARD: cardModule.AICardInstance = {
	cardInstanceId: "card_test_123",
	accessToken: "fake-token",
	tokenExpireTime: Date.now() + 2 * 60 * 60 * 1000,
	inputingStarted: false,
};

const USER_TARGET: cardModule.AICardTarget = { type: "user", userId: "user_test_1" };

function makePayload(overrides: Partial<CronCardPayload> = {}): CronCardPayload {
	return {
		taskName: "daily-brief",
		taskId: "task_abc",
		slug: "daily-brief",
		status: "success",
		exitCode: 0,
		durationMs: 1234,
		output: "## Summary\n\n3 PRs merged today.\n\n- PR #1\n- PR #2",
		...overrides,
	};
}

describe("deliverCronResultAsCard", () => {
	let createSpy: ReturnType<typeof spyOn>;
	let finishSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		createSpy = spyOn(cardModule, "createAICardForTarget").mockResolvedValue(FAKE_CARD);
		finishSpy = spyOn(cardModule, "finishAICard").mockResolvedValue(undefined);
	});

	afterEach(() => {
		createSpy.mockRestore();
		finishSpy.mockRestore();
	});

	it("creates a card and finishes it with the agent's full output as the body", async () => {
		const payload = makePayload({ output: "## Hello\n\nLong markdown body that would have been truncated to 2000 chars by the legacy text path." });

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});

		expect(result.ok).toBe(true);

		expect(createSpy).toHaveBeenCalledTimes(1);
		const [createCfg, createTarget, createOpts] = createSpy.mock.calls[0]!;
		expect(createCfg).toBe(DINGTALK_CONFIG);
		expect(createTarget).toBe(USER_TARGET);
		// statusLine at create-time carries just the timing footer
		// (task name is rendered in the card body, not the footer).
		expect(createOpts?.statusLine).toBe("exit 0 · 1.2s");

		expect(finishSpy).toHaveBeenCalledTimes(1);
		const [finishedCard, finishedData, finishedCfg] = finishSpy.mock.calls[0]!;
		expect(finishedCard).toBe(FAKE_CARD);
		expect(finishedCfg).toBe(DINGTALK_CONFIG);

		// Body must include the full output (not truncated)
		expect(finishedData.content).toContain("Long markdown body that would have been truncated");
		// Status header at the top
		expect(finishedData.content).toMatch(/^✅ daily-brief \(exit 0, 1\.2s\)/);
		// copyContent must be the body text (for the schema's built-in copy)
		expect(finishedData.copyContent).toBe(finishedData.content);
	});

	it("includes a ButtonGroup block with 查看执行日志 and 复制输出 buttons", async () => {
		const payload = makePayload();

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});
		expect(result.ok).toBe(true);

		const finishedData = finishSpy.mock.calls[0]![1];
		const actionBlock = finishedData.blockList.find(b => b.type === cardModule.BlockType.STOP);
		expect(actionBlock).toBeDefined();
		expect(actionBlock?.btns).toHaveLength(2);

		const logBtn = actionBlock?.btns?.find(b => b.text === "查看执行日志");
		expect(logBtn?.actionType).toBe("url");
		expect(logBtn?.url).toMatch(/^file:\/\/.*\.omp\/gateway-data\/scheduler\/logs\/by-task\/daily-brief\/\d{4}-\d{2}-\d{2}\.jsonl$/);

		const copyBtn = actionBlock?.btns?.find(b => b.text === "复制输出");
		expect(copyBtn?.actionType).toBe("call_back");
		expect(copyBtn?.params?.copyText).toContain("## Summary");
	});

	it("renders failure status with ❌ emoji and surfaces the error in the footer", async () => {
		const payload = makePayload({
			status: "failure",
			exitCode: 1,
			output: "Tool call failed",
			error: "ENOSPC: no space left on device",
		});

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});
		expect(result.ok).toBe(true);

		const [, finishedData] = finishSpy.mock.calls[0]!;
		expect(finishedData.content).toMatch(/^❌ daily-brief \(exit 1,/);
		expect(finishedData.statusLine).toContain("ENOSPC");
	});

	it("renders timed_out status with ⏰ emoji", async () => {
		const payload = makePayload({ status: "timed_out", exitCode: 124, durationMs: 60_000 });

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});
		expect(result.ok).toBe(true);

		const [, finishedData] = finishSpy.mock.calls[0]!;
		expect(finishedData.content).toMatch(/^⏰ daily-brief \(exit 124,/);
	});

	it("substitutes a placeholder when the output is empty", async () => {
		const payload = makePayload({ output: "   \n\n  " });

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: payload,
		});
		expect(result.ok).toBe(true);

		const [, finishedData] = finishSpy.mock.calls[0]!;
		expect(finishedData.content).toContain("无输出");
	});

	it("returns { ok: false } and does NOT call finishAICard when createAICardForTarget returns null", async () => {
		// createAICardForTarget returns null on auth/network/4xx failure.
		// The cron deliver must propagate this so the gateway can fall
		// back to the text path — a swallowed null would leave the user
		// with no notification.
		createSpy.mockResolvedValue(null);

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: makePayload(),
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/createAICardForTarget returned null/);
		expect(finishSpy).not.toHaveBeenCalled();
	});

	it("returns { ok: false } when finishAICard throws (retries exhausted / 4xx business error)", async () => {
		// finishAICard is the documented throw site for permanent
		// failures (see comment at finishAICard in dingtalk-card.ts).
		// The cron path catches and returns ok:false so the gateway
		// can fall back to the text path.
		finishSpy.mockRejectedValue(new Error("FINISHED non-retryable failure: status=400 body=..."));

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: makePayload(),
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("FINISHED non-retryable failure");
	});

	it("does not throw on createAICardForTarget rejection (defensive)", async () => {
		// createAICardForTarget's contract says it returns null on
		// failure, not throws. But if a future change starts throwing
		// (e.g. an auth-library exception), the cron path must still
		// return ok:false — the gateway depends on a non-throwing
		// delivery to keep the run from cascading.
		createSpy.mockRejectedValue(new Error("network down"));

		const result = await deliverCronResultAsCard({
			dingtalkConfig: DINGTALK_CONFIG,
			target: USER_TARGET,
			card: makePayload(),
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("network down");
	});
});
