/**
 * Gateway core — orchestrates channels, sessions, agent bridge, and cron scheduler.
 *
 * The gateway is the central hub that:
 * 1. Manages channel connections (DingTalk, Feishu, etc.)
 * 2. Routes inbound messages to the appropriate agent session
 * 3. Bridges agent responses back to the originating channel
 * 4. Runs the cron scheduler for periodic tasks
 * 5. Delivers scheduled task results to configured channels
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildAgentSessionPath,
	ensureAgentDir,
	registerAgent,
	resolveAgentDir,
} from "@oh-my-pi/pi-coding-agent/skeleton";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { ActionRegistry } from "./action-registry";
import { AgentBridge, type AgentBridgeOptions } from "./agent-bridge";
import { DingTalkChannel } from "./channels/dingtalk";
import { ChannelRegistry } from "./channels/registry";
import { defaultCrashLog } from "./crash-log";
import { getDataDir, getDingTalkConfig, getEnabledChannels } from "./config";
import { CronLifecycle } from "./gateway-cron-lifecycle";
import { checkPidFile, PID_FILE, readPidFile, STATUS_FILE } from "./gateway-daemon";
import { MessageHandler } from "./gateway-message";
import { ModelSwitch } from "./gateway-model-switch";
import { NewSessionHandler } from "./gateway-new-session";
import { ResponseHandler } from "./gateway-response";
import { createCronToolDefinitions } from "./scheduler/host-tool";
import { createBridgeStatusToolDefinitions } from "./bridge-status-tool";
import { createDingtalkAttachmentToolDefinitions } from "./dingtalk-attachment-tool";
import { HostToolDispatcher } from "./host-tool-dispatcher";
import { type BridgeStat, type QueueStat, SessionManager } from "./session-manager";
import { SQLiteSessionStore } from "./session-store";
import type {
	AgentResponseMeta,
	Channel,
	ChannelHealth,
	DingtalkAccountConfig,
	ForwardStreamHandlers,
	GatewayConfig,
	InboundMessage,
	MessageContent,
	OutboundMessage,
	ReplyFormatterContext,
	SessionRecord,
} from "./types";
import { checkPidFile, PID_FILE, readPidFile, STATUS_FILE } from "./gateway-daemon";
import { clearRestartSentinel, readRestartSentinel, writeRestartSentinel } from "./restart-sentinel";
import { ModelSwitch } from "./gateway-model-switch";
import { NewSessionHandler } from "./gateway-new-session";
import { ResponseHandler } from "./gateway-response";
import { MessageHandler } from "./gateway-message";

export function buildChannelKey(channelId: string, accountId?: string): string {
	return accountId ? `${channelId}:${accountId}` : channelId;
}

// ═══════════════════════════════════════════════════════════════
// Test injection helper
// ═══════════════════════════════════════════════════════════════
//
// This module-level function backs the `POST /test/inject` endpoint
// exposed by `Gateway.#startTestServer`. It is intentionally
// decoupled from the `Gateway` instance so the implementation can be
// unit-tested and so future test endpoints (e.g. card action
// injection) can reuse the same routing logic.
//
// `channelFactory` is the same factory seam that `Gateway` uses to
// instantiate DingTalk channels; we re-derive a channel for the
// requested accountId so we route into the exact same in-process
// channel that real DingTalk traffic flows through (not a separate
// instance). In production this is the live channel; in test
// drivers the caller can pass a custom factory to intercept.
async function handleInject(
	body: {
		accountId?: string;
		messageId?: string;
		raw?: any;
		skipDedup?: boolean;
		skipMedia?: boolean;
		skipPermission?: boolean;
		captureOutbound?: boolean;
		awaitMs?: number;
	},
	registry: ChannelRegistry,
	channelFactory: ((accountId?: string) => DingTalkChannel) | undefined,
): Promise<Response> {
	if (!body || typeof body !== "object") {
		return Response.json({ ok: false, reason: "missing_body" }, { status: 400 });
	}
	if (!body.accountId || typeof body.accountId !== "string") {
		return Response.json({ ok: false, reason: "missing_accountId" }, { status: 400 });
	}
	if (!body.raw || typeof body.raw !== "object") {
		return Response.json({ ok: false, reason: "missing_raw" }, { status: 400 });
	}

	// Look up the LIVE channel the gateway is already running. Creating
	// a fresh `DingTalkChannel` would not have the registered message
	// handler, so the message would be dropped at `handleInbound`.
	const channelKey = buildChannelKey("dingtalk", body.accountId);
	let channel: DingTalkChannel | undefined = registry.get(channelKey) as DingTalkChannel | undefined;
	if (!channel && channelFactory) {
		// Fallback for in-process test drivers that bypass the registry.
		try {
			channel = channelFactory(body.accountId);
		} catch {}
	}
	if (!channel) {
		return Response.json({ ok: false, reason: "channel_not_found", channelKey }, { status: 404 });
	}

	// ── Optional outbound capture ──
	// Temporarily replace the channel's `sendMessage` so we can return
	// what the gateway would have sent to DingTalk. Useful for tests
	// that want to assert on the reply text without actually posting
	// to DingTalk's API (and the typical test case has a fake
	// `sessionWebhook` / `conversationId`, which would fail).
	const captured: OutboundMessage[] = [];
	let originalSend: typeof channel.sendMessage | null = null;
	if (body.captureOutbound) {
		originalSend = channel.sendMessage.bind(channel);
		(channel as any).sendMessage = async (msg: OutboundMessage) => {
			captured.push(msg);
			logger.info("[DingTalk] TEST INJECT captured outbound", {
				accountId: body.accountId,
				conversationId: msg.conversationId,
				msgType: (msg as any).content?.type,
				preview: (msg as any).content?.text?.slice?.(0, 80) ?? (msg as any).content?.markdown?.slice?.(0, 80) ?? "",
			});
		};
	}

	const messageId = body.messageId ?? `test-inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		const result = await channel.injectTestMessage(body.raw, messageId, {
			skipDedup: body.skipDedup,
			skipMediaDownload: body.skipMedia,
			skipPermission: body.skipPermission,
		});
		// For tests that want to wait for the agent to finish streaming
		// (e.g. /new → agent response → captured reply) before we
		// return. Defaults to 0: return as soon as handleInbound resolves.
		if (body.awaitMs && body.awaitMs > 0) {
			await Bun.sleep(body.awaitMs);
		}
		if (!result.ok) {
			const status = result.reason === "permission_denied" ? 403 : 400;
			return Response.json({ ok: false, reason: result.reason, messageId, captured: captured.length }, { status });
		}
		return Response.json({
			ok: true,
			messageId,
			conversationId: result.inbound.conversationId,
			userId: result.inbound.userId,
			captured: captured.map(m => ({
				conversationId: m.conversationId,
				accountId: m.accountId,
				contentType: (m as any).content?.type,
				text: (m as any).content?.text,
				markdown: (m as any).content?.markdown,
			})),
		});
	} catch (err) {
		return Response.json(
			{ ok: false, reason: "injection_failed", error: (err as Error).message, messageId },
			{ status: 500 },
		);
	} finally {
		// Always restore the original sendMessage so the channel is
		// not left in a captured state for subsequent real traffic.
		if (originalSend) {
			(channel as any).sendMessage = originalSend;
		}
	}
}
export async function createAccountBridgeOptions(
	agentConfig: GatewayConfig["agent"],
	accountId: string,
	account: DingtalkAccountConfig,
	agentDir: string,
	hostToolDispatcher?: import("./host-tool-dispatcher").HostToolDispatcher,
): Promise<AgentBridgeOptions> {
	// Try to read the model from the agent's settings.json
	let model = account.model ?? agentConfig?.model;
	if (!model) {
		try {
			const settingsPath = path.join(agentDir, ".omp", "settings.json");
			const settings = JSON.parse(await Bun.file(settingsPath).text());
			if (settings.modelRoles?.default) {
				model = settings.modelRoles.default;
			}
		} catch {
			// settings.json not found or invalid, use default
		}
	}
	return {
		...agentConfig,
		model,
		timeoutMs: account.timeoutMs ?? agentConfig?.timeoutMs,
		cwd: agentDir,
		deniedTools: account.deniedTools,
		accountId,
		// Each bridge gets a shared crash log sink so per-account crash /
		// recovery / suppressed events are persisted to disk and survive
		// gateway restarts. Tests can pass their own `CrashLog` instance
		// via the 5th argument.
		crashLog: defaultCrashLog(),
		hostToolDispatcher,
	};
}

export class Gateway {
	#config: GatewayConfig;
	#registry = new ChannelRegistry();
	#store: SQLiteSessionStore | null = null;
	#running = false;
	/** Default agent bridge for single-account mode */
	#bridge: AgentBridge;
	/** Per-account agent bridges for multi-agent mode */
	#accountBridges = new Map<string, AgentBridge>();
	#accountAgentDirs = new Map<string, string>();
	#sessionManager?: SessionManager;
	#cronLifecycle: CronLifecycle;
	#modelSwitch: ModelSwitch;
	#newSessionHandler: NewSessionHandler;
	#responseHandler: ResponseHandler;
	#messageHandler: MessageHandler;
	/** Periodic health check: restart bridges stuck in circuit-open. */
	#healthInterval?: NodeJS.Timeout;
	/** Maps accountId → epoch ms of last circuit-open restart (anti-storm). */
	#circuitRestartCooldown = new Map<string, number>();
	/**
	 * Maps DingTalk AI Card instance IDs to the session / bridge that
	 * owns the card, so a TOPIC_CARD action callback (user clicked a
	 * button) can be routed back to the right bridge. Populated by
	 * the channel's `streamCard` (via the `registerCardAction` context
	 * callback) and consulted by `#handleCardAction`. Entries auto-expire
	 * after 30 min so a stale card action can't accidentally abort a
	 * fresh prompt.
	 */
	#actionRegistry = new ActionRegistry();
	/** Test seam: factory for creating DingTalkChannel instances. */
	#channelFactory?: (accountId?: string) => DingTalkChannel;
	/**
	 * Test injection HTTP server. Only started when
	 * `OMP_GATEWAY_TEST_MODE=1` AND this is a non-production build.
	 * Listens on 127.0.0.1 only. See `injectTestEndpoint`.
	 */
	#testServer: { stop: () => void; port: number } | null = null;

	constructor(
		config: GatewayConfig,
		deps?: {
			bridge?: AgentBridge;
			store?: SQLiteSessionStore;
			/** Factory seam: override DingTalkChannel creation in tests. */
			channelFactory?: (accountId?: string) => DingTalkChannel;
		},
	) {
		this.#config = config;
		// In single-account mode the default bridge's host tools use
		// process.cwd() as the agent dir; cron tasks created via the host
		// tool will fail validation until the user provides an explicit
		// agentDir via `omp gateway init` or sets one in the bridge
		// options. Multi-account mode is the supported deployment.
		const defaultDispatcher = this.#buildHostToolDispatcher(process.cwd(), "__default__");
		this.#bridge = new AgentBridge({
			...config.agent,
			hostToolDispatcher: defaultDispatcher,
		});
		this.#store = deps?.store ?? null;
		this.#channelFactory = deps?.channelFactory;

		// Sub-modules are created in dependency order to avoid forward-reference
		// closures. ResponseHandler is created first because ModelSwitch's
		// sendAgentResponse callback references it.
		this.#responseHandler = new ResponseHandler({
			registry: this.#registry,
			sessionManager: this.#sessionManager,
			actionRegistry: this.#actionRegistry,
		});

		this.#modelSwitch = new ModelSwitch({
			resolveDirectBridge: id => this.#resolveDirectBridge(id),
			sendAgentResponse: (msg, text) => this.#responseHandler.sendAgentResponse(msg, text),
			extractMessageText: msg => {
				const c = msg.content;
				if (c.type === "text") return c.text;
				if (c.type === "markdown") return c.markdown;
				if (c.type === "voice") return c.text ?? "";
				return "";
			},
		});

		this.#newSessionHandler = new NewSessionHandler({
			config,
			store: this.#store,
			resolveDirectBridge: id => this.#resolveDirectBridge(id),
			sendAgentResponse: (msg, text) => this.#responseHandler.sendAgentResponse(msg, text),
			extractMessageText: msg => {
				const c = msg.content;
				if (c.type === "text") return c.text;
				if (c.type === "markdown") return c.markdown;
				if (c.type === "voice") return c.text ?? "";
				return "";
			},
		});

		this.#cronLifecycle = new CronLifecycle({
			config,
			bridge: this.#bridge,
			accountBridges: this.#accountBridges,
			accountAgentDirs: this.#accountAgentDirs,
			registry: this.#registry,
			getAccountBridge: id => this.getAccountBridge(id),
			writeStatusFile: () => this.#writeStatusFile(),
		});

		this.#messageHandler = new MessageHandler({
			config,
			store: this.#store,
			registry: this.#registry,
			bridge: this.#bridge,
			accountBridges: this.#accountBridges,
			accountAgentDirs: this.#accountAgentDirs,
			cronLifecycle: this.#cronLifecycle,
			sessionManager: undefined,
			modelSwitch: this.#modelSwitch,
			newSessionHandler: this.#newSessionHandler,
			responseHandler: this.#responseHandler,
			extractMessageText: msg => {
				const c = msg.content;
				if (c.type === "text") return c.text;
				if (c.type === "markdown") return c.markdown;
				if (c.type === "voice") return c.text ?? "";
				return "";
			},
		});
	}

	async start(): Promise<void> {
		if (this.#running) {
			logger.warn("Gateway already running");
			return;
		}

		// Cross-process dedup: check PID file
		const dataDir = getDataDir(this.#config);
		const existingPid = await readPidFile(path.join(dataDir, PID_FILE));
		if (existingPid) {
			try {
				process.kill(existingPid, 0);
				logger.error(`Gateway already running (PID ${existingPid})`);
				return;
			} catch {
				// Stale PID file — will overwrite
			}
		}

		logger.debug("Starting gateway...");

		// Initialize session store
		this.#store = new SQLiteSessionStore(`${dataDir}/sessions.db`);
		this.#messageHandler.setStore(this.#store);
		this.#newSessionHandler.setStore(this.#store);

		// Register channels (handle multi-account DingTalk)
		const enabled = getEnabledChannels(this.#config);
		for (const { id } of enabled) {
			if (id === "dingtalk") {
				await this.#registerDingTalkChannels();
			}
			// Future: feishu, wechat, etc.
		}

		const hasDingTalkAccounts = Boolean(
			getDingTalkConfig(this.#config)?.accounts &&
				Object.keys(getDingTalkConfig(this.#config)?.accounts ?? {}).length > 0,
		);
		// Start default agent bridge only outside multi-account mode.
		if (!hasDingTalkAccounts) {
			try {
				await this.#bridge.start();
				logger.debug("Agent bridge started");
			} catch (err) {
				logger.error("Failed to start agent bridge", { error: String(err) });
			}
		}

		this.#sessionManager = new SessionManager({
			bridges: this.#accountBridges,
			defaultBridge: hasDingTalkAccounts ? undefined : this.#bridge,
		});
		this.#messageHandler.setSessionManager(this.#sessionManager);
		this.#responseHandler.setSessionManager(this.#sessionManager);

		await this.#registry.connectAll(async msg => this.#messageHandler.handleInboundMessage(msg));

		// Start cron scheduler
		await this.#cronLifecycle.start();

		// Prune expired card-action entries every 5 min so the registry
		// doesn't grow unbounded. The registry is bounded by the rate
		// of new cards (~1 per inbound message) so a 5 min cadence is
		// plenty.
		setInterval(() => this.#actionRegistry.expire(), 5 * 60_000).unref?.();

		// Health check: every 60s, if a bridge's circuit breaker has been
		// open for more than 5 minutes, restart it. Prevents a permanently
		// stuck bridge from silently swallowing all messages.
		this.#healthInterval = setInterval(() => this.checkBridgeHealth(), 60_000).unref?.();

		this.#running = true;
		logger.debug("Gateway started");

		// Write PID file for cross-process status detection
		try {
			await fs.writeFile(path.join(getDataDir(this.#config), PID_FILE), String(process.pid));
			logger.debug("PID file written", { path: path.join(getDataDir(this.#config), PID_FILE), pid: process.pid });
		} catch (e) {
			logger.warn("Failed to write PID file", { error: String(e) });
		}

		await this.#writeStatusFile();

		// Test injection endpoint: only when explicitly enabled. Lets
		// integration tests push real `DingTalkRawMessage` payloads
		// into the running gateway without going through the Stream
		// SDK. See `injectTestEndpoint` for the API contract.
		if (process.env.OMP_GATEWAY_TEST_MODE === "1") {
			await this.#startTestServer();
		}
	}

	/** Test seam: access the session manager. */
	getSessionManager(): SessionManager | undefined {
		return this.#sessionManager;
	}

	/**
	 * Build a per-bridge HostToolDispatcher wired to the gateway's cron
	 * scheduler. The dispatcher is created BEFORE the bridge so the
	 * bridge's constructor can capture it; the bridge reference is
	 * resolved lazily via `getBridge()` so the cron tool can call
	 * `getActiveChatContext()` even though the bridge doesn't exist yet
	 * at dispatcher-construction time. Same pattern for `getStorage()`:
	 * the scheduler DB is created in `CronLifecycle.start()` (called after
	 * bridge construction), so the tool reads the storage on each call.
	 */
	#buildHostToolDispatcher(_agentDir: string, accountId: string): HostToolDispatcher {
		const dispatcher = new HostToolDispatcher();
		const ctx = {
			getBridge: () => this.#accountBridges.get(accountId) ?? this.#bridge,
			registry: this.#registry,
			getStorage: () => this.#cronLifecycle.schedulerStorage,
			accountId,
			// `cron` is optional in GatewayConfig; fall back to the same
			// 60_000ms default the cronConfigSchema applies. The cron
			// tool uses this to warn about racy `inMs` values in the
			// `test-run` action; under-estimating is safe (warns more
			// often) while over-estimating would silently miss the
			// warning.
			tickIntervalMs: this.#config.cron?.tickIntervalMs ?? 60_000,
		};
		dispatcher.setTools([
			...createCronToolDefinitions(ctx),
			...createBridgeStatusToolDefinitions({ getBridge: ctx.getBridge }),
			...createDingtalkAttachmentToolDefinitions(ctx),
		]);
		return dispatcher;
	}

	/**
	 * Register DingTalk channel(s). In multi-account mode, each account gets
	 * its own DingTalkChannel instance and account-specific AgentBridge.
	 */
	async #registerDingTalkChannels(): Promise<void> {
		const rawConfig = this.#config.channels.dingtalk;
		const dtConfig = getDingTalkConfig(this.#config);

		if (!dtConfig) {
			logger.warn("DingTalk config invalid, skipping");
			return;
		}

		// Multi-account mode
		if (dtConfig.accounts && Object.keys(dtConfig.accounts).length > 0) {
			for (const [accountId, account] of Object.entries(dtConfig.accounts)) {
				if (!(account.enabled ?? true)) {
					logger.debug("Skipping disabled DingTalk account", { accountId });
					continue;
				}
				const channel = this.#channelFactory?.(accountId) ?? new DingTalkChannel();
				channel.setAccountId(accountId);
				channel.setHideThinkingBlock(account.hideThinkingBlock ?? false);

				const agentDir = resolveAgentDir(accountId, account.agentDir);
				this.#accountAgentDirs.set(accountId, agentDir);
				try {
					await ensureAgentDir(agentDir);
				} catch (err) {
					logger.error("Failed to initialize account agentDir", { accountId, agentDir, error: String(err) });
					continue;
				}
				// Register so `omp agent list` / `show` can discover gateway-created
				// agentDirs (mirrors `omp agent init`). Non-fatal: a failure here only
				// affects list visibility, not gateway operation.
				try {
					await registerAgent(accountId, agentDir);
				} catch (err) {
					logger.warn("Failed to register agentDir", { accountId, agentDir, error: String(err) });
				}

				// Create per-account agent bridge with account-specific config
				// Model is loaded from agentDir/.omp/config.yml by omp itself
				const dispatcher = this.#buildHostToolDispatcher(agentDir, accountId);
				const bridge = new AgentBridge(
					await createAccountBridgeOptions(this.#config.agent, accountId, account, agentDir, dispatcher),
				);
				this.#accountBridges.set(accountId, bridge);

				// Start per-account bridge
				try {
					await bridge.start();
				} catch (err) {
					logger.error("Failed to start account bridge", { accountId, error: String(err) });
				}

				this.#registry.register(
					channel,
					{
						...rawConfig,
						appKey: account.appKey,
						appSecret: account.appSecret,
						robotCode: account.robotCode,
					},
					`dingtalk:${accountId}`,
				);
				// Route card action callbacks (TOPIC_CARD) back to the
				// gateway's ActionRegistry, which looks up the card by
				// instance id and calls the right bridge's abort().
				channel.setCardActionHandler(event => this.#responseHandler.handleCardAction(event));
				logger.debug("Registered DingTalk account channel", { accountId });
			}
			return;
		}

		// Single-account mode (use legacy appKey/appSecret from config)
		const channel = this.#channelFactory?.() ?? new DingTalkChannel();
		channel.setCardActionHandler(event => this.#responseHandler.handleCardAction(event));
		this.#registry.register(channel, rawConfig);
	}

	async #addAccount(accountId: string, account: DingtalkAccountConfig, config: GatewayConfig): Promise<void> {
		if (!(account.enabled ?? true)) {
			logger.debug("Skipping disabled DingTalk account", { accountId });
			return;
		}
		const rawConfig = config.channels.dingtalk;
		const channel = this.#channelFactory?.(accountId) ?? new DingTalkChannel();
		channel.setAccountId(accountId);
		channel.setHideThinkingBlock(account.hideThinkingBlock ?? false);

		const agentDir = resolveAgentDir(accountId, account.agentDir);
		this.#accountAgentDirs.set(accountId, agentDir);
		try {
			await ensureAgentDir(agentDir);
		} catch (err) {
			logger.error("Failed to initialize account agentDir", { accountId, agentDir, error: String(err) });
			return;
		}
		// Register so `omp agent list` / `show` can discover gateway-created
		// agentDirs (mirrors `omp agent init`). Non-fatal: a failure here only
		// affects list visibility, not gateway operation.
		try {
			await registerAgent(accountId, agentDir);
		} catch (err) {
			logger.warn("Failed to register agentDir", { accountId, agentDir, error: String(err) });
		}

		const dispatcher = this.#buildHostToolDispatcher(agentDir, accountId);
		const bridge = new AgentBridge(
			await createAccountBridgeOptions(config.agent, accountId, account, agentDir, dispatcher),
		);
		this.#accountBridges.set(accountId, bridge);
		try {
			await bridge.start();
		} catch (err) {
			logger.error("Failed to start account bridge", { accountId, error: String(err) });
		}

		this.#registry.register(
			channel,
			{
				...rawConfig,
				appKey: account.appKey,
				appSecret: account.appSecret,
				robotCode: account.robotCode,
			},
			`dingtalk:${accountId}`,
		);
		logger.debug("Registered DingTalk account channel", { accountId });

		// Connect the new channel
		try {
			channel.onMessage(async msg => this.#messageHandler.handleInboundMessage(msg));
			await channel.connect({
				...rawConfig,
				appKey: account.appKey,
				appSecret: account.appSecret,
				robotCode: account.robotCode,
			});
			logger.debug("DingTalk account channel connected", { accountId });
		} catch (err) {
			logger.error("Failed to connect DingTalk account channel", { accountId, error: String(err) });
		}
	}

	#removeAccount(accountId: string): void {
		const channelKey = `dingtalk:${accountId}`;
		const channel = this.#registry.get(channelKey);
		if (channel) {
			channel.disconnect().catch(() => {});
		}
		this.#registry.unregister(channelKey);

		const bridge = this.#accountBridges.get(accountId);
		if (bridge) {
			bridge.stop();
		}
		this.#accountBridges.delete(accountId);
		this.#accountAgentDirs.delete(accountId);
		logger.debug("Removed DingTalk account", { accountId });
	}

	async stop(): Promise<void> {
		if (!this.#running) return;

		logger.debug("Stopping gateway...");

		const warnings: string[] = [];

		// Capture active session info BEFORE drain/shutdown for restart recovery.
		// If a bridge is currently processing a message, we write a sentinel so the
		// next gateway startup can resume the conversation.
		const activeSessionInfo = this.#getActiveSessionInfo();

		// Phase 1: disconnect channels (5s grace)
		await Promise.race([
			this.#registry.disconnectAll().catch(err => {
				warnings.push(`channels: ${err instanceof Error ? err.message : String(err)}`);
			}),
			Bun.sleep(5_000).then(() => {
				warnings.push("channels: timeout after 5s");
			}),
		]);

		// Phase 2: stop scheduler + health interval (5s grace)
		this.#cronLifecycle.stop();
		if (this.#healthInterval) {
			clearInterval(this.#healthInterval);
			this.#healthInterval = undefined;
		}

		// Phase 3: drain session queues (configurable grace, default 15s)
		const drainTimeoutMs = this.#config.drainTimeoutMs ?? 15_000;
		const drained = await Promise.race([
			this.#sessionManager?.waitForAllDrained(drainTimeoutMs) ?? Promise.resolve(true),
			Bun.sleep(drainTimeoutMs).then(() => false),
		]);
		if (drained === false) {
			warnings.push(`session-queues: timeout after ${drainTimeoutMs}ms`);
			logger.warn("Gateway shutdown timed out waiting for session queues", {
				queues: this.#sessionManager?.getQueueStats() ?? [],
				drainTimeoutMs,
			});

			// Write restart sentinel if drain timed out and there's an active session.
			// This allows the next gateway startup to resume the interrupted conversation.
			if (activeSessionInfo) {
				await writeRestartSentinel(activeSessionInfo, this.#config);
			}
		}

		// Phase 4: stop all bridges (5s grace)
		await Promise.race([
			Promise.all([
				...Array.from(this.#accountBridges.values()).map(b => {
					try {
						b.stop();
					} catch {}
				}),
				(() => {
					try {
						this.#bridge.stop();
					} catch {}
				})(),
			]).then(() => {}),
			Bun.sleep(5_000).then(() => {
				warnings.push("bridges: timeout after 5s");
			}),
		]);

		this.#accountBridges.clear();
		this.#accountAgentDirs.clear();
		this.#sessionManager = undefined;
		this.#store?.close();
		this.#store = null;
		this.#running = false;

		if (this.#testServer) {
			try {
				this.#testServer.stop();
			} catch {}
			this.#testServer = null;
		}

		if (warnings.length > 0) {
			logger.warn("Gateway stopped with warnings", { warnings });
		} else {
			logger.debug("Gateway stopped");
		}

		// Remove PID file
		try {
			await fs.unlink(path.join(getDataDir(this.#config), PID_FILE));
		} catch {
			/* non-fatal */
		}

		// Remove status file so readers after a clean stop never see a
		// snapshot of a dead process. Done after the PID file so a reader
		// that races us sees `stalePidFile: true` and `running: false`,
		// not a half-cleared snapshot.
		await this.#clearStatusFile();
	}

	/**
	 * Periodic health check: if a bridge's circuit breaker has been open
	 * for more than the threshold, restart the bridge to recover from a
	 * stuck state. A cooldown per bridge prevents restart storms when the
	 * underlying problem persists.
	 *
	 * Exposed as public (not #private) so tests and external health
	 * monitors can trigger it on demand. Thresholds are overridable via
	 * GATEWAY_CIRCUIT_OPEN_MS and GATEWAY_CIRCUIT_COOLDOWN_MS env vars.
	 */
	async checkBridgeHealth(): Promise<void> {
		const CIRCUIT_OPEN_THRESHOLD_MS = Number(process.env.GATEWAY_CIRCUIT_OPEN_MS) || 5 * 60_000;
		const RESTART_COOLDOWN_MS = Number(process.env.GATEWAY_CIRCUIT_COOLDOWN_MS) || 10 * 60_000;
		const now = Date.now();

		const checkOne = async (accountId: string, bridge: AgentBridge) => {
			const snapshot = bridge.getSnapshot();
			if (snapshot.circuitState !== "open") return;

			const openedAt = snapshot.circuitOpenedAt ?? 0;
			if (openedAt === 0 || now - openedAt < CIRCUIT_OPEN_THRESHOLD_MS) return;

			// Anti-storm: skip if we restarted this bridge recently.
			const lastRestart = this.#circuitRestartCooldown.get(accountId) ?? 0;
			if (now - lastRestart < RESTART_COOLDOWN_MS) return;

			logger.warn("Bridge circuit open too long, restarting", {
				accountId,
				circuitOpenedAt: openedAt,
				openDurationMs: now - openedAt,
			});
			this.#circuitRestartCooldown.set(accountId, now);

			try {
				bridge.stop();
				await bridge.start();
				logger.info("Bridge restarted after circuit-open recovery", { accountId });
			} catch (err) {
				logger.error("Failed to restart bridge after circuit-open", {
					accountId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		await Promise.all([
			...Array.from(this.#accountBridges.entries()).map(([id, b]) => checkOne(id, b)),
			this.#bridge.isRunning ? checkOne("__default__", this.#bridge) : Promise.resolve(),
		]);

		// Check channels for stale sockets: connected but no socket activity
		// for more than 10 minutes. The channel's own reconnect logic handles
		// disconnections; this catches 'connected but silent' states.
		const STALE_SOCKET_THRESHOLD_MS = 10 * 60_000;
		for (const channel of this.#registry.getAll()) {
			const health = channel.getHealth?.();
			if (!health || !health.connected) continue;

			const lastActivity = health.lastSocketAvailableAt || health.connectionEstablishedAt;
			if (lastActivity === 0) continue; // never connected, skip

			if (now - lastActivity > STALE_SOCKET_THRESHOLD_MS) {
				logger.warn("Channel stale socket detected", {
					channelId: channel.id,
					lastActivityMs: now - lastActivity,
					reconnectAttempts: health.reconnectAttempts,
					receivedCount: health.receivedCount,
				});
			}
		}
	}

	async reload(config: GatewayConfig): Promise<void> {
		// Snapshot old config for diff
		const oldDtConfig = getDingTalkConfig(this.#config);
		const oldAccounts = oldDtConfig?.accounts ? new Map(Object.entries(oldDtConfig.accounts)) : new Map();
		const oldCronConfig = this.#config.cron;

		const newDtConfig = getDingTalkConfig(config);
		const newAccounts = newDtConfig?.accounts ? new Map(Object.entries(newDtConfig.accounts)) : new Map();
		const newCronConfig = config.cron;

		// Build reload plan: what actually changed?
		const plan = {
			cronChanged: JSON.stringify(oldCronConfig) !== JSON.stringify(newCronConfig),
			accountsToAdd: [] as string[],
			accountsToRemove: [] as string[],
			accountsToUpdate: [] as string[],
		};

		for (const [accountId] of oldAccounts) {
			if (!newAccounts.has(accountId)) plan.accountsToRemove.push(accountId);
		}
		for (const [accountId, account] of newAccounts) {
			if (!oldAccounts.has(accountId)) {
				plan.accountsToAdd.push(accountId);
			} else {
				const oldAccount = oldAccounts.get(accountId)!;
				if (
					oldAccount.appKey !== account.appKey ||
					oldAccount.appSecret !== account.appSecret ||
					oldAccount.robotCode !== account.robotCode ||
					oldAccount.agentDir !== account.agentDir ||
					(oldAccount.enabled ?? true) !== (account.enabled ?? true)
				) {
					plan.accountsToUpdate.push(accountId);
				}
			}
		}

		const hasChanges =
			plan.cronChanged ||
			plan.accountsToAdd.length > 0 ||
			plan.accountsToRemove.length > 0 ||
			plan.accountsToUpdate.length > 0;
		this.#config = config;
		if (!hasChanges) {
			logger.debug("Gateway config reloaded (no changes detected)");
			await this.#writeStatusFile();
			return;
		}

		logger.debug("Gateway config reload plan", plan);

		// Execute plan: only restart what changed
		if (plan.cronChanged) {
			this.#cronLifecycle.stop();
			await this.#cronLifecycle.start();
		}

		for (const accountId of plan.accountsToRemove) {
			this.#removeAccount(accountId);
		}
		for (const accountId of plan.accountsToAdd) {
			await this.#addAccount(accountId, newAccounts.get(accountId)!, config);
		}
		for (const accountId of plan.accountsToUpdate) {
			this.#removeAccount(accountId);
			await this.#addAccount(accountId, newAccounts.get(accountId)!, config);
		}

		// Only rebuild SessionManager if bridges changed
		if (plan.accountsToAdd.length > 0 || plan.accountsToRemove.length > 0 || plan.accountsToUpdate.length > 0) {
			const hasDingTalkAccounts = newAccounts.size > 0;
			this.#sessionManager = new SessionManager({
				bridges: this.#accountBridges,
				defaultBridge: hasDingTalkAccounts ? undefined : this.#bridge,
			});
			this.#messageHandler.setSessionManager(this.#sessionManager);
			this.#responseHandler.setSessionManager(this.#sessionManager);
		}

		await this.#writeStatusFile();

		logger.debug("Gateway config reloaded");
	}

	get isRunning(): boolean {
		return this.#running;
	}

	/** Returns the default (non-account) bridge, if any. */
	getDefaultBridge(): AgentBridge {
		return this.#bridge;
	}

	/**
	 * Direct message for CLI interactive mode.
	 *
	 * In single-account mode, routes to the default bridge.
	 * In multi-account mode, requires accountId to select the
	 * per-account bridge. If accountId is omitted in multi-account
	 * mode, returns a help string listing available accounts.
	 */
	async sendDirectMessage(text: string, accountId?: string): Promise<string | null> {
		const bridge = this.#resolveDirectBridge(accountId);
		if (!bridge) {
			if (this.#accountBridges.size > 0) {
				const ids = Array.from(this.#accountBridges.keys()).join(", ");
				return `请指定账号。可用账号: ${ids}\n用法: @账号名 消息内容 (如 @hr 你好)`;
			}
			logger.warn("Agent bridge not running");
			return null;
		}
		if (!bridge.isRunning) {
			logger.warn("Agent bridge not running", { accountId: accountId ?? "__default__" });
			return null;
		}

		const resolvedAccountId = accountId ?? "__default__";
		const agentDir = this.#accountAgentDirs.get(resolvedAccountId) ?? undefined;
		const conversationId = `cli-conv-${resolvedAccountId}`;
		const sessionPath = agentDir ? buildAgentSessionPath(agentDir, conversationId) : undefined;

		const mockSession: SessionRecord = {
			id: `cli-session-${resolvedAccountId}`,
			channelId: "cli",
			accountId: resolvedAccountId,
			userId: "cli-user",
			conversationId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			ompSessionPath: sessionPath,
			status: "active",
		};

		const mockMessage: InboundMessage = {
			channelId: "cli",
			userId: "cli-user",
			userName: "CLI User",
			conversationId,
			isGroup: false,
			content: { type: "text", text },
			timestamp: new Date(),
		};

		return await bridge.forward(mockMessage, mockSession);
	}

	/**
	 * Resolve the correct AgentBridge for a direct (CLI) message.
	 *
	 * - accountId provided and matches an account bridge: return it.
	 * - No accountId, default bridge running: return default (single-account mode).
	 * - No accountId, multi-account mode: return null (user must specify).
	 */
	#resolveDirectBridge(accountId?: string): AgentBridge | null {
		if (accountId && this.#accountBridges.has(accountId)) {
			return this.#accountBridges.get(accountId)!;
		}
		if (!accountId && this.#accountBridges.size === 0 && this.#bridge.isRunning) {
			return this.#bridge;
		}
		return null;
	}

	/**
	 * Get an AgentBridge by accountId.
	 * Used by the cron scheduler to reuse the already-warm agent process
	 * for scheduled agent tasks instead of spawning a new omp --print.
	 */
	getAccountBridge(accountId: string): AgentBridge | undefined {
		if (this.#accountBridges.has(accountId)) {
			return this.#accountBridges.get(accountId);
		}
		// Fall back to default bridge if no per-account bridges exist
		if (this.#accountBridges.size === 0 && this.#bridge.isRunning) {
			return this.#bridge;
		}
		return undefined;
	}

	async #writeStatusFile(): Promise<void> {
		const dataDir = getDataDir(this.#config);
		const statusPath = path.join(dataDir, STATUS_FILE);
		try {
			const status = await this.getStatus();
			const data = JSON.stringify(
				{
					// Self-identify the writer's PID. A reader can compare this
					// against `process.kill(pid, 0)` to detect a stale snapshot
					// even if the writer exited before updating the file.
					pid: process.pid,
					statusWrittenAt: Date.now(),
					channels: status.channels,
					accounts: status.accounts,
					bridges: status.bridges,
					queues: status.queues,
					scheduler: status.scheduler,
				},
				null,
				2,
			);
			await fs.writeFile(statusPath, data);
		} catch {
			// non-fatal
		}
	}

	/**
	 * Remove the gateway status file. Called on graceful shutdown so a
	 * reader after a clean stop never sees a snapshot of a dead process.
	 * Idempotent and best-effort; a missing file is not an error.
	 */
	async #clearStatusFile(): Promise<void> {
		const statusPath = path.join(getDataDir(this.#config), STATUS_FILE);
		try {
			await fs.unlink(statusPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to clear gateway status file", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// Test injection HTTP server
	// ═══════════════════════════════════════════════════════════════
	//
	// Generic injection endpoint for production-environment
	// integration tests. When `OMP_GATEWAY_TEST_MODE=1` is set in the
	// gateway's environment, `start()` spins up a localhost-only HTTP
	// server that accepts `POST /test/inject` with a real
	// `DingTalkRawMessage` payload and routes it through the same
	// channel pipeline that real DingTalk traffic follows.
	//
	// API:
	//   POST /test/inject
	//   Content-Type: application/json
	//   {
	//     "accountId":   "hr",
	//     "messageId":   "test-msg-001",   // optional; auto-generated
	//     "skipDedup":   false,             // optional
	//     "skipMedia":   false,             // optional
	//     "skipPermission": false,          // optional
	//     "raw": {
	//       ...all DingTalkRawMessage fields...
	//     }
	//   }
	//   -> 200 { ok: true, messageId, conversationId, userId }
	//   -> 4xx { ok: false, reason }
	//
	// The endpoint is intended for test drivers (curl, scripts, or
	// in-process `fetch` from a test runner) that need to verify
	// gateway behavior end-to-end against a real production daemon.
	// It is NOT a public API and must be gated by env var.
	async #startTestServer(): Promise<void> {
		const port = Number.parseInt(process.env.OMP_GATEWAY_TEST_PORT ?? "7890", 10);
		const host = "127.0.0.1";
		// Capture the registry + factory in locals so the fetch handler
		// (which runs with `this` bound to Bun's Server) can route through
		// them. We MUST look up the live channel in the registry — creating
		// a fresh `DingTalkChannel` would yield an un-wired instance with
		// no `onMessage` handler, so `handleInbound` would drop the message.
		const registry = this.#registry;
		const channelFactory = this.#channelFactory;
		const server = Bun.serve({
			hostname: host,
			port,
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/test/health") {
					return Response.json({ ok: true, mode: "test-injection" });
				}
				if (req.method === "POST" && url.pathname === "/test/inject") {
					let body: any;
					try {
						body = await req.json();
					} catch {
						return Response.json({ ok: false, reason: "invalid_json" }, { status: 400 });
					}
					return await handleInject(body, registry, channelFactory);
				}
				return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
			},
		});
		this.#testServer = { stop: () => server.stop(), port: server.port ?? port };
		logger.warn("Test injection HTTP endpoint enabled (NOT for production)", {
			host,
			port: server.port,
			endpoint: "POST /test/inject",
		});
	}

	async getStatus(): Promise<{
		running: boolean;
		channels: Array<{ id: string; name: string; connected: boolean }>;
		accounts: Array<{
			accountId: string;
			channelConnected: boolean;
			bridgeRunning: boolean;
			agentDir?: string;
			bridgeState?: string;
			channelHealth?: ChannelHealth;
		}>;
		sessions: number;
		queues: QueueStat[];
		bridges: BridgeStat[];
		scheduler: {
			running: boolean;
			taskCount: number;
		};
	}> {
		const channels = this.#registry.getAll().map(c => ({
			id: c.id,
			name: c.name,
			connected: c.isConnected(),
		}));

		const sessions = (await this.#store?.getActiveSessions()) ?? [];
		const bridgeStats = this.#sessionManager?.getBridgeStats() ?? [];
		const bridgeStatsByAccount = new Map(bridgeStats.map(stat => [stat.accountId, stat]));
		const accounts = Array.from(this.#accountBridges.entries()).map(([accountId, bridge]) => {
			const channel = this.#registry.get(`dingtalk:${accountId}`);
			return {
				accountId,
				channelConnected: channel?.isConnected() ?? false,
				bridgeRunning: bridge.isRunning,
				agentDir: this.#accountAgentDirs.get(accountId),
				bridgeState: bridgeStatsByAccount.get(accountId)?.state,
				channelHealth: channel?.getHealth?.(),
			};
		});

		return {
			running: this.#running || (await checkPidFile(getDataDir(this.#config), PID_FILE)),
			channels,
			sessions: sessions.length,
			accounts,
			queues: this.#sessionManager?.getQueueStats() ?? [],
			bridges: bridgeStats,
			scheduler: {
				running: this.#cronLifecycle.engineRunning,
				taskCount: this.#cronLifecycle.activeTaskCount,
			},
		};
	}

	/**
	 * Get info about the currently active session (if any).
	 *
	 * Checks each bridge's `activeSessionPath` and looks up the corresponding
	 * `SessionRecord` from the store. Returns the info needed to write a restart
	 * sentinel, or `null` if no bridge has an active session.
	 */
	#getActiveSessionInfo(): { conversationId: string; accountId: string; ompSessionPath: string } | null {
		// Check account bridges first, then default bridge
		const bridgesToCheck = [
			...Array.from(this.#accountBridges.entries()).map(([accountId, bridge]) => ({ accountId, bridge })),
			{ accountId: "__default__", bridge: this.#bridge },
		];

		for (const { accountId, bridge } of bridgesToCheck) {
			const snapshot = bridge.getSnapshot();
			const sessionPath = snapshot.activeSessionPath;
			if (!sessionPath) continue;

			// Derive conversationId from the session path basename.
			// The session path format is: <agentDir>/sessions/<safeId>.jsonl
			// where safeId is the sanitized conversationId.
			const conversationId = path.basename(sessionPath, ".jsonl");

			return {
				conversationId,
				accountId,
				ompSessionPath: sessionPath,
			};
		}

		return null;
	}

	/**
	 * Resume a conversation from a restart sentinel.
	 *
	 * Called on gateway startup after channels are connected and bridges are ready.
	 * Reads the sentinel, finds the appropriate bridge, and sends a continuation
	 * message to resume the interrupted conversation.
	 *
	 * Returns `true` if a sentinel was found and recovery was attempted.
	 */
	async resumeFromSentinel(): Promise<boolean> {
		const sentinel = await readRestartSentinel(this.#config);
		if (!sentinel) {
			return false;
		}

		logger.info("Resuming from restart sentinel", {
			conversationId: sentinel.conversationId,
			accountId: sentinel.accountId,
			ompSessionPath: sentinel.ompSessionPath,
		});

		// Find the appropriate bridge
		const bridge = this.#accountBridges.get(sentinel.accountId) ?? this.#bridge;

		try {
			// Send the continuation message to resume the conversation
			const response = await bridge.executePrompt(sentinel.continuationMessage, {
				sessionPath: sentinel.ompSessionPath,
				timeoutMs: 60_000, // 1 minute timeout for recovery
			});

			logger.info("Restart recovery completed", {
				conversationId: sentinel.conversationId,
				responseLength: response.length,
			});

			// Clear the sentinel after successful recovery
			await clearRestartSentinel(this.#config);

			return true;
		} catch (err) {
			logger.error("Restart recovery failed", {
				conversationId: sentinel.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
			// Don't clear the sentinel — let the next startup retry
			return false;
		}
	}
}
