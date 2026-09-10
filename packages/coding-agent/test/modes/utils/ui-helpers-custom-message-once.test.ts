import { beforeAll, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@cornfield/agent";
import { initTheme } from "@cornfield/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@cornfield/coding-agent/modes/types";
import { UiHelpers } from "@cornfield/coding-agent/modes/utils/ui-helpers";
import type { CustomMessage } from "@cornfield/coding-agent/session/messages";
import { Container } from "@cornfield/tui";

function createCustomMessage(timestamp: number, customType = "intercom_message"): CustomMessage<unknown> {
	return {
		role: "custom",
		customType,
		content: "**From subagent-chat-01a08a2e-b71c-7000**\n\nSubagent completed its task round.",
		display: true,
		details: {},
		attribution: "agent",
		timestamp,
	};
}

function createHarness() {
	const addMessageToChat = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		chatContainer: new Container(),
		addMessageToChat,
		ui: { requestRender },
		session: { extensionRunner: undefined },
	} as unknown as InteractiveModeContext;
	return { helpers: new UiHelpers(ctx), addMessageToChat, requestRender };
}

describe("UiHelpers.renderCustomMessageOnce", () => {
	beforeAll(() => {
		// CustomMessageComponent renders through the global theme instance.
		initTheme();
	});

	test("renders an inbound custom message once", () => {
		const { helpers, addMessageToChat, requestRender } = createHarness();
		const message = createCustomMessage(1789042000000);

		expect(helpers.renderCustomMessageOnce(message)).toBe(true);
		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	test("skips a message that already streamed through message_start", () => {
		// Triggered sends (heartbeat intercom) are delivered through the agent loop, which
		// emits message_start for them. The sender then also asks for a display update —
		// that second request must not render the same message again.
		const { helpers, addMessageToChat, requestRender } = createHarness();
		const message = createCustomMessage(1789042000000);

		expect(helpers.renderCustomMessageOnce(message)).toBe(true);
		expect(helpers.renderCustomMessageOnce(message)).toBe(false);
		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	test("renders a later message that reuses the same text but a new timestamp", () => {
		const { helpers, addMessageToChat } = createHarness();

		expect(helpers.renderCustomMessageOnce(createCustomMessage(1789042000000))).toBe(true);
		expect(helpers.renderCustomMessageOnce(createCustomMessage(1789042001000))).toBe(true);
		expect(addMessageToChat).toHaveBeenCalledTimes(2);
	});

	test("distinguishes custom types that share a timestamp", () => {
		const { helpers, addMessageToChat } = createHarness();

		expect(helpers.renderCustomMessageOnce(createCustomMessage(1789042000000, "intercom_message"))).toBe(true);
		expect(helpers.renderCustomMessageOnce(createCustomMessage(1789042000000, "irc:incoming"))).toBe(true);
		expect(addMessageToChat).toHaveBeenCalledTimes(2);
	});

	test("ignores messages that do not carry a custom role", () => {
		const { helpers, addMessageToChat } = createHarness();
		const user = { role: "user", content: "hi", timestamp: 1 } as unknown as AgentMessage;

		expect(helpers.renderCustomMessageOnce(user)).toBe(false);
		expect(addMessageToChat).not.toHaveBeenCalled();
	});
});
