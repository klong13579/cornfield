/**
 * VoiceImmersiveView — full-viewport voice mode (layout B).
 *
 * Entering voice mode swaps the TUI into this view: parameter HUD on top,
 * the light orb as the protagonist in the center, transcript log at the
 * bottom. While a voice task executes, the orb shrinks to a small top
 * indicator and the freed center becomes the activity feed (task title +
 * rolling tool lines + elapsed), so long tasks never fly blind.
 *
 * Same Component contract as VoicePanel: `update()` pushes live state,
 * tick timers drive animation, and requestRender is signature-gated so
 * static phases produce zero redraws.
 */

import { sanitizeText } from "@oh-my-pi/pi-natives";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { type Component, matchesKey, type TUI, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { LivePhase } from "../../live/types";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { theme as globalTheme, type Theme, type ThemeColor } from "../theme/theme";
import { type OrbPhase, VoiceOrb } from "./voice-orb";
import type { VoicePanelTranscript } from "./voice-panel";

export interface VoiceImmersiveState {
	phase: LivePhase;
	/** Mic RMS 0..1. */
	inputLevel: number;
	/** Speaker RMS 0..1. */
	outputLevel: number;
	transcript?: VoicePanelTranscript;
	/** In-flight task text (task title while running). */
	consultTask?: string;
	/** Latest tool activity line (e.g. "read: TODO.md"). */
	toolLine?: string;
	/** Live thinking tail of the running task's assistant turn. */
	thinkingLine?: string;
	error?: string;
	/** Channel dropped and is coming back. */
	reconnecting?: boolean;
}

export interface VoiceImmersiveCallbacks {
	onExit: () => void;
}

export interface VoiceImmersiveOptions {
	tui: TUI;
	callbacks?: VoiceImmersiveCallbacks;
	exitKeys?: KeyId[];
	theme?: Theme;
	/** Force plain-text rendering (no orb). Default: NO_COLOR / dumb detection. */
	plain?: boolean;
}

const TRANSCRIPT_WINDOW = 3;
const TRANSCRIPT_DISPLAY_LINES = 6;
const ACTIVITY_WINDOW = 10;
const BAR_CELLS = 8;
const LEVEL_DECAY = 0.84;
const LEVEL_EPSILON = 0.02;
/** Rows reserved at the bottom for the editor (border + input + margin). */
const EDITOR_RESERVE = 6;
const MIN_VIEW_H = 22;
const MAX_VIEW_H = 44;
const SMALL_ORB_W = 24;
const SMALL_ORB_H = 12;
const BRAILLE_SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;
const INTERRUPT_HINT = "[ 说话可随时打断 · alt+m 静音 · alt+v 退出 ]";
const BLUE = "150;235;255";
const GREEN = "120;220;140";
const YELLOW = "235;200;110";
const RED = "235;120;110";

const TICK_MS: Partial<Record<LivePhase, number>> = {
	connecting: 83,
	listening: 50,
	thinking: 83,
	speaking: 50,
	interrupted: 50,
	muted: 125,
};

function clampLevel(level: number): number {
	if (!Number.isFinite(level)) return 0;
	return Math.min(1, Math.max(0, level));
}

function clean(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/\s+/g, " ").trim();
}

function detectPlain(): boolean {
	return Bun.env.NO_COLOR !== undefined || Bun.env.TERM === "dumb" || Bun.env.TERM === "";
}

function rgbAnsi(code: string, text: string): string {
	return `\x1b[38;2;${code}m${text}\x1b[0m`;
}

function wide(text: string): number {
	return visibleWidth(text);
}

export class VoiceImmersiveView implements Component {
	readonly wantsKeyRelease = false;

	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #plain: boolean;
	readonly #callbacks: Partial<VoiceImmersiveCallbacks>;
	readonly #exitKeys: KeyId[];
	readonly #orb = new VoiceOrb();

	#phase: LivePhase = "connecting";
	#inputLevel = 0;
	#outputLevel = 0;
	#displayInput = 0;
	#displayOutput = 0;
	#frame = 0;
	#transcripts: VoicePanelTranscript[] = [];
	#lastTranscriptKey = "";
	#taskTitle = "";
	#taskStartedAt = 0;
	#toolLine = "";
	#thinkingLine = "";
	#activity: string[] = [];
	#error = "";
	#reconnecting = false;
	#speakingStartedAt = 0;

	#tickTimer: NodeJS.Timeout | undefined;
	#lastSignature = "";
	#cache: { width: number; rows: number; signature: string; lines: string[] } | undefined;
	#disposed = false;

	constructor(options: VoiceImmersiveOptions) {
		this.#tui = options.tui;
		this.#theme = options.theme ?? globalTheme;
		this.#plain = options.plain ?? detectPlain();
		this.#callbacks = options.callbacks ?? {};
		this.#exitKeys = options.exitKeys ?? [];
		this.#restartTick();
	}

	update(state: VoiceImmersiveState): void {
		if (this.#disposed) return;
		if (state.phase !== this.#phase) this.#onPhaseChange(state.phase);
		this.#inputLevel = clampLevel(state.inputLevel);
		this.#outputLevel = clampLevel(state.outputLevel);
		if (this.#inputLevel > this.#displayInput) this.#displayInput = this.#inputLevel;
		if (this.#outputLevel > this.#displayOutput) this.#displayOutput = this.#outputLevel;

		if (state.transcript) {
			const key = `${state.transcript.text}:${state.transcript.final ? "1" : "0"}`;
			if (key !== this.#lastTranscriptKey) {
				this.#lastTranscriptKey = key;
				this.#pushTranscript(state.transcript);
			}
		}
		if (state.consultTask !== undefined) {
			const task = clean(state.consultTask);
			if (task && !this.#taskTitle) this.#taskStartedAt = Date.now();
			if (!task) this.#taskStartedAt = 0;
			this.#taskTitle = task;
		}
		if (state.toolLine !== undefined) {
			const line = clean(state.toolLine);
			if (line && line !== this.#toolLine) {
				if (this.#toolLine) {
					this.#activity.push(this.#toolLine);
					while (this.#activity.length > ACTIVITY_WINDOW) this.#activity.shift();
				}
				this.#toolLine = line;
			}
			if (!line) this.#toolLine = "";
		}
		if (state.thinkingLine !== undefined) this.#thinkingLine = clean(state.thinkingLine);
		if (state.error !== undefined) this.#error = clean(state.error);
		if (state.reconnecting !== undefined) this.#reconnecting = state.reconnecting;
		this.#requestRender();
	}

	invalidate(): void {
		this.#cache = undefined;
		this.#lastSignature = "";
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopTick();
	}

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
		const w = Math.max(40, width);
		const rows = Math.min(MAX_VIEW_H, Math.max(MIN_VIEW_H, this.#tui.terminal.rows - EDITOR_RESERVE));
		const signature = this.#signature();
		if (this.#cache && this.#cache.width === w && this.#cache.rows === rows && this.#cache.signature === signature) {
			return this.#cache.lines;
		}
		const lines = this.#plain ? this.#renderPlain(w, rows) : this.#renderLines(w, rows);
		this.#cache = { width: w, rows, signature, lines };
		return lines;
	}

	// ============================================================================
	// State handling
	// ============================================================================

	#onPhaseChange(phase: LivePhase): void {
		this.#phase = phase;
		switch (phase) {
			case "speaking":
				this.#speakingStartedAt = Date.now();
				break;
			case "thinking":
				break;
			default:
				break;
		}
		this.#restartTick();
	}

	#pushTranscript(entry: VoicePanelTranscript): void {
		const text = clean(entry.text);
		if (!text) return;
		const last = this.#transcripts[this.#transcripts.length - 1];
		if (last && last.role === entry.role && !last.final) {
			this.#transcripts[this.#transcripts.length - 1] = { role: entry.role, text, final: entry.final };
		} else {
			this.#transcripts.push({ role: entry.role, text, final: entry.final });
		}
		while (this.#transcripts.length > TRANSCRIPT_WINDOW) this.#transcripts.shift();
	}

	/** Task mode: a voice task/consult is executing (orb yields to the feed). */
	get #taskMode(): boolean {
		return this.#taskTitle !== "" || this.#toolLine !== "";
	}

	#elapsedSec(since: number): number {
		if (since === 0) return 0;
		return Math.max(0, Math.floor((Date.now() - since) / 1000));
	}

	// ============================================================================
	// Animation scheduling
	// ============================================================================

	#restartTick(): void {
		this.#stopTick();
		const interval = TICK_MS[this.#phase];
		if (interval === undefined) return;
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
		const signature = this.#signature();
		if (signature !== this.#lastSignature) this.#requestRender();
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

	#signature(): string {
		const base = [
			this.#phase,
			this.#transcripts.map(t => `${t.role}:${t.text}:${t.final ? 1 : 0}`).join("|"),
			this.#taskTitle,
			this.#toolLine,
			this.#thinkingLine,
			this.#activity.join(">"),
			this.#error,
			this.#reconnecting ? "r" : "",
		];
		// Always-on breath: active phases redraw every tick regardless of audio.
		switch (this.#phase) {
			case "listening":
				base.push(`i${Math.round(this.#displayInput * 24)}`, `f${this.#frame}`);
				break;
			case "speaking":
				base.push(
					`o${Math.round(this.#displayOutput * 24)}`,
					`t${this.#elapsedSec(this.#speakingStartedAt)}`,
					`f${this.#frame}`,
				);
				break;
			case "connecting":
			case "thinking":
				base.push(`f${this.#frame}`);
				break;
			case "muted":
			case "interrupted":
			case "error":
				break;
		}
		if (this.#taskMode) base.push(`e${this.#elapsedSec(this.#taskStartedAt)}`);
		return base.join("");
	}

	// ============================================================================
	// Rendering
	// ============================================================================

	#center(width: number, text: string): string {
		const vis = wide(text);
		if (vis >= width) return truncateToWidth(text, width);
		const left = Math.floor((width - vis) / 2);
		return " ".repeat(left) + text;
	}

	#fg(color: ThemeColor, text: string): string {
		return this.#plain ? text : this.#theme.fg(color, text);
	}

	#rgb(code: string, text: string): string {
		return this.#plain ? text : rgbAnsi(code, text);
	}

	#levelBar(level: number, color: string): string {
		const lit = Math.round(level * BAR_CELLS);
		let bar = "";
		for (let i = 0; i < BAR_CELLS; i++) {
			bar += i < lit ? "▓" : "░";
		}
		return this.#rgb(color, bar);
	}

	#hudLine(width: number): string {
		const accent = BLUE;
		const inBar = `${this.#levelBar(this.#displayInput, accent)} ${this.#rgb(accent, `${Math.round(this.#displayInput * 100)}%`)}`;
		const outBar = `${this.#levelBar(this.#displayOutput, accent)} ${this.#rgb(accent, `${Math.round(this.#displayOutput * 100)}%`)}`;
		const liveColor = this.#phase === "error" ? RED : this.#reconnecting ? YELLOW : GREEN;
		const liveLabel = this.#phase === "error" ? "ERROR" : this.#reconnecting ? "RECONNECT" : "LIVE";
		const parts = [
			`${this.#fg("dim", "IN")} ${inBar}`,
			`${this.#fg("dim", "OUT")} ${outBar}`,
			this.#rgb(liveColor, `● ${liveLabel}`),
		];
		const joined = parts.join("   ");
		return this.#center(width, joined);
	}

	#statusLine(): { text: string; vis: number } {
		switch (this.#phase) {
			case "connecting":
				return { text: this.#rgb(YELLOW, `${this.#spinner()} 连接中…`), vis: 6 };
			case "listening":
				return { text: this.#rgb(BLUE, "● 聆听中"), vis: 5 };
			case "thinking":
				return { text: this.#rgb(BLUE, `${this.#spinner()} 思考中`), vis: 4 };
			case "speaking": {
				const s = this.#elapsedSec(this.#speakingStartedAt);
				const stamp = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
				return { text: this.#rgb(BLUE, `◉ 播报中 · ${stamp}`), vis: 9 };
			}
			case "interrupted":
				return { text: this.#rgb(YELLOW, "⚡ 已打断 · 聆听中…"), vis: 9 };
			case "muted":
				return { text: this.#fg("dim", "◌ 已静音 · alt+m 继续"), vis: 13 };
			case "error":
				return { text: this.#rgb(RED, `✕ 语音通道异常：${this.#error || "未知原因"}`), vis: 10 };
		}
	}

	#spinner(): string {
		const frames = this.#theme.spinnerFrames;
		const seq = frames.length > 0 ? frames : BRAILLE_SPINNER;
		return seq[this.#frame % seq.length] ?? "⣾";
	}

	#transcriptLines(width: number): string[] {
		const rows: string[] = [];
		for (const entry of this.#transcripts) {
			const prefix = entry.role === "user" ? this.#fg("accent", "你  ") : this.#fg("dim", "omp ");
			const wrapped = wrapTextWithAnsi(entry.text, Math.max(8, width - 4));
			const body = wrapped.length > 0 ? wrapped : [""];
			for (let i = 0; i < body.length; i++) {
				const seg = truncateToWidth(body[i]!, width - 4);
				if (!entry.final && i === body.length - 1) {
					rows.push(this.#fg("dim", `${prefix}${seg}▌`));
				} else {
					rows.push(`${prefix}${this.#fg(entry.final ? "text" : "dim", seg)}`);
				}
			}
		}
		return rows.slice(-TRANSCRIPT_DISPLAY_LINES);
	}

	#renderLines(width: number, rows: number): string[] {
		const out: string[] = [this.#hudLine(width), ""];
		if (this.#taskMode) {
			this.#renderTaskMode(out, width, rows);
		} else {
			this.#renderOrbMode(out, width, rows);
		}
		return out;
	}

	/** Idle/conversation layout: big centered orb + status + transcript. */
	#renderOrbMode(out: string[], width: number, rows: number): void {
		const boxH = Math.min(rows - 10, 28);
		const boxW = Math.min(width - 8, Math.floor(boxH * 2.4));
		const orbLines = this.#orb.render({
			width: boxW,
			height: boxH,
			phase: this.#phase as OrbPhase,
			frame: this.#frame,
			inputLevel: this.#displayInput,
			outputLevel: this.#displayOutput,
			boost: 1.7,
			transparent: true,
		});
		const pad = Math.max(0, Math.floor((width - boxW) / 2));
		for (const line of orbLines) out.push(" ".repeat(pad) + line);

		const status = this.#statusLine();
		out.push(this.#center(width, status.text));
		out.push("");
		for (const line of this.#transcriptLines(width)) out.push(this.#center(width, line));
		while (out.length < rows - 1) out.push("");
		out.push(this.#center(width, this.#fg("dim", INTERRUPT_HINT)));
	}

	/** Task-execution layout: small orb up top, activity feed in the center. */
	#renderTaskMode(out: string[], width: number, rows: number): void {
		const orbLines = this.#orb.render({
			width: SMALL_ORB_W,
			height: SMALL_ORB_H,
			phase: this.#phase as OrbPhase,
			frame: this.#frame,
			inputLevel: this.#displayInput,
			outputLevel: this.#displayOutput,
			boost: 2.2,
			transparent: true,
		});
		const pad = Math.max(0, Math.floor((width - SMALL_ORB_W) / 2));
		for (const line of orbLines) out.push(" ".repeat(pad) + line);

		const elapsed = this.#elapsedSec(this.#taskStartedAt);
		out.push(this.#center(width, this.#rgb(BLUE, `${this.#spinner()} 执行任务中 · ${elapsed}s`)));
		out.push("");

		const feedW = Math.min(width - 8, 100);
		const fx = Math.max(4, Math.floor((width - feedW) / 2));
		const indent = " ".repeat(fx);
		if (this.#taskTitle) {
			out.push(`${indent}${this.#rgb(BLUE, "任务")} ${truncateToWidth(this.#taskTitle, feedW - 6)}`);
			out.push("");
		}
		for (const line of this.#activity) {
			out.push(indent + this.#fg("dim", `✓ ${truncateToWidth(line, feedW - 2)}`));
		}
		if (this.#toolLine) {
			out.push(indent + this.#rgb(BLUE, `▸ ${truncateToWidth(this.#toolLine, feedW - 2)}`));
		}
		if (this.#thinkingLine) {
			// Live thinking tail — the immersive view replaced the message list,
			// so this feed is the only place the user can watch the model reason.
			const wrapped = wrapTextWithAnsi(this.#thinkingLine, Math.max(8, feedW - 6));
			const tail = wrapped.slice(-3);
			for (const [i, line] of tail.entries()) {
				out.push(indent + this.#fg("dim", i === 0 ? `💭 ${line}` : `  ${line}`));
			}
		}
		const done = this.#activity.length;
		out.push(indent + this.#fg("dim", `${done + (this.#toolLine ? 1 : 0)} 个工具调用 · 已用 ${elapsed}s`));
		out.push("");
		for (const line of this.#transcriptLines(width)) out.push(this.#center(width, line));
		while (out.length < rows - 1) out.push("");
		out.push(this.#center(width, this.#fg("dim", '[ 说话可随时打断 · 说"进度"查状态 · 说"取消"停任务 ]')));
	}

	/** Plain fallback: text-only layout (NO_COLOR / dumb terminals). */
	#renderPlain(width: number, rows: number): string[] {
		const out: string[] = [this.#hudLine(width), ""];
		const status = this.#statusLine();
		out.push(this.#center(width, status.text));
		if (this.#taskTitle) out.push(this.#center(width, `任务: ${truncateToWidth(this.#taskTitle, width - 8)}`));
		if (this.#toolLine)
			out.push(this.#center(width, this.#fg("dim", `▸ ${truncateToWidth(this.#toolLine, width - 8)}`)));
		if (this.#thinkingLine)
			out.push(this.#center(width, this.#fg("dim", `💭 ${truncateToWidth(this.#thinkingLine, width - 8)}`)));
		out.push("");
		for (const line of this.#transcriptLines(width)) out.push(this.#center(width, line));
		while (out.length < rows - 1) out.push("");
		out.push(this.#center(width, INTERRUPT_HINT));
		return out;
	}
}
