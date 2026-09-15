/**
 * Shared render assertions for TUI renderer tests.
 *
 * A renderer's output only means something once its inputs are pinned: the theme
 * it styles with, the width it was asked to fit, and the exact result it renders.
 * This helper pins the theme and the width, and hands every assertion the same
 * stripped text — so an expectation reads as bytes instead of "looks about right".
 *
 * Three rules make an expectation trustworthy:
 *
 * 1. **Assert on stripped text.** Raw output carries escape sequences whose bytes
 *    depend on the terminal's color capability (`COLORTERM` / `TERM` feed
 *    `detectColorMode()`), so an unstripped expectation differs between a
 *    developer's terminal and CI while the visible text is identical.
 *    `sanitizeText` also drops control characters and normalizes CR — the same
 *    normalization the TUI render paths apply.
 * 2. **Rebuild, do not re-render, to prove stability.** `expectStable()` calls the
 *    factory twice, so output that depends on the clock, on map iteration order,
 *    or on state a previous render left behind fails instead of passing twice for
 *    the wrong reason.
 * 3. **Width is part of the input.** A renderer asked for 80 columns must not
 *    return a line wider than 80. `expectWithinWidth()` is the opt-in check for
 *    the constraint documented in `docs/tui/tui.md`.
 *
 * Theme injection installs the loaded theme as the process-global instance
 * (`setThemeInstance`), because renderers reach past their `theme` argument:
 * `getMarkdownTheme()`, `Text`, and the components that import `theme` directly
 * all read the global. That is the wiring `InteractiveMode` performs at boot, and
 * the `getThemeByName` + `setThemeInstance` pair component tests already write out
 * by hand.
 */
import { expect } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@cornfield/coding-agent/modes/theme/theme";
import { sanitizeText } from "@cornfield/natives";
import { type Component, visibleWidth } from "@cornfield/tui";

/** Width a surface renders at unless the test asks for another one. */
export const RENDER_WIDTH = 80;

/**
 * Built-in themes a renderer test may pick. `dark` is the default; `light` exists
 * so a test can prove its expectations do not encode dark-theme colors or symbols.
 */
export type TestThemeName = "dark" | "light";

export interface RenderSurfaceOptions {
	theme?: TestThemeName;
	width?: number;
}

export interface RenderSurface {
	/** Theme loaded and installed for this surface — pass it to `renderCall` / `renderResult`. */
	readonly theme: Theme;
	/** Width every method below renders at. */
	readonly width: number;
	/** Lines exactly as the component returned them, ANSI intact. */
	lines(component: Component): string[];
	/** Rendered text with ANSI and control characters stripped — compare against this. */
	text(component: Component): string;
	/**
	 * Render the same input twice and require byte-identical output.
	 *
	 * `factory` must build a fresh component per call: re-rendering one instance
	 * only proves the component is not stateful across `render()`, not that the
	 * input maps to a stable string.
	 *
	 * @returns the stripped text of the first render.
	 */
	expectStable(factory: () => Component): string;
	/**
	 * Assert every rendered line fits `width` visible columns.
	 *
	 * @returns the stripped text, so a test can assert on content without
	 * rendering a second time.
	 */
	expectWithinWidth(component: Component): string;
}

const themeCache = new Map<TestThemeName, Theme>();

/**
 * Load a built-in theme and install it as the process-global theme instance.
 *
 * Cached per name: `Theme` instances are immutable, so the second caller in a
 * process gets the same object instead of re-reading the theme JSON.
 */
export async function getTestTheme(name: TestThemeName = "dark"): Promise<Theme> {
	let theme = themeCache.get(name);
	if (!theme) {
		const loaded = await getThemeByName(name);
		if (!loaded) throw new Error(`Built-in theme "${name}" is not loadable`);
		theme = loaded;
		themeCache.set(name, theme);
	}
	setThemeInstance(theme);
	return theme;
}

/**
 * Build a render surface: a theme installed globally, a width, and the
 * render/strip/assert helpers bound to both.
 */
export async function createRenderSurface(options: RenderSurfaceOptions = {}): Promise<RenderSurface> {
	const theme = await getTestTheme(options.theme ?? "dark");
	const width = options.width ?? RENDER_WIDTH;

	const lines = (component: Component): string[] => component.render(width);
	const text = (component: Component): string => sanitizeText(lines(component).join("\n"));

	return {
		theme,
		width,
		lines,
		text,
		expectStable(factory: () => Component): string {
			const first = lines(factory());
			const second = lines(factory());
			// Both comparisons: a renderer that varies only in styling still fails,
			// because "same input, same width" is a claim about bytes.
			expect(second).toEqual(first);
			const firstText = sanitizeText(first.join("\n"));
			expect(sanitizeText(second.join("\n"))).toBe(firstText);
			return firstText;
		},
		expectWithinWidth(component: Component): string {
			const rendered = lines(component);
			rendered.forEach((line, index) => {
				expect(
					visibleWidth(line),
					`line ${index + 1} of ${rendered.length} exceeds width ${width}`,
				).toBeLessThanOrEqual(width);
			});
			return sanitizeText(rendered.join("\n"));
		},
	};
}
