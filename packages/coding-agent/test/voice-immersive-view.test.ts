/**
 * VoiceImmersiveView — layout B contracts: HUD, orb/task mode switching,
 * activity feed, transcript window, plain fallback, geometry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type VoiceImmersiveState,
	VoiceImmersiveView,
} from "@cornfield/coding-agent/modes/components/voice-immersive-view";
import { getThemeByName, type Theme } from "@cornfield/coding-agent/modes/theme/theme";
import { type TUI, visibleWidth } from "@cornfield/tui";

const WIDTH = 112;
const ROWS = 44;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function state(partial: Partial<VoiceImmersiveState> & { phase: VoiceImmersiveState["phase"] }): VoiceImmersiveState {
	return { inputLevel: 0, outputLevel: 0, ...partial };
}

describe("VoiceImmersiveView", () => {
	let theme: Theme;
	let renderSpy: ReturnType<typeof vi.fn>;
	let ui: TUI;
	let view: VoiceImmersiveView | undefined;

	beforeEach(async () => {
		const loaded = await getThemeByName("dark");
		expect(loaded).toBeDefined();
		theme = loaded as Theme;
		renderSpy = vi.fn();
		ui = {
			requestRender: () => renderSpy(),
			terminal: { rows: ROWS, columns: WIDTH },
		} as unknown as TUI;
	});

	afterEach(() => {
		view?.dispose();
		view = undefined;
	});

	function createView(options?: { plain?: boolean }): VoiceImmersiveView {
		view = new VoiceImmersiveView({ tui: ui, theme, plain: options?.plain ?? false });
		return view;
	}

	function render(v: VoiceImmersiveView, width = WIDTH): string {
		return v.render(width).join("\n");
	}

	describe("HUD", () => {
		it("shows IN / OUT levels and LIVE status on the top line", () => {
			const v = createView();
			v.update(state({ phase: "listening", inputLevel: 0.5 }));
			const lines = v.render(WIDTH);
			const hud = lines[0]!;
			expect(hud).toContain("IN");
			expect(hud).toContain("OUT");
			expect(hud).toContain("● LIVE");
			expect(hud).toContain("50%");
		});

		it("shows RECONNECT when the channel dropped", () => {
			const v = createView();
			v.update(state({ phase: "connecting", reconnecting: true }));
			expect(render(v)).toContain("RECONNECT");
		});

		it("shows ERROR status in the error phase", () => {
			const v = createView();
			v.update(state({ phase: "error", error: "provider down" }));
			const out = render(v);
			expect(out).toContain("ERROR");
			expect(out).toContain("provider down");
		});
	});

	describe("orb mode (conversation)", () => {
		it("shows the phase status under the orb", () => {
			const v = createView();
			v.update(state({ phase: "listening" }));
			expect(render(v)).toContain("● 聆听中");
		});

		it("renders orb frames with truecolor output", () => {
			const v = createView();
			v.update(state({ phase: "listening" }));
			expect(render(v)).toContain("\x1b[38;2;");
		});

		it("shows the interrupt hint at the bottom", () => {
			const v = createView();
			v.update(state({ phase: "listening" }));
			expect(render(v)).toContain("说话可随时打断");
		});

		it("renders transcripts with role prefixes and partial cursor", () => {
			const v = createView();
			v.update(state({ phase: "listening", transcript: { role: "user", text: "帮我跑一下测试", final: true } }));
			v.update(state({ phase: "speaking", transcript: { role: "assistant", text: "好, 马上跑", final: false } }));
			const out = render(v);
			expect(out).toContain("帮我跑一下测试");
			expect(out).toContain("好, 马上跑");
			expect(out).toContain("▌");
		});
	});

	describe("task mode (activity feed)", () => {
		it("switches to task mode when a task starts", () => {
			const v = createView();
			v.update(state({ phase: "thinking", consultTask: "跑一下 voice-panel 测试" }));
			const out = render(v);
			expect(out).toContain("执行任务中");
			expect(out).toContain("任务");
			expect(out).toContain("跑一下 voice-panel 测试");
		});

		it("shows the current tool line and rolls finished ones into history", () => {
			const v = createView();
			v.update(state({ phase: "listening", consultTask: "跑测试" }));
			v.update(state({ phase: "listening", toolLine: "bash: bun test" }));
			v.update(state({ phase: "listening", toolLine: "read: voice-panel.ts" }));
			const out = render(v);
			// current line marked running, previous rolled into history
			expect(out).toContain("▸ read: voice-panel.ts");
			expect(out).toContain("✓ bash: bun test");
		});

		it("counts tool calls and elapsed time in the summary", () => {
			const v = createView();
			v.update(state({ phase: "listening", consultTask: "跑测试" }));
			v.update(state({ phase: "listening", toolLine: "bash: bun test" }));
			const out = render(v);
			expect(out).toMatch(/1 个工具调用 · 已用 \d+s/);
		});

		it("task mode hint offers spoken progress/cancel controls", () => {
			const v = createView();
			v.update(state({ phase: "listening", consultTask: "跑测试" }));
			expect(render(v)).toContain('说"进度"查状态');
		});

		it("returns to orb mode when the task clears", () => {
			const v = createView();
			v.update(state({ phase: "listening", consultTask: "跑测试", toolLine: "bash: bun test" }));
			v.update(state({ phase: "listening", consultTask: "", toolLine: "" }));
			const out = render(v);
			expect(out).not.toContain("执行任务中");
			expect(out).toContain("● 聆听中");
		});
	});

	describe("degradation", () => {
		it("plain mode renders text-only without orb truecolor", () => {
			const v = createView({ plain: true });
			v.update(state({ phase: "listening", transcript: { role: "user", text: "你好", final: true } }));
			const out = render(v);
			expect(out).toContain("● 聆听中");
			expect(out).toContain("你好");
			expect(out).not.toContain("\x1b[38;2;");
		});

		it("clamps to the minimum height on short terminals", () => {
			(ui.terminal as { rows: number }).rows = 12;
			const v = createView();
			v.update(state({ phase: "listening" }));
			const lines = v.render(WIDTH);
			expect(lines.length).toBeGreaterThanOrEqual(22);
		});
	});

	describe("animation scheduling", () => {
		it("requests renders while animating and settles when static", async () => {
			const v = createView();
			v.update(state({ phase: "listening", inputLevel: 0.6 }));
			renderSpy.mockClear();
			await sleep(180);
			const animated = renderSpy.mock.calls.length;
			expect(animated).toBeGreaterThan(0);

			v.update(state({ phase: "error", error: "x" }));
			renderSpy.mockClear();
			await sleep(180);
			// error phase has no tick timer: only the update itself rendered
			expect(renderSpy.mock.calls.length).toBeLessThanOrEqual(1);
		});

		it("exit keys trigger onExit", () => {
			let exited = false;
			view = new VoiceImmersiveView({
				tui: ui,
				theme,
				callbacks: { onExit: () => (exited = true) },
				exitKeys: ["alt+v" as never],
			});
			const v = view;
			v.update(state({ phase: "listening" }));
			// alt+v escape sequence
			v.handleInput("\x1bv");
			expect(exited).toBe(true);
		});
	});

	describe("geometry", () => {
		it("never exceeds the render width", () => {
			const v = createView();
			v.update(
				state({
					phase: "listening",
					consultTask: "一个非常长的任务标题".repeat(8),
					toolLine: `bash: ${"x".repeat(200)}`,
					transcript: { role: "user", text: "很长的消息".repeat(30), final: true },
				}),
			);
			for (const line of v.render(80)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			}
		});
	});
});
