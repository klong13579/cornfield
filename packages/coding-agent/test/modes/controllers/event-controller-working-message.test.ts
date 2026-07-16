import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const WAITING_MESSAGE = "Thinking… (esc to interrupt)";

function createAssistantMessage(
	content: AssistantMessage["content"] = [],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createMockToolComponent() {
	return { updateResult: vi.fn(), updateArgs: vi.fn() };
}

function createContext() {
	const setWorkingMessage = vi.fn();
	const pendingTools = new Map<string, ReturnType<typeof createMockToolComponent>>();
	const ctx = {
		isInitialized: true,
		hideThinkingBlock: false,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn() },
		chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
		setWorkingMessage,
		pendingTools,
		streamingComponent: { updateContent: vi.fn() },
		streamingMessage: undefined,
		session: { getToolByName: vi.fn() },
	} as unknown as InteractiveModeContext;
	return { ctx, setWorkingMessage, pendingTools };
}

function createToolEndEvent(toolCallId: string, toolName = "bash") {
	return {
		type: "tool_execution_end" as const,
		toolCallId,
		toolName,
		isError: false,
		result: { content: [{ type: "text" as const, text: "ok" }] },
	};
}

describe("EventController working message", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		_resetSettingsForTest();
	});

	it("shows Thinking while waiting for the model after the last foreground tool finishes", async () => {
		const { ctx, setWorkingMessage, pendingTools } = createContext();
		const controller = new EventController(ctx);
		pendingTools.set("call-a", createMockToolComponent());

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-a",
			toolName: "bash",
			args: { command: "echo a" },
			intent: "Running echo a",
		});
		setWorkingMessage.mockClear();

		await controller.handleEvent(createToolEndEvent("call-a"));

		expect(setWorkingMessage).toHaveBeenCalledWith(WAITING_MESSAGE);
	});

	it("keeps the tool intent while another foreground tool is still pending", async () => {
		const { ctx, setWorkingMessage, pendingTools } = createContext();
		const controller = new EventController(ctx);
		pendingTools.set("call-a", createMockToolComponent());
		pendingTools.set("call-b", createMockToolComponent());

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-a",
			toolName: "bash",
			args: { command: "echo a" },
			intent: "Running echo a",
		});
		setWorkingMessage.mockClear();

		await controller.handleEvent(createToolEndEvent("call-a"));

		expect(setWorkingMessage).not.toHaveBeenCalled();
	});

	it("resets to Thinking when a new assistant message starts streaming", async () => {
		const { ctx, setWorkingMessage, pendingTools } = createContext();
		const controller = new EventController(ctx);
		pendingTools.set("call-a", createMockToolComponent());

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-a",
			toolName: "bash",
			args: { command: "echo a" },
			intent: "Running echo a",
		});
		setWorkingMessage.mockClear();

		await controller.handleEvent({ type: "message_start", message: createAssistantMessage() });

		expect(setWorkingMessage).toHaveBeenCalledWith(WAITING_MESSAGE);
	});

	it("ignores non-string streamed _i intent without throwing", async () => {
		const { ctx, setWorkingMessage, pendingTools } = createContext();
		const controller = new EventController(ctx);
		pendingTools.set("call-a", createMockToolComponent());

		const message = createAssistantMessage([
			{
				type: "toolCall",
				id: "call-a",
				name: "bash",
				arguments: { command: "echo a", [INTENT_FIELD]: { nested: "bad" } },
			},
		]);

		await expect(
			controller.handleEvent({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" } as never,
			}),
		).resolves.toBeUndefined();

		expect(setWorkingMessage).not.toHaveBeenCalled();
	});

	it("updates working message from a string streamed _i intent", async () => {
		const { ctx, setWorkingMessage, pendingTools } = createContext();
		const controller = new EventController(ctx);
		pendingTools.set("call-a", createMockToolComponent());

		const message = createAssistantMessage([
			{
				type: "toolCall",
				id: "call-a",
				name: "bash",
				arguments: { command: "echo a", [INTENT_FIELD]: "  Running echo a  " },
			},
		]);

		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" } as never,
		});

		expect(setWorkingMessage).toHaveBeenCalledWith("Running echo a (esc to interrupt)");
	});

	it("ignores non-string tool_execution_start intent without throwing", async () => {
		const { ctx, setWorkingMessage, pendingTools } = createContext();
		const controller = new EventController(ctx);
		pendingTools.set("call-a", createMockToolComponent());

		await expect(
			controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: "call-a",
				toolName: "bash",
				args: { command: "echo a" },
				intent: { nested: "bad" } as unknown as string,
			}),
		).resolves.toBeUndefined();

		expect(setWorkingMessage).not.toHaveBeenCalled();
	});
});
