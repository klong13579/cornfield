/**
 * DingTalk channel — connects via Stream mode using the official dingtalk-stream SDK.
 *
 * Connection lifecycle:
 * 1. Custom application-layer heartbeat (10s ping, 20s timeout) instead of SDK keepalive
 * 2. Exponential backoff reconnect with jitter (1s base, 30s max, infinite retries)
 * 3. Server-initiated disconnect topic handled via immediate reconnect
 * 4. macOS LaunchAgent EBADF fix (reopen /dev/null on invalid fd 0/1/2)
 *
 * Message handling:
 * - Dual-layer dedup (protocol messageId + business msgId) with 5min TTL
 * - Message-processing keepalive (15s intervals during agent inference)
 * - SDK console.info noise suppression
 *
 * Outbound sends via sessionWebhook HTTP POST (instant, within Stream session lifetime).
 */

import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";
import { DWClient, type DWClientDownStream, TOPIC_ROBOT } from "dingtalk-stream";
import {
	createAICardForTarget,
	failAICard,
	finishAICard,
	streamAICard,
} from "./dingtalk-card";
import { formatDingTalkReply } from "./dingtalk-formatter";
import type {
	AgentResponseMeta,
	ChannelConfig,
	DingTalkConfig,
	DingTalkRawMessage,
	ForwardStreamHandlers,
	InboundMessage,
	MessageContent,
	OutboundMessage,
	ReplyFormatterContext,
	SessionRecord,
} from "../types";

type PermissionPolicy = "open" | "allowlist" | "closed";
import { BaseChannel } from "./base";

/** Throttle window for streaming the assistant text into the AI Card. */
const CARD_STREAM_THROTTLE_MS = 1_000;

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

/** Heartbeat interval (ms) — send ping every 10s */
const HEARTBEAT_INTERVAL = 10_000;
/** Timeout threshold (ms) — consider connection dead after 20s without pong */
const TIMEOUT_THRESHOLD = 20_000;
/** Base backoff delay (ms) for reconnect */
const BASE_BACKOFF_DELAY = 1_000;
/** Max backoff delay (ms) for reconnect */
const MAX_BACKOFF_DELAY = 30_000;
/** Message processing keepalive interval (ms) — refresh lastSocketAvailableTime */
const PROCESSING_KEEPALIVE_INTERVAL = 15_000;
/** Dedup cache TTL (ms) */
const DEDUP_TTL = 5 * 60 * 1000;
/** Dedup cleanup interval (ms) */
const DEDUP_CLEANUP_INTERVAL = 5 * 60_000;

// ═══════════════════════════════════════════════════════════════════════
// SDK Console Noise Suppression
// ═══════════════════════════════════════════════════════════════════════

let _streamNoiseSilenced = false;

function silenceDingtalkStreamConsoleNoise(): void {
	if (_streamNoiseSilenced) return;
	_streamNoiseSilenced = true;
	const origConsoleInfo = console.info.bind(console);
	console.info = (...args: unknown[]) => {
		const first = args[0];
		if (typeof first === "string") {
			if (first === "Disconnecting.") return;
			if (/^\[[^\]]+\] connect success$/.test(first)) return;
		}
		return origConsoleInfo(...args);
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Message Dedup
// ═══════════════════════════════════════════════════════════════════════

const processedMessages = new Map<string, number>();

function cleanupProcessedMessages(): void {
	const now = Date.now();
	for (const [msgId, timestamp] of processedMessages.entries()) {
		if (now - timestamp > DEDUP_TTL) {
			processedMessages.delete(msgId);
		}
	}
}

function isMessageProcessed(messageId: string): boolean {
	if (!messageId) return false;
	return processedMessages.has(messageId);
}

function markMessageProcessed(messageId: string): void {
	if (!messageId) return;
	processedMessages.set(messageId, Date.now());
	if (processedMessages.size >= 100) {
		cleanupProcessedMessages();
	}
}

/**
 * Dual-layer dedup check with account-scoped keys.
 *
 * Checks both protocol-layer (headers.messageId) and business-layer (data.msgId)
 * to catch DingTalk server retransmissions where headers.messageId changes
 * but data.msgId remains the same (~60s retry window).
 *
 * Keys are scoped by accountId to prevent cross-account false positives in group chats
 * where multiple bots receive the same msgId.
 */
function checkAndMarkDingtalkMessage(
	accountId: string,
	protocolMessageId: string | undefined,
	businessMsgId: string | undefined,
): boolean {
	const scopedProtocolId = protocolMessageId ? `${accountId}:${protocolMessageId}` : undefined;
	const scopedBusinessId = businessMsgId ? `${accountId}:${businessMsgId}` : undefined;

	const isProtocolDuplicate = scopedProtocolId ? isMessageProcessed(scopedProtocolId) : false;
	const isBusinessDuplicate = scopedBusinessId ? isMessageProcessed(scopedBusinessId) : false;

	if (isProtocolDuplicate || isBusinessDuplicate) {
		return true;
	}

	if (scopedProtocolId) markMessageProcessed(scopedProtocolId);
	if (scopedBusinessId) markMessageProcessed(scopedBusinessId);

	return false;
}

// ═══════════════════════════════════════════════════════════════════════
// Standalone Message Parser
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse a raw DingTalk robot message into an InboundMessage.
 * Standalone function for testability.
 */
export function parseRobotMessage(
	raw: DingTalkRawMessage,
	channelId: string,
	accountId: string,
	messageId?: string,
): InboundMessage | null {
	let content: MessageContent;
	const msgtype = raw.msgtype ?? "text";

	switch (msgtype) {
		case "text": {
			const text = raw.text?.content?.trim() || "";
			if (!text) {
				logger.debug("[DingTalk] skipping empty text message", { messageId });
				return null;
			}
			content = { type: "text", text };
			break;
		}

		case "markdown": {
			let markdown = "";
			try {
				const parsedContent = raw.content ? JSON.parse(raw.content) : {};
				markdown = parsedContent.text?.trim() || raw.text?.content?.trim() || "";
			} catch {
				markdown = raw.content?.trim() || raw.text?.content?.trim() || "";
			}
			if (!markdown) {
				logger.debug("[DingTalk] skipping empty markdown message", { messageId });
				return null;
			}
			content = { type: "markdown", markdown };
			break;
		}

		case "picture": {
			let pictureUrl = "";
			let downloadCode = "";
			try {
				const parsedContent = raw.content ? JSON.parse(raw.content) : {};
				pictureUrl = parsedContent.pictureUrl || "";
				downloadCode = parsedContent.downloadCode || "";
			} catch {
				// ignore parse error
			}
			const url = pictureUrl || (downloadCode ? `downloadCode:${downloadCode}` : "");
			content = { type: "image", url, filename: "image.jpg" };
			break;
		}

		case "audio": {
			let recognition = "[语音消息]";
			let downloadCode = "";
			try {
				const parsedContent = raw.content ? JSON.parse(raw.content) : {};
				if (typeof parsedContent === "object") {
					recognition = (parsedContent as any).recognition || "[语音消息]";
					downloadCode = (parsedContent as any).downloadCode || "";
				}
			} catch {
				// ignore parse error
			}
			content = {
				type: "voice",
				url: downloadCode ? `downloadCode:${downloadCode}` : "",
				text: recognition,
			};
			break;
		}

		case "file": {
			let fileName = "file";
			let downloadCode = "";
			let fileSize = 0;
			try {
				const parsedContent = raw.content ? JSON.parse(raw.content) : {};
				fileName = parsedContent.fileName || "file";
				downloadCode = parsedContent.downloadCode || "";
				fileSize = parsedContent.size || 0;
			} catch {
				// ignore parse error
			}
			content = {
				type: "file",
				url: downloadCode ? `downloadCode:${downloadCode}` : "",
				filename: fileName,
				size: fileSize,
			};
			break;
		}

		default: {
			let text = "";
			if (raw.text?.content) {
				text = raw.text.content.trim();
			} else if (raw.content) {
				try {
					const parsedContent = JSON.parse(raw.content);
					text = parsedContent.text?.trim() || raw.content.trim();
				} catch {
					text = raw.content.trim();
				}
			}
			if (!text) {
				logger.debug("[DingTalk] skipping unsupported message type", { messageId, msgtype });
				return null;
			}
			content = { type: "text", text };
			break;
		}
	}

	return {
		channelId,
		userId: raw.senderStaffId ?? raw.senderId ?? "",
		accountId,
		userName: raw.senderNick ?? "unknown",
		conversationId: raw.conversationId ?? "",
		conversationTitle: raw.conversationTitle ?? "",
		isGroup: raw.conversationType === "2",
		content,
		timestamp: new Date(raw.createAt ?? Date.now()),
		raw,
		sessionWebhook: raw.sessionWebhook,
		messageId,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// DingTalk Channel
// ═══════════════════════════════════════════════════════════════════════

export class DingTalkChannel extends BaseChannel {
	readonly id = "dingtalk";
	readonly name = "DingTalk";
	readonly capabilities = {
		inbound: true,
		outbound: true,
		richContent: true,
		groups: true,
		mentions: true,
		voice: true,
	};

	#client: DWClient | null = null;
	#config: DingTalkConfig | null = null;
	#connected = false;
	#connectionFailed = false;
	#accountId = "__default__";

	/** Set the account ID for multi-account routing */
	setAccountId(accountId: string): void {
		this.#accountId = accountId;
	}

	/** Get the account ID */
	getAccountId(): string {
		return this.#accountId;
	}

	/**
	 * Test seam: inject a DingTalk config directly without going through
	 * `onConnect` / the Stream SDK. Used by e2e tests that need the
	 * channel's card / format-reply logic to see a real config but want
	 * to skip the WebSocket connect step. Production code paths should
	 * rely on `onConnect` (called by `connectAll`) for config injection.
	 */
	setConfig(config: DingTalkConfig): void {
		this.#config = config;
	}

	/**
	 * Build a richer DingTalk reply from agent metadata: 4 sections
	 * (quoteContent / tool summary / main answer / status line) instead of
	 * a single text blob. The gateway calls this after every agent run when
	 * the channel opts in via the `Channel.formatReply?` method.
	 */
	formatReply(
		meta: AgentResponseMeta,
		inbound: InboundMessage,
		context: ReplyFormatterContext,
	): OutboundMessage {
		const { markdown, truncated } = formatDingTalkReply({
			meta,
			inbound,
			agentName: context.agentName,
			accountId: context.accountId,
			dapiCalls: context.dapiCalls,
		});

		const outbound: OutboundMessage = {
			channelId: this.id,
			conversationId: inbound.conversationId,
			content: { type: "markdown", markdown },
			accountId: this.#accountId,
		};
		if (inbound.sessionWebhook) outbound.sessionWebhook = inbound.sessionWebhook;
		if (inbound.messageId) outbound.messageId = inbound.messageId;
		if (inbound.isGroup && inbound.userName) outbound.mentions = [inbound.userName];
		if (truncated) {
			logger.debug("DingTalk reply truncated to 4000-char cap", {
				conversationId: inbound.conversationId,
				accountId: this.#accountId,
			});
		}
		return outbound;
	}

	/**
	 * Stream the agent response into a DingTalk AI Card. The card
	 * replaces the "thinking..." placeholder: it starts in PROCESSING
	 * state, transitions to INPUTING when the first text delta arrives,
	 * and finishes with FINISHED + the full v1-formatted chrome (quote
	 * content / tool summary / status line) on `agent_end`. Returns
	 * `null` when card creation fails so the gateway falls back to
	 * `formatReply` (v1 markdown).
	 *
	 * Card streaming is throttled to `CARD_STREAM_THROTTLE_MS` (1s) so
	 * a long agent run doesn't hammer the DingTalk card API on every
	 * token delta. The last buffered text is flushed on `agent_end`.
	 */
	async streamCard(
		inbound: InboundMessage,
		_session: SessionRecord,
		context: ReplyFormatterContext,
		submit: (handlers?: ForwardStreamHandlers) => Promise<AgentResponseMeta | null>,
	): Promise<OutboundMessage | null> {
		if (!this.#config) {
			logger.debug("[DingTalk] streamCard skipped: channel not connected", {
				accountId: this.#accountId,
				conversationId: inbound.conversationId,
			});
			return null;
		}

		const target = inbound.isGroup
			? ({ type: "group", openConversationId: inbound.conversationId } as const)
			: ({ type: "user", userId: inbound.userId } as const);

		const card = await createAICardForTarget(this.#config, target);
		if (!card) {
			logger.warn("[DingTalk] AI Card creation failed, gateway will fall back to v1 markdown", {
				accountId: this.#accountId,
				conversationId: inbound.conversationId,
			});
			return null;
		}

		// Throttle state: track the latest cumulative text and the
		// pending flush timer. We replace (not append) the buffered text
		// on every delta because the bridge's `cumulative` argument is
		// already the full running total.
		let bufferedText = "";
		let flushTimer: ReturnType<typeof setTimeout> | null = null;

		const flushBuffered = (): void => {
			flushTimer = null;
			if (!bufferedText) return;
			void streamAICard(card, bufferedText, false, this.#config ?? undefined).catch(err => {
				logger.warn("[DingTalk] streamAICard failed (mid-stream)", {
					accountId: this.#accountId,
					conversationId: inbound.conversationId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		};

		const handlers: ForwardStreamHandlers = {
			onTextDelta: (_delta, cumulative) => {
				bufferedText = cumulative;
				if (flushTimer) return;
				flushTimer = setTimeout(flushBuffered, CARD_STREAM_THROTTLE_MS);
			},
		};

		const meta = await submit(handlers);

		// Always cancel the pending flush so we don't double-stream
		// before the final finish call.
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}

		if (meta === null) {
			// Queue full / submit rejected — mark the card as failed so
			// the user doesn't see a stuck PROCESSING card.
			await failAICard(card, "系统繁忙，请稍后重试。", this.#config ?? undefined);
			return null;
		}

		const { markdown } = formatDingTalkReply({
			meta,
			inbound,
			agentName: context.agentName,
			accountId: context.accountId,
			dapiCalls: context.dapiCalls,
		});

		try {
			await finishAICard(card, markdown, this.#config ?? undefined);
		} catch (err) {
			logger.warn("[DingTalk] finishAICard failed, falling back to v1 markdown", {
				accountId: this.#accountId,
				conversationId: inbound.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}

		const outbound: OutboundMessage = {
			channelId: this.id,
			conversationId: inbound.conversationId,
			content: { type: "markdown", markdown },
			accountId: this.#accountId,
		};
		if (inbound.sessionWebhook) outbound.sessionWebhook = inbound.sessionWebhook;
		if (inbound.messageId) outbound.messageId = inbound.messageId;
		if (inbound.isGroup && inbound.userName) outbound.mentions = [inbound.userName];
		return outbound;
	}

	// Connection state
	#lastSocketAvailableTime = 0;
	#connectionEstablishedTime = 0;
	#isReconnecting = false;
	#reconnectAttempts = 0;
	#isStopped = false;
	#keepAliveTimer: ReturnType<typeof setInterval> | null = null;
	#dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

	// Message processing keepalive
	#activeMessageProcessing = false;
	#processingKeepAliveTimer: ReturnType<typeof setInterval> | null = null;

	// Metrics
	#receivedCount = 0;
	#processedCount = 0;

	async onConnect(config: ChannelConfig): Promise<void> {
		this.#config = config as DingTalkConfig;
		this.#isStopped = false;

		// Suppress SDK console.info noise once
		silenceDingtalkStreamConsoleNoise();

		// Fix macOS LaunchAgent EBADF
		this.#fixLaunchAgentEBADF();

		if (!this.#config.appKey || !this.#config.appSecret) {
			throw new Error(
				`[DingTalk] Missing credentials: appKey=${this.#config.appKey ? "present" : "MISSING"}, appSecret=${this.#config.appSecret ? "present" : "MISSING"}`,
			);
		}

		this.#client = new DWClient({
			clientId: this.#config.appKey,
			clientSecret: this.#config.appSecret,
			ua: "pi-gateway/0.1.0",
			debug: false,
			autoReconnect: false,  // pi-gateway has its own #doReconnect logic
		});

		// Connection lifecycle
		this.#client.on("connect", () => {
			logger.debug("[DingTalk] Stream connect event", { accountId: this.#accountId });
			this.#connected = true;
		});

		this.#client.on("disconnect", () => {
			logger.warn("[DingTalk] Stream disconnect event", { accountId: this.#accountId });
			this.#connected = false;
		});

		this.#client.on("error", (err: Error) => {
			logger.error("[DingTalk] Stream error", { accountId: this.#accountId, error: err.message });
		});

		// Register robot message listener
		this.#client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
			void this.#handleMessage(msg);
		});

		// Start dedup cleanup timer
		this.#dedupCleanupTimer = setInterval(cleanupProcessedMessages, DEDUP_CLEANUP_INTERVAL);

		try {
			await this.#client.connect();

			// Verify WebSocket actually reached OPEN state (SDK connect() may not throw on failure)
			const connected = await this.#waitForSocketOpen(10_000);
			if (!connected) {
				throw new Error("Socket did not reach OPEN state within 10s");
			}

			// Setup socket event listeners after connect (client.socket is created)
			this.#setupPongListener();
			this.#setupMessageListener();
			this.#setupCloseListener();

			this.#lastSocketAvailableTime = Date.now();
			this.#connectionEstablishedTime = Date.now();
			this.#reconnectAttempts = 0;
			this.#connected = true;

			// Start custom heartbeat
			this.#startKeepAlive();

			logger.debug("[DingTalk] Connected to DingTalk Stream", { accountId: this.#accountId });
		} catch (err) {
			this.#connectionFailed = true;
			this.#connected = false;
			logger.error("[DingTalk] Failed to connect", { accountId: this.#accountId, error: String(err) });
			throw err;
		}
	}

	async onDisconnect(): Promise<void> {
		this.#isStopped = true;
		this.#connected = false;

		// Stop keepalive
		if (this.#keepAliveTimer) {
			clearInterval(this.#keepAliveTimer);
			this.#keepAliveTimer = null;
		}

		// Stop processing keepalive
		this.#stopProcessingKeepalive();

		// Stop dedup cleanup
		if (this.#dedupCleanupTimer) {
			clearInterval(this.#dedupCleanupTimer);
			this.#dedupCleanupTimer = null;
		}

		// Clear event listeners
		if ((this.#client as any)?.socket) {
			(this.#client as any).socket.removeAllListeners();
		}

		if (this.#client) {
			try {
				this.#client.disconnect();
			} catch {
				// ignore disconnect errors during shutdown
			}
			this.#client = null;
		}
	}

	override isConnected(): boolean {
		if (this.#connectionFailed) return false;
		// Check actual WebSocket state instead of relying solely on the #connected flag,
		// which can be set true by the SDK 'connect' event even when the socket later fails.
		const socket = (this.#client as any)?.socket;
		if (socket?.readyState === 1) return true;
		return this.#connected && socket?.readyState !== 3;
	}

	async sendMessage(msg: OutboundMessage): Promise<void> {
		if (!msg.sessionWebhook) {
			throw new Error("[DingTalk] sendMessage failed: missing sessionWebhook");
		}

		const text =
			msg.content.type === "markdown"
				? msg.content.markdown
				: msg.content.type === "text"
					? msg.content.text
					: "[unsupported content type]";

		logger.debug("[DingTalk] sending message", { text: text.slice(0, 500), type: msg.content.type });

		try {
			const body =
				msg.content.type === "markdown"
					? { msgtype: "markdown", markdown: { title: "消息", text }, conversationId: msg.conversationId }
					: {
							msgtype: "text",
							text: { content: text },
							conversationId: msg.conversationId,
							atUser: msg.mentions ? { dingtalkIds: msg.mentions } : undefined,
						};

			const res = await fetch(msg.sessionWebhook, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const errText = await res.text();
				logger.error("[DingTalk] send failed", { status: res.status, body: errText });
				throw new Error(`[DingTalk] send failed: ${res.status} ${errText}`);
			}
			logger.debug("[DingTalk] message sent", { conversationId: msg.conversationId });
		} catch (err) {
			logger.error("[DingTalk] send error", { error: String(err) });
			throw err;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Heartbeat & Keepalive
	// ═══════════════════════════════════════════════════════════════════

	#startKeepAlive(): void {
		if (this.#keepAliveTimer) return;

		this.#keepAliveTimer = setInterval(() => {
			if (this.#isStopped) {
				if (this.#keepAliveTimer) {
					clearInterval(this.#keepAliveTimer);
					this.#keepAliveTimer = null;
				}
				return;
			}

			const elapsed = Date.now() - this.#lastSocketAvailableTime;

			// Timeout detection
			if (elapsed > TIMEOUT_THRESHOLD) {
				logger.debug("[DingTalk] Heartbeat timeout", { elapsedSec: Math.round(elapsed / 1000) });
				void this.#doReconnect();
				return;
			}

			// Socket state check
			const socketState = (this.#client as any)?.socket?.readyState;
			const timeSinceConnection = Date.now() - this.#connectionEstablishedTime;

			// Give new connections a 15s grace period
			if (socketState !== 1) {
				if (timeSinceConnection < 15_000) return;
				void this.#doReconnect(true);
				return;
			}

			// Send native WebSocket ping
			try {
				(this.#client as any)?.socket?.ping();
				logger.debug("[DingTalk] PING sent");
			} catch (err) {
				logger.warn("[DingTalk] PING failed", { error: String(err) });
			}
		}, HEARTBEAT_INTERVAL);
	}

	#setupPongListener(): void {
		(this.#client as any)?.socket?.on("pong", () => {
			this.#lastSocketAvailableTime = Date.now();
			logger.debug("[DingTalk] PONG received");
		});
	}

	#setupMessageListener(): void {
		(this.#client as any)?.socket?.on("message", (data: unknown) => {
			try {
				if (typeof data !== "string") return;
				const msg = JSON.parse(data);
				if (msg.type === "SYSTEM" && msg.headers?.topic === "disconnect") {
					logger.debug("[DingTalk] Server disconnect topic received, reconnecting", { accountId: this.#accountId });
					if (!this.#isStopped && !this.#isReconnecting) {
						void this.#doReconnect(true);
					}
				}
			} catch {
				// ignore parse errors
			}
		});
	}

	#setupCloseListener(): void {
		(this.#client as any)?.socket?.on("close", (code: number, reason: string) => {
			logger.debug("[DingTalk] WebSocket close", { accountId: this.#accountId, code, reason });
			this.#connected = false;
			if (this.#isStopped) return;
			void this.#doReconnect(true);
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Reconnect
	// ═══════════════════════════════════════════════════════════════════

	#calculateBackoffDelay(attempt: number): number {
		const exponentialDelay = BASE_BACKOFF_DELAY * 2 ** attempt;
		const jitter = Math.random() * 1000;
		return Math.min(exponentialDelay + jitter, MAX_BACKOFF_DELAY);
	}

	async #doReconnect(immediate = false): Promise<void> {
		if (this.#isReconnecting || this.#isStopped) return;

		this.#isReconnecting = true;

		if (!immediate && this.#reconnectAttempts > 0) {
			const delay = this.#calculateBackoffDelay(this.#reconnectAttempts);
			logger.debug("[DingTalk] Reconnecting", { accountId: this.#accountId, attempt: this.#reconnectAttempts + 1, delayMs: Math.round(delay) });
			await Bun.sleep(delay);
		}

		const client = this.#client;
		if (!client) {
			logger.warn("[DingTalk] No client to reconnect with");
			this.#isReconnecting = false;
			return;
		}

		try {
			const sock = (client as any)?.socket;
			if (sock?.readyState === 1 || sock?.readyState === 3) {
				try {
					client.disconnect();
				} catch {
					// ignore disconnect errors during reconnect
				}
			}

			await client.connect();

			this.#setupPongListener();
			this.#setupMessageListener();
			this.#setupCloseListener();

			const connected = await this.#waitForSocketOpen(10_000);
			if (!connected) {
				throw new Error("Socket did not reach OPEN state within 10s");
			}

			this.#lastSocketAvailableTime = Date.now();
			this.#connectionEstablishedTime = Date.now();
			this.#reconnectAttempts = 0;
			this.#connectionFailed = false;
			this.#connected = true;

			logger.debug("[DingTalk] Reconnect successful", { accountId: this.#accountId });
		} catch (err) {
			this.#reconnectAttempts++;
			logger.error("[DingTalk] Reconnect failed", { accountId: this.#accountId, attempt: this.#reconnectAttempts, error: String(err) });
		} finally {
			this.#isReconnecting = false;
		}
	}

	async #waitForSocketOpen(timeoutMs: number): Promise<boolean> {
		if ((this.#client as any)?.socket?.readyState === 1) return true;

		const { promise, resolve } = Promise.withResolvers<boolean>();
		const timeout = setTimeout(() => resolve(false), timeoutMs);

		const clientAny = this.#client as any;
		const onOpen = () => {
			clearTimeout(timeout);
			clientAny.socket?.removeListener("open", onOpen);
			clientAny.socket?.removeListener("error", onError);
			resolve(true);
		};

		const onError = () => {
			clearTimeout(timeout);
			clientAny.socket?.removeListener("open", onOpen);
			clientAny.socket?.removeListener("error", onError);
			resolve(false);
		};

		clientAny.socket?.once("open", onOpen);
		clientAny.socket?.once("error", onError);

		return promise;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Processing Keepalive
	// ═══════════════════════════════════════════════════════════════════

	#startProcessingKeepalive(): void {
		this.#activeMessageProcessing = true;
		this.#lastSocketAvailableTime = Date.now();

		this.#stopProcessingKeepalive();

		this.#processingKeepAliveTimer = setInterval(() => {
			if (this.#activeMessageProcessing) {
				this.#lastSocketAvailableTime = Date.now();
			}
		}, PROCESSING_KEEPALIVE_INTERVAL);
	}

	#stopProcessingKeepalive(): void {
		if (this.#processingKeepAliveTimer) {
			clearInterval(this.#processingKeepAliveTimer);
			this.#processingKeepAliveTimer = null;
		}
		this.#activeMessageProcessing = false;
	}

	// ═══════════════════════════════════════════════════════════════════
	// macOS LaunchAgent EBADF Fix
	// ═══════════════════════════════════════════════════════════════════

	#fixLaunchAgentEBADF(): void {
		if (process.platform !== "darwin") return;
		for (const stdioFd of [0, 1, 2]) {
			try {
				fs.fstatSync(stdioFd);
			} catch (fdError: unknown) {
				const err = fdError as NodeJS.ErrnoException;
				if (err.code === "EBADF") {
					logger.warn(`[DingTalk] LaunchAgent: fd ${stdioFd} invalid (EBADF), redirecting to /dev/null`);
					try {
						fs.openSync("/dev/null", stdioFd === 0 ? "r" : "w");
					} catch (openError) {
						logger.warn(`[DingTalk] LaunchAgent: could not fix fd ${stdioFd}: ${(openError as Error).message}`);
					}
				}
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Permission Policy Check
	// ═══════════════════════════════════════════════════════════════════

	#checkPermission(msg: InboundMessage): boolean {
		const config = this.#config;
		if (!config) return true;

		// DM policy
		if (!msg.isGroup) {
			const dmPolicy = ((config as any).dmPolicy as PermissionPolicy) ?? "allowlist";
			if (dmPolicy === "open") return true;
			if (dmPolicy === "closed") return false;
			// allowlist mode
			if (config.allowedUsers && config.allowedUsers.length > 0) {
				return config.allowedUsers.includes(msg.userId);
			}
			return true; // no allowlist configured = open
		}

		// Group policy
		const groupPolicy = ((config as any).groupPolicy as PermissionPolicy) ?? "allowlist";
		if (groupPolicy === "closed") return false;
		if (groupPolicy === "open") return true;
		// allowlist mode
		if (config.allowedGroups && config.allowedGroups.length > 0) {
			return config.allowedGroups.includes(msg.conversationId);
		}
		return true; // no allowlist configured = open
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	async #handleMessage(msg: DWClientDownStream): Promise<void> {
		this.#receivedCount++;
		const { headers, data: rawData } = msg;
		const messageId = headers.messageId;

		// Acknowledge immediately
		if (messageId) {
			this.#client?.socketCallBackResponse(messageId, { success: true });
		}

		// Protocol-layer dedup (headers.messageId)
		if (checkAndMarkDingtalkMessage(this.#accountId, messageId, undefined)) {
			this.#processedCount++;
			return;
		}

		// Parse message data
		let parsed: DingTalkRawMessage;
		try {
			parsed = JSON.parse(rawData);
		} catch {
			logger.warn("[DingTalk] failed to parse message data");
			return;
		}

		// Business-layer dedup (data.msgId)
		const businessMsgId = parsed.msgId;
		if (checkAndMarkDingtalkMessage(this.#accountId, undefined, businessMsgId)) {
			this.#processedCount++;
			return;
		}

		// Start processing keepalive for long AI tasks
		this.#startProcessingKeepalive();

		try {
			logger.debug("[DingTalk] message received", {
				messageId,
				msgId: businessMsgId,
				msgtype: parsed.msgtype,
				sender: parsed.senderNick,
				conversationType: parsed.conversationType === "1" ? "DM" : "Group",
			});

			// Parse inbound message with media support
			const inbound = this.#parseRobotMessage(parsed, messageId);
			if (!inbound) return;

			// Check permissions
			if (!this.#checkPermission(inbound)) {
				logger.debug("[DingTalk] message blocked by permission policy", {
					userId: inbound.userId,
					conversationId: inbound.conversationId,
				});
				// Send a gentle denial for DM
				if (!inbound.isGroup && inbound.sessionWebhook) {
					try {
						await fetch(inbound.sessionWebhook, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								msgtype: "text",
								text: {
									content:
										"抱歉，您没有权限使用此机器人。请联系管理员。\n\nSorry, you don't have permission to use this bot. Please contact the administrator.",
								},
							}),
						});
					} catch {
						// best effort
					}
				}
				return;
			}

			await this.handleInbound(inbound);
			this.#processedCount++;
		} finally {
			this.#stopProcessingKeepalive();
		}
	}

	#parseRobotMessage(raw: DingTalkRawMessage, messageId?: string): InboundMessage | null {
		return parseRobotMessage(raw, this.id, this.#accountId, messageId);
	}
}
