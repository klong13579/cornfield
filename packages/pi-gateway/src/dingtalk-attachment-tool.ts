/**
 * `dingtalk_attachment` host tool — send a local file as a DingTalk attachment.
 *
 * When the LLM receives a request like "直接附件发我看看" (send this as an
 * attachment), it can call this tool to upload a local filesystem file and
 * deliver it to the current DingTalk conversation as a `sampleFile` message.
 *
 * **How it works:**
 *   1. The LLM calls `dingtalk_attachment({filePath: "/path/to/file.md"})`.
 *   2. The gateway resolves the current conversation from the bridge's
 *      active chat context (the same conversation the user's last message
 *      came from).
 *   3. The gateway finds the right DingTalkChannel instance for this account.
 *   4. The file is uploaded via DingTalk's media API and sent as a file
 *      attachment.
 *
 * **Supported file types:** doc, docx, xls, xlsx, ppt, pptx, zip, pdf, rar.
 *
 * **See also:**
 *   - `DingTalkChannel.sendFile()` — the underlying public method
 *   - `#sendFileStandalone()` — upload + send logic in dingtalk.ts
 */

import { access } from "node:fs/promises";

import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { AgentBridge } from "./agent-bridge";
import { DingTalkChannel } from "./channels/dingtalk";
import type { AICardTarget } from "./channels/dingtalk-card";
import type { ChannelRegistry } from "./channels/registry";
import type { HostToolHandler, HostToolResultBody, RpcHostToolDefinition } from "./host-tool-dispatcher";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const ATTACHMENT_PARAMETERS = Type.Object({
	filePath: Type.String({
		description:
			"Absolute path to the file on disk. The file must exist and be readable. " +
			"Supported types: doc, docx, xls, xlsx, ppt, pptx, zip, pdf, rar.",
	}),
	originalName: Type.Optional(
		Type.String({
			description:
				"Optional display name for the file in the chat. " + "If omitted, the basename of `filePath` is used.",
		}),
	),
});

const ATTACHMENT_DEFINITION: RpcHostToolDefinition = {
	name: "dingtalk_attachment",
	label: "Attachment",
	description:
		"Send a local file as a file attachment to the current DingTalk conversation. " +
		'Call this when the user asks you to send them a file (e.g. "直接附件发我看看", ' +
		'"把这个文件发给我", "附件形式发过来").\n' +
		"\n" +
		"**Parameters:**\n" +
		"  - `filePath` (required): absolute path to the file on disk\n" +
		"  - `originalName` (optional): display name in the chat\n" +
		"\n" +
		"**The file is sent to the same conversation the user's last message came from.** " +
		"There is no need to specify a target conversation — it is auto-detected.\n" +
		"\n" +
		"**Supported file types:** doc, docx, xls, xlsx, ppt, pptx, zip, pdf, rar.\n" +
		"\n" +
		"**Error handling:** returns a clear error message if the file doesn't exist, " +
		"the upload fails, or no active conversation is found. The LLM can surface " +
		"the error to the user verbatim.",
	parameters: ATTACHMENT_PARAMETERS as unknown as Record<string, unknown>,
};

// ---------------------------------------------------------------------------
// Context & factory
// ---------------------------------------------------------------------------

/**
 * Context the attachment tool needs at call time. Closed over from the
 * gateway's per-account bridge and channel registry.
 */
export interface DingtalkAttachmentToolContext {
	getBridge: () => AgentBridge;
	registry: ChannelRegistry;
	accountId: string;
}

export function createDingtalkAttachmentToolDefinitions(ctx: DingtalkAttachmentToolContext): HostToolHandler[] {
	return [
		{
			definition: ATTACHMENT_DEFINITION,
			handle: async (args: Record<string, unknown>): Promise<HostToolResultBody> => {
				return handleAttachment(ctx, args);
			},
		},
	];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleAttachment(
	ctx: DingtalkAttachmentToolContext,
	args: Record<string, unknown>,
): Promise<HostToolResultBody> {
	// 1. Validate parameters
	const filePath = args.filePath;
	if (typeof filePath !== "string" || !filePath) {
		return errResult("Missing required parameter: `filePath` (string, absolute path to the file).");
	}

	const originalName =
		typeof args.originalName === "string" && args.originalName.trim() ? args.originalName.trim() : undefined;

	// 2. Verify the file exists
	try {
		await access(filePath);
	} catch {
		return errResult(`File not found or not readable: ${filePath}`);
	}

	// 3. Get active chat context to know where to send
	const bridge = ctx.getBridge();
	const activeContext = bridge.getActiveChatContext();
	if (!activeContext) {
		return errResult(
			"No active conversation found. The attachment tool can only send files " +
				"to the conversation the user's last message came from. There is no active " +
				"message context — this may be a cron task or the session was reset.",
		);
	}

	// 4. Find the DingTalkChannel for this account
	// Multi-account mode: channel registered as `dingtalk:{accountId}`
	// Single-account mode: channel registered as `dingtalk` (channel.id)
	const channel = ctx.registry.get(`dingtalk:${ctx.accountId}`) ?? ctx.registry.get("dingtalk");
	if (!channel) {
		return errResult("DingTalk channel not found. Is the DingTalk channel enabled in the gateway config?");
	}

	// 5. Construct the target from active context and send
	const target: AICardTarget = activeContext.isGroup
		? { type: "group", openConversationId: activeContext.conversationId }
		: { type: "user", userId: activeContext.userId };

	// Guard: the found channel MUST be a DingTalkChannel, not just any Channel
	if (!(channel instanceof DingTalkChannel)) {
		return errResult("The DingTalk channel is not a DingTalkChannel instance — cannot send files.");
	}

	try {
		await channel.sendFile(target, filePath, originalName);
		logger.info("[Attachment] file sent", {
			filePath,
			originalName,
			targetType: target.type,
			accountId: ctx.accountId,
		});
		return okResult(`File sent successfully to the current conversation.`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error("[Attachment] send failed", {
			filePath,
			error: message,
			accountId: ctx.accountId,
		});
		return errResult(`Failed to send file: ${message}`);
	}
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function okResult(text: string): HostToolResultBody {
	return {
		type: "tool_result",
		tool_use_id: "",
		content: [{ type: "text", text }],
	};
}

function errResult(text: string): HostToolResultBody {
	return {
		type: "tool_result",
		tool_use_id: "",
		content: [{ type: "text", text }],
		isError: true,
	};
}
