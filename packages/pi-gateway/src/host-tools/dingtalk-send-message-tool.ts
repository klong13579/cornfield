/**
 * `dingtalk.send_message` host tool — send a text message to a DingTalk user
 * via the robot's 1-on-1 chat (Phase A).
 *
 * The LLM calls `dingtalk.send_message({targetUserId: "xxx", text: "..."})`.
 * The gateway resolves the DingTalk channel from the account ID, checks the
 * channel type, and sends the message via `channel.sendProactiveDM()`.
 *
 * Phase B (send as the user's own identity, not the robot) is TODO.
 * See `docs/phase-b-user-oauth.md` when that work starts.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { DingTalkChannel } from "../channels/dingtalk";
import type { ChannelRegistry } from "../channels/registry";
import type { HostToolHandler, HostToolResultBody } from "../host-tool-dispatcher";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const SEND_MESSAGE_PARAMETERS = Type.Object({
	targetUserId: Type.String({
		description: "The DingTalk userId of the target recipient (e.g. '601590212')",
	}),
	text: Type.String({
		description: "Plain-text message content to send",
	}),
});

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface DingtalkSendMessageToolContext {
	registry: ChannelRegistry;
	accountId: string;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function okResult(data: Record<string, unknown>): HostToolResultBody {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errResult(reason: string): HostToolResultBody {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: reason }) }], isError: true };
}

// ---------------------------------------------------------------------------
// Handler (ctx-first signature; the factory below closes over ctx to match
// the cron/bridge-status/attachment tool shape that HostToolDispatcher.setTools
// expects).
// ---------------------------------------------------------------------------

async function handleSendMessage(
	ctx: DingtalkSendMessageToolContext,
	args: { targetUserId: string; text: string },
): Promise<HostToolResultBody> {
	logger.info("[SendMessage] dingtalk.send_message called", args);

	// --- parameter validation ---
	if (!args.targetUserId || typeof args.targetUserId !== "string") {
		return errResult("Missing or invalid required parameter: targetUserId");
	}
	if (!args.text || typeof args.text !== "string") {
		return errResult("Missing or invalid required parameter: text");
	}

	// --- resolve channel ---
	// Try account-qualified key first, then fall back to the first DingTalk
	// channel in the registry.
	const channel = ctx.registry.get(`dingtalk:${ctx.accountId}`) ?? ctx.registry.get("dingtalk");
	if (!channel) {
		return errResult("No DingTalk channel found in registry");
	}
	if (!(channel instanceof DingTalkChannel)) {
		return errResult("The found channel is not a DingTalkChannel instance — cannot send message.");
	}

	// --- send ---
	try {
		await channel.sendProactiveDM(args.targetUserId, args.text);
		logger.info("[SendMessage] message sent successfully", { targetUserId: args.targetUserId });
		return okResult({ sent: true, targetUserId: args.targetUserId });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("[SendMessage] failed to send message", { targetUserId: args.targetUserId, error: msg });
		return errResult(`Failed to send message: ${msg}`);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDingtalkSendMessageToolDefinitions(ctx: DingtalkSendMessageToolContext): HostToolHandler[] {
	return [
		{
			definition: {
				name: "dingtalk.send_message",
				description:
					"Send a text message to a DingTalk user via the robot's 1-on-1 chat. " +
					"The message appears as sent by the PI robot in the target user's robot chat. " +
					"Use this to proactively notify or communicate with DingTalk users.",
				parameters: SEND_MESSAGE_PARAMETERS,
			},
			handle: args => handleSendMessage(ctx, args as { targetUserId: string; text: string }),
		},
	];
}
