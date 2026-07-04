/**
 * E2E: real DM injection via `POST /test/inject` → LLM → `cron` host tool → v2 task.
 *
 * Wires a real Gateway (`OMP_GATEWAY_TEST_MODE=1`) with a fake OMP RPC that
 * simulates an LLM calling the gateway-registered `cron` host tool. After
 * the DM is injected, the test reads the scheduler DB and asserts the
 * created `ScheduledTask` matches the v2 JSON shape (the same shape
 * `omp gateway cron list --json` emits).
 *
 * What this proves:
 *   1. The /test/inject endpoint (Gateway.#startTestServer) is wired and
 *      the FakeDingTalkChannel routes injected messages through the same
 *      parse → dedup → permission → handleInbound path as real DingTalk.
 *   2. The AgentBridge registers the `cron` host tool via `set_host_tools`
 *      and dispatches `host_tool_call` frames through HostToolDispatcher.
 *   3. The cron tool handler:
 *      - reads the bridge's active chat context (D4 auto-inference)
 *      - creates a v2 ScheduledTask with `delivery.channel` and
 *        `delivery.toUserId` (DM) or `delivery.toConversationId` (group)
 *        inferred from the inbound message
 *      - validates the channel is registered in ChannelRegistry
 *   4. The resulting task's JSON serialization is the same shape as
 *      `omp gateway cron list --json`.
 *
 * No real LLM, no real DingTalk API. Runs in <1s.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { Gateway } from "../src/gateway";
import { DingTalkChannel } from "../src/channels/dingtalk";
import { SchedulerDbStorage } from "../src/scheduler/storage";
import { getSchedulerDbPath } from "../src/scheduler/types";
import type { DingTalkRawMessage, OutboundMessage } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Fake OMP RPC — handles set_host_tools + emits a cron host tool call
// ═══════════════════════════════════════════════════════════════════════
//
// This script stands in for `omp --mode rpc`. It:
//  1. Replies to every setup command (get_state / set_model / switch_session /
//     set_host_tools) with a successful response so the gateway bridge reaches
//     `idle`.
//  2. On `prompt`: emits a `host_tool_call` for the `cron` tool with the
//     payload the LLM would have produced if the user had asked it to
//     schedule a task. NO `delivery` field is sent — the gateway must
//     auto-infer delivery from the active chat context (D4).
//  3. On `host_tool_result`: the tool has run. Emit a final assistant
//     text reply + `agent_end` so the bridge flushes the response back
//     to the channel.
const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
// Send the ready signal immediately so the RpcTransport knows
// the subprocess is up and can start writing commands.
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
function emit(v) { process.stdout.write(JSON.stringify(v) + "\\n"); }
function ack(id, command, data) {
  emit({ type: "response", id, command, success: true, data: data ?? {} });
}
async function handleFrame(frame) {
  switch (frame.type) {
    case "get_state":
      ack(frame.id, "get_state", { model: "fake-model", provider: "fake-provider", modelId: "fake-model" });
      return;
    case "set_model":
      ack(frame.id, "set_model");
      return;
    case "switch_session":
      ack(frame.id, "switch_session", { cancelled: false });
      return;
    case "set_host_tools":
      ack(frame.id, "set_host_tools", { toolNames: frame.tools.map(t => t.name) });
      return;
    case "set_denied_tools":
      ack(frame.id, "set_denied_tools");
      return;
    case "prompt": {
      ack(frame.id, "prompt");
      // Simulate the LLM deciding to call the cron host tool.
      setTimeout(() => {
        emit({
          type: "host_tool_call",
          id: "htc-" + Date.now(),
          toolCallId: "tc-1",
          toolName: "cron",
          arguments: {
            action: "add",
            name: "check-mail-daily",
            schedule: "0 9 * * *",
            prompt: "\u63d0\u9192\u6211\u68c0\u67e5\u90ae\u4ef6",
            taskType: "agent",
            agentDir: process.env.OMP_TEST_AGENT_DIR
            // Note: no delivery field - the gateway must auto-infer it
            // from the active chat context (D4).
          },
        });
      }, 50);
      return;
    }
    case "host_tool_result": {
      // The cron tool has run. Emit the LLM's final reply.
      setTimeout(() => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已为你创建每天 9 点的邮件提醒" }],
          },
        });
        emit({ type: "agent_end" });
      }, 50);
      return;
    }
    case "abort":
      ack(frame.id, "abort");
      return;
  }
  // Unrecognised: ignore (or echo minimally so we don't lock the line)
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let i = buffer.indexOf("\\n");
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) await handleFrame(JSON.parse(line)).catch(() => {});
    i = buffer.indexOf("\\n");
  }
}
`;

// ═══════════════════════════════════════════════════════════════════════
// Fake DWClient — EventEmitter that simulates the Stream SDK without
// dialling DingTalk. Inherits the real DWClient type so the channel's
// `createDWClient` factory seam accepts it.
// ═══════════════════════════════════════════════════════════════════════

class FakeDWClient extends EventEmitter {
	socketCallBackResponse(_messageId: string, _result: { success: boolean }): void {}
	async connect(): Promise<void> {
		(this as any).socket = new EventEmitter();
		(this as any).socket.readyState = 1; // WebSocket.OPEN
		queueMicrotask(() => this.emit("connect"));
	}
	disconnect(): void {
		(this as any).socket = null;
		this.emit("disconnect");
	}
	registerCallbackListener(_topic: string, _handler: (msg: unknown) => void): void {}
}

// ═══════════════════════════════════════════════════════════════════════
// FakeDingTalkChannel — overrides createDWClient + sendMessage
// ═══════════════════════════════════════════════════════════════════════

class FakeDingTalkChannel extends DingTalkChannel {
	sentOutbound: OutboundMessage[] = [];
	#accountId: string | null = null;

	protected override createDWClient(_opts: {
		clientId: string;
		clientSecret: string;
		ua?: string;
		debug?: boolean;
		autoReconnect?: boolean;
	}): FakeDWClient {
		return new FakeDWClient();
	}

	override async sendMessage(msg: OutboundMessage): Promise<void> {
		this.sentOutbound.push(msg);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function makeChannelFactory(channels: Map<string, FakeDingTalkChannel>): (accountId?: string) => DingTalkChannel {
	return (accountId?: string) => {
		const ch = new FakeDingTalkChannel();
		if (accountId) channels.set(accountId, ch);
		return ch;
	};
}

function makeDmMessage(
	overrides: Partial<DingTalkRawMessage> & { senderId: string; conversationId: string; text: string },
): DingTalkRawMessage {
	return {
		conversationType: "1", // DM
		chatbotCorpId: "corp001",
		chatbotUserId: "bot001",
		isAdmin: false,
		senderCorpId: "corp001",
		robotCode: "robot001",
		isInAtList: false,
		atUsers: [],
		conversationTitle: "DM",
		sessionWebhookExpiredTime: Date.now() + 3600_000,
		createAt: Date.now(),
		msgtype: "text",
		senderNick: "测试用户",
		senderStaffId: overrides.senderId,
		sessionWebhook: `https://example.com/webhook/${overrides.conversationId}`,
		msgId: `msg-${overrides.conversationId}-${Date.now()}`,
		...overrides,
		text: { content: overrides.text },
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Test
// ═══════════════════════════════════════════════════════════════════════

describe("DM injection → cron host tool → v2 task", () => {
	let rootDir: string;
	let rpcPath: string;
	let testPort: number;
	let gateway: Gateway | null = null;
	let savedHome: string | undefined;
	let savedTestMode: string | undefined;
	let savedTestPort: string | undefined;
	let fakeChannels: Map<string, FakeDingTalkChannel>;

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gw-dm-inject-"));
		rpcPath = path.join(rootDir, "fake-rpc");
		await Bun.write(rpcPath, FAKE_RPC_SCRIPT);
		await fs.chmod(rpcPath, 0o755);

		// On macOS, Bun's `os.homedir()` reads the system passwd database
		// rather than `process.env.HOME`, so we can't redirect scheduler
		// storage by setting `HOME` alone. The scheduler exposes
		// `OMP_GATEWAY_DATA_DIR` (see `getGatewayDataDir()`) which we
		// honour for hermetic test isolation.
		testPort = 40000 + Math.floor(Math.random() * 10000);
		savedHome = process.env.HOME;
		process.env.OMP_GATEWAY_DATA_DIR = path.join(rootDir, ".omp", "gateway-data");
		await fs.mkdir(process.env.OMP_GATEWAY_DATA_DIR, { recursive: true, mode: 0o700 });

		// Wipe scheduler DB from previous test runs (scheduler always uses
		// the default path at ~/.omp/gateway-data/ — does not respect
		// OMP_GATEWAY_DATA_DIR or config.dataDir).
		try {
			const sdb = getSchedulerDbPath();
			await fs.rm(sdb, { force: true });
			await fs.rm(sdb + "-wal", { force: true });
			await fs.rm(sdb + "-shm", { force: true });
		} catch {}
		savedTestMode = process.env.OMP_GATEWAY_TEST_MODE;
		savedTestPort = process.env.OMP_GATEWAY_TEST_PORT;
		process.env.HOME = rootDir;
		process.env.OMP_GATEWAY_TEST_MODE = "1";
		process.env.OMP_GATEWAY_TEST_PORT = String(testPort);
		fakeChannels = new Map();
	});

	afterEach(async () => {
		if (gateway) {
			await gateway.stop().catch(() => {});
			gateway = null;
		}
		// Restore env FIRST so a gateway.stop() failure doesn't leak HOME.
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedTestMode === undefined) delete process.env.OMP_GATEWAY_TEST_MODE;
		else process.env.OMP_GATEWAY_TEST_MODE = savedTestMode;
		if (savedTestPort === undefined) delete process.env.OMP_GATEWAY_TEST_PORT;
		else process.env.OMP_GATEWAY_TEST_PORT = savedTestPort;
		delete process.env.OMP_GATEWAY_DATA_DIR;
		await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
	});

	/**
	 * End-to-end smoke for D4 (delivery auto-inference) + the v2 task shape.
	 *
	 * Sequence:
	 *   1. Gateway starts in test mode → /test/inject + bridge are live.
	 *   2. POST a DM to /test/inject.
	 *   3. Bridge routes to fake OMP via prompt; fake OMP emits a
	 *      `host_tool_call` for the `cron` tool with NO `delivery` field.
	 *   4. HostToolDispatcher dispatches to `handleCronAction`, which reads
	 *      the active chat context (set by `forwardWithMeta`) and infers
	 *      `{channel: "dingtalk", accountId: "hr", toUserId: <senderId>}`.
	 *   5. Task is persisted in the scheduler DB.
	 *   6. Fake OMP receives the tool result, emits the LLM reply.
	 *   7. Bridge sends the reply back through the channel.
	 *
	 * We then verify:
	 *   - the inbound was accepted by /test/inject
	 *   - exactly one ScheduledTask was created
	 *   - the task's JSON shape matches what `omp gateway cron list --json`
	 *     would print (delivery, agentDir, command, cron, status, etc.)
	 *   - the auto-inferred delivery has channel="dingtalk" and
	 *     toUserId=<senderId> (DM inference)
	 *   - the LLM's reply was captured via the test seam
	 */
	test("DM inject triggers cron.add with auto-inferred DM delivery and v2 task shape", async () => {
		const agentDir = path.join(rootDir, "agents", "hr");
		const config = {
			channels: {
				dingtalk: {
					enabled: true,
					dmPolicy: "open" as const,
					groupPolicy: "open" as const,
					accounts: {
						hr: {
							appKey: "test-key",
							appSecret: "test-secret",
							robotCode: "test-robot",
							agentDir,
						},
					},
				},
			},
			agent: { ompPath: rpcPath, timeoutMs: 5_000 },
			session: { resetPolicy: "none" as const },
			cron: { enabled: true, tickIntervalMs: 60_000 },
			dataDir: rootDir,
		};

		// Mock fetch: card creation fails (force V1 markdown reply path),
		// token fetch returns a stub. Everything else (including the test
		// driver's own calls to /test/health and /test/inject) passes through
		// to the real fetch so we can observe the gateway's behavior.
		const realFetch = globalThis.fetch;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes("card/instances")) {
					return new Response(JSON.stringify({ success: false, errmsg: "simulated" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.includes("oauth2/accessToken")) {
					return new Response(JSON.stringify({ accessToken: "fake-token", expireIn: 7200 }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				// Pass through: real DingTalk / OMP / test-inject calls hit the wire.
				return realFetch.call(globalThis, input, init);
			},
		);

		// The fake OMP subprocess reads this to know which agentDir to
		// attach to the cron tool call (matches the gateway's hr account).
		process.env.OMP_TEST_AGENT_DIR = agentDir;

		gateway = new Gateway(config, {
			channelFactory: makeChannelFactory(fakeChannels),
		});

		try {
			await gateway.start();

			// Give the bridge subprocess a moment to send `set_host_tools` and
			// for the fake OMP to ack it. Without this sleep the prompt can
			// race the registration and OMP may emit host_tool_call for a
			// tool that hasn't been registered yet.
			await Bun.sleep(500);

			// Confirm /test/inject is live.
			const health = await fetch(`http://127.0.0.1:${testPort}/test/health`);
			expect(health.status).toBe(200);
			const healthBody = (await health.json()) as { ok: boolean; mode: string };
			expect(healthBody.ok).toBe(true);
			expect(healthBody.mode).toBe("test-injection");

			// Build the DM payload.
			const conversationId = "conv-dm-e2e-001";
			const senderId = "user-dm-sender-001";
			const dmMessage = makeDmMessage({
				conversationId,
				senderId,
				senderStaffId: senderId,
				text: "帮我每天早上 9 点提醒我检查邮件",
			});

			// POST to /test/inject with captureOutbound so the response
			// includes the LLM's reply text. awaitMs gives the prompt
			// → tool call → tool result → reply chain time to complete.
			const injectResp = await fetch(`http://127.0.0.1:${testPort}/test/inject`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					accountId: "hr",
					captureOutbound: true,
					awaitMs: 3000,
					raw: dmMessage,
				}),
			});
			const injectResult = (await injectResp.json()) as {
				ok: boolean;
				messageId: string;
				conversationId: string;
				userId: string;
				captured: Array<{ conversationId: string; contentType: string; text?: string; markdown?: string }>;
			};
			expect(injectResult.ok).toBe(true);
			expect(injectResult.conversationId).toBe(conversationId);
			expect(injectResult.userId).toBe(senderId);

			// Allow a tail of the message loop to settle (host_tool_result
			// → message_end → channel.sendMessage).
			await Bun.sleep(500);

			// ── Assert: task created with v2 shape ──
			// Same construction as `omp gateway cron list --json`:
			//   const tasks = storage.listTasks();
			//   console.log(JSON.stringify(tasks, null, 2));
			const schedulerStorage = new SchedulerDbStorage(getSchedulerDbPath());
			const tasks = schedulerStorage.listTasks();
			expect(tasks.length).toBe(1);

			const task = tasks[0]!;
			// The v2 ScheduledTask shape:
			expect(task.name).toBe("check-mail-daily");
			expect(task.cron).toBe("0 9 * * *");
			expect(task.taskType).toBe("agent");
			expect(task.command).toBe("提醒我检查邮件");
			expect(task.status).toBe("active");
			expect(task.agentDir).toBe(agentDir);
			expect(task.delivery).toEqual({
				channel: "dingtalk",
				accountId: "hr",
				toUserId: senderId, // ← auto-inferred from the active DM context
				mode: "announce",
			});

			// The JSON shape is identical to what `omp gateway cron list --json`
			// prints — callers can rely on the same field set.
			const jsonShape = JSON.parse(JSON.stringify(task));
			expect(jsonShape.delivery.toUserId).toBe(senderId);
			expect(jsonShape.delivery.channel).toBe("dingtalk");
			expect(jsonShape.delivery.toConversationId).toBeUndefined();
			expect(jsonShape.cron).toBe("0 9 * * *");

			// ── Assert: the LLM's reply was captured ──
			// The reply goes through channel.sendMessage, which is
			// temporarily replaced by `captureOutbound: true` so the test
			// driver can observe it without standing up a fake DingTalk
			// webhook. The captured messages land in `injectResult.captured`.
			const reply = injectResult.captured.find(c => c.contentType === "markdown" || c.contentType === "text");
			expect(reply).toBeDefined();
			const replyText = reply!.markdown ?? reply!.text ?? "";
			expect(replyText).toContain("已为你创建");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	/**
	 * Group DM variant: verifies the auto-inference branch picks
	 * `toConversationId` (not `toUserId`) when the active chat is a
	 * group. The XOR refinement in `CronDeliverySchema` would reject
	 * a payload that sets both, so the gateway must choose correctly.
	 */
	test("Group inject triggers cron.add with auto-inferred toConversationId", async () => {
		const agentDir = path.join(rootDir, "agents", "hr");
		const config = {
			channels: {
				dingtalk: {
					enabled: true,
					dmPolicy: "open" as const,
					groupPolicy: "open" as const,
					accounts: {
						hr: {
							appKey: "test-key",
							appSecret: "test-secret",
							robotCode: "test-robot",
							agentDir,
						},
					},
				},
			},
			agent: { ompPath: rpcPath, timeoutMs: 5_000 },
			session: { resetPolicy: "none" as const },
			cron: { enabled: true, tickIntervalMs: 60_000 },
			dataDir: rootDir,
		};

		// Group test: override the fake OMP so its emitted cron task name
		// differs from the DM test, and the group conversation title is
		// distinct.
		const groupRpc = path.join(rootDir, "fake-rpc-group");
		const groupScript = FAKE_RPC_SCRIPT.replace('name: "check-mail-daily"', 'name: "group-daily-summary"');
		await Bun.write(groupRpc, groupScript);
		await fs.chmod(groupRpc, 0o755);
		config.agent.ompPath = groupRpc;

		const realFetch2 = globalThis.fetch;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes("card/instances")) {
					return new Response(JSON.stringify({ success: false, errmsg: "simulated" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.includes("oauth2/accessToken")) {
					return new Response(JSON.stringify({ accessToken: "fake-token", expireIn: 7200 }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				return realFetch2.call(globalThis, input, init);
			},
		);

		process.env.OMP_TEST_AGENT_DIR = agentDir;

		gateway = new Gateway(config, {
			channelFactory: makeChannelFactory(fakeChannels),
		});

		try {
			await gateway.start();
			await Bun.sleep(500);

			const conversationId = "conv-group-e2e-001";
			const senderId = "user-group-sender-001";
			const groupMessage: DingTalkRawMessage = {
				conversationId,
				conversationType: "2", // group
				chatbotCorpId: "corp001",
				chatbotUserId: "bot001",
				isAdmin: false,
				senderCorpId: "corp001",
				robotCode: "robot001",
				isInAtList: true,
				atUsers: [{ staffId: "bot001" }],
				conversationTitle: "团队日报群",
				sessionWebhookExpiredTime: Date.now() + 3600_000,
				createAt: Date.now(),
				msgtype: "text",
				senderId,
				senderStaffId: senderId,
				senderNick: "测试用户",
				sessionWebhook: `https://example.com/webhook/${conversationId}`,
				msgId: `msg-${conversationId}-${Date.now()}`,
				text: { content: "每天 18 点发个日报汇总到这个群" },
			};

			const injectResp = await fetch(`http://127.0.0.1:${testPort}/test/inject`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					accountId: "hr",
					captureOutbound: true,
					awaitMs: 3000,
					raw: groupMessage,
				}),
			});
			const injectResult = (await injectResp.json()) as { ok: boolean; conversationId: string };
			expect(injectResult.ok).toBe(true);
			expect(injectResult.conversationId).toBe(conversationId);

			await Bun.sleep(500);

			const schedulerStorage = new SchedulerDbStorage(getSchedulerDbPath());
			const tasks = schedulerStorage.listTasks();
			expect(tasks.length).toBe(1);
			const task = tasks[0]!;

			expect(task.name).toBe("group-daily-summary");
			// Group inference: toConversationId, NOT toUserId
			expect(task.delivery?.toConversationId).toBe(conversationId);
			expect(task.delivery?.toUserId).toBeUndefined();
			expect(task.delivery?.channel).toBe("dingtalk");
			expect(task.delivery?.accountId).toBe("hr");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

/**
 * Find a free TCP port by binding to :0 and immediately releasing. The
 * window between release and re-bind is small but possible to race; the
 * caller accepts the race by re-trying once on EADDRINUSE inside the
 * gateway.
 */
async function pickFreePort(): Promise<number> {
	// Unused in current test — kept for potential re-introduction.
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = server.port ?? 0;
	await server.stop();
	return port;
}
