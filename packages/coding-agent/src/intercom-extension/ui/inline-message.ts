import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { Ellipsis, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { Message, SessionInfo } from "../types";

/** Number of message lines shown in the collapsed preview. Matches PREVIEW_LIMITS.OUTPUT_COLLAPSED (read tool). */
const COLLAPSED_PREVIEW_LINES = 3;

export class InlineMessageComponent implements Component {
	private from: SessionInfo;
	private message: Message;
	private theme: Theme;
	private replyCommand?: string;
	private bodyText?: string;
	private collapsed: boolean;
	// Caches assume message/bodyText never mutate after construction; theme
	// styling stays outside the caches so live theme changes apply per render.
	private collapsedPreview?: string[];
	private wrappedBody?: { width: number; lines: string[] };

	constructor(
		from: SessionInfo,
		message: Message,
		theme: Theme,
		replyCommand?: string,
		bodyText?: string,
		collapsed = false,
	) {
		this.from = from;
		this.message = message;
		this.theme = theme;
		this.replyCommand = replyCommand;
		this.bodyText = bodyText;
		this.collapsed = collapsed;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const borderChar = "─";
		const senderName = this.from.name || this.from.id.slice(0, 8);
		if (width < 3) {
			return [truncateToWidth(`From ${senderName}`, width)];
		}
		const bodyWidth = Math.max(1, width - 2);

		const header = ` From: ${senderName} (${this.from.cwd}) `;
		const headerText = truncateToWidth(
			this.collapsed ? `${header} Ctrl+O expands ` : header,
			bodyWidth,
			Ellipsis.Omit,
		);
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		lines.push(
			this.theme.fg("muted", "╭") +
				this.theme.fg("toolTitle", headerText) +
				this.theme.fg("muted", `${borderChar.repeat(headerPadding)}╮`),
		);

		const frameLine = (content: string): string => {
			const text = truncateToWidth(content, bodyWidth, Ellipsis.Omit);
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			return this.theme.fg("muted", "│") + text + this.theme.fg("muted", `${" ".repeat(padding)}│`);
		};

		if (this.collapsed) {
			// Collapsed preview: first COLLAPSED_PREVIEW_LINES logical lines, each whitespace-collapsed
			// and width-truncated by frameLine. Blank lines are dropped so they don't consume preview rows.
			this.collapsedPreview ??= (this.bodyText || this.message.content.text)
				.split("\n")
				.map(line => line.replace(/\s+/g, " ").trim())
				.filter(Boolean)
				.slice(0, COLLAPSED_PREVIEW_LINES);
			for (const line of this.collapsedPreview) {
				lines.push(frameLine(this.theme.fg("text", line)));
			}

			const meta: string[] = [];
			if (this.replyCommand) meta.push(`To reply: ${this.replyCommand}`);
			if (this.message.content.attachments?.length) {
				const count = this.message.content.attachments.length;
				meta.push(`${count} attachment${count === 1 ? "" : "s"}`);
			}
			if (this.message.replyTo && !this.message.expectsReply)
				meta.push(`Reply to ${this.message.replyTo.slice(0, 8)}`);
			meta.push("Ctrl+O to expand");

			lines.push(frameLine(this.theme.fg("dim", ` ${meta.join(" · ")}`)));
			lines.push(this.theme.fg("muted", `╰${borderChar.repeat(bodyWidth)}╯`));
			return lines;
		}

		if (this.wrappedBody?.width !== bodyWidth) {
			this.wrappedBody = {
				width: bodyWidth,
				lines: wrapTextWithAnsi(this.bodyText || this.message.content.text, bodyWidth),
			};
		}
		for (const line of this.wrappedBody.lines) {
			lines.push(frameLine(this.theme.fg("text", line)));
		}

		if (this.replyCommand) {
			lines.push(frameLine(""));
			const replyLines = wrapTextWithAnsi(this.theme.fg("dim", ` To reply: ${this.replyCommand}`), bodyWidth);
			for (const line of replyLines) {
				lines.push(frameLine(line));
			}
		}

		if (this.message.content.attachments?.length) {
			lines.push(frameLine(""));
			for (const att of this.message.content.attachments) {
				lines.push(frameLine(this.theme.fg("dim", ` Attachment: ${att.name}`)));
			}
		}

		if (this.message.replyTo && !this.message.expectsReply) {
			lines.push(frameLine(""));
			lines.push(frameLine(this.theme.fg("dim", ` Reply to ${this.message.replyTo.slice(0, 8)}`)));
		}

		lines.push(this.theme.fg("muted", `╰${borderChar.repeat(bodyWidth)}╯`));

		return lines;
	}
}
