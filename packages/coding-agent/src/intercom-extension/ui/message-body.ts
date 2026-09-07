import type { Theme } from "@cornfield/coding-agent";
import type { Component } from "@cornfield/tui";
import { replaceTabs, wrapTextWithAnsi } from "@cornfield/tui";

/** Collapsed visual-line budget for outgoing message bodies (matches BASH_DEFAULT_PREVIEW_LINES). */
export const INTERCOM_MESSAGE_PREVIEW_LINES = 10;

/**
 * Renders an outgoing intercom message body the way bash renders output:
 * width-wrapped, collapsed to the first INTERCOM_MESSAGE_PREVIEW_LINES visual
 * lines with an expand hint, and fully shown when the tool view is expanded.
 */
export function createMessageBodyComponent(
	header: string,
	message: string,
	theme: Theme,
	isExpanded: () => boolean,
): Component {
	const body = message.trim();
	return {
		invalidate(): void {},
		render(width: number): string[] {
			const lines = [header];
			if (!body) {
				return lines;
			}
			const wrapped = wrapTextWithAnsi(replaceTabs(body), Math.max(1, width));
			const styled = wrapped.map(line => theme.fg("dim", line));
			if (isExpanded() || wrapped.length <= INTERCOM_MESSAGE_PREVIEW_LINES) {
				lines.push(...styled);
				return lines;
			}
			lines.push(...styled.slice(0, INTERCOM_MESSAGE_PREVIEW_LINES));
			lines.push(
				theme.fg("dim", `… (${wrapped.length - INTERCOM_MESSAGE_PREVIEW_LINES} more lines, Ctrl+O to expand)`),
			);
			return lines;
		},
	};
}
