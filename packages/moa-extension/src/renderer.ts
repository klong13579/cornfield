import type { MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import { Box, Markdown, Spacer, Text, type Component, type MarkdownTheme } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { MoaTraceDetails } from "./types";

function buildCollapsedLine(details: MoaTraceDetails | undefined): string {
	if (!details) {
		return "MOA result";
	}
	const okCount = details.workers.filter(worker => worker.ok).length;
	return truncateToWidth(replaceTabs(`task: ${details.task} | workers: ${okCount}/${details.workerCount}`), 100);
}

export function createRenderMoaResult(getMarkdownTheme: () => MarkdownTheme): MessageRenderer<MoaTraceDetails> {
	return (message, options, theme): Component => {
		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[moa]")), 0, 0));
		box.addChild(new Spacer(1));

		if (!options.expanded) {
			box.addChild(new Text(theme.fg("customMessageText", buildCollapsedLine(message.details)), 0, 0));
			return box;
		}

		const text =
			typeof message.content === "string"
				? message.content
				: message.content
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
