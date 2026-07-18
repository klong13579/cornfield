/**
 * Failing coverage for dispose-before-clear (design Part B).
 *
 * Container.clear() currently drops children without calling dispose()/stop(),
 * so Loader setInterval timers keep calling requestRender() after rebuild/handoff.
 * These tests encode the expected contract before Task 6 implements it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Loader } from "../src/components/loader";
import type { Terminal, TerminalAppearance } from "../src/terminal";
import type { Component } from "../src/tui";
import { Container, TUI } from "../src/tui";

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

describe("Container.dispose-before-clear", () => {
	let term: MockTerminal;
	let ui: TUI;
	let renderSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
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
	});

	it("calls child dispose() on clear()", () => {
		const dispose = vi.fn();
		const child: Component & { dispose(): void } = {
			render: () => [],
			invalidate: () => {},
			dispose,
		};
		const container = new Container();
		container.addChild(child);

		container.clear();

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(container.children.length).toBe(0);
	});

	it("stops Loader timers after clear (rebuildChatFromMessages path)", async () => {
		const loader = new Loader(ui, (s) => s, (s) => s, "working");
		const chatContainer = new Container();
		chatContainer.addChild(loader);

		// Same call site as InteractiveMode.rebuildChatFromMessages():
		// this.chatContainer.clear();
		chatContainer.clear();

		renderSpy.mockClear();
		await Bun.sleep(200);

		expect(renderSpy.mock.calls.length).toBe(0);
	});
});
