/**
 * TUI sink for MoA worker streaming (once-right P5).
 *
 * Minimal-invasive: uses ExtensionUIContext.setWidget to show a throttled
 * per-worker preview above the editor while plan workers run in parallel.
 * Does not depend on custom TUI components.
 */

import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

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
	/** Max chars of the tail preview per worker. Default 160. */
	previewChars?: number;
}

type WidgetUi = Pick<ExtensionUIContext, "setWidget">;

interface WorkerSlot {
	text: string;
	status: WorkerStreamStatus;
}

const WIDGET_KEY = "moa-workers";

function previewTail(text: string, maxChars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxChars) return flat;
	return `…${flat.slice(-(maxChars - 1))}`;
}

function statusTag(status: WorkerStreamStatus): string {
	switch (status) {
		case "ok":
			return "OK";
		case "blocked":
			return "BLOCKED";
		case "failed":
			return "FAILED";
		default:
			return "…";
	}
}

/**
 * Create a throttled UI sink that paints `setWidget("moa-workers", lines)`.
 * Safe with a missing/partial UI (no-ops). Call `clear()` when the run ends.
 */
export function createWorkerStreamSink(
	ui: WidgetUi | undefined,
	options: WorkerStreamSinkOptions = {},
): WorkerStreamSink {
	const throttleMs = options.throttleMs ?? 200;
	const previewChars = options.previewChars ?? 160;
	const slots = new Map<string, WorkerSlot>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const paint = () => {
		timer = undefined;
		if (!ui || typeof ui.setWidget !== "function") return;
		if (slots.size === 0) {
			ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines: string[] = ["MOA workers (streaming):"];
		for (const [name, slot] of slots) {
			const tag = statusTag(slot.status);
			const preview = previewTail(slot.text, previewChars) || "(waiting…)";
			lines.push(`[${name}] ${tag} ${preview}`);
		}
		ui.setWidget(WIDGET_KEY, lines);
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
			});
			schedule();
		},
		markStatus(name, status) {
			const existing = slots.get(name) ?? { text: "", status: "streaming" as const };
			slots.set(name, { text: existing.text, status });
			schedule();
		},
		clear() {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			slots.clear();
			if (ui && typeof ui.setWidget === "function") {
				ui.setWidget(WIDGET_KEY, undefined);
			}
		},
	};
}
