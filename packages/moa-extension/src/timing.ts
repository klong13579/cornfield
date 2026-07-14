/**
 * MOA stage wall-clock helpers (docs/plans/2026-07-15-moa-stage-timing-design.md).
 */

export type MoaTimingKey =
	| "discovery"
	| "ask"
	| "rewrite"
	| "workers"
	| `workers_r${number}`
	| "synthesis"
	| "total"
	| (string & {});

export function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	const seconds = safe / 1000;
	return `${seconds.toFixed(1)}s`;
}

export class StageClock {
	#now: () => number;
	#starts = new Map<string, number>();
	#values = new Map<string, number>();
	#totalStart: number | undefined;

	constructor(now: () => number = () => Date.now()) {
		this.#now = now;
	}

	/** Test hook: replace the clock source after construction. */
	set now(fn: () => number) {
		this.#now = fn;
	}

	get now(): () => number {
		return this.#now;
	}

	markTotalStart(at?: number): void {
		this.#totalStart = at ?? this.#now();
	}

	start(key: string): void {
		this.#starts.set(key, this.#now());
	}

	elapsedMs(key: string): number {
		const started = this.#starts.get(key);
		if (started === undefined) return this.#values.get(key) ?? 0;
		return Math.max(0, this.#now() - started);
	}

	stop(key: string): number {
		const started = this.#starts.get(key);
		const elapsed = started === undefined ? 0 : Math.max(0, this.#now() - started);
		this.#starts.delete(key);
		this.#values.set(key, elapsed);

		const roundMatch = /^workers_r(\d+)$/.exec(key);
		if (roundMatch) {
			const prev = this.#values.get("workers") ?? 0;
			this.#values.set("workers", prev + elapsed);
		}
		return elapsed;
	}

	stopTotal(): number {
		const start = this.#totalStart ?? this.#now();
		const elapsed = Math.max(0, this.#now() - start);
		this.#values.set("total", elapsed);
		return elapsed;
	}

	get(key: string): number {
		return this.#values.get(key) ?? 0;
	}

	/** Snapshot of recorded (stopped) timings. */
	snapshot(): Record<string, number> {
		return Object.fromEntries(this.#values.entries());
	}

	record(key: string, ms: number): void {
		this.#values.set(key, Math.max(0, ms));
	}
}

const SUMMARY_ORDER = ["discovery", "ask", "rewrite", "workers", "synthesis", "total"] as const;

function padLabel(label: string): string {
	return label.padEnd(10, " ");
}

export function formatTimingSummary(timings: Record<string, number>): string {
	const lines: string[] = ["MOA 耗时"];
	for (const key of SUMMARY_ORDER) {
		const ms = timings[key] ?? 0;
		let line = `  ${padLabel(key)}${formatDuration(ms)}`;
		if (key === "workers") {
			const rounds = Object.keys(timings)
				.map(k => {
					const m = /^workers_r(\d+)$/.exec(k);
					return m ? { n: Number(m[1]), ms: timings[k] ?? 0 } : null;
				})
				.filter((x): x is { n: number; ms: number } => x !== null)
				.sort((a, b) => a.n - b.n);
			if (rounds.length > 1) {
				const parts = rounds.map(r => `r${r.n} ${formatDuration(r.ms)}`);
				line += `   (${parts.join(" + ")})`;
			}
		}
		lines.push(line);
	}
	return lines.join("\n");
}
