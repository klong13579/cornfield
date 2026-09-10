import { describe, expect, test, vi } from "bun:test";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@cornfield/coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@cornfield/coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@cornfield/coding-agent/modes/types";
import type { CustomMessage } from "@cornfield/coding-agent/session/messages";

function createHarness(options: { isStreaming?: boolean; isBackgrounded?: boolean } = {}) {
	let lastCreated: CustomMessage<unknown> | undefined;
	// Mirrors AgentSession.sendCustomMessage: the created message inherits customType,
	// content and display from the caller and mints its own timestamp.
	const sendCustomMessage = vi.fn(
		async (input: {
			customType: string;
			content: unknown;
			display: boolean;
			details?: unknown;
			attribution?: string;
		}) => {
			lastCreated = {
				role: "custom",
				customType: input.customType,
				content: input.content,
				display: input.display,
				details: input.details,
				attribution: input.attribution ?? "agent",
				timestamp: 1789042000000,
			} as CustomMessage<unknown>;
			return lastCreated;
		},
	);
	const renderCustomMessageOnce = vi.fn(() => true);
	const rebuildChatFromMessages = vi.fn();
	let capturedActions: ExtensionActions | undefined;
	const ctx = {
		isBackgrounded: options.isBackgrounded ?? false,
		renderCustomMessageOnce,
		rebuildChatFromMessages,
		chatContainer: { clear: vi.fn() },
		ui: { requestRender: vi.fn() },
		editor: { setText: vi.fn(), getText: () => "", handleInput: vi.fn(), onEscape: undefined },
		setToolUIContext: vi.fn(),
		session: {
			isStreaming: options.isStreaming ?? false,
			sendCustomMessage,
			extensionRunner: {
				initialize: (
					actions: ExtensionActions,
					_contextActions: ExtensionContextActions,
					_commandActions: ExtensionCommandContextActions,
					_uiContext: ExtensionUIContext,
				) => {
					capturedActions = actions;
				},
				onError: vi.fn(),
			},
		},
	} satisfies Record<string, unknown> as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);
	controller.initializeHookRunner({} as ExtensionUIContext, false);

	return {
		getCreated: () => {
			if (!lastCreated) throw new Error("sendCustomMessage was not called");
			return lastCreated;
		},
		sendCustomMessage,
		renderCustomMessageOnce,
		rebuildChatFromMessages,
		getActions: () => {
			if (!capturedActions) throw new Error("initializeHookRunner did not capture actions");
			return capturedActions;
		},
	};
}

describe("ExtensionUiController inbound custom message display", () => {
	test("appends the message incrementally instead of rebuilding the chat", async () => {
		const h = createHarness();
		const input = { customType: "intercom_message", content: "heartbeat", display: true, details: {} };

		h.getActions().sendMessage(input, { triggerTurn: true });
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(h.sendCustomMessage).toHaveBeenCalledWith(input, { triggerTurn: true });
		expect(h.renderCustomMessageOnce).toHaveBeenCalledTimes(1);
		expect(h.renderCustomMessageOnce).toHaveBeenCalledWith(h.getCreated());
		// The regressed behavior: a full chat rebuild re-converts every session entry,
		// resets the viewport and re-appends the compaction summary at the bottom.
		expect(h.rebuildChatFromMessages).not.toHaveBeenCalled();
	});

	test("does not render messages with display: false", async () => {
		const h = createHarness();
		const input = { customType: "intercom_message", content: "hidden", display: false, details: {} };

		h.getActions().sendMessage(input, {});
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(h.renderCustomMessageOnce).not.toHaveBeenCalled();
		expect(h.rebuildChatFromMessages).not.toHaveBeenCalled();
	});

	test("does not render while streaming (message events own the display)", async () => {
		const h = createHarness({ isStreaming: true });
		const input = { customType: "intercom_message", content: "heartbeat", display: true, details: {} };

		h.getActions().sendMessage(input, { triggerTurn: true });
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(h.renderCustomMessageOnce).not.toHaveBeenCalled();
		expect(h.rebuildChatFromMessages).not.toHaveBeenCalled();
	});

	test("does not render when the TUI is backgrounded", async () => {
		const h = createHarness({ isBackgrounded: true });
		const input = { customType: "intercom_message", content: "heartbeat", display: true, details: {} };

		h.getActions().sendMessage(input, {});
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(h.renderCustomMessageOnce).not.toHaveBeenCalled();
		expect(h.rebuildChatFromMessages).not.toHaveBeenCalled();
	});
});
