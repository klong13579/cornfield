/**
 * VoicePanel — TUI panel for the Jarvis realtime voice mode (P0d).
 *
 * Renders the 7 LivePhase states from docs/voice-jarvis-p0-design.md §4:
 * connecting / listening / thinking / speaking / interrupted / muted / error.
 *
 * Implements the pi-tui `Component` interface so it mounts as a top-level
 * panel; the TUI's differential renderer only rewrites changed lines, and the
 * panel additionally caches frames + gates `requestRender()` on a frame
 * signature so idle states produce zero redraws.
 */

import { sanitizeText } from "@oh-my-pi/pi-natives";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { type Component, matchesKey, type TUI, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { LivePhase } from "../../live/types";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { theme as globalTheme, type Theme, type ThemeColor } from "../theme/theme";
import { type OrbPhase, VoiceOrb } from "./voice-orb";

export interface VoicePanelTranscript {
	role: "user" | "assistant";
	text: string;
	final: boolean;
}

export interface VoicePanelState {
	phase: LivePhase;
	/** Mic RMS 0..1. */
	inputLevel: number;
	/** Speaker RMS 0..1. */
	outputLevel: number;
	transcript?: VoicePanelTranscript;
	consultTask?: string;
	toolLine?: string;
	error?: string;
}

export interface VoicePanelCallbacks {
	/** User asked to exit voice mode (e.g. alt+v). */
	onExit: () => void;
}

export interface VoicePanelOptions {
	tui: TUI;
	/** Panel callbacks (currently: exit handling). */
	callbacks?: VoicePanelCallbacks;
	/** Key(s) that exit voice mode while the panel is focused. */
	exitKeys?: KeyId[];
	/** Injected theme (tests); defaults to the global theme instance. */
	theme?: Theme;
	/** Force plain-text rendering (no ANSI). Default: NO_COLOR / dumb-terminal detection. */
	plain?: boolean;
	/** Interrupt shatter flash duration in ms before falling back to listening. Default 300. */
	interruptFlashMs?: number;
}

/** Max transcript entries kept in the scrollback window (spec: 2-4). */
const TRANSCRIPT_WINDOW = 3;
/** Max wrapped transcript lines rendered across all entries — full utterances
 * stay visible (word-wrapped), panel height stays bounded. */
const TRANSCRIPT_DISPLAY_LINES = 10;
/** Level bar cell count (spec: 8-12). */
const BAR_CELLS = 10;
/** Waveform cell count for the speaking radiating pattern. */
const WAVE_CELLS = 11;
/** Peak decay per animation frame (from upstream visualizer). */
const LEVEL_DECAY = 0.84;
/** Below this a smoothed level snaps to zero so idle frames settle. */
const LEVEL_EPSILON = 0.02;

/** Wide layout (layout A) geometry. */
const ORB_LAYOUT_MIN_WIDTH = 70;
const ORB_W = 30;
const ORB_H = 14;
const ORB_BLUE = "150;235;255";

const LEVEL_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const BRAILLE_SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;
const INTERRUPT_HINT = "[ 说话可随时打断 ]";

/** Frame intervals (ms) per animated phase, from spec §4.3. */
const TICK_MS: Partial<Record<LivePhase, number>> = {
	connecting: 83, // 12fps
	listening: 50, // 20fps
	thinking: 83, // 12fps
	speaking: 50, // 20fps
	interrupted: 50, // one-shot flash, ticks until fallback
	muted: 125, // 8fps breathing
	// error: static — no timer
};

function clampLevel(level: number): number {
	if (!Number.isFinite(level)) return 0;
	return Math.min(1, Math.max(0, level));
}

/** User-supplied text → single-line, tab-free, control-free. */
function clean(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/\s+/g, " ").trim();
}

function detectPlain(): boolean {
	return Bun.env.NO_COLOR !== undefined || Bun.env.TERM === "dumb" || Bun.env.TERM === "";
}

/** A compact, bordered, fixed-structure panel for the live voice session. */
export class VoicePanel implements Component {
	readonly wantsKeyRelease = false;

	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #plain: boolean;
	readonly #interruptFlashMs: number;
	readonly #callbacks: Partial<VoicePanelCallbacks>;
	readonly #exitKeys: KeyId[];
	readonly #orb = new VoiceOrb();

	#phase: LivePhase = "connecting";
	/** What is actually drawn; "interrupted" falls back to "listening" after the flash. */
	#displayPhase: LivePhase = "connecting";
	#inputLevel = 0;
	#outputLevel = 0;
	#displayInput = 0;
	#displayOutput = 0;
	#frame = 0;
	#transcripts: VoicePanelTranscript[] = [];
	#consultTask = "";
	#toolLine = "";
	#error = "";
	#speakingStartedAt = 0;
	#lastTranscriptText = "";

	#tickTimer: NodeJS.Timeout | undefined;
	#flashTimer: NodeJS.Timeout | undefined;
	#lastSignature = "";
	#cache: { width: number; signature: string; lines: string[] } | undefined;
	#disposed = false;

	constructor(options: VoicePanelOptions) {
		this.#tui = options.tui;
		this.#theme = options.theme ?? globalTheme;
		this.#plain = options.plain ?? detectPlain();
		this.#interruptFlashMs = options.interruptFlashMs ?? 300;
		this.#callbacks = options.callbacks ?? {};
		this.#exitKeys = options.exitKeys ?? [];
		this.#restartTick();
	}

	/** Push new live state into the panel. Mirrors the LiveSessionController callbacks. */
	update(state: VoicePanelState): void {
		if (this.#disposed) return;
		// Phase transition first: entering thinking clears stale consult lines
		// before the fresh ones from this very update are applied below.
		if (state.phase !== this.#phase) {
			this.#onPhaseChange(state.phase);
		}
		this.#inputLevel = clampLevel(state.inputLevel);
		this.#outputLevel = clampLevel(state.outputLevel);
		// Levels rise instantly, decay on ticks (upstream displayLevel pattern).
		if (this.#inputLevel > this.#displayInput) this.#displayInput = this.#inputLevel;
		if (this.#outputLevel > this.#displayOutput) this.#displayOutput = this.#outputLevel;

		// Only process a transcript if it is new (prevents echo-loop duplication).
		// A partial->final transition with the same text is still processed (the cursor disappears).
		if (state.transcript) {
			const key = `${state.transcript.text}:${state.transcript.final ? "1" : "0"}`;
			if (key !== this.#lastTranscriptText) {
				this.#lastTranscriptText = key;
				this.#pushTranscript(state.transcript);
			}
		}
		if (state.consultTask !== undefined) this.#consultTask = clean(state.consultTask);
		if (state.toolLine !== undefined) this.#toolLine = clean(state.toolLine);
		if (state.error !== undefined) this.#error = clean(state.error);
		this.#requestRender();
	}

	/** Clears the render cache. Called by the TUI on theme changes. */
	invalidate(): void {
		this.#cache = undefined;
		this.#lastSignature = "";
	}

	/** Stops all timers. Idempotent. */
	dispose(): void {
		this.#disposed = true;
		this.#stopTick();
		if (this.#flashTimer) {
			clearTimeout(this.#flashTimer);
			this.#flashTimer = undefined;
		}
	}

	/**
	 * Dispatch a key event. Only the configured exit key is honored — the panel
	 * no longer drives the mic (mic is always-on for the duration of the
	 * voice session).
	 */
	handleInput(data: string): void {
		if (this.#disposed) return;
		for (const key of this.#exitKeys) {
			if (matchesKey(data, key)) {
				this.#callbacks.onExit?.();
				return;
			}
		}
	}

	render(width: number): string[] {
		const w = Math.max(16, width);
		const signature = this.#signature();
		if (this.#cache && this.#cache.width === w && this.#cache.signature === signature) {
			return this.#cache.lines;
		}
		const lines = !this.#plain && w >= ORB_LAYOUT_MIN_WIDTH ? this.#renderOrbLayout(w) : this.#renderLines(w);
		this.#cache = { width: w, signature, lines };
		return lines;
	}

	// ============================================================================
	// State handling
	// ============================================================================

	#onPhaseChange(phase: LivePhase): void {
		this.#phase = phase;
		if (this.#flashTimer) {
			clearTimeout(this.#flashTimer);
			this.#flashTimer = undefined;
		}
		switch (phase) {
			case "interrupted": {
				this.#displayPhase = "interrupted";
				// Shatter flash, then fall back to listening on our own — the
				// controller may take longer to confirm the phase transition.
				this.#flashTimer = setTimeout(() => {
					this.#flashTimer = undefined;
					if (this.#disposed || this.#phase !== "interrupted") return;
					this.#displayPhase = "listening";
					this.#restartTick();
					this.#requestRender();
				}, this.#interruptFlashMs);
				this.#flashTimer.unref?.();
				break;
			}
			case "speaking":
				this.#speakingStartedAt = Date.now();
				this.#displayPhase = "speaking";
				break;
			case "thinking":
				// Stale consult lines from a previous round must not leak in.
				if (this.#displayPhase !== "thinking") {
					this.#consultTask = "";
					this.#toolLine = "";
				}
				this.#displayPhase = "thinking";
				break;
			default:
				this.#displayPhase = phase;
		}
		this.#restartTick();
	}

	#pushTranscript(entry: VoicePanelTranscript): void {
		const text = clean(entry.text);
		if (!text) return;
		const last = this.#transcripts[this.#transcripts.length - 1];
		if (last && last.role === entry.role && !last.final) {
			// Streaming partial replaces the previous partial of the same role.
			this.#transcripts[this.#transcripts.length - 1] = { role: entry.role, text, final: entry.final };
		} else {
			this.#transcripts.push({ role: entry.role, text, final: entry.final });
		}
		while (this.#transcripts.length > TRANSCRIPT_WINDOW) this.#transcripts.shift();
	}

	// ============================================================================
	// Animation scheduling
	// ============================================================================

	#restartTick(): void {
		this.#stopTick();
		const interval = TICK_MS[this.#displayPhase];
		if (interval === undefined) return; // error: static
		this.#tickTimer = setInterval(() => this.#tick(), interval);
		this.#tickTimer.unref?.();
	}

	#stopTick(): void {
		if (this.#tickTimer) {
			clearInterval(this.#tickTimer);
			this.#tickTimer = undefined;
		}
	}

	#tick(): void {
		if (this.#disposed) return;
		this.#frame += 1;
		this.#displayInput = this.#smooth(this.#displayInput, this.#inputLevel);
		this.#displayOutput = this.#smooth(this.#displayOutput, this.#outputLevel);
		// Idle zero-redraw: only repaint when the visible frame actually changed.
		const signature = this.#signature();
		if (signature !== this.#lastSignature) {
			this.#requestRender();
		}
	}

	#smooth(display: number, target: number): number {
		const next = Math.max(target, display * LEVEL_DECAY);
		return next < LEVEL_EPSILON ? 0 : next;
	}

	#requestRender(): void {
		this.#lastSignature = this.#signature();
		this.#cache = undefined;
		this.#tui.requestRender();
	}

	/**
	 * Everything that can change the rendered output, per display phase.
	 * Static contributions (transcripts, consult lines) always included.
	 */
	#signature(): string {
		const base = [
			this.#displayPhase,
			this.#transcripts.map(t => `${t.role}:${t.text}:${t.final ? 1 : 0}`).join("|"),
			this.#consultTask,
			this.#toolLine,
			this.#error,
		];
		switch (this.#displayPhase) {
			case "connecting":
			case "thinking":
				base.push(`s${this.#spinnerIndex()}`);
				break;
			case "listening":
				base.push(`i${this.#quantize(this.#displayInput)}`, `f${this.#frame}`);
				break;
			case "speaking": {
				base.push(`o${this.#quantize(this.#displayOutput)}`, `t${this.#speakingElapsedSec()}`, `f${this.#frame}`);
				break;
			}
			case "muted":
				base.push(`b${this.#frame % 2}`);
				break;
			case "interrupted":
			case "error":
				break; // static
		}
		return base.join("");
	}

	#quantize(level: number): number {
		return Math.round(level * 24);
	}

	#spinnerIndex(): number {
		return this.#frame % this.#spinnerFrames().length;
	}

	#spinnerFrames(): readonly string[] {
		const frames = this.#theme.spinnerFrames;
		return frames.length > 0 ? frames : BRAILLE_SPINNER;
	}

	#speakingElapsedSec(): number {
		if (this.#speakingStartedAt === 0) return 0;
		return Math.max(0, Math.floor((Date.now() - this.#speakingStartedAt) / 1000));
	}

	// ============================================================================
	// Rendering
	// ============================================================================

	#color(color: ThemeColor, text: string): string {
		return this.#plain ? text : this.#theme.fg(color, text);
	}

	#renderLines(width: number): string[] {
		const inner = width - 4; // "│ " + content + " │"
		// All callers pass ANSI-styled content; truncateToWidth is ANSI-aware and
		// guarantees the width invariant no matter which hardcoded hint grows.
		const line = (content: string, contentWidth?: number): string => {
			const visible = contentWidth ?? visibleWidth(content);
			const clamped = visible > inner ? truncateToWidth(content, inner) : content;
			const pad = " ".repeat(Math.max(0, inner - Math.min(visible, inner)));
			return `${this.#color("border", "│ ")}${clamped}${pad}${this.#color("border", " │")}`;
		};
		const centered = (content: string, contentWidth: number): string => {
			if (contentWidth > inner) return line(content, contentWidth);
			const left = Math.max(0, Math.floor((inner - contentWidth) / 2));
			const right = Math.max(0, inner - contentWidth - left);
			return `${this.#color("border", "│ ")}${" ".repeat(left)}${content}${" ".repeat(right)}${this.#color("border", " │")}`;
		};
		const top = this.#color("border", `╭${"─".repeat(width - 2)}╮`);
		const bottom = this.#color("border", `╰${"─".repeat(width - 2)}╯`);
		return [top, ...this.#bodyLines(this.#displayPhase, inner, line, centered), bottom];
	}

	// ============================================================================
	// Wide layout (layout A): orb left, info right, HUD in the top border
	// ============================================================================

	/** True-color helper for the orb HUD (theme-independent color semantics). */
	#rgb(code: string, text: string): string {
		return this.#plain ? text : `\x1b[38;2;${code}m${text}\x1b[0m`;
	}

	#orbStateLabel(): string {
		switch (this.#displayPhase) {
			case "connecting":
				return "连接中";
			case "listening":
				return "聆听";
			case "thinking":
				return "思考";
			case "speaking":
				return "播报";
			case "interrupted":
				return "已打断";
			case "muted":
				return "已静音";
			case "error":
				return "异常";
		}
	}

	#hudSegment(): string {
		const bar = (level: number): string => {
			const lit = Math.round(level * BAR_CELLS);
			return this.#rgb(ORB_BLUE, "▓".repeat(lit)) + this.#color("dim", "░".repeat(BAR_CELLS - lit));
		};
		const pct = (level: number): string => this.#rgb(ORB_BLUE, `${Math.round(level * 100)}%`);
		const liveColor = this.#phase === "error" ? "235;120;110" : "120;220;140";
		const liveLabel = this.#phase === "error" ? "ERROR" : "LIVE";
		return [
			`${this.#color("dim", "IN")} ${bar(this.#displayInput)} ${pct(this.#displayInput)}`,
			`${this.#color("dim", "OUT")} ${bar(this.#displayOutput)} ${pct(this.#displayOutput)}`,
			this.#rgb(liveColor, `● ${liveLabel}`),
		].join("  ");
	}

	#orbBadge(): string {
		switch (this.#displayPhase) {
			case "connecting": {
				const badge = `${this.#spinnerFrames()[this.#spinnerIndex()]} jarvis · 连接中…`;
				return this.#color("warning", badge);
			}
			case "listening":
				return this.#color("accent", "● 聆听中");
			case "thinking":
				return this.#color("warning", `${this.#spinnerFrames()[this.#spinnerIndex()]} 思考中`);
			case "speaking": {
				const elapsed = this.#speakingElapsedSec();
				const stamp = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
				return this.#color("accent", `◉ 播报中 · ${stamp}`);
			}
			case "interrupted":
				return this.#color("warning", "⚡ 已打断 · 聆听中…");
			case "muted":
				return this.#color(this.#frame % 2 === 0 ? "accent" : "dim", "◉ jarvis");
			case "error":
				return this.#color("error", `✕ 语音通道异常：${this.#error || "未知原因"}`);
		}
	}

	#renderOrbLayout(w: number): string[] {
		const inner = w - 4;
		const orbW = Math.min(ORB_W, Math.floor(inner * 0.35));
		const gap = 3;
		const textW = inner - orbW - gap;
		const b = (s: string): string => this.#color("border", s);

		// Top border: state title left, live parameter HUD right.
		const title = ` voice · ${this.#orbStateLabel()} `;
		const hud = this.#hudSegment();
		const gapW = Math.max(1, w - 4 - visibleWidth(title) - visibleWidth(hud));
		const top = b("╭─") + this.#rgb(ORB_BLUE, title) + b("─".repeat(gapW)) + hud + b("─╮");

		const orbLines = this.#orb.render({
			width: orbW,
			height: ORB_H,
			phase: this.#displayPhase as OrbPhase,
			frame: this.#frame,
			inputLevel: this.#displayInput,
			outputLevel: this.#displayOutput,
			transparent: true,
			boost: 2.2,
		});

		// Right zone: badge, activity, transcripts, hints — budgeted into ORB_H rows.
		const fixed: string[] = [this.#orbBadge()];
		if (this.#toolLine) fixed.push(this.#color("dim", `▸ 执行中: ${this.#toolLine}`));
		else if (this.#consultTask) fixed.push(this.#color("dim", `▸ 执行中: ${this.#consultTask}`));
		const hints: string[] = [];
		if (this.#displayPhase === "speaking") hints.push(this.#color("warning", INTERRUPT_HINT));
		hints.push(this.#color("dim", "alt+m 静音 · alt+v 退出语音"));
		const transcriptBudget = Math.max(0, ORB_H - fixed.length - hints.length - 1);
		const transcripts = this.#transcriptContent(textW).slice(-transcriptBudget);
		const textLines = [...fixed, "", ...transcripts];
		while (textLines.length < ORB_H - hints.length) textLines.push("");
		textLines.push(...hints);

		const rows: string[] = [top];
		for (let i = 0; i < ORB_H; i++) {
			const text = textLines[i] ?? "";
			const vis = visibleWidth(text);
			const clamped = vis > textW ? truncateToWidth(text, textW) : text;
			const pad = " ".repeat(Math.max(0, textW - Math.min(vis, textW)));
			rows.push(`${b("│ ")}${orbLines[i] ?? ""}${" ".repeat(gap)}${clamped}${pad}${b(" │")}`);
		}
		rows.push(b(`╰${"─".repeat(w - 2)}╯`));
		return rows;
	}

	#bodyLines(
		phase: LivePhase,
		inner: number,
		line: (content: string) => string,
		centered: (content: string, contentWidth: number) => string,
	): string[] {
		switch (phase) {
			case "connecting": {
				const badge = `${this.#spinnerFrames()[this.#spinnerIndex()]} jarvis · 连接中…`;
				return [
					centered(this.#color("warning", badge), visibleWidth(badge)),
					line(this.#color("muted", truncateToWidth("正在建立语音通道 (realtime)", inner))),
				];
			}
			case "listening": {
				const lines = [
					line(this.#color("accent", this.#levelBar(inner, this.#displayInput))),
					line(this.#color("accent", "● 聆听中")),
				];
				// A task/consult may still be executing while the phase is back to
				// listening (post-filler): keep its activity visible.
				if (this.#toolLine) {
					lines.push(line(this.#color("dim", truncateToWidth(`▸ 执行中: ${this.#toolLine}`, inner))));
				} else if (this.#consultTask) {
					lines.push(line(this.#color("dim", truncateToWidth(`▸ 执行中: ${this.#consultTask}`, inner))));
				}
				lines.push(...this.#transcriptLines(inner, line));
				return lines;
			}
			case "thinking": {
				const badge = `${this.#spinnerFrames()[this.#spinnerIndex()]} 思考中`;
				const lines = [centered(this.#color("warning", badge), visibleWidth(badge))];
				if (this.#consultTask) {
					lines.push(
						line(this.#color("muted", truncateToWidth(`▸ omp_agent_consult: ${this.#consultTask}`, inner))),
					);
				}
				if (this.#toolLine) {
					lines.push(line(this.#color("dim", truncateToWidth(`▸ tool: ${this.#toolLine}`, inner))));
				}
				return lines;
			}
			case "speaking": {
				const elapsed = this.#speakingElapsedSec();
				const stamp = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
				return [
					line(this.#color("accent", this.#waveform(inner))),
					line(this.#color("accent", `◉ 播报中 · ${stamp}`)),
					...this.#transcriptLines(inner, line),
					centered(this.#color("warning", INTERRUPT_HINT), visibleWidth(INTERRUPT_HINT)),
				];
			}
			case "interrupted": {
				return [
					line(this.#color("warning", `))) ⌇ ⌇  ✕`)),
					line(this.#color("warning", "⚡ 已打断 · 聆听中…")),
					...this.#transcriptLines(inner, line),
				];
			}
			case "muted": {
				const bright = this.#frame % 2 === 0;
				const badge = "◉ jarvis";
				return [
					centered(this.#color(bright ? "accent" : "dim", badge), visibleWidth(badge)),
					line(this.#color("muted", truncateToWidth("已静音 · Ctrl+M 继续 / Esc 退出语音模式", inner))),
				];
			}
			case "error": {
				const reason = this.#error || "未知原因";
				return [
					line(this.#color("error", truncateToWidth(`✕ 语音通道异常：${reason}`, inner))),
					line(this.#color("muted", "按 Ctrl+V 重连 / Esc 退出")),
				];
			}
		}
	}

	/** partial → dim + cursor, final → full text color (karaoke rule from spec §4.3).
	 * Utterances are word-wrapped so long requests/answers show in full. */
	#transcriptContent(maxWidth: number): string[] {
		const rows: string[] = [];
		for (const entry of this.#transcripts) {
			const wrapped = wrapTextWithAnsi(entry.text, maxWidth);
			const body = wrapped.length > 0 ? wrapped : [""];
			for (let i = 0; i < body.length; i++) {
				const segment = truncateToWidth(body[i]!, maxWidth);
				if (!entry.final && i === body.length - 1) {
					const cursor = "▌";
					const clipped = truncateToWidth(segment, Math.max(1, maxWidth - visibleWidth(cursor)));
					rows.push(this.#color("dim", `${clipped}${cursor}`));
				} else {
					rows.push(this.#color(entry.final ? "text" : "dim", segment));
				}
			}
		}
		return rows;
	}

	#transcriptLines(inner: number, line: (content: string) => string): string[] {
		return this.#transcriptContent(inner)
			.slice(-TRANSCRIPT_DISPLAY_LINES)
			.map(s => line(s));
	}

	/** 8-12 cell RMS level bar; sqrt-scaled, deterministic per (cell, frame). */
	#levelBar(inner: number, level: number): string {
		const cells = Math.min(BAR_CELLS, Math.max(1, inner));
		let bar = "";
		for (let i = 0; i < cells; i++) {
			const envelope = 0.55 + 0.45 * Math.sin(i * 1.7 + this.#frame * 0.9);
			const value = level * envelope;
			const index = Math.min(LEVEL_GLYPHS.length - 1, Math.round(Math.sqrt(value) * (LEVEL_GLYPHS.length - 1)));
			bar += LEVEL_GLYPHS[index];
		}
		return bar;
	}
	#waveform(inner: number): string {
		const cells = Math.min(WAVE_CELLS, Math.max(1, inner));
		const half = (cells - 1) / 2;
		let wave = "";
		for (let i = 0; i < cells; i++) {
			const distance = half === 0 ? 0 : Math.abs(i - half) / half;
			const wobble = 0.4 + 0.6 * Math.abs(Math.sin(i * 0.9 + this.#frame * 0.7));
			const amplitude = this.#displayOutput * wobble * (1 - distance * 0.6);
			wave += amplitude > 0.33 ? ")" : amplitude > 0.08 ? "⌇" : " ";
		}
		return wave.trimEnd() === "" ? "⌇" : wave;
	}
}
