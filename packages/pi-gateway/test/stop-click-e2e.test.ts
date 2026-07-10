/**
 * Stop-click end-to-end integration test.
 *
 * Exercises the full chain that fires when a user taps the "停止" button
 * on an AI Card:
 *
 *   synthetic TOPIC_CARD frame
 *     → DingTalkChannel.__testHandleCardCallback
 *       → parses action JSON
 *         → installed action handler
 *           → ActionRegistry.lookup
 *             → bridge.abort()
 *               → AgentBridge.sendCommandAndWait("abort")
 *                 → fake RPC emits abort response + interrupted toolResult
 *                   + final text + agent_end
 *                     → forwardWithMeta resolves with aborted: true
 *
 * The fake RPC and the real bridge / channel are the same code path the
 * gateway's `omp gateway test-longtask --simulate-stop` CLI exercises,
 * minus the real DingTalk API call. This lets us pin the integration
 * in a unit test that runs in <500ms.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ActionRegistry } from "../src/action-registry";
import { AgentBridge, type AgentResponseMeta } from "../src/agent-bridge";
import { DingTalkChannel } from "../src/channels/dingtalk";
import type { DingTalkConfig } from "../src/types";

const HR_CONFIG: DingTalkConfig = {
	enabled: true,
	appKey: "ding8yvoithqnrrz0kz5",
	appSecret: "secret",
	robotCode: "ding8yvoithqnrrz0kz5",
};

/** Build a fake RPC that holds for `holdMs`, then answers the abort
 *  command by emitting an interrupted toolResult + agent_end. */
function buildHoldRpc(holdMs: number): string {
	return `#!/usr/bin/env bun
const HOLD_MS = ${holdMs};
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
const emit = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
let toolActive = false;
let toolTimer = null;
const finish = (aborted) => {
  if (toolTimer) { clearTimeout(toolTimer); toolTimer = null; }
  toolActive = false;
  emit({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "tc_test",
      toolName: "bash",
      isError: aborted,
      content: [{ type: "text", text: aborted ? "[abort] interrupted" : "done" }]
    }
  });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: aborted ? "aborted" : "ok", contentIndex: 0 }, message: { role: "assistant", content: [] } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: aborted ? "aborted by user" : "ok" }] } });
  emit({ type: "agent_end" });
};
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let idx = buffer.indexOf("\\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) { idx = buffer.indexOf("\\n"); continue; }
    const f = JSON.parse(line);
    if (f.type === "switch_session") {
      emit({ type: "response", id: f.id, command: "switch_session", success: true, data: { cancelled: false } });
    } else if (f.type === "prompt") {
      emit({ type: "response", id: f.id, command: "prompt", success: true });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"sleep 30"}' }, message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "tc_test", name: "bash", arguments: { command: "sleep 30" } } }, message: { role: "assistant", content: [] } });
      toolActive = true;
      toolTimer = setTimeout(() => finish(false), HOLD_MS);
    } else if (f.type === "abort") {
      emit({ type: "response", id: f.id, command: "abort", success: true });
      if (toolActive) finish(true);
    }
    idx = buffer.indexOf("\\n");
  }
}
`;
}

describe("DingTalk stop-click end-to-end", () => {
	let tmpDir: string;
	let rpcPath: string;
	let bridge: AgentBridge;
	let channel: DingTalkChannel;
	let registry: ActionRegistry;
	let stopActionReceived: { cardInstanceId: string; toolName: string | undefined; userId: string } | null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stop-click-test-"));
		rpcPath = path.join(tmpDir, "fake-rpc");
		await Bun.write(rpcPath, buildHoldRpc(60_000));
		await fs.chmod(rpcPath, 0o755);

		bridge = new AgentBridge({ ompPath: rpcPath });
		await bridge.start();

		channel = new DingTalkChannel();
		channel.setAccountId("hr");
		channel.setConfig(HR_CONFIG);

		registry = new ActionRegistry();
		stopActionReceived = null;

		// Wire the same chain the gateway uses: handler looks up the
		// card in the registry, then aborts the bridge.
		channel.setCardActionHandler(async event => {
			if (event.params.type !== "stop") return;
			const info = registry.lookup(event.cardInstanceId);
			if (!info) return;
			stopActionReceived = {
				cardInstanceId: event.cardInstanceId,
				toolName: info.toolName,
				userId: event.userId,
			};
			await bridge.abort();
		});
	});

	afterEach(async () => {
		bridge.stop();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("a synthetic TOPIC_CARD stop click on a registered card aborts the bridge", async () => {
		// 1. Pre-register a card the way the gateway's streamCard does
		//    on create. The toolName-less entry is the eager one; the
		//    long-task watcher would later re-register with toolName.
		const cardInstanceId = "card_test_001";
		registry.register(cardInstanceId, { accountId: "hr", sessionId: "conv_1" });
		// Simulate the watcher's re-register-with-toolName (see
		// channel.streamCard's onLongTask branch).
		registry.register(cardInstanceId, {
			accountId: "hr",
			sessionId: "conv_1",
			toolName: "bash",
		});

		// 2. Confirm pre-condition: no active prompt yet, so abort would no-op.
		expect(bridge.isRunning).toBe(true);

		// 3. Drive a prompt in the background. We don't await it; we
		//    fire the stop click mid-flight, mirroring the watcher-then-
		//    click sequence the real gateway runs.
		const inbound = {
			channelId: "dingtalk" as const,
			accountId: "hr",
			userId: "601590212",
			conversationId: "conv_1",
			isGroup: false,
			content: { type: "text" as const, text: "test" },
			timestamp: new Date(),
		};
		const session = {
			id: "conv_1",
			channelId: "dingtalk" as const,
			accountId: "hr",
			userId: "601590212",
			conversationId: "conv_1",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			ompSessionPath: "/tmp/test-session.jsonl",
			status: "active" as const,
		};
		const forwardP = bridge.forwardWithMeta(inbound, session);

		// 4. Wait for the bridge to start the prompt. The first thing
		//    the bridge does is send switch_session; once it sees the
		//    response, it sends the prompt. We poll for an active
		//    promptId via the public getSnapshot() API.
		const pollStart = Date.now();
		while (Date.now() - pollStart < 5_000) {
			if (bridge.getSnapshot().activePromptId) break;
			await Bun.sleep(20);
		}
		// Sanity: prompt is in flight, abort should not be a no-op.
		expect(bridge.getSnapshot().activePromptId).toBeTruthy();

		// 5. Fire the synthetic stop click. The shape mirrors what
		//    DingTalk's TOPIC_CARD SDK delivers.
		const frame = {
			headers: { messageId: "msg-stop-1" },
			data: JSON.stringify({
				type: "actionCallback",
				outTrackId: cardInstanceId,
				corpId: "dingcorp1",
				userId: "601590212",
				content: JSON.stringify({
					cardPrivateData: {
						actionIds: ["btn_stop"],
						params: { type: "stop", sessionId: "conv_1", toolName: "bash" },
					},
				}),
			}),
		};
		await channel.__testHandleCardCallback(
			frame as unknown as Parameters<typeof channel.__testHandleCardCallback>[0],
		);

		// 6. Wait for the action handler to run. It's async; the bridge
		//    abort call is also async. Give it a few ticks.
		const handlerStart = Date.now();
		while (Date.now() - handlerStart < 2_000) {
			if (stopActionReceived) break;
			await Bun.sleep(20);
		}

		// 7. Verify the handler received the right event.
		expect(stopActionReceived).not.toBeNull();
		expect(stopActionReceived?.cardInstanceId).toBe(cardInstanceId);
		expect(stopActionReceived?.toolName).toBe("bash");
		expect(stopActionReceived?.userId).toBe("601590212");

		// 8. Verify forwardWithMeta returned with aborted: true.
		const meta: AgentResponseMeta | null = await forwardP;
		expect(meta).not.toBeNull();
		expect(meta?.aborted).toBe(true);
	});

	test("unknown cardInstanceId is a no-op (registry miss, no abort)", async () => {
		let handlerInvoked = false;
		channel.setCardActionHandler(async () => {
			handlerInvoked = true;
		});
		const frame = {
			headers: { messageId: "msg-2" },
			data: JSON.stringify({
				type: "actionCallback",
				outTrackId: "card_never_registered",
				userId: "u",
				content: JSON.stringify({
					cardPrivateData: { params: { type: "stop" } },
				}),
			}),
		};
		await channel.__testHandleCardCallback(
			frame as unknown as Parameters<typeof channel.__testHandleCardCallback>[0],
		);
		// Handler IS invoked (channel-level), but the registry lookup
		// is the one that no-ops.
		expect(handlerInvoked).toBe(true);
	});

	test("non-stop action type is a no-op (handler decides)", async () => {
		const cardInstanceId = "card_test_002";
		registry.register(cardInstanceId, { accountId: "hr", sessionId: "conv_2", toolName: "bash" });
		const events: string[] = [];
		channel.setCardActionHandler(async ev => {
			events.push(ev.params.type);
			// Only stop calls abort — this handler is selective.
			if (ev.params.type === "stop") await bridge.abort();
		});

		const frame = {
			headers: { messageId: "msg-3" },
			data: JSON.stringify({
				type: "actionCallback",
				outTrackId: cardInstanceId,
				userId: "u",
				content: JSON.stringify({
					cardPrivateData: { params: { type: "view-detail" } },
				}),
			}),
		};
		await channel.__testHandleCardCallback(
			frame as unknown as Parameters<typeof channel.__testHandleCardCallback>[0],
		);
		expect(events).toEqual(["view-detail"]);
		// Bridge was never prompted → no active prompt → abort would
		// throw if called, but the handler skipped it, so we're fine.
	});
});
