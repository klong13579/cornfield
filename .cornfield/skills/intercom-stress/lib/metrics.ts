/**
 * Metrics pipeline: event collection, JSONL persistence, and report synthesis.
 *
 * Every phase of a run (chess game or synthetic load) emits MetricEvent records.
 * The collector keeps an in-memory ring, flushes to <run>/events.jsonl on a
 * timer, and synthesizes <run>/report.json at the end.
 */

import type { Message } from "../../../../packages/coding-agent/src/intercom-extension/types";

export type MetricEvent =
	| { t: number; kind: "phase"; phase: string }
	| { t: number; kind: "ask_sent"; askId: string; to: string; toName: string }
	| { t: number; kind: "ask_delivered"; askId: string; ok: boolean; reason?: string }
	| { t: number; kind: "reply"; askId: string; from: string; fromName: string; rttMs: number; msg: Message }
	| { t: number; kind: "move"; moveNo: number; side: string; san: string; fen: string; legal: boolean; rttMs?: number; thinkingMs?: number }
	| { t: number; kind: "presence"; sessionId: string; sessionName: string; status?: string; contextPct?: number }
	| { t: number; kind: "receipt"; from: string; messageId: string; status: string; detail?: string }
	| { t: number; kind: "control"; from: string; messageId: string; action: string; detail?: string }
	| { t: number; kind: "session_joined"; sessionId: string; sessionName: string }
	| { t: number; kind: "session_left"; sessionId: string; sessionName: string }
	| { t: number; kind: "disconnected" }
	| { t: number; kind: "reconnected"; sessionId: string }
	| { t: number; kind: "throttle"; detail: string }
	| { t: number; kind: "fault_injected"; fault: string; detail: string }
	| { t: number; kind: "fault_observed"; fault: string; detail: string }
	| { t: number; kind: "game_end"; result: string; reason: string }
	| { t: number; kind: "load_rate"; sendPerSec: number; replyPerSec: number; targetPerSec: number; throttleCount: number }
	| { t: number; kind: "note"; text: string };

export function percentile(sorted: number[], p: number): number | undefined {
	if (sorted.length === 0) return undefined;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)] ?? undefined;
}

export interface Stats {
	count: number;
	min?: number;
	p50?: number;
	p95?: number;
	p99?: number;
	max?: number;
	mean?: number;
}

export function summarize(values: number[]): Stats {
	const sorted = [...values].sort((a, b) => a - b);
	if (values.length === 0) return { count: 0 };
	return {
		count: values.length,
		min: sorted[0],
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: sorted[sorted.length - 1],
		mean: values.reduce((a, b) => a + b, 0) / values.length,
	};
}

export interface PresenceBreakdown {
	totalMs: number;
	byStatus: Record<string, number>;
}

interface PresenceTracker {
	lastStatus: string;
	lastTs: number;
	totalMs: number;
	byStatus: Record<string, number>;
}

	export class Metrics {
	readonly events: MetricEvent[] = [];
	readonly askRttMs: number[] = [];
	readonly throttleCount = { value: 0 };
	readonly faultsInjected: string[] = [];
	readonly faultsObserved: string[] = [];
	readonly deliveryFailures = { value: 0 };
	readonly timeouts = { value: 0 };

	/** Cumulative kind counters — independent of the volatile in-memory event
	 *  queue (which is drained by flush), so reports stay complete. */
	readonly counts = new Map<string, number>();

	/** Broker-side hop latencies accumulated from reply message timestamps. */
	readonly hops = {
		sendToBroker: [] as number[],
		brokerHold: [] as number[],
		brokerToReceiver: [] as number[],
		receiverToInjected: [] as number[],
		endToEnd: [] as number[],
	};

	private presenceTrackers = new Map<string, PresenceTracker>();
	private flushPromise: Promise<void> = Promise.resolve();
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	constructor(
		private readonly eventsPath: string,
		private readonly flushIntervalMs = 500,
	) {}

	start(): void {
		this.flushTimer = setInterval(() => {
			this.flush().catch(() => {});
		}, this.flushIntervalMs);
	}

	record(ev: MetricEvent): void {
		this.counts.set(ev.kind, (this.counts.get(ev.kind) ?? 0) + 1);
		if (ev.kind === "ask_delivered" && !ev.ok) this.deliveryFailures.value++;
		if (ev.kind === "note" && ev.text.includes("timeout")) this.timeouts.value++;
		if (ev.kind === "reply") {
			const msg = ev.msg;
			if (msg.brokerReceivedAt !== undefined && msg.timestamp !== undefined && msg.brokerReceivedAt - msg.timestamp >= 0) {
				this.hops.sendToBroker.push(msg.brokerReceivedAt - msg.timestamp);
			}
			if (msg.brokerDeliveredAt !== undefined && msg.timestamp !== undefined && msg.brokerDeliveredAt - msg.timestamp >= 0) {
				this.hops.brokerHold.push(msg.brokerDeliveredAt - msg.timestamp);
			}
			if (msg.receiverReceivedAt !== undefined && msg.brokerDeliveredAt !== undefined && msg.receiverReceivedAt - msg.brokerDeliveredAt >= 0) {
				this.hops.brokerToReceiver.push(msg.receiverReceivedAt - msg.brokerDeliveredAt);
			}
			if (msg.injectedAt !== undefined && msg.receiverReceivedAt !== undefined && msg.injectedAt - msg.receiverReceivedAt >= 0) {
				this.hops.receiverToInjected.push(msg.injectedAt - msg.receiverReceivedAt);
			}
			if (msg.injectedAt !== undefined && msg.timestamp !== undefined && msg.injectedAt - msg.timestamp >= 0) {
				this.hops.endToEnd.push(msg.injectedAt - msg.timestamp);
			}
		}
		this.events.push(ev);
	}

	/** Track presence-state residency per session for the report. */
	presence(sessionId: string, sessionName: string, status: string, contextPct?: number): void {
		const now = Date.now();
		let tracker = this.presenceTrackers.get(sessionId);
		if (!tracker) {
			tracker = { lastStatus: status, lastTs: now, totalMs: 0, byStatus: {} };
			this.presenceTrackers.set(sessionId, tracker);
		} else if (tracker.lastStatus !== status) {
			const elapsed = now - tracker.lastTs;
			tracker.totalMs += elapsed;
			tracker.byStatus[tracker.lastStatus] = (tracker.byStatus[tracker.lastStatus] ?? 0) + elapsed;
			tracker.lastStatus = status;
			tracker.lastTs = now;
		}
		this.record({ t: now, kind: "presence", sessionId, sessionName, status, contextPct });
	}

	presenceBreakdown(sessionId: string): PresenceBreakdown | undefined {
		const tracker = this.presenceTrackers.get(sessionId);
		if (!tracker) return undefined;
		const now = Date.now();
		const elapsed = now - tracker.lastTs;
		return {
			totalMs: tracker.totalMs + elapsed,
			byStatus: { ...tracker.byStatus, [tracker.lastStatus]: (tracker.byStatus[tracker.lastStatus] ?? 0) + elapsed },
		};
	}

	async flush(): Promise<void> {
		if (this.closed || this.events.length === 0) return;
		const batch = this.events.splice(0, this.events.length);
		const lines = batch.map(ev => JSON.stringify(ev)).join("\n") + "\n";
		this.flushPromise = this.flushPromise.then(() =>
			Bun.write(this.eventsPath, lines, { append: true, createPath: true }).catch(() => {}),
		);
		await this.flushPromise;
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.flushTimer) clearInterval(this.flushTimer);
		await this.flush();
	}
}

export interface OpSummary {
	requests: number;
	replies: number;
	deliveryFailures: number;
	timeouts: number;
	throttles: number;
	rateLimitEvents: number;
	askRtt: Stats;
	sendToBroker: Stats;
	brokerHold: Stats;
	brokerToReceiver: Stats;
	receiverToInjected: Stats;
	endToEnd: Stats;
}

export function summarizeOps(metrics: Metrics): OpSummary {
	return {
		requests: metrics.counts.get("ask_sent") ?? 0,
		replies: metrics.counts.get("reply") ?? 0,
		deliveryFailures: metrics.deliveryFailures.value,
		timeouts: metrics.timeouts.value,
		throttles: 0,
		rateLimitEvents: metrics.counts.get("throttle") ?? 0,
		askRtt: summarize(metrics.askRttMs),
		sendToBroker: summarize(metrics.hops.sendToBroker),
		brokerHold: summarize(metrics.hops.brokerHold),
		brokerToReceiver: summarize(metrics.hops.brokerToReceiver),
		receiverToInjected: summarize(metrics.hops.receiverToInjected),
		endToEnd: summarize(metrics.hops.endToEnd),
	};
}