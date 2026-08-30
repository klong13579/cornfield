/**
 * Synthetic load generator. Registers N virtual sessions as broker clients
 * (no LLM, no pi processes), each replying to asks with instant "pong"
 * replies; the controller drives a ramp of concurrent asks at a target rate.
 *
 * The broker rate-limits per connection (burst ~240, steady ~120 frames/s,
 * disconnect after ~50 consecutive rejections). The loader's headline output
 * is the throttle boundary: the aggregate rate at which the first rejection
 * appears. Default profile stops at the boundary; --aggressive keeps pushing.
 */

import type { Message } from "../../../../packages/coding-agent/src/intercom-extension/types";
import { BrokerSession } from "./broker";
import type { Metrics } from "./metrics";

export interface LoadConfig {
	/** Virtual worker sessions to register. */
	sessions: number;
	/** Peak target rate (asks per second, controller-side). */
	rampTo: number;
	/** Seconds to ramp from 0 to rampTo. */
	rampS: number;
	/** Seconds to hold after ramping (or at the throttle boundary). */
	soakS: number;
	/** Keep pushing past the throttle boundary instead of settling. */
	aggressive: boolean;
	/** Reply delay jitter per vhost, ms. */
	jitterMs: number;
	/** Max unanswered asks the controller keeps in flight per vhost. */
	maxInflightPerVhost: number;
	/** Per-ask timeout, ms. */
	askTimeoutMs: number;
	/** Controller session name in the broker roster. */
	name: string;
	/** External stop request (Ctrl-C): checked between pacing ticks. */
	stop?: () => boolean;
}

export interface LoadTick {
	sentTotal: number;
	replyTotal: number;
	perSec: number;
	targetPerSec: number;
	throttleCount: number;
	elapsedMs: number;
}

export interface LoadOutcome {
	throttleFirstAtPerSec: number | null;
	throttleEvents: number;
	deliveryFailures: number;
	timeouts: number;
	peakAchievedPerSec: number;
	avgReplyRttMs: number | null;
}

interface InflightAsk {
	vhostIndex: number;
	timer: ReturnType<typeof setTimeout>;
}

export class Loadgen {
	private readonly vhosts: BrokerSession[] = [];
	private readonly inflight = new Map<string, InflightAsk>();
	private readonly perVhostInflight: number[] = [];
	private rateLimited = false;

	private replyRtts: number[] = [];

	constructor(
		private readonly cfg: LoadConfig,
		private readonly metrics: Metrics,
		private readonly onTick?: (tick: LoadTick) => void,
	) {}

	private vhostName(index: number): string {
		return `${this.cfg.name}-vhost-${index}`;
	}

	private async spawnVhost(index: number): Promise<void> {
		const created = Date.now();
		const vhost = new BrokerSession(
			{
				cwd: process.cwd(),
				model: "intercom-stress/vhost",
				pid: process.pid,
				startedAt: created,
				lastActivity: created,
				name: this.vhostName(index),
				status: "idle",
			},
			event => {
				// Per-connection rate-limit rejections must be visible: the vhost's
				// own bucket is usually the binding constraint in a ping-pong load.
				if (event.type === "error") {
					this.rateLimited = true;
					this.metrics.record({ t: Date.now(), kind: "throttle", detail: event.error });
				}
			},
		);
		await vhost.connect();
		if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] vhost ${index} connected ${vhost.sessionId?.slice(0, 8)}\n`);
		vhost.client.on("message", (from, message: Message) => {
			if (!message.expectsReply || message.replyTo) return;
			const delay = Math.max(0, Math.round(Math.random() * this.cfg.jitterMs));
			if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] vhost ${index} got ask ${message.id.slice(0, 8)} from ${from.id.slice(0, 8)}\n`);
			setTimeout(() => {
				vhost.client.send(from.id, { text: "pong", replyTo: message.id, expectsReply: false }).then(r => {
					if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] vhost ${index} reply sent delivered=${r.delivered}\n`);
				}).catch(e => process.stdout.write(`[dbg] vhost ${index} reply send failed: ${e.message}\n`));
			}, delay);
		});
		this.vhosts.push(vhost);
		this.perVhostInflight[index] = 0;
	}

	async run(): Promise<LoadOutcome> {
		const controller = new BrokerSession(
			{ cwd: process.cwd(), model: "intercom-stress/load", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), name: this.cfg.name, status: "driver" },
			event => {
				if (event.type === "error") {
					// Broker-level rate-limit rejection for one of our frames.
					this.rateLimited = true;
					this.metrics.record({ t: Date.now(), kind: "throttle", detail: event.error });
				}
				if (event.type === "left") {
					this.metrics.record({
						t: Date.now(),
						kind: "note",
						text: `session left: ${event.sessionId}`,
					});
				}
			},
		);
		await controller.connect();

		for (let i = 0; i < this.cfg.sessions; i++) await this.spawnVhost(i);
		controller.updatePresence("ramping");

		const start = Date.now();
		const totalMs = (this.cfg.rampS + this.cfg.soakS) * 1000;
		let sentTotal = 0;
		let replyTotal = 0;
		let deliveryFailures = 0;
		let timeouts = 0;
		let throttleEvents = 0;
		let throttleFirstAtPerSec: number | null = null;
		let vhostCursor = 0;
		let throttledRate = 0;

		// Second-window throughput.
		const perSecondSends: number[] = [];
		const perSecondReplies: number[] = [];
		let secondWindowStart = Date.now();
		let sendsInWindow = 0;
		let repliesInWindow = 0;
		let lastTickSent = 0;
		let lastTickReplies = 0;
		let lastTickAt = Date.now();

		controller.client.on("message", (from, message: Message) => {
			if (!message.replyTo) return;
			const pending = this.inflight.get(message.replyTo);
			if (process.env.ICS_DEBUG) process.stdout.write(`[dbg] controller got reply to ${message.replyTo.slice(0, 8)} from ${from.id.slice(0, 8)} pending=${pending !== undefined}\n`);
			if (!pending) return;
			this.inflight.delete(message.replyTo);
			clearTimeout(pending.timer);
			this.perVhostInflight[pending.vhostIndex] = Math.max(0, this.perVhostInflight[pending.vhostIndex] - 1);
			replyTotal++;
			repliesInWindow++;
			const rtt = Date.now() - message.timestamp;
			this.replyRtts.push(rtt);
			this.metrics.askRttMs.push(rtt);
			this.metrics.record({
				t: Date.now(),
				kind: "reply",
				askId: message.replyTo,
				from: from.id,
				fromName: this.vhostName(pending.vhostIndex),
				rttMs: rtt,
				msg: message,
			});
		});

		const sendOne = async (vhostIndex: number): Promise<void> => {
			const target = this.vhosts[vhostIndex];
			if (!target?.sessionId) return;
			const askId = crypto.randomUUID();
			const sentAt = Date.now();
			this.inflight.set(askId, { vhostIndex, timer: setTimeout(() => undefined, 0) });
			this.perVhostInflight[vhostIndex] = (this.perVhostInflight[vhostIndex] ?? 0) + 1;
			const timer = setTimeout(() => {
				if (!this.inflight.has(askId)) return;
				this.inflight.delete(askId);
				this.perVhostInflight[vhostIndex] = Math.max(0, this.perVhostInflight[vhostIndex] - 1);
				timeouts++;
				controller.client.cancelAsk(askId);
				this.metrics.record({ t: Date.now(), kind: "note", text: `ask timeout: ${askId.slice(0, 8)}` });
			}, this.cfg.askTimeoutMs);
			const entry = this.inflight.get(askId);
			if (entry) entry.timer = timer;

			this.metrics.record({ t: sentAt, kind: "ask_sent", askId, to: target.sessionId, toName: this.vhostName(vhostIndex) });
			try {
				const res = await controller.client.send(target.sessionId, { text: "ping", messageId: askId, expectsReply: true });
				sentTotal++;
				sendsInWindow++;
				if (!res.delivered) {
					deliveryFailures++;
					this.metrics.record({ t: Date.now(), kind: "ask_delivered", askId, ok: false, reason: res.reason ?? "undelivered" });
					if ((res.reason ?? "").includes("rate")) {
						this.rateLimited = true;
					}
				} else {
					this.metrics.record({ t: Date.now(), kind: "ask_delivered", askId, ok: true });
				}
			} catch (error) {
				deliveryFailures++;
				this.metrics.record({ t: Date.now(), kind: "ask_delivered", askId, ok: false, reason: String(error) });
			}
		};

		// 200ms paced tick: send enough asks to track the target rate curve.
		let placedTotal = 0;
		let tickCount = 0;
		const tick = async (): Promise<void> => {
			const elapsedSec = (Date.now() - start) / 1000;
			const targetRate = Math.min(this.cfg.rampTo, (this.cfg.rampTo * elapsedSec) / this.cfg.rampS);
			const tickMs = 100;
			const desired = Math.max(0, Math.round((targetRate * tickMs) / 1000));
			for (let i = 0; i < desired; i++) {
				let placed = false;
				for (let j = 0; j < this.cfg.sessions; j++) {
					const v = (vhostCursor + j) % this.cfg.sessions;
					if ((this.perVhostInflight[v] ?? 0) < this.cfg.maxInflightPerVhost) {
						void sendOne(v);
						vhostCursor = (vhostCursor + 1) % this.cfg.sessions;
						placed = true;
						placedTotal++;
						break;
					}
				}
				if (!placed) break;
			}
			tickCount++;
			if (process.env.ICS_DEBUG && tickCount % 10 === 0) {
				const inflightSum = [...this.inflight.values()].length;
				process.stdout.write(`[dbg] t=${((Date.now() - start) / 1000).toFixed(0)}s target=${targetRate.toFixed(0)} desired=${desired} placed-ish=${(placedTotal / tickCount).toFixed(1)}/tick inflight=${inflightSum}/${this.cfg.sessions * this.cfg.maxInflightPerVhost}\n`);
			}

			// Throttle bookkeeping.
			if (this.rateLimited) {
				throttleEvents = this.metrics.counts.get("throttle") ?? 0;
				if (throttleFirstAtPerSec === null) {
					throttleFirstAtPerSec = targetRate;
					throttledRate = targetRate;
					this.metrics.record({
						t: Date.now(),
						kind: "note",
						text: `throttle boundary hit at ~${targetRate.toFixed(0)} msg/s target`,
					});
				}
			}

			// Roll 1-second windows.
			const now = Date.now();
			if (now - secondWindowStart >= 1000) {
				perSecondSends.push(sendsInWindow);
				perSecondReplies.push(repliesInWindow);
				sendsInWindow = 0;
				repliesInWindow = 0;
				secondWindowStart = now;
				const sendPerSec = perSecondSends[perSecondSends.length - 1] ?? 0;
				const replyPerSec = perSecondReplies[perSecondReplies.length - 1] ?? 0;
				this.metrics.record({
					t: now,
					kind: "load_rate",
					sendPerSec,
					replyPerSec,
					targetPerSec: targetRate,
					throttleCount: throttleEvents,
				});
				this.onTick?.({
					sentTotal,
					replyTotal,
					perSec: replyPerSec,
					targetPerSec: targetRate,
					throttleCount: throttleEvents,
					elapsedMs: Date.now() - start,
				});
			}
		};

		while (!this.cfg.stop?.() && Date.now() - start < totalMs) {
			await tick();
			// After the boundary, hold the soak at a sustainable level unless aggressive.
			if (this.rateLimited && !this.cfg.aggressive) {
				const alreadySoaking = Date.now() - start >= this.cfg.rampS * 1000;
				if (alreadySoaking) {
					// keep ticking at the boundary rate (tick() paces off the curve, which is now capped)
					await Bun.sleep(50);
				} else {
					await Bun.sleep(10);
				}
			} else {
				await Bun.sleep(100);
			}
		}

		// Final window.
		perSecondSends.push(sendsInWindow);
		perSecondReplies.push(repliesInWindow);

		// Drain: cancel outstanding asks, settle.
		for (const askId of this.inflight.keys()) {
			const pending = this.inflight.get(askId);
			if (pending) clearTimeout(pending.timer);
			controller.client.cancelAsk(askId);
		}
		this.inflight.clear();
		await Bun.sleep(200);

		controller.updatePresence("finalizing");
		for (const vhost of this.vhosts) await vhost.disconnect();
		await controller.disconnect();

		return {
			throttleFirstAtPerSec,
			throttleEvents,
			deliveryFailures,
			timeouts,
			peakAchievedPerSec: Math.max(...perSecondSends, 0),
			avgReplyRttMs: this.replyRtts.length > 0 ? this.replyRtts.reduce((a, b) => a + b, 0) / this.replyRtts.length : null,
		};
	}
}