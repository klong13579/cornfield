/**
 * VoicePanel state → frame mapping, animation scheduling, and degradation tests.
 *
 * Uses the real component against a fake TUI that only counts requestRender
 * calls; frame content is asserted on the lines returned by render(width).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { VoicePanel, type VoicePanelState } from "@cornfield/coding-agent/modes/components/voice-panel";
import { getThemeByName, type Theme } from "@cornfield/coding-agent/modes/theme/theme";
import { type TUI, visibleWidth } from "@cornfield/tui";

const WIDTH = 60;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function state(partial: Partial<VoicePanelState> & { phase: VoicePanelState["phase"] }): VoicePanelState {
	return { inputLevel: 0, outputLevel: 0, ...partial };
}

describe("VoicePanel", () => {
	let theme: Theme;
	let renderSpy: ReturnType<typeof vi.fn>;
	let ui: TUI;
	let panel: VoicePanel | undefined;

	beforeEach(async () => {
		const loaded = await getThemeByName("dark");
		expect(loaded).toBeDefined();
		theme = loaded as Theme;
		renderSpy = vi.fn();
		ui = { requestRender: () => renderSpy() } as unknown as TUI;
	});

	afterEach(() => {
		panel?.dispose();
		panel = undefined;
	});

	function createPanel(options?: { plain?: boolean; interruptFlashMs?: number }): VoicePanel {
		panel = new VoicePanel({
			tui: ui,
			theme,
			plain: options?.plain ?? false,
			interruptFlashMs: options?.interruptFlashMs,
		});
		return panel;
	}

	function render(p: VoicePanel, width = WIDTH): string {
		return p.render(width).join("\n");
	}

	describe("state → frame content", () => {
		it("connecting shows spinner + connecting badge", () => {
			const p = createPanel();
			p.update(state({ phase: "connecting" }));
			const out = render(p);
			expect(out).toContain("jarvis");
			expect(out).toContain("连接中");
			expect(out).toContain("正在建立语音通道");
			// braille spinner glyph from the theme frames
			expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/);
		});

		it("listening shows level bar glyphs from mic RMS and status", () => {
			const p = createPanel();
			p.update(state({ phase: "listening", inputLevel: 0.9 }));
			const out = render(p);
			expect(out).toContain("● 聆听中");
			// high RMS must light up the upper glyphs of ▁▂▃▄▅▆▇█
			expect(out).toMatch(/[▆▇█]/);
		});

		it("listening shows low bar when mic is silent", () => {
			const p = createPanel();
			p.update(state({ phase: "listening", inputLevel: 0 }));
			const out = render(p);
			expect(out).toContain("● 聆听中");
			expect(out).toContain("▁");
			expect(out).not.toMatch(/[▅▆▇█]/);
		});

		it("listening renders partial transcript dim with cursor, final without", () => {
			const p = createPanel();
			p.update(
				state({
					phase: "listening",
					transcript: { role: "user", text: "帮我把明天上午的日程同步到钉钉", final: false },
				}),
			);
			let out = render(p);
			expect(out).toContain("帮我把明天上午的日程同步到钉钉");
			expect(out).toContain("▌");

			p.update(
				state({
					phase: "listening",
					transcript: { role: "user", text: "帮我把明天上午的日程同步到钉钉", final: true },
				}),
			);
			out = render(p);
			expect(out).toContain("帮我把明天上午的日程同步到钉钉");
			expect(out).not.toContain("▌");
		});

		it("thinking shows spinner plus consult and tool summary lines", () => {
			const p = createPanel();
			p.update(
				state({
					phase: "thinking",
					consultTask: "同步日程到钉钉",
					toolLine: "bash  curl -s api.dingtalk.com/…",
				}),
			);
			const out = render(p);
			expect(out).toContain("思考中");
			expect(out).toContain("▸ omp_agent_consult: 同步日程到钉钉");
			expect(out).toContain("▸ tool: bash curl -s api.dingtalk.com/…");
		});

		it("speaking shows waveform, elapsed badge, karaoke transcript and interrupt hint", () => {
			const p = createPanel();
			p.update(
				state({
					phase: "speaking",
					outputLevel: 0.9,
					transcript: { role: "assistant", text: "明天上午三个会：九点半供应商评审", final: false },
				}),
			);
			const out = render(p);
			expect(out).toContain("◉ 播报中 · 0:00");
			expect(out).toContain(")"); // radiating waveform follows output RMS
			expect(out).toContain("明天上午三个会：九点半供应商评审");
			expect(out).toContain("[ 说话可随时打断 ]");
		});

		it("interrupted shows shatter glyph and amber flash line", () => {
			const p = createPanel({ interruptFlashMs: 1000 });
			p.update(state({ phase: "speaking", outputLevel: 0.5 }));
			p.update(state({ phase: "interrupted" }));
			const out = render(p);
			expect(out).toContain("✕");
			expect(out).toContain("⚡ 已打断 · 聆听中…");
		});

		it("muted shows breathing jarvis badge and resume hint", () => {
			const p = createPanel();
			p.update(state({ phase: "muted" }));
			const out = render(p);
			expect(out).toContain("◉ jarvis");
			expect(out).toContain("Ctrl+M");
		});

		it("error shows reason and reconnect hint", () => {
			const p = createPanel();
			p.update(state({ phase: "error", error: "WSS 握手失败 403" }));
			const out = render(p);
			expect(out).toContain("✕ 语音通道异常：WSS 握手失败 403");
			expect(out).toContain("按 Ctrl+V 重连 / Esc 退出");
		});

		it("keeps every rendered line within the viewport width for all states", () => {
			const p = createPanel();
			const states: VoicePanelState[] = [
				state({ phase: "connecting" }),
				state({
					phase: "listening",
					inputLevel: 0.8,
					transcript: { role: "user", text: "一段很长很长的转写".repeat(20), final: false },
				}),
				state({ phase: "thinking", consultTask: "查一下待办", toolLine: "read TODO.md" }),
				state({
					phase: "speaking",
					outputLevel: 0.8,
					transcript: { role: "assistant", text: "播报内容".repeat(30), final: false },
				}),
				state({ phase: "interrupted" }),
				state({ phase: "muted" }),
				state({ phase: "error", error: "boom".repeat(50) }),
			];
			for (const s of states) {
				p.update(s);
				for (const w of [24, 40, WIDTH]) {
					for (const line of p.render(w)) {
						expect(visibleWidth(line)).toBeLessThanOrEqual(w);
					}
				}
			}
		});
	});

	describe("animation scheduling", () => {
		it("interrupted flash falls back to listening within the flash window", async () => {
			const p = createPanel({ interruptFlashMs: 40 });
			p.update(state({ phase: "speaking", outputLevel: 0.5 }));
			p.update(state({ phase: "interrupted" }));
			expect(render(p)).toContain("已打断");

			await sleep(120); // well under the 300ms spec budget
			const out = render(p);
			expect(out).not.toContain("已打断");
			expect(out).toContain("聆听中");
		});

		it("listening breathes continuously: redraws even without audio input", async () => {
			const p = createPanel();
			p.update(state({ phase: "listening", inputLevel: 0, outputLevel: 0 }));
			await sleep(150); // let any pending ticks fire
			renderSpy.mockClear();
			await sleep(250);
			expect(renderSpy).toHaveBeenCalled();
		});

		it("redraws while mic level decays after speech", async () => {
			const p = createPanel();
			p.update(state({ phase: "listening", inputLevel: 0.9 }));
			p.update(state({ phase: "listening", inputLevel: 0 }));
			renderSpy.mockClear();
			await sleep(180); // peak decays per tick → frames change
			expect(renderSpy).toHaveBeenCalled();
		});
		it("error is static: no timer-driven redraws", async () => {
			const p = createPanel();
			p.update(state({ phase: "error", error: "down" }));
			renderSpy.mockClear();
			await sleep(250);
			expect(renderSpy).not.toHaveBeenCalled();
		});

		it("dispose stops all timers", async () => {
			const p = createPanel();
			p.update(state({ phase: "thinking", consultTask: "x" }));
			p.dispose();
			renderSpy.mockClear();
			await sleep(250);
			expect(renderSpy).not.toHaveBeenCalled();
		});
	});

	describe("degradation and sanitization", () => {
		it("plain mode renders no ANSI escapes but keeps status word and spinner", () => {
			const p = createPanel({ plain: true });
			p.update(state({ phase: "listening", inputLevel: 0.5 }));
			const out = render(p);
			expect(out).not.toContain("\x1b");
			expect(out).toContain("聆听中");

			p.update(state({ phase: "thinking" }));
			const thinking = render(p);
			expect(thinking).not.toContain("\x1b");
			expect(thinking).toContain("思考中");
			expect(thinking).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/);
		});

		it("detects NO_COLOR from the environment when plain is not forced", () => {
			const previous = Bun.env.NO_COLOR;
			Bun.env.NO_COLOR = "1";
			try {
				const p = new VoicePanel({ tui: ui, theme });
				panel = p;
				p.update(state({ phase: "error", error: "x" }));
				expect(render(p)).not.toContain("\x1b");
			} finally {
				if (previous === undefined) {
					delete Bun.env.NO_COLOR;
				} else {
					Bun.env.NO_COLOR = previous;
				}
			}
		});

		it("colored mode emits ANSI sequences from the theme", () => {
			const p = createPanel();
			p.update(state({ phase: "error", error: "x" }));
			expect(render(p)).toContain("\x1b[");
		});

		it("sanitizes tabs and newlines out of transcript text", () => {
			const p = createPanel({ plain: true });
			p.update(
				state({
					phase: "listening",
					transcript: { role: "user", text: "第一\t段\n第二段", final: false },
				}),
			);
			const out = render(p);
			expect(out).not.toContain("\t");
			expect(out).toContain("第一 段 第二段");
		});

		it("wraps long utterances so the full content stays visible", () => {
			const p = createPanel({ plain: true });
			const tail = "结尾标记XYZ";
			p.update(
				state({
					phase: "listening",
					transcript: { role: "user", text: `很长的请求${"填充文本".repeat(40)}${tail}`, final: true },
				}),
			);
			const out = render(p);
			// Single-line truncation would lose the tail; wrapping keeps it.
			// Join wrapped lines (the marker may straddle a wrap boundary).
			const joined = out
				.split("\n")
				.map(l => l.replaceAll("│", ""))
				.join("")
				.replaceAll(/\s+/g, "");
			expect(joined).toContain(tail);
		});

		it("listening phase shows the running-work activity line (Gap 4)", () => {
			const p = createPanel({ plain: true });
			p.update(state({ phase: "listening", toolLine: "bash: bun test" }));
			const out = render(p);
			expect(out).toContain("● 聆听中");
			expect(out).toContain("▸ 执行中: bash: bun test");
		});

		it("activity line clears when the work finishes", () => {
			const p = createPanel({ plain: true });
			p.update(state({ phase: "listening", toolLine: "bash: bun test" }));
			expect(render(p)).toContain("▸ 执行中");
			p.update(state({ phase: "listening", toolLine: "", consultTask: "" }));
			expect(render(p)).not.toContain("▸ 执行中");
		});
	});

	describe("wide layout (layout A with orb)", () => {
		const WIDE = 100;

		it("renders state title and live HUD in the top border", () => {
			const p = createPanel();
			p.update(state({ phase: "listening", inputLevel: 0.4 }));
			const out = p.render(WIDE).join("\n");
			expect(out).toContain("voice · 聆听");
			expect(out).toContain("IN");
			expect(out).toContain("OUT");
			expect(out).toContain("● LIVE");
			expect(out).toContain("40%");
		});

		it("renders the orb in truecolor next to badge, activity and transcripts", () => {
			const p = createPanel();
			p.update(state({ phase: "listening", transcript: { role: "user", text: "帮我跑测试", final: true } }));
			p.update(state({ phase: "listening", toolLine: "bash: bun test" }));
			const out = p.render(WIDE).join("\n");
			expect(out).toContain("\x1b[38;2;");
			expect(out).toContain("● 聆听中");
			expect(out).toContain("帮我跑测试");
			expect(out).toContain("▸ 执行中: bash: bun test");
		});

		it("keeps every line at exactly the render width", () => {
			const p = createPanel();
			p.update(
				state({
					phase: "speaking",
					outputLevel: 0.5,
					transcript: { role: "assistant", text: "回答内容", final: false },
				}),
			);
			for (const line of p.render(WIDE)) {
				expect(visibleWidth(line)).toBe(WIDE);
			}
		});

		it("falls back to the text layout below the orb width threshold", () => {
			const p = createPanel();
			p.update(state({ phase: "listening" }));
			const out = p.render(60).join("\n");
			expect(out).not.toContain("voice · 聆听");
			expect(out).toContain("● 聆听中");
		});

		it("shows ERROR status in the HUD when the channel failed", () => {
			const p = createPanel();
			p.update(state({ phase: "error", error: "provider down" }));
			const out = p.render(WIDE).join("\n");
			expect(out).toContain("ERROR");
			expect(out).toContain("voice · 异常");
		});
	});
});
