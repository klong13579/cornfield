/**
 * Regression: Container.clear() dispose-before-drop stops Loader timers.
 * BashExecutionComponent.#updateDisplay clears then re-adds the same loader
 * while status === "running" — must call start() again or the spinner freezes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { BashExecutionComponent } from "@cornfield/coding-agent/modes/components/bash-execution";
import { PythonExecutionComponent } from "@cornfield/coding-agent/modes/components/python-execution";
import { getThemeByName, setThemeInstance } from "@cornfield/coding-agent/modes/theme/theme";
import type { TUI } from "@cornfield/tui";

describe("bash/python loader survives clear-then-readd rebuild", () => {
	let renderSpy: ReturnType<typeof vi.fn>;
	let ui: TUI;

	beforeEach(async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
		renderSpy = vi.fn();
		ui = { requestRender: () => renderSpy() } as unknown as TUI;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("BashExecutionComponent keeps spinner after output rebuild while running", async () => {
		const component = new BashExecutionComponent("echo hello", ui, false);
		component.appendOutput("hello\n");
		// render() flushes #displayDirty → #updateDisplay → clear → re-add loader
		component.render(80);

		renderSpy.mockClear();
		await Bun.sleep(200);

		expect(renderSpy.mock.calls.length).toBeGreaterThan(0);
		component.dispose();
	});

	it("PythonExecutionComponent keeps spinner after output rebuild while running", async () => {
		const component = new PythonExecutionComponent("print(1)", ui, false);
		component.appendOutput("1\n");
		component.render(80);

		renderSpy.mockClear();
		await Bun.sleep(200);

		expect(renderSpy.mock.calls.length).toBeGreaterThan(0);
		component.dispose();
	});
});
