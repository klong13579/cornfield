import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@cornfield/ai";
import { _resetSettingsForTest, Settings } from "@cornfield/coding-agent/config/settings";
import { AssistantMessageComponent } from "@cornfield/coding-agent/modes/components/assistant-message";
import { initTheme } from "@cornfield/coding-agent/modes/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@cornfield/tui";
import * as imageConvert from "../../../src/utils/image-convert";

const originalImageProtocol = TERMINAL.imageProtocol;
const IMAGE_CONTENT_TYPE = "image";
// A real 1x1 PNG so the Image component can decode dimensions during render.
const VALID_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function renderWithToolImage(image: { data: string; mimeType: string }): {
	rendered: string;
	component: AssistantMessageComponent;
} {
	const component = new AssistantMessageComponent(createAssistantMessage());
	component.setToolResultImages("call-1", [{ type: IMAGE_CONTENT_TYPE, data: image.data, mimeType: image.mimeType }]);
	const rendered = component.render(120).join("\n");
	return { rendered, component };
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	_resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.restoreAllMocks();
	setTerminalImageProtocol(ImageProtocol.Kitty);
});

afterEach(() => {
	_resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	vi.restoreAllMocks();
});

describe("AssistantMessageComponent tool-result images", () => {
	it("converts non-PNG tool images to PNG under the Kitty protocol and renders them", async () => {
		const convertSpy = vi
			.spyOn(imageConvert, "convertToPng")
			.mockResolvedValue({ data: VALID_PNG, mimeType: "image/png" });

		const { component } = renderWithToolImage({ data: "not-real-webp-data", mimeType: "image/webp" });

		// Conversion is async — the first paint is the text placeholder.
		expect(component.render(120).join("\n")).toContain("[Image: image/webp]");
		expect(convertSpy).toHaveBeenCalledWith("not-real-webp-data", "image/webp");

		// After the conversion resolves, the message re-renders with a real PNG image.
		await Bun.sleep(0);
		const rendered = component.render(120).join("\n");
		expect(rendered).not.toContain("[Image: image/webp]");
		expect(rendered).toContain("\x1b_G");
	});

	it("shows the text placeholder when no image protocol is active", () => {
		setTerminalImageProtocol(null);
		const convertSpy = vi
			.spyOn(imageConvert, "convertToPng")
			.mockResolvedValue({ data: VALID_PNG, mimeType: "image/png" });

		const { rendered } = renderWithToolImage({ data: "not-real-webp-data", mimeType: "image/webp" });

		expect(rendered).toContain("[Image: image/webp]");
		expect(convertSpy).not.toHaveBeenCalled();
	});

	it("does not convert images that are already PNG under the Kitty protocol", async () => {
		const convertSpy = vi
			.spyOn(imageConvert, "convertToPng")
			.mockResolvedValue({ data: VALID_PNG, mimeType: "image/png" });

		const { component } = renderWithToolImage({ data: VALID_PNG, mimeType: "image/png" });

		await Bun.sleep(0);
		const rendered = component.render(120).join("\n");
		expect(convertSpy).not.toHaveBeenCalled();
		expect(rendered).toContain("\x1b_G");
		expect(rendered).not.toContain("[Image: image/png]");
	});

	it("keeps the text placeholder when PNG conversion fails", async () => {
		vi.spyOn(imageConvert, "convertToPng").mockResolvedValue(null);

		const { component } = renderWithToolImage({ data: "corrupt-data", mimeType: "image/webp" });

		await Bun.sleep(0);
		expect(component.render(120).join("\n")).toContain("[Image: image/webp]");
	});
});
