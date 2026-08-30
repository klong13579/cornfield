/**
 * ANSI real-time dashboard. Full-screen when stdout is a TTY; no-op otherwise
 * (callers fall back to plain event lines). Also snapshots state to
 * <run>/live.json every render for external tailing.
 */

export interface WorkerView {
	name: string;
	status: string;
	sessionId?: string;
	contextPct?: number;
	lastRttMs?: number;
}

export interface TuiState {
	mode: string;
	phase: string;
	elapsedMs: number;
	boardAscii?: string;
	moveNo?: number;
	turn?: string;
	lastMove?: string;
	result?: string;
	workers: WorkerView[];
	rttHistory: number[];
	sendCount: number;
	replyCount: number;
	perSec: number;
	targetPerSec?: number;
	throttleCount: number;
	faults: string[];
	eventTail: string[];
	extra?: Array<[string, string]>;
}

const ESC = "\u001b[";
const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[], width = 20): string {
	if (values.length === 0) return "(no data)";
	const windowed = values.slice(-width);
	const max = Math.max(...windowed, 1);
	return windowed
		.map(v => SPARK_BLOCKS[Math.min(SPARK_BLOCKS.length - 1, Math.floor((v / max) * SPARK_BLOCKS.length))] ?? "▁")
		.join("");
}

function box(title: string, lines: string[], width: number): string {
	// Total frame width is width + 4 (2 padding + 2 borders). All edges are
	// padded to the same total so corners align.
	const total = width + 4;
	const dashes = Math.max(1, total - 2 - 3 - 1 - title.length); // ┌─ <title> <dashes> ┐
	const top = "┌─ " + title + " " + "─".repeat(dashes) + "┐";
	const out: string[] = [top];
	for (const line of lines) {
		const visible = stripAnsi(line);
		const pad = Math.max(0, total - 4 - visible);
		out.push("│ " + line + " ".repeat(pad) + " │");
	}
	out.push("└" + "─".repeat(total - 2) + "┘");
	return out.join("\n");
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

export class Tui {
	private readonly active: boolean;
	private lastLiveWrite = 0;

	constructor(
		private readonly tty: boolean,
		private readonly liveJsonPath?: string,
	) {
		this.active = tty;
	}

	start(): void {
		if (!this.active) return;
		process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`);
	}

	render(state: TuiState): void {
		if (!this.active) return;
		const now = Date.now();
		if (now - this.lastLiveWrite >= 250) {
			this.lastLiveWrite = now;
			if (this.liveJsonPath) {
				Bun.write(this.liveJsonPath, JSON.stringify(state, null, 2)).catch(() => {});
			}
		}

		const width = 72;
		const rows: string[] = [];

		const header = `intercom-stress · ${state.mode} · ${state.phase} · ${fmtDuration(state.elapsedMs)}`;
		rows.push(`${ESC}1m${header}${ESC}22m`);

		if (state.boardAscii) {
			const turnLine = `move ${state.moveNo ?? 0} · ${state.turn === "w" ? "white" : "black"} to move` + (state.lastMove ? ` · last: ${state.lastMove}` : "");
			rows.push(turnLine);
			rows.push("");
			for (const line of state.boardAscii.split("\n")) rows.push(line);
			rows.push("");
		}

		if (state.result) rows.push(`${ESC}1mRESULT: ${state.result}${ESC}22m`);

		const workerLines = state.workers.map(w => {
			const ctx = w.contextPct !== undefined ? ` · ctx ${w.contextPct}%` : "";
			const rtt = w.lastRttMs !== undefined ? ` · lastRTT ${fmtDuration(w.lastRttMs)}` : "";
			return `${w.name}: ${w.status}` + ctx + rtt;
		});
		rows.push(box("workers", workerLines, width));

		const stats: Array<[string, string]> = [
			["sent", String(state.sendCount)],
			["replies", String(state.replyCount)],
			["rate", `${state.perSec}/s`],
			...(state.targetPerSec !== undefined ? [["target", `${state.targetPerSec}/s`]] : []),
			["throttle", String(state.throttleCount)],
			["faults", state.faults.join(",") || "-"],
			...(state.extra ?? []),
		];
		rows.push(box("stats", stats.map(([k, v]) => `${k}: ${v}`), width));

		rows.push(box(`rtt sparkline (n=${state.rttHistory.length})`, [sparkline(state.rttHistory)], width));

		rows.push(box("events", state.eventTail.length > 0 ? state.eventTail.slice(-3) : ["(waiting…)"], width));

		const frame = rows.join("\n");
		process.stdout.write(`${ESC}2J${ESC}H${frame}`);
	}

	stop(): void {
		if (!this.active) return;
		process.stdout.write(`${ESC}?25h${ESC}?1049l`);
	}
}