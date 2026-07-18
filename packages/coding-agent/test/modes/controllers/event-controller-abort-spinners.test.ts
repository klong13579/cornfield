/**
 * Regression test for the memory leak caused by orphaned spinner intervals
 * after an agent abort.
 *
 * Root cause: when the agent is aborted, the event controller cleaned up
 * pendingTools by deleting them from the Map but never called dispose()/
 * stopAnimation() on the components. Each ToolExecutionComponent and
 * BashExecutionComponent has a Loader or spinner with an 80ms setInterval
 * that calls requestRender(). After abort, these intervals run forever,
 * continuously allocating strings in the JSC heap and leaking file
 * descriptors via the logger transport's rotation.
 *
 * This test reproduces the scenario:
 *   1. Create real TUI + real components with real spinners
 *   2. Populate pendingTools, pendingBashComponents, pendingPythonComponents,
 *      and active bashComponent/pythonComponent
 *   3. Fire agent_end (simulating abort)
 *   4. Assert that all intervals are cleared (no active timers remain)
 *
 * The key assertion is timer-based: after agent_end, waiting 200ms should
 * NOT produce any additional requestRender calls. If spinners are still
 * running, we'd see 2+ renders in that window (at 80ms intervals).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui";
import { TUI, Container } from "@oh-my-pi/pi-tui";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BashExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/bash-execution";
import { PythonExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/python-execution";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/** Minimal Terminal implementation for testing — no real stdin/stdout. */
class MockTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	appearance: TerminalAppearance | undefined = undefined;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}
	async drainInput(): Promise<void> {}
	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}
	write(_data: string): void {}
	onAppearanceChange(_cb: (appearance: TerminalAppearance) => void): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
}

function createAssistantMessage(stopReason: AssistantMessage["stopReason"] = "aborted"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createContext(ui: TUI): InteractiveModeContext {
	return {
		isInitialized: true,
		hideThinkingBlock: false,
		ui,
		chatContainer: new Container(),
		pendingMessagesContainer: new Container(),
		statusContainer: new Container(),
		todoContainer: new Container(),
		btwContainer: new Container(),
		editor: { onEscape: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		requestRender: () => ui.requestRender(),
		ensureLoadingAnimation: vi.fn(),
		setWorkingMessage: vi.fn(),
		applyPendingWorkingMessage: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		flushPendingModelSwitch: vi.fn().mockResolvedValue(undefined),
		sendCompletionNotification: vi.fn(),
		pendingTools: new Map(),
		pendingBashComponents: [] as BashExecutionComponent[],
		pendingPythonComponents: [] as PythonExecutionComponent[],
		bashComponent: undefined as BashExecutionComponent | undefined,
		pythonComponent: undefined as PythonExecutionComponent | undefined,
		isPythonMode: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		session: {
			subscribe: vi.fn(),
			abort: vi.fn(),
			isStreaming: false,
			isTtsrAbortPending: false,
			retryAttempt: 0,
			isCompacting: false,
			queuedMessageCount: 0,
			getToolByName: vi.fn(),
		},
		sessionManager: {
			titleSource: "auto",
			getSessionName: vi.fn().mockReturnValue("test"),
		},
		isBackgrounded: undefined,
		settings: { get: vi.fn().mockReturnValue(false) },
		toolOutputExpanded: false,
	} as unknown as InteractiveModeContext;
}

describe("EventController abort spinner cleanup", () => {
	let term: MockTerminal;
	let ui: TUI;
	let renderSpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		term = new MockTerminal();
		ui = new TUI(term);
		renderSpy = vi.fn();
		const origRequestRender = ui.requestRender.bind(ui);
		ui.requestRender = ((force?: boolean) => {
			renderSpy();
			origRequestRender(force);
		}) as typeof ui.requestRender;
	});

	afterEach(() => {
		ui.stop();
		vi.restoreAllMocks();
		_resetSettingsForTest();
	});

	it("stops all ToolExecutionComponent spinners on agent_end after abort", async () => {
		const ctx = createContext(ui);
		const controller = new EventController(ctx);

		const tool1 = new ToolExecutionComponent("task", {}, {}, undefined, ui, "/tmp", "call-1");
		const tool2 = new ToolExecutionComponent("edit", {}, {}, undefined, ui, "/tmp", "call-2");
		ctx.pendingTools.set("call-1", tool1);
		ctx.pendingTools.set("call-2", tool2);

		await controller.handleEvent({ type: "agent_end" });

		// After agent_end, wait 200ms — if spinners are still running,
		// we'd see 2+ requestRender calls (80ms interval).
		renderSpy.mockClear();
		await Bun.sleep(200);

		expect(renderSpy.mock.calls.length).toBe(0);
	});

	it("stops BashExecutionComponent and PythonExecutionComponent spinners on agent_end", async () => {
		const ctx = createContext(ui);
		const controller = new EventController(ctx);

		const bash1 = new BashExecutionComponent("echo hello", ui, false);
		const bash2 = new BashExecutionComponent("ls -la", ui, false);
		const python1 = new PythonExecutionComponent("print('hi')", ui, false);

		ctx.pendingBashComponents.push(bash1, bash2);
		ctx.pendingPythonComponents.push(python1);

		ctx.bashComponent = new BashExecutionComponent("active cmd", ui, false);
		ctx.pythonComponent = new PythonExecutionComponent("x = 1", ui, false);

		await controller.handleEvent({ type: "agent_end" });

		renderSpy.mockClear();
		await Bun.sleep(200);

		expect(renderSpy.mock.calls.length).toBe(0);
		expect(ctx.pendingBashComponents.length).toBe(0);
		expect(ctx.pendingPythonComponents.length).toBe(0);
	});

	it("disposes pending tools on message_end with aborted stopReason", async () => {
		const ctx = createContext(ui);
		const controller = new EventController(ctx);

		const tool1 = new ToolExecutionComponent("task", {}, {}, undefined, ui, "/tmp", "call-1");
		ctx.pendingTools.set("call-1", tool1);

		ctx.streamingComponent = {
			updateContent: vi.fn(),
			setUsageInfo: vi.fn(),
		} as any;
		ctx.session.isTtsrAbortPending = false;

		await controller.handleEvent({
			type: "message_end",
			message: createAssistantMessage("aborted"),
		});

		renderSpy.mockClear();
		await Bun.sleep(200);

		expect(renderSpy.mock.calls.length).toBe(0);
	});

	it("disposes pending tools on message_end with length stopReason", async () => {
		const ctx = createContext(ui);
		const controller = new EventController(ctx);

		const tool1 = new ToolExecutionComponent("task", {}, {}, undefined, ui, "/tmp", "call-1");
		ctx.pendingTools.set("call-1", tool1);

		ctx.streamingComponent = {
			updateContent: vi.fn(),
			setUsageInfo: vi.fn(),
		} as any;
		ctx.session.isTtsrAbortPending = false;

		await controller.handleEvent({
			type: "message_end",
			message: createAssistantMessage("length"),
		});

		// After length finalize, wait 200ms — if spinners are still running,
		// we'd see 2+ requestRender calls (80ms interval).
		renderSpy.mockClear();
		await Bun.sleep(200);

		expect(renderSpy.mock.calls.length).toBe(0);
	});

	it("does NOT dispose tools on message_end with normal stopReason", async () => {
		const ctx = createContext(ui);
		const controller = new EventController(ctx);

		const tool1 = new ToolExecutionComponent("task", {}, {}, undefined, ui, "/tmp", "call-1");
		ctx.pendingTools.set("call-1", tool1);

		ctx.streamingComponent = {
			updateContent: vi.fn(),
			setUsageInfo: vi.fn(),
		} as any;

		await controller.handleEvent({
			type: "message_end",
			message: createAssistantMessage("toolUse"),
		});

		// Tools should NOT be disposed — they're still active.
		expect(ctx.pendingTools.has("call-1")).toBe(true);
	});
});
