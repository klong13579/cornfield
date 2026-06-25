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
import { DWClient, type DWClientDownStream, TOPIC_CARD, TOPIC_ROBOT } from "dingtalk-stream";
import {
	buildAnswerBlock,
	buildImageBlock,
	buildStopBlock,
	buildThinkBlock,
	buildToolBlock,
	type CardBlock,
	BlockType,
} from "./dingtalk-card";
import { createAICardForTarget, failAICard, finishAICard, patchAICardBlocks, streamAICard } from "./dingtalk-card";
import { uploadMedia } from "./dingtalk-media";
import { formatDingTalkChrome, formatDingTalkReply } from "./dingtalk-formatter";
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
	/** Handler invoked when a card action callback arrives via TOPIC_CARD. */
	#cardActionHandler: ((event: DingTalkCardActionEvent) => Promise<void>) | null = null;
	/** OAuth token cache for proactive message sending (DM + group push). */
	#tokenCache: { token: string; expiresAt: number } | null = null;

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
		const blocks: CardBlock[] = [];
		let contentText = "";
		let thinkingText = "";
		/** toolName / args keyed by id; values from onToolCall. */
		const pendingTools = new Map<string, { name: string; args: unknown }>();
		/** tmp dir for image data URIs that need to be uploaded. */
		const tmpFiles: string[] = [];

		// Throttle timers.
		let textFlushTimer: ReturnType<typeof setTimeout> | null = null;
		let blockPatchTimer: ReturnType<typeof setTimeout> | null = null;

		const flushText = (): void => {
			textFlushTimer = null;
			if (!contentText) return;
			void streamAICard(card, contentText, blocks, config).catch(err => {
				logger.warn("[DingTalk] streamAICard failed (mid-stream)", {
					accountId: this.#accountId,
					conversationId: inbound.conversationId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		};

		const flushBlocks = (): void => {
			blockPatchTimer = null;
			void patchAICardBlocks(card, { content: contentText, blockList: blocks }, config).catch(err => {
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
			onTextDelta: (_delta, cumulative) => {
				contentText = cumulative;
				if (textFlushTimer) return;
				textFlushTimer = setTimeout(flushText, CARD_STREAM_THROTTLE_MS);
			},
			onThinkingDelta: delta => {
				thinkingText += delta;
			},
			onToolCall: call => {
				pendingTools.set(call.id, { name: call.name, args: call.args });
			},
			onToolResult: result => {
				const pending = pendingTools.get(result.id);
				if (!pending) {
					// tool_result without a matching toolcall_end is unusual
					// (it can happen if the bridge dropped a delta) — still
					// emit a block with the name we have, for visibility.
					blocks.push(buildToolBlock({ name: result.name, args: null }, result.contentText, result.isError));
				} else {
					blocks.push(buildToolBlock(pending, result.contentText, result.isError));
				}
				pendingTools.delete(result.id);
				scheduleBlockPatch();
			},
			onAssistantMessageEnd: () => {
				// Flush the thinking buffer as a think block. The text
				// itself is in contentText; the answer block is built at
				// onAgentEnd so we can include the final content (after
				// any post-message-end edits the model performs).
				if (thinkingText.trim()) {
					blocks.push(buildThinkBlock(thinkingText));
					thinkingText = "";
				}
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
						cardInstanceId: card.cardInstanceId,
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
			await failAICard(card, "系统繁忙，请稍后重试。", config);
			await cleanupTmpFiles(tmpFiles);
			return null;
		}

		// Image upload pipeline: scan the assistant's final text for
		// data URI images AND local file references, upload each one
		// to DingTalk, and emit a type-3 image block per upload. The
		// raw image markdown is then stripped from the answer text so
		// the card body doesn't render broken image placeholders.
		//
		// Supported syntax:
		//   ![alt](data:image/png;base64,...)   — inline base64
		//   ![alt](file:///abs/path.png)         — file URI scheme
		//   ![alt](/abs/path.png)                — absolute path
		//
		// Tool results that return images are not yet auto-uploaded
		// (they would need binary content in onToolResult, which the
		// bridge currently surfaces only as `contentText`).
		const dataUris = extractDataUriImages(meta.text);
		for (const match of dataUris) {
			const tmp = await writeDataUriToTempFile(match.dataUri, match.mimeType);
			if (!tmp) continue;
			tmpFiles.push(tmp);
			const upload = await uploadMedia(tmp, "image", config);
			if (!upload) {
				logger.warn("[DingTalk] image upload failed; skipping image block", {
					accountId: this.#accountId,
					conversationId: inbound.conversationId,
				});
				continue;
			}
			blocks.push(buildImageBlock(upload.mediaId, match.alt));
		}

		const localFiles = extractLocalFileImages(meta.text);
		for (const match of localFiles) {
			try {
				await fs.promises.access(match.path);
			} catch {
				logger.warn("[DingTalk] local image file not found, skipping", {
					path: match.path,
					accountId: this.#accountId,
				});
				continue;
			}
			const upload = await uploadMedia(match.path, "image", config);
			if (!upload) {
				logger.warn("[DingTalk] local image upload failed; skipping image block", {
					path: match.path,
					accountId: this.#accountId,
				});
				continue;
			}
			blocks.push(buildImageBlock(upload.mediaId, match.alt));
		}

		// Strip all image markdown (data URI + local file) from the
		// answer text so the card body shows only text — images are
		// delivered as type-3 blocks above.
		const strippedText = stripImageDirectives(meta.text);
		const strippedMeta: AgentResponseMeta = { ...meta, text: strippedText, rawText: strippedText };
		const chrome = formatDingTalkChrome({
			meta: strippedMeta,
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
			await finishAICard(card, cardData, config);
		} catch (err) {
			logger.warn("[DingTalk] finishAICard failed, falling back to v1 markdown", {
				accountId: this.#accountId,
				conversationId: inbound.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
			await cleanupTmpFiles(tmpFiles);
			return null;
		}

		await cleanupTmpFiles(tmpFiles);

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

		// Route 1: sessionWebhook — interactive reply (existing path)
		if (msg.sessionWebhook) {
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
				logger.debug("[DingTalk] message sent via webhook", { conversationId: msg.conversationId });
			} catch (err) {
				logger.error("[DingTalk] send error", { error: String(err) });
				throw err;
			}
			return;
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
			"[DingTalk] sendMessage failed: no delivery route (missing sessionWebhook or accountId+toUserId or accountId+conversationId)",
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
 * per match. Only `data:<mime>;base64,...` is supported — remote
 * `https://...` images are left untouched (DingTalk can fetch them
 * natively; the channel doesn't need to upload them).
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
 * Match `![alt](file:///path)` and `![alt](/abs/path)` but NOT
 * `https://...` / `http://...` / relative paths. Path must end with
 * a known image extension so we don't try to upload arbitrary files.
 */
const LOCAL_FILE_IMAGE_RE = /!\[([^\]]*)\]\((file:\/\/[^)]+|\/[^)]+\.(?:png|jpe?g|gif|webp|bmp|svg))\)/gi;

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

/**
 * Strip both data-URI and local-file image markdown from answer text
 * so the card body doesn't render broken image placeholders. The
 * actual images are delivered as type-3 image blocks via uploadMedia.
 */
export function stripImageDirectives(text: string): string {
	let stripped = text.replace(DATA_URI_IMAGE_RE, "");
	stripped = stripped.replace(LOCAL_FILE_IMAGE_RE, "");
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
