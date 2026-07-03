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
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { DWClient, type DWClientDownStream, TOPIC_CARD, TOPIC_ROBOT } from "dingtalk-stream";
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
import {
	type AICardInstance,
	type AICardTarget,
	BlockType,
	buildAnswerBlock,
	buildImageBlock,
	buildStopBlock,
	buildThinkBlock,
	buildToolBlock,
	type CardBlock,
	createAICardForTarget,
	failAICard,
	finishAICard,
	patchAICardBlocks,
	streamAICard,
} from "./dingtalk-card";
import {
	classifyFile,
	extractExtension,
	type FileKind,
	isExtensionSupported,
	mediaTypeForKind,
	unsupportedFallbackMarkdown,
	warnUnsupportedFile,
} from "./dingtalk-files";
import { formatDingTalkChrome, formatDingTalkReply } from "./dingtalk-formatter";
import { uploadMedia } from "./dingtalk-media";

type PermissionPolicy = "open" | "allowlist" | "closed";

import { BaseChannel } from "./base";

/** Throttle window for streaming the assistant text into the AI Card. */
const CARD_STREAM_THROTTLE_MS = 1_000;
/** Throttle window for incremental blockList patches (think / tool / image). */
const CARD_BLOCK_PATCH_THROTTLE_MS = 800;

/**
 * Event the channel emits when the user clicks a button on an AI Card.
 * Routed by the gateway's ActionRegistry to the matching session's
 * bridge (e.g. for `type=stop` actions).
 */
export interface DingTalkCardActionEvent {
	cardInstanceId: string;
	actionIds: string[];
	params: Record<string, string>;
	/** User that clicked. Useful for audit / authorization. */
	userId: string;
	corpId: string;
}

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
/** Cap on reconnect attempts before the channel gives up. Backoff
 *  doubles each failure up to MAX_BACKOFF_DELAY, so 50 attempts spans
 *  ~25 minutes. After that we stop trying — a persistent failure
 *  usually means credentials are wrong or the account was revoked,
 *  in which case reconnecting every 30s just spams the log without
 *  any realistic chance of succeeding. Operators can re-enable the
 *  channel via `omp gateway reload` or a process restart. */
const MAX_RECONNECT_ATTEMPTS = 50;
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
 * Normalize DingTalk `content` field to a parsed object.
 * DingTalk SDK sometimes delivers `content` as a JSON string, sometimes
 * as an already-parsed object. This helper handles both cases so callers
 * don't need try/catch around JSON.parse.
 */
function parseContentField(content: string | Record<string, unknown> | undefined): Record<string, any> {
	if (!content) return {};
	if (typeof content === "string") {
		try {
			return JSON.parse(content);
		} catch {
			return {};
		}
	}
	if (typeof content === "object") return content as Record<string, any>;
	return {};
}

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
	let richTextMediaUrls: string[] | undefined;
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
			const mdParsed = parseContentField(raw.content);
			markdown = mdParsed.text?.trim() || raw.text?.content?.trim() || "";
			if (!markdown) {
				logger.debug("[DingTalk] skipping empty markdown message", { messageId });
				return null;
			}
			content = { type: "markdown", markdown };
			break;
		}

		case "picture": {
			const picParsed = parseContentField(raw.content);
			const pictureUrl = picParsed.pictureUrl || "";
			const downloadCode = picParsed.downloadCode || "";
			const url = pictureUrl || (downloadCode ? `downloadCode:${downloadCode}` : "");
			content = { type: "image", url, filename: "image.jpg" };
			break;
		}

		case "audio": {
			const audioParsed = parseContentField(raw.content);
			const recognition = audioParsed.recognition || "[语音消息]";
			const downloadCode = audioParsed.downloadCode || "";
			content = {
				type: "voice",
				url: downloadCode ? `downloadCode:${downloadCode}` : "",
				text: recognition,
			};
			break;
		}

		case "file": {
			const fileParsed = parseContentField(raw.content);
			const fileName = fileParsed.fileName || "file";
			const downloadCode = fileParsed.downloadCode || "";
			const fileSize = fileParsed.size || 0;
			content = {
				type: "file",
				url: downloadCode ? `downloadCode:${downloadCode}` : "",
				filename: fileName,
				size: fileSize,
			};
			break;
		}

		case "video": {
			const vidParsed = parseContentField(raw.content);
			const downloadCode = vidParsed.downloadCode || "";
			content = {
				type: "video",
				url: downloadCode ? `downloadCode:${downloadCode}` : "",
				filename: "video.mp4",
			};
			break;
		}

		case "richText": {
			const rtParsed = parseContentField(raw.content);
			const parts = Array.isArray(rtParsed.richText) ? rtParsed.richText : [];
			let rtText = "";
			const pictureCodes: string[] = [];
			for (const part of parts) {
				const p = part as Record<string, unknown>;
				const pType = typeof p.type === "string" ? p.type : undefined;
				const pText = typeof p.text === "string" ? p.text : undefined;
				if ((pType === "text" || pType === undefined) && pText) {
					rtText += pText;
				} else if (pType === "at" && typeof p.atName === "string") {
					rtText += `@${p.atName} `;
				} else if (pType === "picture") {
					rtText += "[图片]";
					if (typeof p.downloadCode === "string" && p.downloadCode.trim()) {
						pictureCodes.push(p.downloadCode.trim());
					}
				}
			}
			rtText = rtText.trim();
			if (!rtText && pictureCodes.length === 0) {
				logger.debug("[DingTalk] skipping empty richText message", { messageId });
				return null;
			}
			content = { type: "text", text: rtText || "[富文本消息]" };
			// Stash image downloadCodes as mediaUrls for the channel layer to download.
			// parseRobotMessage returns InboundMessage, but we can't set mediaUrls here
			// because it's on the return object — set it below via a closure variable.
			richTextMediaUrls = pictureCodes.map(c => `downloadCode:${c}`);
			break;
		}

		default: {
			let text = "";
			if (raw.text?.content) {
				text = raw.text.content.trim();
			} else if (raw.content) {
				const defParsed = parseContentField(raw.content);
				text = defParsed.text?.trim() || (typeof raw.content === "string" ? raw.content.trim() : "");
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
		mediaUrls: richTextMediaUrls,
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
	/**
	 * When true, drop thinking/reasoning blocks from the rendered AI
	 * Card. The omp agent still emits thinking deltas; the channel
	 * just discards them instead of forwarding to `buildThinkBlock`.
	 * Set per-account by the gateway from `DingtalkAccountConfig.hideThinkingBlock`.
	 */
	#hideThinkingBlock = false;
	/**
	 * Factory seam: build the DingTalk Stream SDK client. Production
	 * code uses the real `DWClient`; integration tests override this
	 * to inject a fake `EventEmitter`-based client that captures
	 * callbacks without dialing the real DingTalk WebSocket. Marked
	 * `protected` so subclasses can override it.
	 */
	protected createDWClient(_opts: {
		clientId: string;
		clientSecret: string;
		ua?: string;
		debug?: boolean;
		autoReconnect?: boolean;
	}): DWClient {
		return new DWClient(_opts);
	}
	/** Handler invoked when a card action callback arrives via TOPIC_CARD. */
	#cardActionHandler: ((event: DingTalkCardActionEvent) => Promise<void>) | null = null;
	/** OAuth token cache for proactive message sending (DM + group push). */
	#tokenCache: { token: string; expiresAt: number } | null = null;
	/**
	 * Test seam: when set, `#handleMessage` uses this directory to
	 * resolve `downloadCode:...` references to placeholder files
	 * instead of hitting the real DingTalk OAPI. Production never sets
	 * this; integration tests use it to exercise the richText +
	 * image-pipeline path without real DingTalk credentials.
	 */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: written via setMediaDir, read by test override of createMediaDownloader
	#mediaDir: string | null = null;

	/**
	 * Test seam: install a directory used to materialise downloaded
	 * attachments as placeholder files. Tests call this before
	 * `connect()` so that richText messages with embedded image
	 * `downloadCode:...` URLs resolve to local placeholder files and
	 * the bridge receives the expected number of `ImageContent`
	 * blocks.
	 */
	setMediaDir(dir: string): void {
		this.#mediaDir = dir;
	}

	/**
	 * Factory seam: build a custom attachment downloader. Production
	 * returns `undefined` (use the default `resolveInboundAttachments`
	 * flow that hits the real DingTalk OAPI). Tests override this to
	 * return a function that materialises placeholder files in
	 * `#mediaDir` instead of dialing OAPI.
	 *
	 * Returned function signature matches the test's expectations:
	 * receives `(ref, kind)`, returns a `DownloadedMedia` shape or
	 * `null` on failure.
	 */
	protected createMediaDownloader():
		| ((
				ref: string,
				kind: "image" | "voice" | "video" | "file",
		  ) => Promise<{
				path: string;
				mimeType: string;
				originalName: string;
				size: number;
		  } | null>)
		| null {
		return null;
	}

	/** Set the account ID for multi-account routing */
	setAccountId(accountId: string): void {
		this.#accountId = accountId;
	}

	/** Get the account ID */
	getAccountId(): string {
		return this.#accountId;
	}

	/**
	 * Set the handler for AI Card action callbacks. The gateway
	 * installs this so the channel's TOPIC_CARD listener can route
	 * button clicks back to the right session / bridge. Called once
	 * during gateway startup; the handler is stable for the channel's
	 * lifetime.
	 */
	setCardActionHandler(handler: (event: DingTalkCardActionEvent) => Promise<void>): void {
		this.#cardActionHandler = handler;
	}

	/**
	 * Test seam: expose `#handleCardCallback` so unit tests can
	 * drive the card action parsing path without spinning up the
	 * full Stream SDK. Production code should rely on the SDK to
	 * call `#handleCardCallback` via `registerCallbackListener`.
	 * Returns a promise that resolves when the handler finishes
	 * (or the callback is silently dropped).
	 */
	__testHandleCardCallback(msg: DWClientDownStream): Promise<void> {
		return this.#handleCardCallback(msg);
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
	 * When `true`, the channel discards thinking/reasoning deltas
	 * emitted by the agent instead of forwarding them into the AI
	 * Card via `buildThinkBlock`. The model still thinks; the card
	 * just doesn't show it. Set by the gateway from
	 * `DingtalkAccountConfig.hideThinkingBlock` for per-account control.
	 */
	setHideThinkingBlock(hide: boolean): void {
		this.#hideThinkingBlock = hide;
	}

	/** Test seam: read the current hideThinkingBlock flag. */
	__testGetHideThinkingBlock(): boolean {
		return this.#hideThinkingBlock;
	}

	/**
	 * Build a richer DingTalk reply from agent metadata: 4 sections
	 * (quoteContent / tool summary / main answer / status line) instead of
	 * a single text blob. The gateway calls this after every agent run when
	 * the channel opts in via the `Channel.formatReply?` method.
	 */
	formatReply(meta: AgentResponseMeta, inbound: InboundMessage, context: ReplyFormatterContext): OutboundMessage {
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
			toUserId: inbound.userId,
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

		const config = this.#config;
		const target = inbound.isGroup
			? ({ type: "group", openConversationId: inbound.conversationId } as const)
			: ({ type: "user", userId: inbound.userId } as const);

		// Pre-compute chrome for create-time and finish-time. We need
		// the inbound's quoteContent visible from the moment the card
		// is delivered (so users in a busy group see what the card is
		// replying to before the answer starts streaming in). The
		// placeholder meta is shaped to satisfy `AgentResponseMeta` even
		// though we only consume `quoteContent` here — the rest of the
		// fields are filled by `formatDingTalkChrome` at finish time
		// from the real run meta.
		const quoteText =
			formatDingTalkChrome({
				meta: {
					text: "",
					rawText: "",
					model: null,
					provider: null,
					usage: null,
					agentDurationMs: null,
					taskDurationMs: 0,
					effort: null,
					toolCalls: [],
					toolResults: [],
					error: null,
					aborted: false,
					isFallback: true,
				},
				inbound,
				agentName: context.agentName,
				accountId: context.accountId,
				dapiCalls: 0,
			}).quoteContent ?? "";

		const card = await createAICardForTarget(config, target, { quoteContent: quoteText });
		if (!card) {
			logger.warn("[DingTalk] AI Card creation failed, gateway will fall back to v1 markdown", {
				accountId: this.#accountId,
				conversationId: inbound.conversationId,
			});
			return null;
		}

		// Pre-register the card with the gateway's ActionRegistry. The
		// registration is gated on `registerCardAction` (set by the
		// gateway when it builds the context). We register the card
		// eagerly so that a TOPIC_CARD callback for a stop button (pushed
		// later by onLongTask) can be routed back. The `toolName` field
		// is unknown at create-time and is patched in when the stop
		// block is pushed below.
		context.registerCardAction?.({
			cardInstanceId: card.cardInstanceId,
			accountId: this.#accountId,
			sessionId: inbound.conversationId,
		});

		// Block builder state. Blocks are emitted in two phases:
		//   1. mid-stream incremental patch (think / tool / image appear
		//      as the agent produces them — throttled)
		//   2. final flush (answer block + chrome fields) on agent_end
		//
		// Multi-card segment splitting (Hermes-style): each assistant
		// message that precedes a tool-call boundary becomes its own
		// finalized card. When onAssistantMessageEnd fires, we mark a
		// pending segment break. The next onTextDelta finalizes the old
		// card (FINISHED) and creates a fresh card for the new text.
		// The last card is finalized with full chrome on agent_end.
		let currentCard = card;
		const cards: AICardInstance[] = [card];
		const blocks: CardBlock[] = [];
		let _contentText = "";
		let segmentText = "";
		let thinkingText = "";
		let pendingSegmentBreak = false;
		let segmentBusy = false;
		/** toolName / args keyed by id; values from onToolCall. */
		const pendingTools = new Map<string, { name: string; args: unknown }>();
		/** tmp dir for image data URIs that need to be uploaded. */
		const tmpFiles: string[] = [];

		// Throttle timers.
		let textFlushTimer: ReturnType<typeof setTimeout> | null = null;
		let blockPatchTimer: ReturnType<typeof setTimeout> | null = null;

		const flushText = (): void => {
			textFlushTimer = null;
			if (!segmentText) return;
			void streamAICard(currentCard, segmentText, blocks, config).catch(err => {
				logger.warn("[DingTalk] streamAICard failed (mid-stream)", {
					accountId: this.#accountId,
					conversationId: inbound.conversationId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		};

		const flushBlocks = (): void => {
			blockPatchTimer = null;
			logger.info("[DingTalk] patchAICardBlocks", {
				accountId: this.#accountId,
				conversationId: inbound.conversationId,
				blockCount: blocks.length,
				blockTypes: blocks.map(b => b.type),
				blockTexts: blocks.map(b => b.text?.slice(0, 80)),
			});
			void patchAICardBlocks(currentCard, { content: segmentText, blockList: blocks }, config).catch(err => {
				logger.warn("[DingTalk] patchAICardBlocks failed", {
					accountId: this.#accountId,
					conversationId: inbound.conversationId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		};

		const scheduleBlockPatch = (): void => {
			if (blockPatchTimer) return;
			blockPatchTimer = setTimeout(flushBlocks, CARD_BLOCK_PATCH_THROTTLE_MS);
		};

		const handlers: ForwardStreamHandlers = {
			onTextDelta: (delta, cumulative) => {
				_contentText = cumulative;
				// If a segment break is pending (onAssistantMessageEnd fired
				// and this is the first text of the next assistant message),
				// finalize the old card and start a fresh one. The split is
				// async but we can't await here (sync handler). Instead,
				// we synchronously reset segment state and fire off the
				// async finish+create. A `segmentBusy` flag prevents
				// streaming until the new card is ready.
				if (pendingSegmentBreak) {
					pendingSegmentBreak = false;
					if (segmentText.trim()) {
						// Capture the old card + segment data synchronously,
						// then reset state for the new segment.
						const oldCard = currentCard;
						const oldText = segmentText;
						const oldBlocks = blocks.filter(b => b.type !== BlockType.STOP);
						// Reset per-segment state immediately so the new
						// delta accumulates into a fresh segment.
						blocks.length = 0;
						segmentText = "";
						thinkingText = "";
						pendingTools.clear();
						segmentBusy = true;

						// Async: finalize old card, create new card.
						void (async () => {
							if (oldText.trim()) {
								const segAnswer = buildAnswerBlock(oldText);
								try {
									await finishAICard(
										oldCard,
										{
											content: oldText,
											blockList: [...oldBlocks, segAnswer],
											quoteContent: quoteText,
											statusLine: "",
											copyContent: oldText,
											hasAction: false,
											version: 1 as const,
										},
										config,
									);
								} catch (err) {
									logger.warn("[DingTalk] segment finishAICard failed", {
										accountId: this.#accountId,
										conversationId: inbound.conversationId,
										error: err instanceof Error ? err.message : String(err),
									});
								}
							}

							const nextCard = await createAICardForTarget(config, target, { quoteContent: quoteText });
							if (nextCard) {
								context.registerCardAction?.({
									cardInstanceId: nextCard.cardInstanceId,
									accountId: this.#accountId,
									sessionId: inbound.conversationId,
								});
								currentCard = nextCard;
								cards.push(nextCard);
							} else {
								logger.warn("[DingTalk] segment card creation failed, reusing old card", {
									accountId: this.#accountId,
									conversationId: inbound.conversationId,
								});
							}
							segmentBusy = false;
							// Flush any buffered text now that the new card is ready.
							if (segmentText) {
								void streamAICard(currentCard, segmentText, blocks, config).catch(() => {});
							}
						})();
					}
				}
				segmentText += delta;
				// Don't schedule streaming while a segment split is in flight —
				// the text will be flushed when the new card is ready.
				if (segmentBusy) return;
				if (textFlushTimer) return;
				textFlushTimer = setTimeout(flushText, CARD_STREAM_THROTTLE_MS);
			},
			onThinkingDelta: delta => {
				// When the account has `hideThinkingBlock: true`, drop the
				// delta entirely — the model still thinks, but the card
				// shows no chain-of-thought. The session JSONL transcript
				// is unchanged (it's written by omp, not the gateway).
				if (this.#hideThinkingBlock) return;
				thinkingText += delta;
			},
			onToolCall: call => {
				pendingTools.set(call.id, { name: call.name, args: call.args });
			},
			onToolResult: result => {
				logger.info("[DingTalk] onToolResult", {
					accountId: this.#accountId,
					toolName: result.name,
					toolId: result.id,
					pendingSegmentBreak,
					segmentBusy,
					hasPending: pendingTools.has(result.id),
				});
				// If a segment break is pending (onAssistantMessageEnd
				// fired but no onTextDelta came — e.g. agent only
				// produced thinking text), trigger the split here.
				if (pendingSegmentBreak) {
					pendingSegmentBreak = false;
					if (segmentText.trim() || blocks.some(b => b.type !== BlockType.STOP)) {
						// Capture pending tool info before clearing.
						const pending = pendingTools.get(result.id) ?? { name: result.name, args: null };
						// Same capture+reset+async-split as onTextDelta path.
						const oldCard = currentCard;
						const oldText = segmentText;
						const oldBlocks = blocks.filter(b => b.type !== BlockType.STOP);
						blocks.length = 0;
						segmentText = "";
						thinkingText = "";
						pendingTools.clear();
						segmentBusy = true;

						void (async () => {
							if (oldText.trim() || oldBlocks.length > 0) {
								const segAnswer = oldText.trim() ? buildAnswerBlock(oldText) : null;
								const finalSegBlocks = segAnswer ? [...oldBlocks, segAnswer] : oldBlocks;
								try {
									await finishAICard(
										oldCard,
										{
											content: oldText,
											blockList: finalSegBlocks,
											quoteContent: quoteText,
											statusLine: "",
											copyContent: oldText,
											hasAction: false,
											version: 1 as const,
										},
										config,
									);
								} catch (err) {
									logger.warn("[DingTalk] segment finishAICard failed (tool boundary)", {
										accountId: this.#accountId,
										conversationId: inbound.conversationId,
										error: err instanceof Error ? err.message : String(err),
									});
								}
							}

							const nextCard = await createAICardForTarget(config, target, { quoteContent: quoteText });
							if (nextCard) {
								context.registerCardAction?.({
									cardInstanceId: nextCard.cardInstanceId,
									accountId: this.#accountId,
									sessionId: inbound.conversationId,
								});
								currentCard = nextCard;
								cards.push(nextCard);
							}
							segmentBusy = false;
							// Push the tool result that triggered the split onto
							// the new card's blocks.
							blocks.push(buildToolBlock(pending, result.contentText, result.isError));
							scheduleBlockPatch();
						})();
						return;
					}
				}

				if (segmentBusy) return;

				const pending = pendingTools.get(result.id);
				if (!pending) {
					blocks.push(buildToolBlock({ name: result.name, args: null }, result.contentText, result.isError));
				} else {
					blocks.push(buildToolBlock(pending, result.contentText, result.isError));
				}
				pendingTools.delete(result.id);
				scheduleBlockPatch();
			},
			onAssistantMessageEnd: () => {
				// Flush the thinking buffer as a think block.
				if (thinkingText.trim()) {
					blocks.push(buildThinkBlock(thinkingText));
					thinkingText = "";
				}
				// Mark a pending segment break. The actual card split
				// happens when the next onTextDelta arrives (so we know
				// there IS more text). If onAgentEnd follows directly,
				// no new card is created — the current card gets the
				// final chrome as normal.
				pendingSegmentBreak = true;
			},
			onLongTask: evt => {
				// Long-running tool: surface a stop block with an abort
				// button. Only push on the threshold fire (not on every
				// ping) so we don't spam the blockList with duplicates.
				// On ping events, append a progress line to the existing
				// stop block (or the most recent think block) instead.
				if (evt.threshold) {
					blocks.push(
						buildStopBlock({
							toolName: evt.toolName,
							elapsedMs: evt.elapsedMs,
							sessionId: _session.id,
						}),
					);
					scheduleBlockPatch();
					// Patch the registry entry with the toolName now that
					// we know which tool is hanging. The base registration
					// (without toolName) is already in place from the
					// create-time call; this re-registers with the richer
					// info so audit logs / future action types can see it.
					context.registerCardAction?.({
						cardInstanceId: currentCard.cardInstanceId,
						accountId: this.#accountId,
						sessionId: inbound.conversationId,
						toolName: evt.toolName,
					});
				} else {
					// Pings just update the last stop block's text with
					// the latest elapsed time, or append a progress line
					// to the think block if no stop block exists.
					const last = blocks[blocks.length - 1];
					if (last && last.type === BlockType.STOP) {
						const elapsedMin = Math.floor(evt.elapsedMs / 60_000);
						const body = `⏳ **${evt.toolName}** 已运行 ${elapsedMin} 分钟。点击下方按钮中止。`;
						last.text = body;
						last.markdown = body;
					} else {
						// No stop block to update (we missed the threshold
						// somehow) — fall back to a progress line on the
						// last think block.
						const elapsedMin = Math.floor(evt.elapsedMs / 60_000);
						thinkingText += `\n⏳ ${evt.toolName} 仍运行中 (${elapsedMin} min)`;
					}
					scheduleBlockPatch();
				}
			},
		};

		const meta = await submit(handlers);

		// Wait for any in-flight segment split to complete before
		// finalizing the last card.
		if (segmentBusy) {
			for (let i = 0; i < 200 && segmentBusy; i++) {
				await Bun.sleep(50);
			}
		}

		// Always cancel pending flushes so we don't double-stream before
		// the final finish call.
		if (textFlushTimer) {
			clearTimeout(textFlushTimer);
			textFlushTimer = null;
		}
		if (blockPatchTimer) {
			clearTimeout(blockPatchTimer);
			blockPatchTimer = null;
		}

		if (meta === null) {
			await failAICard(currentCard, "系统繁忙，请稍后重试。", config);
			await cleanupTmpFiles(tmpFiles);
			return null;
		}

		// Media pipeline: route every embedded media token by its
		// declared kind, deferring anything the AI Card cannot render
		// inline (videos / audios / documents / unsupported image
		// formats) to standalone robot messages or to a clickable
		// fallback link in the answer text.
		//
		// Sources:
		//   - image: data URI, local file, remote URL  → in-card type-3 block
		//   - video: local file, remote URL           → standalone sampleVideo
		//   - audio: local file, remote URL           → standalone sampleAudio
		//   - document: local file, remote URL        → standalone sampleFile
		//   - unsupported (webp/svg image, mov/webm/avi/mkv video)
		//                                              → clickable fallback link
		//
		// We scan segmentText (last segment only) not meta.text
		// (full cumulative) because earlier segments were already
		// finalized in their own cards.
		//
		// Standalone messages are queued here and dispatched AFTER
		// `finishAICard` succeeds so the user sees the card first and
		// the attachments follow in the conversation timeline.

		type MediaSource = "data-uri" | "local" | "remote";
		interface MediaMatch {
			/** Which extractor regex matched this token. */
			originalKind: "image" | "video" | "audio" | "document";
			/** What classifyFile says based on extension / MIME. */
			classifiedKind: FileKind;
			/** Original markdown token as it appeared in the text. */
			raw: string;
			alt: string;
			source: MediaSource;
			/** Normalized location: local path, remote URL, or data URI. */
			location: string;
			/** Data URI fields (only set when source === "data-uri"). */
			mimeType?: string;
			base64?: string;
		}

		const mediaMatches: MediaMatch[] = [];

		// 1a. Data URI images.
		for (const m of extractDataUriImages(segmentText)) {
			mediaMatches.push({
				originalKind: "image",
				classifiedKind: classifyFile(`x.${m.mimeType.split("/")[1] ?? "bin"}`),
				raw: m.dataUri,
				alt: m.alt,
				source: "data-uri",
				location: m.dataUri,
				mimeType: m.mimeType,
				base64: m.base64,
			});
		}

		// 1b. Local files (image / video / audio / document).
		const localImageExtracts = extractLocalFileImages(segmentText);
		const localVideoExtracts = extractLocalFileVideos(segmentText);
		const localAudioExtracts = extractLocalFileAudios(segmentText);
		const localDocExtracts = extractLocalFileDocuments(segmentText);
		for (const m of localImageExtracts) {
			mediaMatches.push({
				originalKind: "image",
				classifiedKind: classifyFile(m.path),
				raw: m.raw,
				alt: m.alt,
				source: "local",
				location: m.path,
			});
		}
		for (const m of localVideoExtracts) {
			mediaMatches.push({
				originalKind: "video",
				classifiedKind: classifyFile(m.path),
				raw: m.raw,
				alt: m.alt,
				source: "local",
				location: m.path,
			});
		}
		for (const m of localAudioExtracts) {
			mediaMatches.push({
				originalKind: "audio",
				classifiedKind: classifyFile(m.path),
				raw: m.raw,
				alt: m.alt,
				source: "local",
				location: m.path,
			});
		}
		for (const m of localDocExtracts) {
			mediaMatches.push({
				originalKind: "document",
				classifiedKind: classifyFile(m.path),
				raw: m.raw,
				alt: m.alt,
				source: "local",
				location: m.path,
			});
		}

		// 1c. Remote URLs (image / video / audio / document).
		const remoteImageExtracts = extractRemoteUrlImages(segmentText);
		const remoteVideoExtracts = extractRemoteUrlVideos(segmentText);
		const remoteAudioExtracts = extractRemoteUrlAudios(segmentText);
		const remoteDocExtracts = extractRemoteUrlDocuments(segmentText);
		for (const m of remoteImageExtracts) {
			mediaMatches.push({
				originalKind: "image",
				classifiedKind: classifyFile(m.url),
				raw: m.raw,
				alt: m.alt,
				source: "remote",
				location: m.url,
			});
		}
		for (const m of remoteVideoExtracts) {
			mediaMatches.push({
				originalKind: "video",
				classifiedKind: classifyFile(m.url),
				raw: m.raw,
				alt: m.alt,
				source: "remote",
				location: m.url,
			});
		}
		for (const m of remoteAudioExtracts) {
			mediaMatches.push({
				originalKind: "audio",
				classifiedKind: classifyFile(m.url),
				raw: m.raw,
				alt: m.alt,
				source: "remote",
				location: m.url,
			});
		}
		for (const m of remoteDocExtracts) {
			mediaMatches.push({
				originalKind: "document",
				classifiedKind: classifyFile(m.url),
				raw: m.raw,
				alt: m.alt,
				source: "remote",
				location: m.url,
			});
		}

		// 2. Bucket each match by routing decision. Standalone sends run
		//    after `finishAICard`; inline image blocks go onto the card
		//    blockList; fallback links are woven back into the answer
		//    text at the original token position.
		//
		//    Temp file lifetime differs by destination:
		//      - image-only (data URI / remote image) → `imageTmpFiles`,
		//        cleaned up after the card is finalized (the bytes are
		//        already on DingTalk servers by then).
		//      - standalone (remote video / audio / document) →
		//        `standaloneTmpFiles`, cleaned up AFTER the standalone
		//        message send completes, since the upload + send needs
		//        the file to still exist.
		//      - local file → use the original path, never copied.
		const standaloneQueue: {
			kind: "video" | "audio" | "document";
			path: string;
			alt: string;
			/** Original URL or local path — used to derive a friendly
			 *  fileName / fileType in the standalone msgParam. */
			originalLocation: string;
		}[] = [];
		const fallbackReplacements = new Map<string, string>(); // raw token → fallback markdown
		const imageTmpFiles: string[] = [];
		const standaloneTmpFiles: string[] = [];

		for (const m of mediaMatches) {
			if (m.classifiedKind === "unsupported") {
				warnUnsupportedFile(
					m.location,
					`original=${m.originalKind}, ext not supported`,
					this.#accountId,
					inbound.conversationId,
				);
				const reason = m.originalKind === "image" ? "客户端不支持该图片格式" : "客户端不支持该视频格式";
				fallbackReplacements.set(m.raw, unsupportedFallbackMarkdown(m.alt, m.location, m.originalKind, reason));
				continue;
			}

			// Format check: only upload if the extension is in the supported
			// set for the kind we matched. (The regex already restricts
			// extensions per kind, but the image regex includes webp/svg
			// and the video regex includes mov/webm/avi/mkv — both of
			// which classify as "unsupported" and land in the fallback
			// branch above. This guard is for future kinds and as defense
			// in depth.)
			if (m.source !== "data-uri" && !isExtensionSupported(m.classifiedKind, extractExtension(m.location))) {
				warnUnsupportedFile(
					m.location,
					"extension not in supported set for kind",
					this.#accountId,
					inbound.conversationId,
				);
				fallbackReplacements.set(
					m.raw,
					unsupportedFallbackMarkdown(m.alt, m.location, m.originalKind, "扩展名不匹配"),
				);
				continue;
			}

			// 3. Materialize to a temp file (if not already) and upload.
			let tmpPath: string | null = null;
			if (m.source === "data-uri") {
				tmpPath = await writeDataUriToTempFile(m.location, m.mimeType ?? "image/png");
				if (tmpPath) imageTmpFiles.push(tmpPath);
			} else if (m.source === "remote") {
				tmpPath = await downloadRemoteUrlToTempFile(m.location);
				if (tmpPath) {
					if (m.classifiedKind === "image") {
						imageTmpFiles.push(tmpPath);
					} else {
						standaloneTmpFiles.push(tmpPath);
					}
				}
			} else if (m.source === "local") {
				// Verify the local file is reachable before scheduling.
				try {
					await fs.promises.access(m.location);
				} catch {
					logger.warn("[DingTalk] local media file not found, degrading to link", {
						path: m.location,
						originalKind: m.originalKind,
						accountId: this.#accountId,
					});
					fallbackReplacements.set(
						m.raw,
						unsupportedFallbackMarkdown(m.alt, m.location, m.originalKind, "本地文件不存在"),
					);
					continue;
				}
				tmpPath = m.location;
			}

			if (!tmpPath) {
				logger.warn("[DingTalk] media download / write failed, degrading to link", {
					location: m.location.slice(0, 200),
					originalKind: m.originalKind,
					classifiedKind: m.classifiedKind,
					accountId: this.#accountId,
				});
				fallbackReplacements.set(m.raw, unsupportedFallbackMarkdown(m.alt, m.location, m.originalKind, "下载失败"));
				continue;
			}

			// 4. Route by kind.
			if (m.classifiedKind === "image") {
				const upload = await uploadMedia(tmpPath, mediaTypeForKind("image"), config);
				if (!upload) {
					logger.warn("[DingTalk] image upload failed; degrading to link", {
						location: m.location.slice(0, 200),
						accountId: this.#accountId,
					});
					fallbackReplacements.set(m.raw, unsupportedFallbackMarkdown(m.alt, m.location, "image", "上传失败"));
					continue;
				}
				blocks.push(buildImageBlock(upload.mediaId, m.alt));
			} else {
				// video / audio / document → standalone after the card.
				standaloneQueue.push({
					kind: m.classifiedKind,
					path: tmpPath,
					alt: m.alt,
					originalLocation: m.location,
				});
			}
		}

		// 5. Build the answer text. Replace each unsupported media token
		//    with a fallback link at its original position FIRST, then
		//    strip the supported media tokens (which have already been
		//    uploaded). Reversing the order would strip the raw token
		//    before the replacement could find it.
		//
		//    Result: a reply like
		//      "Here's the diagram: 🔗 [diagram](file:///tmp/d.webp) — image 格式不支持"
		//    instead of an empty slot or a silently dropped image.
		let workingText = segmentText;
		for (const [raw, fallback] of fallbackReplacements) {
			workingText = workingText.replace(raw, fallback);
		}
		// Strip remaining media markdown (the supported ones we already
		// uploaded). Order: video first (their URLs are not images, but
		// stripping them first keeps `stripImageDirectives` from
		// accidentally matching `https://…/clip.mp4` as an image
		// token — defensive, the regex already restricts by extension).
		workingText = stripImageDirectives(workingText);
		workingText = stripVideoDirectives(workingText);
		workingText = stripNonImageMediaDirectives(workingText);
		// Collapse runs of 3+ blank lines left by stripped tokens.
		const strippedSegText = workingText.replace(/\n{3,}/g, "\n\n").trim();

		const segMeta: AgentResponseMeta = { ...meta, text: strippedSegText, rawText: strippedSegText };
		const chrome = formatDingTalkChrome({
			meta: segMeta,
			inbound,
			agentName: context.agentName,
			accountId: context.accountId,
			dapiCalls: context.dapiCalls,
		});

		if (chrome.answerText) {
			blocks.push(buildAnswerBlock(chrome.answerText));
		}

		// Strip stop blocks from the final card: the run is over (normal
		// completion, timeout, or abort), so the stop affordance is no
		// longer actionable. Leaving it shows a dead button that returns
		// "no active prompt" when clicked, and the elapsed time is stale.
		// The tool summary in the status line already records what ran.
		const finalBlocks = blocks.filter(b => b.type !== BlockType.STOP);

		const cardData = {
			content: chrome.answerText,
			blockList: finalBlocks,
			quoteContent: chrome.quoteContent ?? quoteText,
			statusLine: chrome.statusLine ?? "",
			copyContent: chrome.copyContent,
			hasAction: false,
			version: 1 as const,
		};

		try {
			await finishAICard(currentCard, cardData, config);
		} catch (err) {
			logger.warn("[DingTalk] finishAICard failed, falling back to v1 markdown", {
				accountId: this.#accountId,
				conversationId: inbound.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
			await cleanupTmpFiles(imageTmpFiles);
			await cleanupTmpFiles(standaloneTmpFiles);
			return null;
		}

		// Image-only temp files are no longer needed once the card is
		// finalized — the bytes have already been uploaded to DingTalk.
		await cleanupTmpFiles(imageTmpFiles);

		// 6. Dispatch all standalone media (videos, audios, documents) in
		//    the order they were queued. Order is preserved by kind: an
		//    image immediately after a video still goes on the card, while
		//    a video immediately after an image is queued here. Within the
		//    queue, we dispatch in declared order so the conversation
		//    timeline matches the order of the agent's reply.
		for (const item of standaloneQueue) {
			if (item.kind === "video") {
				await this.#sendVideoStandalone(target, item.path, config);
			} else if (item.kind === "audio") {
				await this.#sendAudioStandalone(target, item.path, config);
			} else {
				// Documents: prefer the original URL / local path as the
				// fileName (e.g. "q4.pdf") so the user sees something
				// meaningful in their chat. Fall back to alt.
				const originalName =
					item.originalLocation.startsWith("http://") || item.originalLocation.startsWith("https://")
						? path.basename(new URL(item.originalLocation).pathname)
						: path.basename(item.originalLocation);
				await this.#sendFileStandalone(target, item.path, originalName, config);
			}
		}

		// Standalone temp files can be cleaned up now — the upload +
		// standalone send both happened above.
		await cleanupTmpFiles(standaloneTmpFiles);

		// The card itself is the user-visible reply. We still return a
		// markdown OutboundMessage for the gateway's own bookkeeping /
		// tests; the v1 chrome is the most complete representation of
		// the response in a single string. Channels that send via the
		// card and ignore the OutboundMessage (DingTalk) will simply
		// drop it on the floor — the card is already delivered.
		const { markdown } = formatDingTalkReply({
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
			toUserId: inbound.userId,
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

	// Metrics — written in #handleMessage / handleInbound. Kept as
	// plain counters for now; exposing them through a getter is a
	// future change. biome's `noUnusedPrivateClassMembers` flags them
	// as unused because they're only written; suppress inline.
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: written in #handleMessage, future getter
	#receivedCount = 0;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: written in #handleMessage, future getter
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

		// Factory seam: production uses the real SDK client; tests
		// override `createDWClient` to inject a fake `EventEmitter`-based
		// client that captures callbacks without dialing DingTalk.
		this.#client = this.createDWClient({
			clientId: this.#config.appKey,
			clientSecret: this.#config.appSecret,
			ua: "pi-gateway/0.1.0",
			debug: false,
			autoReconnect: false, // pi-gateway has its own #doReconnect logic
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

		// Register AI Card action callback listener. When the user clicks
		// a button on a card we created, DingTalk pushes a callback over
		// the same Stream WebSocket on /v1.0/card/instances/callback.
		// The handler routes the action back to the gateway's
		// ActionRegistry, which looks up the card and calls bridge.abort()
		// (or other action types in the future).
		this.#client.registerCallbackListener(TOPIC_CARD, (msg: DWClientDownStream) => {
			void this.#handleCardCallback(msg);
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

			// Clean up everything we set up before the failed connect:
			// without this, the dedup setInterval keeps running, the
			// DWClient holds internal timers / WS state, and any SDK
			// `error` / `disconnect` event that fires later will hit
			// handlers on a half-initialised channel. None of that is
			// catastrophic on its own, but it leaks per failed account
			// (and in the long run produces confusing log lines).
			if (this.#dedupCleanupTimer) {
				clearInterval(this.#dedupCleanupTimer);
				this.#dedupCleanupTimer = null;
			}
			if (this.#client) {
				try {
					// Best-effort: drop the SDK's listeners and the client
					// itself. We don't `disconnect()` because the WS may
					// never have opened; removing listeners + nulling the
					// reference is enough for GC.
					(this.#client as any).removeAllListeners?.();
				} catch {
					// ignore — we're already in a failure path
				}
				this.#client = null;
			}

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
		const text =
			msg.content.type === "markdown"
				? msg.content.markdown
				: msg.content.type === "text"
					? msg.content.text
					: "[unsupported content type]";

		logger.debug("[DingTalk] sending message", { text: text.slice(0, 500), type: msg.content.type });

		// DingTalk may return HTTP 200 with an `errcode` in the body when a
		// business-level error occurs (notably `300001 session 不存在` for
		// expired session webhooks). The HTTP status check alone is not
		// enough — we must parse the body. `errcode` is omitted on success
		// (treated as 0). On any non-zero errcode we throw, but fall back
		// to Route 2/3 below if the caller provided a target user or
		// conversation — otherwise the user would never see a reply to a
		// /new issued after a long idle period.
		const tryRoute1 = async (): Promise<boolean> => {
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
				logger.error("[DingTalk] send failed (HTTP)", {
					accountId: msg.accountId,
					conversationId: msg.conversationId,
					status: res.status,
					body: errText,
				});
				throw new Error(`[DingTalk] send failed: ${res.status} ${errText}`);
			}

			let parsed: { errcode?: number; errmsg?: string } | null = null;
			try {
				parsed = (await res.json()) as { errcode?: number; errmsg?: string };
			} catch {
				// Non-JSON success body — treat as success.
			}

			const errcode = parsed?.errcode ?? 0;
			if (errcode !== 0) {
				logger.warn("[DingTalk] webhook returned business error", {
					accountId: msg.accountId,
					conversationId: msg.conversationId,
					errcode,
					errmsg: parsed?.errmsg,
				});
				return false; // signal "fall back to next route"
			}

			logger.info("[DingTalk] message sent via webhook", {
				accountId: msg.accountId,
				conversationId: msg.conversationId,
			});
			return true;
		};

		// Route 1: sessionWebhook — interactive reply. Try first; on
		// business errors (expired session) fall through to Route 2/3.
		if (msg.sessionWebhook) {
			const ok = await tryRoute1();
			if (ok) return;
			logger.debug("[DingTalk] Route 1 (webhook) failed, falling back to OAuth routes", {
				accountId: msg.accountId,
				hasToUserId: !!msg.toUserId,
				hasConversationId: !!msg.conversationId,
			});
		}

		// Route 2: OAuth DM — proactive push to individual user (cron delivery)
		if (msg.accountId && msg.toUserId) {
			await this.#sendViaOAuthDM(msg.toUserId, text);
			return;
		}

		// Route 3: OAuth group — proactive push to conversation (cron delivery)
		if (msg.accountId && msg.conversationId) {
			await this.#sendViaOAuthGroup(msg.conversationId, text);
			return;
		}

		throw new Error(
			"[DingTalk] sendMessage failed: all routes exhausted (webhook failed and no accountId+toUserId or accountId+conversationId for fallback)",
		);
	}

	/**
	 * Get an OAuth access token for proactive message sending, with caching.
	 * Token TTL is taken from DingTalk's expireIn response minus a 60s safety margin.
	 */
	async #getOAuthToken(): Promise<string> {
		const now = Date.now();
		if (this.#tokenCache && this.#tokenCache.expiresAt > now) {
			return this.#tokenCache.token;
		}

		if (!this.#config?.appKey || !this.#config?.appSecret) {
			throw new Error("[DingTalk] cannot get OAuth token: missing appKey/appSecret in channel config");
		}

		let appSecret = this.#config.appSecret;
		if (appSecret.startsWith("$")) {
			const envVal = Bun.env[appSecret.slice(1)];
			if (envVal) appSecret = envVal;
		}

		try {
			const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ appKey: this.#config.appKey, appSecret }),
			});
			if (!res.ok) {
				const err = await res.text();
				throw new Error(`[DingTalk] failed to get OAuth token: ${res.status} ${err}`);
			}
			const data = (await res.json()) as { accessToken?: string; expireIn?: number };
			if (!data.accessToken) {
				throw new Error("[DingTalk] OAuth response missing accessToken");
			}
			const expireIn = data.expireIn ?? 7200;
			this.#tokenCache = {
				token: data.accessToken,
				expiresAt: now + (expireIn - 60) * 1000,
			};
			return data.accessToken;
		} catch (err) {
			this.#tokenCache = null;
			throw err;
		}
	}

	/** Resolve robotCode from channel config (fallback to appKey). */
	#getRobotCode(): string {
		return this.#config?.robotCode ?? this.#config?.appKey ?? "";
	}

	/** Send a proactive DM via OAuth API. */
	async #sendViaOAuthDM(userId: string, text: string): Promise<void> {
		const token = await this.#getOAuthToken();
		const robotCode = this.#getRobotCode();
		const msgParam = JSON.stringify({ content: text });

		logger.debug("[DingTalk] sending DM via OAuth", { userId, accountId: this.#accountId });

		const res = await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-acs-dingtalk-access-token": token,
			},
			body: JSON.stringify({
				robotCode,
				userIds: [userId],
				msgKey: "sampleText",
				msgParam,
			}),
		});

		if (!res.ok) {
			const err = await res.text();
			logger.error("[DingTalk] OAuth DM send failed", { status: res.status, body: err });
			throw new Error(`[DingTalk] OAuth DM send failed: ${res.status} ${err}`);
		}
		logger.debug("[DingTalk] DM sent via OAuth", { userId, accountId: this.#accountId });
	}

	/** Send a proactive group message via OAuth API. */
	async #sendViaOAuthGroup(conversationId: string, text: string): Promise<void> {
		const token = await this.#getOAuthToken();
		const robotCode = this.#getRobotCode();
		const msgParam = JSON.stringify({ content: text });

		logger.debug("[DingTalk] sending group message via OAuth", { conversationId, accountId: this.#accountId });

		const res = await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-acs-dingtalk-access-token": token,
			},
			body: JSON.stringify({
				robotCode,
				openConversationId: conversationId,
				msgKey: "sampleText",
				msgParam,
			}),
		});

		if (!res.ok) {
			const err = await res.text();
			logger.error("[DingTalk] OAuth group send failed", { status: res.status, body: err });
			throw new Error(`[DingTalk] OAuth group send failed: ${res.status} ${err}`);
		}
		logger.debug("[DingTalk] group message sent via OAuth", { conversationId, accountId: this.#accountId });
	}

	/**
	 * Send a standalone video message via the DingTalk OAuth API.
	 *
	 * Videos cannot be rendered inside the AI Card blockList (the OpenClaw
	 * schema has no video block type). Instead, after `finishAICard` completes,
	 * the channel sends each extracted video as a `sampleVideo` robot message
	 * that appears in the same conversation immediately after the card.
	 *
	 * Requires: video file already on disk (local path or downloaded from
	 * a remote URL). The method uploads the video, extracts a cover frame
	 * via ffmpeg, gets duration via ffprobe, and sends the `sampleVideo`
	 * message via `oToMessages/batchSend` (DM) or `groupMessages/send` (group).
	 */
	async #sendVideoStandalone(target: AICardTarget, videoPath: string, config: DingTalkConfig): Promise<void> {
		const token = await this.#getOAuthToken();
		const robotCode = this.#getRobotCode();
		const videoType = getVideoType(videoPath);

		// 1. Upload video → videoMediaId
		const videoUpload = await uploadMedia(videoPath, "video", config);
		if (!videoUpload) {
			logger.warn("[DingTalk] video upload failed; skipping standalone video message", {
				path: videoPath,
				accountId: this.#accountId,
			});
			return;
		}

		// 2. Extract cover frame + upload → picMediaId (best-effort)
		let picMediaId: string | undefined;
		const coverPath = await extractVideoCoverFrame(videoPath);
		if (coverPath) {
			const coverUpload = await uploadMedia(coverPath, "image", config);
			try {
				await fs.promises.unlink(coverPath);
			} catch {}
			if (coverUpload) {
				picMediaId = coverUpload.mediaId;
			}
		}

		// 3. Get duration (best-effort, 0 if ffprobe unavailable)
		const duration = await getVideoDuration(videoPath);

		// 4. Build sampleVideo msgParam
		const msgParam = JSON.stringify({
			duration: String(duration),
			videoMediaId: videoUpload.mediaId,
			videoType,
			...(picMediaId ? { picMediaId } : {}),
		});

		logger.debug("[DingTalk] sending standalone video", {
			videoPath,
			duration,
			videoType,
			hasCover: !!picMediaId,
			accountId: this.#accountId,
		});

		// 5. Send via OAuth API (DM or group)
		let res: Response;
		if (target.type === "user") {
			res = await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-acs-dingtalk-access-token": token,
				},
				body: JSON.stringify({
					robotCode,
					userIds: [target.userId],
					msgKey: "sampleVideo",
					msgParam,
				}),
			});
		} else {
			res = await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-acs-dingtalk-access-token": token,
				},
				body: JSON.stringify({
					robotCode,
					openConversationId: target.openConversationId,
					msgKey: "sampleVideo",
					msgParam,
				}),
			});
		}

		if (!res.ok) {
			const err = await res.text();
			logger.error("[DingTalk] standalone video send failed", {
				status: res.status,
				body: err,
				accountId: this.#accountId,
			});
		} else {
			logger.debug("[DingTalk] standalone video sent", { accountId: this.#accountId });
		}
	}

	/**
	 * Send a standalone audio message via the DingTalk OAuth API.
	 *
	 * Mirrors `#sendVideoStandalone` for audio files. The AI Card has
	 * no audio block type, so the channel sends each extracted audio
	 * as a `sampleAudio` robot message after `finishAICard` completes.
	 *
	 * `sampleAudio` requires `mediaId` and `duration` (ms). Duration
	 * is best-effort: ffprobe if available, else 0 (the client just
	 * won't show a duration badge).
	 */
	async #sendAudioStandalone(target: AICardTarget, audioPath: string, config: DingTalkConfig): Promise<void> {
		const token = await this.#getOAuthToken();
		const robotCode = this.#getRobotCode();

		const upload = await uploadMedia(audioPath, "voice", config);
		if (!upload) {
			logger.warn("[DingTalk] audio upload failed; skipping standalone audio message", {
				path: audioPath,
				accountId: this.#accountId,
			});
			return;
		}

		const durationMs = await getAudioDurationMs(audioPath);

		const msgParam = JSON.stringify({
			mediaId: upload.mediaId,
			duration: String(durationMs),
		});

		logger.debug("[DingTalk] sending standalone audio", {
			audioPath,
			durationMs,
			accountId: this.#accountId,
		});

		const res =
			target.type === "user"
				? await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-acs-dingtalk-access-token": token,
						},
						body: JSON.stringify({
							robotCode,
							userIds: [target.userId],
							msgKey: "sampleAudio",
							msgParam,
						}),
					})
				: await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-acs-dingtalk-access-token": token,
						},
						body: JSON.stringify({
							robotCode,
							openConversationId: target.openConversationId,
							msgKey: "sampleAudio",
							msgParam,
						}),
					});

		if (!res.ok) {
			const err = await res.text();
			logger.error("[DingTalk] standalone audio send failed", {
				status: res.status,
				body: err,
				accountId: this.#accountId,
			});
		} else {
			logger.debug("[DingTalk] standalone audio sent", { accountId: this.#accountId });
		}
	}

	/**
	 * Send a standalone document / office / archive file via the
	 * DingTalk OAuth API. Mirrors `#sendVideoStandalone` for
	 * documents (PDF, Word, Excel, PPT, zip, rar).
	 *
	 * The AI Card has no document block type, so the channel sends
	 * each extracted document as a `sampleFile` robot message after
	/**
	 * Public entry point for sending a file attachment to a DingTalk conversation.
	 *
	 * Handles the full lifecycle: upload via uploadMedia('file') then send as
	 * a sampleFile robot message. Designed to be called by host tools
	 * (e.g. `dingtalk.attachment`) that resolve the target from active chat
	 * context.
	 *
	 * Supported file types: doc, docx, xls, xlsx, ppt, pptx, zip, pdf, rar.
	 *
	 * @param target  — user or group target
	 * @param filePath — absolute path to the file on disk
	 * @param originalName — optional display name (defaults to basename of filePath)
	 */
	async sendFile(target: AICardTarget, filePath: string, originalName?: string): Promise<void> {
		return this.#sendFileStandalone(target, filePath, originalName, this.#config);
	}

	/**
	 * `finishAICard` completes. `fileType` is the extension (without
	 * the dot) — derived from the path; DingTalk docs explicitly
	 * list xlsx/pdf/zip/rar/doc/docx.
	 */
	async #sendFileStandalone(
		target: AICardTarget,
		filePath: string,
		originalName: string | undefined,
		config: DingTalkConfig,
	): Promise<void> {
		const token = await this.#getOAuthToken();
		const robotCode = this.#getRobotCode();

		const upload = await uploadMedia(filePath, "file", config);
		if (!upload) {
			logger.warn("[DingTalk] file upload failed; skipping standalone file message", {
				path: filePath,
				accountId: this.#accountId,
			});
			return;
		}

		const fileName = originalName?.trim() ? originalName.trim() : path.basename(filePath);
		const fileType = extractExtension(filePath) || extractExtension(fileName);

		const msgParam = JSON.stringify({
			mediaId: upload.mediaId,
			fileName,
			fileType,
		});

		logger.debug("[DingTalk] sending standalone file", {
			filePath,
			fileName,
			fileType,
			accountId: this.#accountId,
		});

		const res =
			target.type === "user"
				? await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-acs-dingtalk-access-token": token,
						},
						body: JSON.stringify({
							robotCode,
							userIds: [target.userId],
							msgKey: "sampleFile",
							msgParam,
						}),
					})
				: await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-acs-dingtalk-access-token": token,
						},
						body: JSON.stringify({
							robotCode,
							openConversationId: target.openConversationId,
							msgKey: "sampleFile",
							msgParam,
						}),
					});

		if (!res.ok) {
			const err = await res.text();
			logger.error("[DingTalk] standalone file send failed", {
				status: res.status,
				body: err,
				accountId: this.#accountId,
			});
		} else {
			logger.debug("[DingTalk] standalone file sent", { accountId: this.#accountId });
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
					logger.debug("[DingTalk] Server disconnect topic received, reconnecting", {
						accountId: this.#accountId,
					});
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

		// Hard cap: after MAX_RECONNECT_ATTEMPTS failures, give up and
		// leave the channel disconnected. The heartbeat timer will
		// keep firing but early-returns here, so it's a no-op. A
		// reload or process restart is required to retry — a
		// persistent failure usually means credentials are wrong.
		if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			logger.error("[DingTalk] reconnect exhausted; channel left disconnected", {
				accountId: this.#accountId,
				attempts: this.#reconnectAttempts,
				max: MAX_RECONNECT_ATTEMPTS,
			});
			this.#connected = false;
			this.#connectionFailed = true;
			return;
		}

		this.#isReconnecting = true;

		if (!immediate && this.#reconnectAttempts > 0) {
			const delay = this.#calculateBackoffDelay(this.#reconnectAttempts);
			logger.debug("[DingTalk] Reconnecting", {
				accountId: this.#accountId,
				attempt: this.#reconnectAttempts + 1,
				delayMs: Math.round(delay),
			});
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
			logger.error("[DingTalk] Reconnect failed", {
				accountId: this.#accountId,
				attempt: this.#reconnectAttempts,
				error: String(err),
			});
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

	/**
	 * Test seam: expose `#checkPermission` so unit tests can verify
	 * the permission policy logic (open / allowlist / closed, DM / group)
	 * without spinning up the full Stream SDK.
	 */
	__testCheckPermission(msg: InboundMessage): boolean {
		return this.#checkPermission(msg);
	}

	/**
	 * Test seam: set config without connecting, for permission tests.
	 */
	__testSetConfig(config: DingTalkConfig): void {
		this.#config = config;
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
			return false; // empty allowlist = deny all (fail-closed)
		}

		// Group policy
		const groupPolicy = ((config as any).groupPolicy as PermissionPolicy) ?? "allowlist";
		if (groupPolicy === "closed") return false;
		if (groupPolicy === "open") return true;
		// allowlist mode
		if (config.allowedGroups && config.allowedGroups.length > 0) {
			return config.allowedGroups.includes(msg.conversationId);
		}
		return false; // empty allowlist = deny all (fail-closed)
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Handle a DingTalk AI Card action callback (TOPIC_CARD).
	 *
	 * The body shape is:
	 *   { type: "actionCallback", outTrackId, corpId, userId,
	 *     content: "{...cardPrivateData JSON...}" }
	 *
	 * `outTrackId` is the cardInstanceId we generated at create-time,
	 * so the gateway's ActionRegistry can look up the session / bridge
	 * that owns the card. `content.cardPrivateData.params` carries the
	 * `btns[N].params` we set in `buildStopBlock` (e.g. `type=stop`,
	 * `sessionId`, `toolName`).
	 */
	async #handleCardCallback(msg: DWClientDownStream): Promise<void> {
		if (!this.#cardActionHandler) {
			logger.debug("[DingTalk] card action arrived but no handler installed", {
				accountId: this.#accountId,
			});
			return;
		}
		const raw = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
		let body: {
			outTrackId?: string;
			corpId?: string;
			userId?: string;
			content?: string;
		};
		try {
			body = JSON.parse(raw) as typeof body;
		} catch (err) {
			logger.warn("[DingTalk] card callback body not JSON", {
				accountId: this.#accountId,
				error: err instanceof Error ? err.message : String(err),
				preview: raw.slice(0, 200),
			});
			return;
		}
		if (!body.outTrackId || !body.content) {
			logger.warn("[DingTalk] card callback missing outTrackId or content", {
				accountId: this.#accountId,
				body,
			});
			return;
		}
		let privateData: { cardPrivateData?: { actionIds?: string[]; params?: Record<string, string> } };
		try {
			privateData = JSON.parse(body.content);
		} catch (err) {
			logger.warn("[DingTalk] card callback content not JSON", {
				accountId: this.#accountId,
				error: err instanceof Error ? err.message : String(err),
				preview: body.content.slice(0, 200),
			});
			return;
		}
		const cpd = privateData.cardPrivateData ?? {};
		const event: DingTalkCardActionEvent = {
			cardInstanceId: body.outTrackId,
			actionIds: cpd.actionIds ?? [],
			params: cpd.params ?? {},
			userId: body.userId ?? "",
			corpId: body.corpId ?? "",
		};
		try {
			await this.#cardActionHandler(event);
		} catch (err) {
			logger.error("[DingTalk] card action handler threw", {
				accountId: this.#accountId,
				cardInstanceId: event.cardInstanceId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

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
			logger.info("[DingTalk] message received", {
				messageId,
				msgId: businessMsgId,
				msgtype: parsed.msgtype,
				sender: parsed.senderNick,
				conversationType: parsed.conversationType === "1" ? "DM" : "Group",
				rawContent:
					typeof parsed.content === "string"
						? parsed.content.slice(0, 500)
						: JSON.stringify(parsed.content)?.slice(0, 500),
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

			// Download media attachments (images/files/videos) before forwarding.
			// Fail-soft: download errors produce an empty array and the message
			// still reaches the agent as text.
			// Also downloads for richText messages where content.type is "text"
			// but mediaUrls carries embedded image downloadCodes.
			const needsDownload =
				this.#config &&
				((inbound.content.type !== "text" && inbound.content.type !== "markdown") ||
					(inbound.mediaUrls && inbound.mediaUrls.length > 0));
			if (needsDownload) {
				logger.info("[DingTalk] Downloading attachment", {
					type: inbound.content.type,
					url: (inbound.content as any).url?.slice(0, 80),
					mediaUrlCount: inbound.mediaUrls?.length ?? 0,
				});
				const { resolveInboundAttachments } = await import("./dingtalk-media");
				const customDownloader = this.createMediaDownloader() ?? undefined;
				inbound.attachments = await resolveInboundAttachments(inbound, this.#config, customDownloader);
				logger.info("[DingTalk] Attachment resolved", {
					count: inbound.attachments?.length ?? 0,
					kinds: inbound.attachments?.map(a => a.kind),
					mimes: inbound.attachments?.map(a => a.mimeType),
				});
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

	// ═══════════════════════════════════════════════════════════════
	// Test injection seam
	// ═══════════════════════════════════════════════════════════════
	//
	// `injectTestMessage` lets a test driver push a real `DingTalkRawMessage`
	// into the channel without going through the Stream SDK WebSocket. It
	// runs the same parse → dedup → permission → media download →
	// handleInbound path that production traffic follows, but skips the
	// ACK (no real socket to ACK against) and never touches the network.
	//
	// Use this for production-environment integration tests where the
	// gateway is running as a daemon and we want to simulate a user
	// message without manually opening DingTalk. Callers are expected to
	// gate the test HTTP endpoint (see `Gateway.injectTestEndpoint`)
	// behind `OMP_GATEWAY_TEST_MODE=1`.
	//
	// Returns the parsed `InboundMessage` on success so callers can
	// assert on `conversationId`, `userId`, etc. without re-parsing.
	/**
	 * Inject a real `DingTalkRawMessage` into the channel pipeline.
	 * Skips ACK; preserves dedup. Returns the parsed inbound or a
	 * `{ ok: false, reason }` shape on failure.
	 */
	async injectTestMessage(
		raw: DingTalkRawMessage,
		messageId: string,
		opts: { skipDedup?: boolean; skipMediaDownload?: boolean; skipPermission?: boolean } = {},
	): Promise<{ ok: true; inbound: InboundMessage } | { ok: false; reason: string }> {
		const log = logger;
		log.info("[DingTalk] TEST INJECT", {
			conversationId: (raw as any).conversationId,
			senderId: (raw as any).senderId,
			msgtype: raw.msgtype,
			preview: typeof raw.text?.content === "string" ? raw.text.content.slice(0, 80) : "<non-text>",
		});

		// ── dedup: protocol + business, mirroring #handleMessage ──
		if (!opts.skipDedup) {
			if (checkAndMarkDingtalkMessage(this.#accountId, messageId, undefined)) {
				return { ok: false, reason: "duplicate_messageId" };
			}
			if (checkAndMarkDingtalkMessage(this.#accountId, undefined, raw.msgId)) {
				return { ok: false, reason: "duplicate_msgId" };
			}
		}

		// ── parse ──
		const inbound = this.#parseRobotMessage(raw, messageId);
		if (!inbound) return { ok: false, reason: "parse_failed" };

		// ── permission ──
		if (!opts.skipPermission && !this.#checkPermission(inbound)) {
			log.warn("[DingTalk] TEST INJECT blocked by permission policy", {
				userId: inbound.userId,
				conversationId: inbound.conversationId,
			});
			return { ok: false, reason: "permission_denied" };
		}

		// ── media download (same trigger as #handleMessage) ──
		const needsDownload =
			this.#config &&
			!opts.skipMediaDownload &&
			((inbound.content.type !== "text" && inbound.content.type !== "markdown") ||
				(inbound.mediaUrls && inbound.mediaUrls.length > 0));
		if (needsDownload && this.#config) {
			const { resolveInboundAttachments } = await import("./dingtalk-media");
			const customDownloader = this.createMediaDownloader() ?? undefined;
			inbound.attachments = await resolveInboundAttachments(inbound, this.#config, customDownloader);
		}

		// ── run the same final step as #handleMessage ──
		await this.handleInbound(inbound);
		this.#processedCount++;
		return { ok: true, inbound };
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Data URI image helpers (v3 image block pipeline)
// ═══════════════════════════════════════════════════════════════════════

/** A single data URI image found in assistant text. */
interface ExtractedImage {
	/** The full data URI as it appeared in the markdown. */
	dataUri: string;
	/** "image/png", "image/jpeg", etc. */
	mimeType: string;
	/** Raw base64 payload (no MIME prefix). */
	base64: string;
	/** alt text from the markdown image (the `[alt]` part). */
	alt: string;
}

const DATA_URI_IMAGE_RE = /!\[([^\]]*)\]\(data:([a-zA-Z0-9./+-]+);base64,([A-Za-z0-9+/=]+)\)/g;

/**
 * Scan assistant text for markdown data-URI images. Returns one entry
 * per match. Only `data:<mime>;base64,...` is supported.
 */
export function extractDataUriImages(text: string): ExtractedImage[] {
	const out: ExtractedImage[] = [];
	for (const match of text.matchAll(DATA_URI_IMAGE_RE)) {
		out.push({
			dataUri: match[0],
			mimeType: match[2],
			base64: match[3],
			alt: match[1] ?? "",
		});
	}
	return out;
}

/** A local file image referenced by `![alt](file:///path)` or `![alt](/abs/path)`. */
interface LocalFileImage {
	/** The original markdown image token as it appeared in text. */
	raw: string;
	/** Absolute filesystem path to the image. */
	path: string;
	/** alt text from the markdown image. */
	alt: string;
}

/**
 * Match `![alt](file:///path)` and `![alt](/abs/path)` for image files.
 * Both the `file://` and absolute-path branches require an image
 * extension so audio / video / document `file://` references don't
 * get double-counted as images by the streaming pipeline.
 *
 * Path must end with a known image extension so we don't try to
 * upload arbitrary files.
 */
const LOCAL_FILE_IMAGE_RE =
	/!\[([^\]]*)\]\((file:\/\/[^)]+\.(?:png|jpe?g|gif|webp|bmp|svg)|\/[^)]+\.(?:png|jpe?g|gif|webp|bmp|svg))\)/gi;

/**
 * Scan assistant text for markdown images pointing to local files.
 * Matches `![alt](file:///abs/path.png)` and `![alt](/abs/path.png)`.
 * Remote URLs and relative paths are ignored.
 */
export function extractLocalFileImages(text: string): LocalFileImage[] {
	const out: LocalFileImage[] = [];
	for (const match of text.matchAll(LOCAL_FILE_IMAGE_RE)) {
		const rawUrl = match[2];
		const filePath = rawUrl.startsWith("file://") ? decodeURIComponent(rawUrl.slice("file://".length)) : rawUrl;
		out.push({ raw: match[0], path: filePath, alt: match[1] ?? "" });
	}
	return out;
}

/** A remote URL image referenced by `![alt](https://...)` or `![alt](http://...)`. */
interface RemoteUrlImage {
	/** The original markdown image token as it appeared in text. */
	raw: string;
	/** The full HTTP(S) URL. */
	url: string;
	/** alt text from the markdown image. */
	alt: string;
}

/**
 * Match `![alt](https://...)` for image files only. The previous
 * version matched any HTTP(S) URL (`https?:\/\/[^)]+`), which
 * double-counted URLs that also matched the audio / video / document
 * extractors (e.g. `https://.../voice.mp3` was being extracted as
 * BOTH an image and an audio). Restricting to image extensions
 * keeps the four extractors mutually exclusive.
 *
 * Query strings are included so signed CDN URLs work.
 */
const REMOTE_URL_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^)]*)?)\)/gi;

/**
 * Scan assistant text for markdown images pointing to remote HTTP(S) URLs.
 * DingTalk cards cannot render remote URLs natively — they must be
 * downloaded and uploaded as mediaId. Data URIs and local files are
 * handled by their own extractors.
 */
export function extractRemoteUrlImages(text: string): RemoteUrlImage[] {
	const out: RemoteUrlImage[] = [];
	for (const match of text.matchAll(REMOTE_URL_IMAGE_RE)) {
		out.push({ raw: match[0], url: match[2], alt: match[1] ?? "" });
	}
	return out;
}

/**
 * Strip all image markdown (data URI + local file + remote URL) from
 * answer text so the card body doesn't render broken image
 * placeholders. The actual images are delivered as type-3 blocks
 * via uploadMedia.
 */
export function stripImageDirectives(text: string): string {
	let stripped = text.replace(DATA_URI_IMAGE_RE, "");
	stripped = stripped.replace(LOCAL_FILE_IMAGE_RE, "");
	stripped = stripped.replace(REMOTE_URL_IMAGE_RE, "");
	// Collapse 3+ blank lines left by removed images into a single paragraph break
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Decode a base64 data URI to a temp file on disk. Returns the path
 * (caller must `cleanupTmpFiles` it) or null on failure.
 */
async function writeDataUriToTempFile(dataUri: string, mimeType: string): Promise<string | null> {
	const match = DATA_URI_IMAGE_RE.exec(dataUri);
	if (!match) return null;
	const base64 = match[3];
	const ext = mimeType.split("/")[1] ?? "bin";
	const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "");
	try {
		const bytes = Buffer.from(base64, "base64");
		const tmpPath = path.join(
			os.tmpdir(),
			`omp-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`,
		);
		await fs.promises.writeFile(tmpPath, bytes);
		return tmpPath;
	} catch (err) {
		logger.warn("[DingTalk] data URI decode failed", { mimeType, error: String(err) });
		return null;
	}
}

async function cleanupTmpFiles(paths: string[]): Promise<void> {
	await Promise.all(
		paths.map(async p => {
			try {
				await fs.promises.unlink(p);
			} catch {
				// best effort
			}
		}),
	);
}

/**
 * Download a remote HTTP(S) image to a temp file on disk.
 * Returns the path (caller must `cleanupTmpFiles` it) or null on failure.
 * The file extension is derived from the Content-Type header, falling
 * back to the URL path extension, then to `.bin`.
 */
async function downloadRemoteUrlToTempFile(url: string): Promise<string | null> {
	try {
		const resp = await fetch(url, { method: "GET" });
		if (!resp.ok) {
			logger.warn("[DingTalk] remote image download failed", {
				status: resp.status,
				url: url.slice(0, 200),
			});
			return null;
		}

		const contentType = resp.headers.get("content-type") ?? "image/jpeg";
		const ext =
			contentType
				.split("/")
				.pop()
				?.replace(/[^a-zA-Z0-9]/g, "") || "jpg";
		const buffer = await resp.arrayBuffer();
		const tmpPath = path.join(
			os.tmpdir(),
			`omp-card-remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
		);
		await fs.promises.writeFile(tmpPath, Buffer.from(buffer));
		return tmpPath;
	} catch (err) {
		logger.warn("[DingTalk] remote image download error", {
			url: url.slice(0, 200),
			error: String(err),
		});
		return null;
	}
}

// ════════════════════════════════════════════════════════════════════════
// Video extraction helpers (standalone video message pipeline)
// ════════════════════════════════════════════════════════════════════════

/** A local file video referenced by `![alt](file:///path)` or `![alt](/abs/path)`. */
interface LocalFileVideo {
	/** The original markdown image token as it appeared in text. */
	raw: string;
	/** Absolute filesystem path to the video. */
	path: string;
	/** alt text from the markdown image. */
	alt: string;
}

/**
 * Match `![alt](file:///path)` and `![alt](/abs/path)` for video files.
 * Mirrors LOCAL_FILE_IMAGE_RE but with video extensions.
 */
const LOCAL_FILE_VIDEO_RE = /!\[([^\]]*)\]\((file:\/\/[^)]+|\/[^)]+\.(?:mp4|mov|webm|avi|mkv))\)/gi;
/**
 * Scan assistant text for markdown videos pointing to local files.
 * Matches `![alt](file:///abs/path.mp4)` and `![alt](/abs/path.mp4)`.
 */
export function extractLocalFileVideos(text: string): LocalFileVideo[] {
	const out: LocalFileVideo[] = [];
	for (const match of text.matchAll(LOCAL_FILE_VIDEO_RE)) {
		const rawUrl = match[2];
		const filePath = rawUrl.startsWith("file://") ? decodeURIComponent(rawUrl.slice("file://".length)) : rawUrl;
		out.push({ raw: match[0], path: filePath, alt: match[1] ?? "" });
	}
	return out;
}

/** A remote URL video referenced by `![alt](https://...)`. */
interface RemoteUrlVideo {
	/** The original markdown image token as it appeared in text. */
	raw: string;
	/** The full HTTP(S) URL. */
	url: string;
	/** alt text from the markdown image. */
	alt: string;
}

/**
 * Match `![alt](https://...)` for video files only.
 * Query strings are included. Non-video URLs are ignored.
 */
const REMOTE_URL_VIDEO_RE = /!\[([^\]]*)\]\((https?:\/\/[^)]+\.(?:mp4|mov|webm|avi|mkv)(?:\?[^)]*)?)\)/gi;
/**
 * Scan assistant text for markdown videos pointing to remote HTTP(S) URLs.
 * DingTalk cards cannot render videos in blockList — videos are sent as
 * standalone `sampleVideo` messages after the card finishes.
 */
export function extractRemoteUrlVideos(text: string): RemoteUrlVideo[] {
	const out: RemoteUrlVideo[] = [];
	for (const match of text.matchAll(REMOTE_URL_VIDEO_RE)) {
		out.push({ raw: match[0], url: match[2], alt: match[1] ?? "" });
	}
	return out;
}

/**
 * Strip all video markdown (local file + remote URL) from answer text
 * so the card body doesn't render broken video placeholders. The actual
 * videos are delivered as standalone `sampleVideo` messages.
 */
export function stripVideoDirectives(text: string): string {
	let stripped = text.replace(LOCAL_FILE_VIDEO_RE, "");
	stripped = stripped.replace(REMOTE_URL_VIDEO_RE, "");
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Get video duration in seconds using ffprobe. Returns 0 on failure
 * (the DingTalk API accepts 0 — the video just won't show a duration badge).
 */
async function getVideoDuration(filePath: string): Promise<number> {
	try {
		const result = await $`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${filePath}`.quiet().nothrow();
		if (result.exitCode === 0) {
			const parsed = parseFloat(result.text().trim());
			return Number.isFinite(parsed) ? Math.round(parsed) : 0;
		}
	} catch {
		// ffprobe not available or file unreadable
	}
	return 0;
}

/**
 * Get audio duration in milliseconds using ffprobe. Returns 0 on
 * failure. The standalone `sampleAudio` message template takes
 * duration in milliseconds (unlike sampleVideo which is seconds).
 */
async function getAudioDurationMs(filePath: string): Promise<number> {
	try {
		const result = await $`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${filePath}`.quiet().nothrow();
		if (result.exitCode === 0) {
			const parsed = parseFloat(result.text().trim());
			return Number.isFinite(parsed) ? Math.round(parsed * 1000) : 0;
		}
	} catch {
		// ffprobe not available or file unreadable
	}
	return 0;
}

/**
 * Extract a cover frame from a video at ~1s offset using ffmpeg.
 * Returns the temp image path (caller must clean up) or null on failure.
 */
async function extractVideoCoverFrame(filePath: string): Promise<string | null> {
	const tmpPath = path.join(
		os.tmpdir(),
		`omp-video-cover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
	);
	try {
		const result = await $`ffmpeg -y -ss 1 -i ${filePath} -frames:v 1 -f image2 ${tmpPath}`.quiet().nothrow();
		if (result.exitCode === 0) {
			// Verify the file was actually written
			await fs.promises.access(tmpPath);
			return tmpPath;
		}
	} catch {
		// ffmpeg not available or extraction failed
	}
	try {
		await fs.promises.unlink(tmpPath);
	} catch {}
	return null;
}

/**
 * Derive the DingTalk videoType from a file path extension.
 * DingTalk currently only supports "mp4"; non-mp4 files are sent as
 * mp4 anyway (the API will reject if the container is incompatible).
 */
function getVideoType(_filePath: string): string {
	return "mp4";
}

// ═══════════════════════════════════════════════════════════════════════
// Audio extraction helpers (standalone audio message pipeline)
// ═══════════════════════════════════════════════════════════════════════

/** A local file audio referenced by `![alt](file:///path)` or `![alt](/abs/path)`. */
interface LocalFileAudio {
	/** The original markdown image token as it appeared in text. */
	raw: string;
	/** Absolute filesystem path to the audio. */
	path: string;
	/** alt text from the markdown image. */
	alt: string;
}

/**
 * Match `![alt](file:///path)` and `![alt](/abs/path)` for audio files.
 * Mirrors LOCAL_FILE_VIDEO_RE but with audio extensions (amr/mp3/wav/ogg).
 * Single source of truth for the supported set: `dingtalk-files.ts`.
 */
const LOCAL_FILE_AUDIO_RE = /!\[([^\]]*)\]\((file:\/\/[^)]+|\/[^)]+\.(?:amr|mp3|wav|ogg))\)/gi;

/**
 * Scan assistant text for markdown audios pointing to local files.
 * Matches `![alt](file:///abs/path.mp3)` and `![alt](/abs/path.amr)`.
 */
export function extractLocalFileAudios(text: string): LocalFileAudio[] {
	const out: LocalFileAudio[] = [];
	for (const match of text.matchAll(LOCAL_FILE_AUDIO_RE)) {
		const rawUrl = match[2];
		const filePath = rawUrl.startsWith("file://") ? decodeURIComponent(rawUrl.slice("file://".length)) : rawUrl;
		out.push({ raw: match[0], path: filePath, alt: match[1] ?? "" });
	}
	return out;
}

/** A remote URL audio referenced by `![alt](https://...)`. */
interface RemoteUrlAudio {
	/** The original markdown image token as it appeared in text. */
	raw: string;
	/** The full HTTP(S) URL. */
	url: string;
	/** alt text from the markdown image. */
	alt: string;
}

/**
 * Match `![alt](https://...)` for audio files only.
 * Query strings are included. Non-audio URLs are ignored.
 */
const REMOTE_URL_AUDIO_RE = /!\[([^\]]*)\]\((https?:\/\/[^)]+\.(?:amr|mp3|wav|ogg)(?:\?[^)]*)?)\)/gi;

/**
 * Scan assistant text for markdown audios pointing to remote HTTP(S) URLs.
 * DingTalk cards cannot render audio inline — audios are sent as
 * standalone `sampleAudio` messages after the card finishes.
 */
export function extractRemoteUrlAudios(text: string): RemoteUrlAudio[] {
	const out: RemoteUrlAudio[] = [];
	for (const match of text.matchAll(REMOTE_URL_AUDIO_RE)) {
		out.push({ raw: match[0], url: match[2], alt: match[1] ?? "" });
	}
	return out;
}

// ═══════════════════════════════════════════════════════════════════════
// Document extraction helpers (standalone file message pipeline)
// ═══════════════════════════════════════════════════════════════════════

/** A local file document (PDF / Word / Excel / PPT / zip / rar) referenced
 *  by `![alt](file:///path)` or `![alt](/abs/path)`. */
interface LocalFileDocument {
	/** The original markdown image token as it appeared in text. */
	raw: string;
	/** Absolute filesystem path to the document. */
	path: string;
	/** alt text from the markdown image. */
	alt: string;
}

/**
 * Match `![alt](file:///path)` and `![alt](/abs/path)` for office documents.
 * Single source of truth for the supported set: `dingtalk-files.ts`.
 */
const LOCAL_FILE_DOCUMENT_RE =
	/!\[([^\]]*)\]\((file:\/\/[^)]+|\/[^)]+\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar))\)/gi;

/**
 * Scan assistant text for markdown documents pointing to local files.
 * Matches `![alt](file:///abs/path.pdf)` and `![alt](/abs/path.docx)`.
 */
export function extractLocalFileDocuments(text: string): LocalFileDocument[] {
	const out: LocalFileDocument[] = [];
	for (const match of text.matchAll(LOCAL_FILE_DOCUMENT_RE)) {
		const rawUrl = match[2];
		const filePath = rawUrl.startsWith("file://") ? decodeURIComponent(rawUrl.slice("file://".length)) : rawUrl;
		out.push({ raw: match[0], path: filePath, alt: match[1] ?? "" });
	}
	return out;
}

/** A remote URL document referenced by `![alt](https://...)`. */
interface RemoteUrlDocument {
	/** The original markdown image token as it appeared in text. */
	raw: string;
	/** The full HTTP(S) URL. */
	url: string;
	/** alt text from the markdown image. */
	alt: string;
}

/**
 * Match `![alt](https://...)` for office document files only.
 * Query strings are included. Non-document URLs are ignored.
 */
const REMOTE_URL_DOCUMENT_RE =
	/!\[([^\]]*)\]\((https?:\/\/[^)]+\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar)(?:\?[^)]*)?)\)/gi;

/**
 * Scan assistant text for markdown documents pointing to remote HTTP(S) URLs.
 * DingTalk cards cannot render documents inline — documents are sent as
 * standalone `sampleFile` messages after the card finishes.
 */
export function extractRemoteUrlDocuments(text: string): RemoteUrlDocument[] {
	const out: RemoteUrlDocument[] = [];
	for (const match of text.matchAll(REMOTE_URL_DOCUMENT_RE)) {
		out.push({ raw: match[0], url: match[2], alt: match[1] ?? "" });
	}
	return out;
}

// ═══════════════════════════════════════════════════════════════════════
// Non-image media stripper
// ═══════════════════════════════════════════════════════════════════════

/**
 * Strip non-image media markdown (audio + document) from answer text.
 * The actual media are delivered as standalone `sampleAudio` / `sampleFile`
 * messages after the card finishes. This keeps the card body free of
 * broken links to file URLs that the AI Card renderer would otherwise
 * try to fetch and fail to preview.
 *
 * Image stripping is intentionally NOT here — `stripImageDirectives`
 * remains the single source of truth for image markdown so existing
 * call sites and tests don't move.
 */
export function stripNonImageMediaDirectives(text: string): string {
	let stripped = text.replace(LOCAL_FILE_AUDIO_RE, "");
	stripped = stripped.replace(REMOTE_URL_AUDIO_RE, "");
	stripped = stripped.replace(LOCAL_FILE_DOCUMENT_RE, "");
	stripped = stripped.replace(REMOTE_URL_DOCUMENT_RE, "");
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
}
