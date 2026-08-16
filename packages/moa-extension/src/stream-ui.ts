/**
 * TUI sink for MoA worker streaming (once-right P5 + UX refresh).
 *
 * Uses ExtensionUIContext.setWidget with a theme factory (like autoresearch /
 * tool execution) so we can show multi-line previews, status colors, and a
 * spinner while workers stream — bypassing the string[] MAX_WIDGET_LINES=10 cap.
 */

import type { ExtensionUIContext, ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";

export interface WorkerStreamChunk {
	name: string;
	text: string;
}

export type WorkerStreamStatus = "streaming" | "ok" | "blocked" | "failed";

export interface WorkerStreamSink {
	onPartial(chunk: WorkerStreamChunk): void;
	markStatus(name: string, status: Exclude<WorkerStreamStatus, "streaming">): void;
	clear(): void;
}

export interface WorkerStreamSinkOptions {
	/** Debounce widget paints. 0 = paint synchronously (tests). Default 200. */
	throttleMs?: number;
	/** Max chars of the tail preview per worker. Default 480. */
	previewChars?: number;
	/** Max lines of the tail preview per worker. Default 6. */
	previewLines?: number;
	/** Spinner tick while any worker is streaming. Default 120. 0 disables. */
	spinnerMs?: number;
}

/** Duck-typed theme surface used by the widget factory (matches Theme.fg/bg). */
export interface WorkerStreamTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	spinnerFrames: readonly string[];
}

export interface WorkerStreamSlotView {
	name: string;
	text: string;
	status: WorkerStreamStatus;
	startedAtMs?: number;
}

export interface BuildWorkerStreamLinesOptions {
	previewLines: number;
	previewChars: number;
	spinnerFrame: number;
	nowMs?: number;
}

type WidgetUi = Pick<ExtensionUIContext, "setWidget">;

interface WorkerSlot {
	text: string;
	status: WorkerStreamStatus;
	startedAtMs: number;
}

const WIDGET_KEY = "moa-workers";
const DEFAULT_PREVIEW_CHARS = 480;
const DEFAULT_PREVIEW_LINES = 6;
const DEFAULT_SPINNER_MS = 120;

/**
 * Keep the last `maxLines` non-empty-aware lines, then trim to `maxChars`
 * from the end so the newest content stays visible.
 */
export function previewMultilineTail(text: string, maxLines: number, maxChars: number): string[] {
	const rawLines = text.replace(/\r\n/g, "\n").split("\n");
	const trimmed = rawLines.map(l => l.replace(/\t/g, "  "));
	const lastLines = trimmed.slice(-Math.max(1, maxLines));
	let joined = lastLines.join("\n");
	if (joined.length <= maxChars) {
		return lastLines.filter((l, i) => l.length > 0 || i === lastLines.length - 1);
	}
	joined = `…${joined.slice(-(maxChars - 1))}`;
	return joined.split("\n");
}

function statusMeta(
	status: WorkerStreamStatus,
	theme: WorkerStreamTheme,
	spinnerFrame: number,
): { icon: string; label: string; fg: string; bg: string } {
	switch (status) {
		case "ok":
			return { icon: "✓", label: "OK", fg: "success", bg: "toolSuccessBg" };
		case "blocked":
			return { icon: "⊘", label: "BLOCKED", fg: "warning", bg: "toolPendingBg" };
		case "failed":
			return { icon: "✗", label: "FAILED", fg: "error", bg: "toolErrorBg" };
		default: {
			const frames = theme.spinnerFrames.length > 0 ? theme.spinnerFrames : ["…"];
			const icon = frames[spinnerFrame % frames.length] ?? "…";
			return { icon, label: "streaming", fg: "warning", bg: "toolPendingBg" };
		}
	}
}

function formatElapsed(startedAtMs: number | undefined, nowMs: number): string {
	if (!startedAtMs || !Number.isFinite(startedAtMs)) return "";
	const secs = Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
	return ` · ${secs}s`;
}

/** Pure renderer — used by the widget factory and unit tests. */
export function buildWorkerStreamLines(
	slots: ReadonlyArray<WorkerStreamSlotView>,
	theme: WorkerStreamTheme,
	options: BuildWorkerStreamLinesOptions,
): string[] {
	const nowMs = options.nowMs ?? Date.now();
	const out: string[] = [theme.bold(theme.fg("accent", "MOA workers"))];
	for (const slot of slots) {
		const meta = statusMeta(slot.status, theme, options.spinnerFrame);
		const elapsed = formatElapsed(slot.startedAtMs, nowMs);
		const header = theme.fg(meta.fg, `${meta.icon} ${slot.name}  ${meta.label}${elapsed}`);
		out.push(header);
		const preview = previewMultilineTail(slot.text, options.previewLines, options.previewChars);
		if (preview.length === 0 || (preview.length === 1 && !preview[0]?.trim())) {
			out.push(theme.bg(meta.bg, theme.fg("dim", "  (waiting…)")));
		} else {
			for (const line of preview) {
				out.push(theme.bg(meta.bg, theme.fg("toolOutput", `  ${line}`)));
			}
		}
		out.push(""); // spacer between workers
	}
	if (out.length > 1 && out[out.length - 1] === "") out.pop();
	return out;
}

/**
 * Create a throttled UI sink that paints `setWidget("moa-workers", factory)`.
 * Safe with a missing/partial UI (no-ops). Call `clear()` when the run ends.
 */
export function createWorkerStreamSink(
	ui: WidgetUi | undefined,
	options: WorkerStreamSinkOptions = {},
): WorkerStreamSink {
	const throttleMs = options.throttleMs ?? 200;
	const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
	const previewLines = options.previewLines ?? DEFAULT_PREVIEW_LINES;
	const spinnerMs = options.spinnerMs ?? DEFAULT_SPINNER_MS;
	const slots = new Map<string, WorkerSlot>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let spinnerFrame = 0;

	const stopSpinner = () => {
		if (spinnerTimer !== undefined) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	const anyStreaming = () => [...slots.values()].some(s => s.status === "streaming");

	const ensureSpinner = () => {
		if (spinnerMs <= 0 || !ui) return;
		if (!anyStreaming()) {
			stopSpinner();
			return;
		}
		if (spinnerTimer !== undefined) return;
		spinnerTimer = setInterval(() => {
			spinnerFrame += 1;
			paint();
		}, spinnerMs);
	};

	const paint = () => {
		timer = undefined;
		if (!ui || typeof ui.setWidget !== "function") return;
		if (slots.size === 0) {
			ui.setWidget(WIDGET_KEY, undefined);
			stopSpinner();
			return;
		}
		const snapshot: WorkerStreamSlotView[] = [...slots.entries()].map(([name, slot]) => ({
			name,
			text: slot.text,
			status: slot.status,
			startedAtMs: slot.startedAtMs,
		}));
		const frame = spinnerFrame;
		const content: ExtensionWidgetContent = (_tui, theme) => {
			const themed: WorkerStreamTheme = {
				fg: (color, text) => theme.fg(color as never, text),
				bg: (color, text) => theme.bg(color as never, text),
				bold: text => theme.bold(text),
				spinnerFrames: theme.spinnerFrames,
			};
			const lines = buildWorkerStreamLines(snapshot, themed, {
				previewLines,
				previewChars,
				spinnerFrame: frame,
			});
			return new Text(lines.join("\n"), 0, 0);
		};
		ui.setWidget(WIDGET_KEY, content);
		ensureSpinner();
	};

	const schedule = () => {
		if (throttleMs <= 0) {
			paint();
			return;
		}
		if (timer !== undefined) return;
		timer = setTimeout(paint, throttleMs);
	};

	return {
		onPartial(chunk) {
			const existing = slots.get(chunk.name);
			slots.set(chunk.name, {
				text: chunk.text,
				status: existing && existing.status !== "streaming" ? existing.status : "streaming",
				startedAtMs: existing?.startedAtMs ?? Date.now(),
			});
			schedule();
		},
		markStatus(name, status) {
			const existing = slots.get(name) ?? {
				text: "",
				status: "streaming" as const,
				startedAtMs: Date.now(),
			};
			slots.set(name, { text: existing.text, status, startedAtMs: existing.startedAtMs });
			schedule();
		},
		clear() {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			stopSpinner();
			slots.clear();
			if (ui && typeof ui.setWidget === "function") {
				ui.setWidget(WIDGET_KEY, undefined);
			}
		},
	};
}
