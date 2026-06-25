/**
 * Long-task watcher end-to-end test.
 *
 * Bypasses the LLM: spawns a fake `omp --mode rpc` binary that emits a
 * single long-running `bash` tool call, holds for the configured
 * duration, then emits the tool result. The bridge's `onLongTask`
 * watcher fires at `longTaskThresholdMs` and pushes a stop block into
 * the card via the real DingTalkChannel → real DingTalk API. The user
 * sees a real card with a real "停止" button on their DingTalk.
 *
 * No LLM round-trip; no agent session file needed. The bridge uses the
 * fake RPC as its `ompPath`, so it never spawns a real omp process.
 *
 * Usage:
 *   import { runLongTaskTest } from "./test-longtask";
 *   await runLongTaskTest({ accountId: "hr", holdMs: 35_000, ... });
 *
 * `holdMs` controls how long the fake tool call takes; the watcher's
 * threshold + ping intervals come from the same env vars the production
 * gateway uses (DINGTALK_LONG_TASK_THRESHOLD_MS, etc.) so the test
 * exercises the same configuration code path.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentBridge, type ForwardStreamHandlers } from "./agent-bridge";
import { DingTalkChannel } from "./channels/dingtalk";
import type { DingTalkConfig } from "./types";
import type { InboundMessage, SessionRecord } from "./types";

/** Per-account DingTalk config in gateway.json. */
interface AccountEntry {
	appKey: string;
	appSecret: string;
	robotCode: string;
	agentDir: string;
}

/** Top-level gateway config. */
interface GatewayConfigJson {
	channels?: {
		dingtalk?: {
			accounts?: Record<string, AccountEntry>;
		};
	};
}

/** Public test runner. */
export interface LongTaskTestOptions {
	accountId: string;
	holdMs: number;
	/** Real DingTalk user ID that the test card should be delivered to. */
	userId: string;
	/** Synthetic conversation ID. Real DingTalk uses long hashes; this
	 * is fine because the test never sends anything back to this
	 * conversation, it only delivers a fresh card to `userId`. */
	conversationId?: string;
	/** Override the gateway config path. Default: ~/.omp/gateway.json. */
	configPath?: string;
	/** If true, after the long-task watcher fires the threshold, the
	 *  test synthesises a TOPIC_CARD stop-click callback and routes it
	 *  through the channel's `__testHandleCardCallback` test seam. The
	 *  channel's action handler is wired to the same code path the
	 *  gateway uses (ActionRegistry lookup → bridge.abort()). This
	 *  exercises the full stop-button chain end-to-end without needing
	 *  a human to click a real DingTalk button. */
	simulateStopClick?: boolean;
}

export interface LongTaskTestResult {
	success: boolean;
	cardInstanceId?: string;
	watcherFired?: boolean;
	watcherEvents?: number;
	/** True if the action handler received the synthetic stop click. */
	stopActionHandled?: boolean;
	/** True if `bridge.abort()` returned true (active prompt existed). */
	aborted?: boolean;
	error?: string;
}

/** Build the fake RPC script that simulates a long-running bash tool call.
 *
 * Behaviour:
 *   - On `prompt`: emit toolcall_start/delta/end for `bash sleep N`,
 *     then start a setTimeout. The bridge's onLongTask watcher fires
 *     at its threshold (~5s in tests) and pushes a stop block.
 *   - On `abort`: clear the setTimeout, emit an interrupted toolResult
 *     + final text + agent_end, then send the abort response. This
 *     matches what a real LLM-driven `omp --mode rpc` does on SIGINT
 *     / abort: the in-flight tool is cancelled, the model gets a
 *     `isError: true` result, and the run ends.
 *   - On `setTimeout` (no abort): emit the normal toolResult + final
 *     text + agent_end.
 *
 * The two paths converge on `agent_end` so the bridge's
 * `forwardWithMeta` always resolves cleanly. */
function buildFakeRpcScript(holdMs: number): string {
	const holdMsLiteral = holdMs;
	return `#!/usr/bin/env bun
// Synthetic RPC for long-task watcher test.
const HOLD_MS = ${holdMsLiteral};
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");

let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function setBuf(s) { buffer = s; }

let toolTimer = null;
let toolActive = false;
let promptResponseId = null;

function finishNormally() {
  toolActive = false;
  toolTimer = null;
  emit({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "tc_longtask",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "done after " + HOLD_MS + "ms" }]
    }
  });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "ok", contentIndex: 0 },
    message: { role: "assistant", content: [] }
  });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }]
    }
  });
  emit({ type: "agent_end" });
}

function finishByAbort() {
  if (toolTimer) { clearTimeout(toolTimer); toolTimer = null; }
  toolActive = false;
  emit({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "tc_longtask",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "[abort] interrupted by user" }]
    }
  });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "aborted", contentIndex: 0 },
    message: { role: "assistant", content: [] }
  });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "aborted by user" }]
    }
  });
  emit({ type: "agent_end" });
}

for await (const chunk of Bun.stdin.stream()) {
  setBuf(buffer + new TextDecoder().decode(chunk));
  let idx = buffer.indexOf("\\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) { idx = buffer.indexOf("\\n"); continue; }
    const frame = JSON.parse(line);
    if (frame.type === "switch_session") {
      emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    } else if (frame.type === "prompt") {
      promptResponseId = frame.id;
      emit({ type: "response", id: frame.id, command: "prompt", success: true });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"sleep ' + Math.ceil(HOLD_MS / 1000) + '"}' },
        message: { role: "assistant", content: [] }
      });
      emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { id: "tc_longtask", name: "bash", arguments: { command: "sleep " + Math.ceil(HOLD_MS / 1000) } }
        },
        message: { role: "assistant", content: [] }
      });
      toolActive = true;
      toolTimer = setTimeout(finishNormally, HOLD_MS);
    } else if (frame.type === "abort") {
      // Acknowledge abort FIRST so the bridge's sendCommandAndWait
      // resolves before we emit the post-abort stream events. The
      // bridge has its own promise chain and will move on once the
      // response arrives; emitting the toolResult / agent_end after
      // the response is safe because the bridge keeps reading from
      // its reader loop until it sees agent_end (or timeout).
      emit({ type: "response", id: frame.id, command: "abort", success: true });
      if (toolActive) finishByAbort();
    }
    idx = buffer.indexOf("\\n");
  }
}
`;
}

/** Read gateway config; returns the per-account DingTalk entry. */
async function loadAccountConfig(
	accountId: string,
	configPath: string,
): Promise<{ dtConfig: DingTalkConfig; agentDir: string }> {
	if (!existsSync(configPath)) {
		throw new Error(`Gateway config not found at ${configPath}`);
	}
	const raw = (await Bun.file(configPath).json()) as GatewayConfigJson;
	const account = raw.channels?.dingtalk?.accounts?.[accountId];
	if (!account) {
		throw new Error(
			`Account "${accountId}" not found in ${configPath}. Available: ${Object.keys(
				raw.channels?.dingtalk?.accounts ?? {},
			).join(", ")}`,
		);
	}
	if (!account.appKey || !account.appSecret) {
		throw new Error(`Account "${accountId}" is missing appKey or appSecret`);
	}
	return {
		dtConfig: {
			enabled: true,
			appKey: account.appKey,
			appSecret: account.appSecret,
			robotCode: account.robotCode ?? account.appKey,
			accounts: { [accountId]: account },
		},
		agentDir: account.agentDir,
	};
}

/**
 * Run the long-task watcher test against the given DingTalk account.
 *
 * The fake RPC binary is created in a temp dir; the test cleans it up
 * before returning. The bridge is stopped before returning.
 */
export async function runLongTaskTest(opts: LongTaskTestOptions): Promise<LongTaskTestResult> {
	const configPath = opts.configPath ?? path.join(os.homedir(), ".omp", "gateway.json");
	const conversationId = opts.conversationId ?? `test-longtask-${Date.now()}`;

	const { dtConfig, agentDir } = await loadAccountConfig(opts.accountId, configPath);

	// 1. Write the fake RPC binary
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-longtask-test-"));
	const rpcPath = path.join(tmpDir, "fake-rpc");
	await Bun.write(rpcPath, buildFakeRpcScript(opts.holdMs));
	await fs.chmod(rpcPath, 0o755);

	// 2. Create the bridge (no real agent, no real session)
	const bridge = new AgentBridge({
		ompPath: rpcPath,
		timeoutMs: 5 * 60_000,
		// Force a short threshold so we don't have to wait the default 3
		// min. The watcher should also be tunable via the env var, but
		// the option takes precedence — set it explicitly so the test
		// is self-contained and the env-var code path doesn't fight us.
		longTaskThresholdMs: 5_000,
		progressPingIntervalMs: 10_000,
	});
	await bridge.start();

	// 3. Create the DingTalk channel with a synthetic config (skips WS connect)
	const channel = new DingTalkChannel();
	channel.setAccountId(opts.accountId);
	channel.setConfig(dtConfig);

	// 4. Build a synthetic inbound message + session
	const inbound: InboundMessage = {
		channelId: "dingtalk",
		accountId: opts.accountId,
		userId: opts.userId,
		conversationId,
		isGroup: false,
		content: { type: "text", text: "[long-task test] trigger long bash tool" },
		timestamp: new Date(),
	};
	const session: SessionRecord = {
		id: conversationId,
		channelId: "dingtalk",
		accountId: opts.accountId,
		userId: opts.userId,
		conversationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		ompSessionPath: path.join(agentDir, "sessions", `${conversationId}.jsonl`),
		status: "active",
	};

	// 5. Run the card stream
	const { ActionRegistry } = await import("./action-registry");
	const actionRegistry = new ActionRegistry();
	let observedCardInstanceId: string | null = null;
	let stopActionHandled = false;
	let aborted = false;
	let stopClicked = false;
	const context = {
		accountId: opts.accountId,
		agentName: opts.accountId,
		dapiCalls: 0,
		// Mirror the gateway's registerCardAction wiring. The channel
		// calls this on card create (eager) and again on onLongTask
		// (with the toolName that the watcher just learned). We capture
		// the cardInstanceId the first time it lands so the simulated
		// stop click has the right key.
		registerCardAction: (info: {
			cardInstanceId: string;
			accountId: string;
			sessionId: string;
			toolName?: string;
		}) => {
			observedCardInstanceId = info.cardInstanceId;
			actionRegistry.register(info.cardInstanceId, {
				accountId: info.accountId,
				sessionId: info.sessionId,
				toolName: info.toolName,
			});
		},
	};

	// Mirror the gateway's action handler: on a `stop` action, look up
	// the card in the registry, then ask the bridge to abort. This is
	// the same chain `#handleCardAction` runs in production — the
	// only thing the gateway adds on top is the SessionManager hop.
	channel.setCardActionHandler(async event => {
		if (event.params.type !== "stop") return;
		const info = actionRegistry.lookup(event.cardInstanceId);
		if (!info) return;
		stopActionHandled = true;
		console.log(
			`[long-task test] card stop action received — card=${event.cardInstanceId} tool=${info.toolName} clickedBy=${event.userId}`,
		);
		try {
			aborted = await bridge.abort();
		} catch (err) {
			console.log(`[long-task test] bridge.abort() threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// The channel builds its own ForwardStreamHandlers internally
	// (including onLongTask). It calls `submit(handlers)` to forward
	// them to the bridge. We don't see the handlers from outside; the
	// card delivery itself is the signal — if the watcher's stop
	// block appears in the card, the test succeeded. We also wrap
	// `submit` to log the watcher's fire so the CLI shows progress.
	const longTaskLog: Array<{ threshold: boolean; toolName: string; elapsedMs: number }> = [];
	const submit = (h?: ForwardStreamHandlers) => {
		if (h?.onLongTask) {
			const orig = h.onLongTask;
			h.onLongTask = evt => {
				longTaskLog.push({ threshold: evt.threshold, toolName: evt.toolName, elapsedMs: evt.elapsedMs });
				console.log(
					`[long-task test] onLongTask FIRED threshold=${evt.threshold} tool=${evt.toolName} elapsed=${evt.elapsedMs}ms`,
				);
				orig(evt);
			};
		}
		return bridge.forwardWithMeta(inbound, session, h);
	};

	// Fire the simulated stop click ~500ms after the watcher hits its
	// threshold. This gives the channel time to push the stop block
	// into the card and re-register the action with the toolName. The
	// `setInterval` checks every 100ms so the wait is short and
	// bounded; we cap at holdMs so the test never blocks past the
	// tool's natural timeout.
	const stopClickWatcher = setInterval(() => {
		if (!opts.simulateStopClick) return;
		if (stopClicked) return;
		const thresholdFire = longTaskLog.find(e => e.threshold);
		if (!thresholdFire) return;
		if (!observedCardInstanceId) return;
		// Defer one extra tick so the channel's re-register-with-toolName
		// (which runs synchronously after pushing the stop block) has
		// landed in the registry before we look it up via the handler.
		stopClicked = true;
		setTimeout(() => {
			const cardInstanceId = observedCardInstanceId!;
			const toolName = thresholdFire.toolName;
			const sessionId = inbound.conversationId;
			console.log(`[long-task test] simulating TOPIC_CARD stop click for card=${cardInstanceId}`);
			const syntheticMsg = {
				headers: { messageId: `synthetic-stop-${Date.now()}` },
				data: JSON.stringify({
					type: "actionCallback",
					outTrackId: cardInstanceId,
					corpId: "test-corp",
					userId: opts.userId,
					content: JSON.stringify({
						cardPrivateData: {
							actionIds: ["btn_stop"],
							params: { type: "stop", sessionId, toolName },
						},
					}),
				}),
			} as unknown as Parameters<typeof channel.__testHandleCardCallback>[0];
			void channel.__testHandleCardCallback(syntheticMsg);
		}, 200);
	}, 100);

	let cardOutbound: { id: string } | null = null;
	try {
		const result = await channel.streamCard(inbound, session, context, submit);
		cardOutbound = result as { id: string } | null;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		clearInterval(stopClickWatcher);
		bridge.stop();
		await fs.rm(tmpDir, { recursive: true, force: true });
		return { success: false, error: `streamCard threw: ${message}` };
	}
	clearInterval(stopClickWatcher);

	// Allow the post-streamCard abort chain to settle: the handler is
	// async and the bridge.abort() RPC round-trip happens after
	// streamCard returns. 500ms is plenty for the in-process fake.
	if (opts.simulateStopClick) {
		await Bun.sleep(500);
	}

	bridge.stop();
	await fs.rm(tmpDir, { recursive: true, force: true });

	// streamCard returns null when card creation failed; that's
	// distinct from a successful run that produced no stop block.
	if (!cardOutbound) {
		return {
			success: false,
			error: "channel.streamCard returned null — card creation failed; check gateway logs",
		};
	}

	// Even when the card is delivered, we want the operator to see
	// whether the watcher actually fired — if it didn't, the card
	// won't have the stop block affordance.
	const thresholdFired = longTaskLog.some(e => e.threshold);

	return {
		success: true,
		cardInstanceId: observedCardInstanceId ?? undefined,
		watcherFired: thresholdFired,
		watcherEvents: longTaskLog.length,
		stopActionHandled: opts.simulateStopClick ? stopActionHandled : undefined,
		aborted: opts.simulateStopClick ? aborted : undefined,
	};
}
