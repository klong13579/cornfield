import type { AssistantMessage, ImageContent, Usage } from "@cornfield/ai";
import { stripReasoningTagsFromText } from "@cornfield/ai/utils/reasoning-tags";
import { Container, Image, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@cornfield/tui";
import { formatNumber } from "@cornfield/utils";
import { settings } from "../../config/settings";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { resolveImageOptions } from "../../tools/render-utils";
import { convertToPng } from "../../utils/image-convert";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	/** Tool images converted to PNG for the Kitty protocol, keyed by `${toolCallId}#${index}`. */
	#convertedToolImages = new Map<string, { data: string; mimeType: string }>();
	/** Keys of tool images whose async PNG conversion is in flight. */
	#pendingToolImageConversions = new Set<string>();
	#usageInfo?: Usage;

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
	) {
		super();

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
		}
		// Images for this tool call were replaced — drop cached conversions so stale data is never rendered.
		this.#clearToolImageConversions(toolCallId);
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	#toolImageConversionKey(toolCallId: string, index: number): string {
		return `${toolCallId}#${index}`;
	}

	#clearToolImageConversions(toolCallId: string): void {
		const prefix = `${toolCallId}#`;
		for (const key of this.#convertedToolImages.keys()) {
			if (key.startsWith(prefix)) this.#convertedToolImages.delete(key);
		}
		for (const key of this.#pendingToolImageConversions) {
			if (key.startsWith(prefix)) this.#pendingToolImageConversions.delete(key);
		}
	}

	setUsageInfo(usage: Usage): void {
		this.#usageInfo = usage;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	/**
	 * Kick off async conversion of non-PNG tool images to PNG for the Kitty graphics
	 * protocol (which requires PNG). Completion re-renders the message so the image
	 * appears in place of the text placeholder shown while converting.
	 */
	#kickOffToolImageConversions(): void {
		if (!TERMINAL.imageProtocol || TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const [toolCallId, images] of this.#toolImagesByCallId) {
			for (let i = 0; i < images.length; i++) {
				const image = images[i];
				const key = this.#toolImageConversionKey(toolCallId, i);
				if (image.mimeType === "image/png" || !image.data) continue;
				if (this.#convertedToolImages.has(key) || this.#pendingToolImageConversions.has(key)) continue;
				this.#pendingToolImageConversions.add(key);
				const originalData = image.data;
				void convertToPng(originalData, image.mimeType).then(converted => {
					this.#pendingToolImageConversions.delete(key);
					if (!converted) return;
					// Stale guard: the images for this tool call may have been replaced while converting.
					const current = this.#toolImagesByCallId.get(toolCallId)?.[i];
					if (!current || current.data !== originalData) return;
					this.#convertedToolImages.set(key, converted);
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage);
					}
				});
			}
		}
	}

	#renderToolImages(): void {
		if (this.#toolImagesByCallId.size === 0) return;

		this.#kickOffToolImageConversions();
		this.#contentContainer.addChild(new Spacer(1));
		for (const [toolCallId, images] of this.#toolImagesByCallId) {
			for (let i = 0; i < images.length; i++) {
				const image = images[i];
				const converted = this.#convertedToolImages.get(this.#toolImageConversionKey(toolCallId, i));
				const data = converted?.data ?? image.data;
				const mimeType = converted?.mimeType ?? image.mimeType;
				if (
					TERMINAL.imageProtocol &&
					(TERMINAL.imageProtocol !== ImageProtocol.Kitty || mimeType === "image/png")
				) {
					this.#contentContainer.addChild(
						new Image(
							data,
							mimeType,
							{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
							resolveImageOptions(),
						),
					);
					continue;
				}
				this.#contentContainer.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
			}
		}
	}

	updateContent(message: AssistantMessage): void {
		this.#lastMessage = message;

		// Clear content container
		this.#contentContainer.clear();

		const hasVisibleContent = message.content.some(
			c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.#contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Defensive strip: the streaming parser in pi-ai normally moves
				// reasoning blocks into a separate `thinking` content block. If
				// a tag ever leaks through (unknown namespace, parser edge case),
				// scrub it here so the user never sees a raw `<think>` literal.
				// Code regions are preserved by the stripper.
				const cleanedText = stripReasoningTagsFromText(content.text);
				this.#contentContainer.addChild(new Markdown(cleanedText.trim(), 1, 0, getMarkdownTheme()));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					this.#contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0));
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					this.#contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, getMarkdownTheme(), {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		this.#renderToolImages();
		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.#contentContainer.addChild(new Spacer(1));
				} else {
					this.#contentContainer.addChild(new Spacer(1));
				}
				this.#contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
		if (message.errorMessage && message.stopReason !== "aborted" && message.stopReason !== "error") {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${message.errorMessage}`), 1, 0));
		}

		// Token usage metadata
		if (settings.get("display.showTokenUsage") && this.#usageInfo) {
			const usage = this.#usageInfo;
			const totalInput = usage.input + usage.cacheWrite;
			const parts: string[] = [];
			parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
			parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
			if (usage.cacheRead > 0) {
				parts.push(`cache: ${formatNumber(usage.cacheRead)}`);
			}
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", parts.join("  ")), 1, 0));
		}
	}
}
