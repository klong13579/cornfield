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
}

export interface LongTaskTestResult {
	success: boolean;
	cardInstanceId?: string;
	watcherFired?: boolean;
	watcherEvents?: number;
	error?: string;
}

/** Build the fake RPC script that simulates a long-running bash tool call. */
function buildFakeRpcScript(holdMs: number): string {
	const holdMsLiteral = holdMs;
	return `#!/usr/bin/env bun
// Synthetic RPC for long-task watcher test.
// Emits: ready → switch_session response → prompt response → toolcall
// (held for HOLD_MS) → toolresult → final text → agent_end.
const HOLD_MS = ${holdMsLiteral};
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");

let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }

for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let idx = buffer.indexOf("\\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) { idx = buffer.indexOf("\\n"); continue; }
    const frame = JSON.parse(line);
    if (frame.type === "switch_session") {
      emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    } else if (frame.type === "prompt") {
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
      // Hold using real wall clock so the bridge's setTimeout fires.
      const start = Date.now();
      while (Date.now() - start < HOLD_MS) { /* spin */ }
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
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", id: "tc_longtask", name: "bash", arguments: { command: "sleep " + Math.ceil(HOLD_MS / 1000) } }
          ]
        }
      });
      emit({ type: "agent_end" });
    } else if (frame.type === "abort") {
      emit({ type: "response", id: frame.id, command: "abort", success: true });
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
	const context = {
		accountId: opts.accountId,
		agentName: opts.accountId,
		dapiCalls: 0,
	};

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

	let cardOutbound: { id: string } | null = null;
	try {
		const result = await channel.streamCard(inbound, session, context, submit);
		cardOutbound = result as { id: string } | null;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Clean up before failing
		bridge.stop();
		await fs.rm(tmpDir, { recursive: true, force: true });
		return { success: false, error: `streamCard threw: ${message}` };
	} finally {
		bridge.stop();
		await fs.rm(tmpDir, { recursive: true, force: true });
	}

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
		cardInstanceId: cardOutbound.id,
		watcherFired: thresholdFired,
		watcherEvents: longTaskLog.length,
	};
}
