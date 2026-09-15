/**
 * Recovery for sloppy edit payloads the model emits as plain assistant text
 * instead of an `edit` tool call.
 *
 * Registered as the agent loop's `transformAssistantMessage` hook: the finalized
 * assistant message is rewritten in place before the loop reads its tool calls
 * and before it reaches the event stream, the session log or the next provider
 * request. The payload is lifted out of the text block and re-materialized as a
 * synthetic `edit` tool call, so the normal pipeline — argument validation,
 * approval, plan-mode guards, execution, rendering, journaling, provider replay —
 * runs it unchanged.
 *
 * This is a different layer from post-write validation/auto-repair
 * (`./post-write`): recovery happens before execution, repair after it.
 */

import type { AgentTool } from "@cornfield/agent";
import type { AssistantMessage } from "@cornfield/ai";
import type { EditMode } from "../utils/edit-mode";
import { extractInlineSloppyRegions } from "./modes/sloppy";

/**
 * Convert stray sloppy payloads in `message`'s text blocks into one synthetic
 * `edit` tool call. Mutates the message in place; returns the number of payload
 * regions recovered (0 = message untouched).
 *
 * Fires only on a clean `stop` turn that carries no tool call: a `length`-
 * truncated payload must never execute half an edit (it may also be missing its
 * closing tag, which the region scan already refuses), and a turn that already
 * called tools handled its own edits — any quoted payload there is commentary.
 */
export function recoverInlineSloppyEdit(message: AssistantMessage): number {
	if (message.stopReason !== "stop") return 0;
	if (message.content.some(block => block.type === "toolCall")) return 0;

	const payloads: string[] = [];
	for (const block of message.content) {
		if (block.type !== "text") continue;
		const regions = extractInlineSloppyRegions(block.text);
		if (regions.length === 0) continue;
		let remaining = "";
		let cursor = 0;
		for (const region of regions) {
			remaining += block.text.slice(cursor, region.start);
			cursor = region.end;
			payloads.push(region.payload);
		}
		remaining += block.text.slice(cursor);
		block.text = remaining;
	}

	if (payloads.length === 0) return 0;

	message.content = message.content.filter(block => !(block.type === "text" && block.text.trim() === ""));
	message.content.push({
		type: "toolCall",
		id: `call_recovered_${crypto.randomUUID()}`,
		name: "edit",
		arguments: { input: payloads.join("\n") },
	});
	return payloads.length;
}

/**
 * Recovery, gated on the live `edit` tool actually running the `sloppy` mode.
 *
 * `edit.mode` is one way to reach that mode, but not the only one (env override,
 * per-model variant) and not authoritative for a bridged tool — a Cursor-style
 * `edit` pinned to `replace` never receives an `{ input }` payload, so it must
 * never have one synthesized for it.
 */
export function recoverInlineSloppyEditFromTools(
	tools: readonly AgentTool<any>[] | undefined,
	message: AssistantMessage,
): number {
	const editTool = tools?.find(tool => tool.name === "edit") as { mode?: EditMode } | undefined;
	if (editTool?.mode !== "sloppy") return 0;
	return recoverInlineSloppyEdit(message);
}
