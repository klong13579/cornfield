/**
 * Agent response delivery — send replies, stream AI Cards, handle card actions.
 *
 * Encapsulates all the reply-formatting and card-streaming logic that was
 * inline in Gateway: sendAgentResponse, sendFormattedAgentResponse,
 * tryStreamAgentResponse, handleCardAction, handleAbortMessage, etc.
 */
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { AgentBridge } from "./agent-bridge";
import type { DingTalkCardActionEvent, DingTalkChannel } from "./channels/dingtalk";
import { ChannelRegistry } from "./channels/registry";
import { ActionRegistry } from "./action-registry";
import { SessionManager } from "./session-manager";
import type {
	AgentResponseMeta,
	Channel,
	ForwardStreamHandlers,
	InboundMessage,
	MessageContent,
	OutboundMessage,
	ReplyFormatterContext,
	SessionRecord,
} from "./types";

/** Interface for the subset of Gateway that ResponseHandler needs. */
export interface ResponseGatewayDeps {
	registry: ChannelRegistry;
	sessionManager: SessionManager | undefined;
	actionRegistry: ActionRegistry;
}

export class ResponseHandler {
	#deps: ResponseGatewayDeps;

	constructor(deps: ResponseGatewayDeps) {
		this.#deps = deps;
	}

	/** Update the session manager reference after it's created in Gateway.start(). */
	setSessionManager(sm: SessionManager): void {
		this.#deps.sessionManager = sm;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Abort
	// ═══════════════════════════════════════════════════════════════════

	async handleAbortMessage(msg: InboundMessage, accountId: string): Promise<boolean> {
		if (!this.#isAbortContent(msg.content)) return false;
		let aborted = false;
		try {
			aborted = (await this.#deps.sessionManager?.abort(accountId)) ?? false;
		} catch (err) {
			logger.warn("Failed to abort agent turn", {
				accountId,
				conversationId: msg.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		await this.sendAgentResponse(msg, aborted ? "已请求停止当前任务。" : "当前没有正在运行的任务。");
		return true;
	}

	#isAbortContent(content: MessageContent): boolean {
		const text =
			content.type === "text"
				? content.text
				: content.type === "markdown"
					? content.markdown
					: content.type === "voice"
						? (content.text ?? "")
						: "";
		const normalized = text.trim().toLowerCase();
		return (
			normalized === "停止" ||
			normalized === "取消" ||
			normalized === "中止" ||
			normalized === "abort" ||
			normalized === "cancel" ||
			normalized === "stop"
		);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Plain-text response
	// ═══════════════════════════════════════════════════════════════════

	async sendAgentResponse(msg: InboundMessage, text: string): Promise<void> {
		const outbound: OutboundMessage = {
			channelId: msg.channelId,
			conversationId: msg.conversationId,
			content: { type: "text", text },
			sessionWebhook: msg.sessionWebhook,
			accountId: msg.accountId,
		};
		try {
			await this.#deps.registry.sendMessage(outbound);
		} catch (err) {
			logger.error("Failed to send agent response", {
				accountId: msg.accountId,
				conversationId: msg.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Send the agent's reply through the channel-specific `formatReply` (if
	 * the channel implements one) so platforms that opt into richer visuals
	 * get status lines, tool summaries, and quote content. Channels that
	 * haven't implemented `formatReply` get the plain-text fallback.
	 */
	async sendFormattedAgentResponse(msg: InboundMessage, meta: AgentResponseMeta, accountId: string): Promise<void> {
		const channel = this.#deps.registry.get(this.#buildChannelKey(msg.channelId, msg.accountId));
		const context: ReplyFormatterContext = {
			accountId,
			agentName: this.resolveAgentName(accountId),
			dapiCalls: 0,
		};

		const outbound = channel?.formatReply ? channel.formatReply(meta, msg, context) : null;

		if (!outbound) {
			await this.sendAgentResponse(msg, meta.text);
			return;
		}

		try {
			await this.#deps.registry.sendMessage(outbound);
		} catch (err) {
			logger.error("Failed to send formatted agent response", {
				accountId,
				conversationId: msg.conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// AI Card streaming
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Try to run the agent through the channel's v2 AI Card streaming
	 * path. Returns `true` when the channel handled the reply (card
	 * created + streamed + finished), `false` when the channel doesn't
	 * support cards or card creation failed.
	 */
	async tryStreamAgentResponse(
		msg: InboundMessage,
		session: SessionRecord,
		accountId: string,
		channel: Channel | undefined,
		sessionManager: SessionManager | undefined,
	): Promise<boolean> {
		if (!channel?.streamCard) return false;
		if (!sessionManager) return false;

		const context: ReplyFormatterContext = {
			accountId,
			agentName: this.resolveAgentName(accountId),
			dapiCalls: 0,
			registerCardAction: info =>
				this.#deps.actionRegistry.register(info.cardInstanceId, {
					accountId: info.accountId,
					sessionId: info.sessionId,
					toolName: info.toolName,
				}),
		};

		const submit = (handlers?: ForwardStreamHandlers): Promise<AgentResponseMeta | null> =>
			sessionManager.enqueueWithMeta(msg, session, handlers);

		try {
			const outbound = await channel.streamCard(msg, session, context, submit);
			return outbound !== null;
		} catch (err) {
			logger.error("Failed to run AI Card stream path, falling back to v1 markdown", {
				accountId,
				conversationId: msg.conversationId,
				channel: msg.channelId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Card action callbacks
	// ═══════════════════════════════════════════════════════════════════

	async handleCardAction(event: DingTalkCardActionEvent): Promise<void> {
		const info = this.#deps.actionRegistry.lookup(event.cardInstanceId);
		if (!info) {
			if (event.actionIds.includes("btn_stop")) {
				logger.warn("[Gateway] btn_stop on unknown card — aborting by user", {
					cardInstanceId: event.cardInstanceId,
					clickedBy: event.userId,
				});
				if (this.#deps.sessionManager) {
					try {
						await this.#deps.sessionManager.abortByUser(event.userId);
					} catch (err) {
						logger.error("[Gateway] btn_stop fallback abort failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				return;
			}
			logger.warn("[Gateway] card action for unknown / expired card", {
				cardInstanceId: event.cardInstanceId,
				actionType: event.params.type,
				actionIds: event.actionIds,
				userId: event.userId,
			});
			return;
		}

		const isStop = event.params.type === "stop" || event.actionIds.includes("btn_stop");
		if (isStop) {
			logger.warn("[Gateway] card stop action — aborting bridge", {
				cardInstanceId: event.cardInstanceId,
				accountId: info.accountId,
				sessionId: info.sessionId,
				toolName: info.toolName,
				clickedBy: event.userId,
			});
			if (!this.#deps.sessionManager) {
				logger.warn("[Gateway] sessionManager not initialized; cannot abort");
				return;
			}
			try {
				const aborted = await this.#deps.sessionManager.abort(info.accountId);
				if (!aborted) {
					logger.debug("[Gateway] abort() returned false (no active prompt)", {
						accountId: info.accountId,
					});
				}
			} catch (err) {
				logger.error("[Gateway] bridge abort failed", {
					accountId: info.accountId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			return;
		}

		logger.warn("[Gateway] unhandled card action type", {
			actionType: event.params.type,
			cardInstanceId: event.cardInstanceId,
			actionIds: event.actionIds,
			params: event.params,
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// V1 markdown fallback
	// ═══════════════════════════════════════════════════════════════════

	async sendAgentResponseViaV1Markdown(
		msg: InboundMessage,
		session: SessionRecord,
		accountId: string,
		sessionManager: SessionManager | undefined,
	): Promise<void> {
		// Run the agent first, then send the response in a single message.
		// We don't send a "thinking..." placeholder here because DingTalk's
		// sessionWebhook is single-use — a placeholder would consume the
		// webhook and the actual response would fail to deliver.
		// The AI Card path (tryStreamAgentResponse) is preferred for streaming
		// feedback; this V1 path is the fallback for when cards are unavailable.
		const meta = await sessionManager?.enqueueWithMeta(msg, session);
		if (meta) {
			await this.sendFormattedAgentResponse(msg, meta, accountId);
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════════════════════

	resolveAgentName(accountId: string): string | null {
		if (!accountId || accountId === "__default__") return null;
		return accountId;
	}

	/** Build the registry key for a channel lookup. */
	#buildChannelKey(channelId: string, accountId?: string): string {
		return accountId ? `${channelId}:${accountId}` : channelId;
	}
}
