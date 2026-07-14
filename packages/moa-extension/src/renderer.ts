import type { MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import { Box, type Component, Markdown, type MarkdownTheme, Spacer, Text } from "@oh-my-pi/pi-tui";
import type { MoaTraceDetails } from "./types";

/**
 * Render the user-visible `moa-result` custom message.
 *
 * Always renders the full handoff content (not collapsible) because:
 * 1. The handoff is bounded by `settings.resumeContextBytes` (default 8KB),
 *    so it always fits without spamming the TUI.
 * 2. The synthesis is the deliverable; the user needs to see it immediately
 *    to reference it in the next turn (e.g. "based on the OKR framework above, ...").
 * 3. The global `ctrl+o` expand toggle would otherwise collapse moa-result
 *    along with tool outputs, hiding the result the user just asked for.
 *
 * Branch and compaction summaries still use the collapsed default — those
 * are mid-session state, not terminal results.
 */
export function createRenderMoaResult(getMarkdownTheme: () => MarkdownTheme): MessageRenderer<MoaTraceDetails> {
	return (_message, _options, theme): Component => {
		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[moa]")), 0, 0));
		box.addChild(new Spacer(1));

		const text =
			typeof _message.content === "string"
				? _message.content
				: _message.content
						.filter(part => part.type === "text")
						.map(part => part.text)
						.join("\n");
		box.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (value: string) => theme.fg("customMessageText", value),
			}),
		);
		return box;
	};
}
