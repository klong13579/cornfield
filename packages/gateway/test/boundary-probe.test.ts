/**
 * Boundary probe suite for IntercomBroker (exploratory — raw sockets bypass
 * the client library so broker-side behavior is observed directly).
 *
 * Findings are logged; assertions encode observed behavior so a future change
 * that alters a boundary is caught.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { IntercomBroker } from "../src/intercom/broker-server";
import { createMessageReader, writeMessage } from "../src/intercom/framing";

// ── raw socket client (no client-lib validation) ─────────────────────────

function registration(name?: string, extra: Record<string, unknown> = {}) {
	return {
		...(name !== undefined ? { name } : {}),
		cwd: "/tmp/boundary-probe",
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		...extra,
	};
}

class RawClient {
	socket: net.Socket;
	received: Array<Record<string, unknown>> = [];
	private readers: Array<(msg: Record<string, unknown>) => void> = [];
	closed = false;
	errorCode: string | null = null;

	constructor(socketPath: string) {
		this.socket = net.connect(socketPath);
		const reader = createMessageReader(
			msg => {
				const record = msg as Record<string, unknown>;
				this.received.push(record);
				for (const r of [...this.readers]) r(record);
			},
			() => {
				this.errorCode = "reader-error";
			},
		);
		this.socket.on("data", reader);
		this.socket.on("close", () => {
			this.closed = true;
		});
	}

	async waitConnect(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.socket.once("connect", () => resolve());
			this.socket.once("error", reject);
		});
	}

	send(msg: unknown): void {
		writeMessage(this.socket, msg);
	}

	/** Wait for a message matching `type` (and optional predicate). */
	async waitFor(type: string, pred?: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
		const existing = this.received.find(m => m.type === type && (!pred || pred(m)));
		if (existing) return existing;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5_000);
			const check = (m: Record<string, unknown>) => {
				if (m.type === type && (!pred || pred(m))) {
					clearTimeout(timer);
					this.readers = this.readers.filter(r => r !== check);
					resolve(m);
				}
			};
			this.readers.push(check);
		});
	}

	destroy(): void {
		this.socket.destroy();
	}
}

function sessionMsg(to: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		type: "send",
		to,
		message: {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			senderSequence: 1,
			content: { text },
			...extra,
		},
	};
}

// ── suite ─────────────────────────────────────────────────────────────────

describe("intercom broker boundary probes", () => {
	let runtimeDir: string;
	let socketPath: string;
	let broker: IntercomBroker;

	beforeEach(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-intercom-boundary-"));
		socketPath = path.join(runtimeDir, "broker.sock");
		broker = new IntercomBroker({ intercomDir: runtimeDir, listenTarget: socketPath });
		await broker.start();
	});

	afterEach(async () => {
		broker.stop();
		await fs.rm(runtimeDir, { recursive: true, force: true });
	});

	test("E1: oversized outgoing frame is rejected at the writing side before it can kill the receiver", async () => {
		// Reader-side guard: MAX_FRAME_BYTES = 1MB. The write side now enforces
		// the SAME cap (serializeMessageToFrame) — a sender emitting >1 MiB
		// fails locally instead of shipping a frame that the recipient's own
		// guard would reject by tearing down their connection.
		const a = new RawClient(socketPath);
		const b = new RawClient(socketPath);
		await a.waitConnect();
		await b.waitConnect();
		a.send({ type: "register", session: registration("alice") });
		b.send({ type: "register", session: registration("bob") });
		await a.waitFor("registered");
		await b.waitFor("registered");

		const big = "x".repeat(1024 * 1024 + 64); // just over 1 MiB
		console.log(
			"[E1] sender write rejected locally:",
			(() => {
				try {
					b.send(sessionMsg("alice", big));
					return "no-throw";
				} catch (err) {
					return (err as Error).message;
				}
			})(),
		);
		expect(() => b.send(sessionMsg("alice", big))).toThrow(/does not fit/);

		// Receiver was never touched: no message, no tear-down, no broadcast.
		await Bun.sleep(300);
		console.log("[E1] receiver closed:", a.closed, "| receiver frames:", a.received.map(m => m.type).join(","));
		expect(a.closed).toBe(false);
		expect(a.received.filter(m => m.type === "message").length).toBe(0);
		a.destroy();
		b.destroy();
	}, 15_000);

	test("E2: slow consumer — write-backpressure guard ejects a peer that stops reading", async () => {
		// A registers then stops reading. B floods big messages. The broker used
		// to buffer unboundedly (observed +45 MiB); writeMessage now tears down
		// a peer whose pending write buffer exceeds 8 MiB (MAX_PENDING_WRITE_BYTES).
		const a = new RawClient(socketPath);
		const b = new RawClient(socketPath);
		await a.waitConnect();
		await b.waitConnect();
		a.send({ type: "register", session: registration("slow") });
		b.send({ type: "register", session: registration("flooder") });
		await a.waitFor("registered");
		await b.waitFor("registered");

		const COUNT = 200;
		const PAYLOAD = 128 * 1024;
		const before = process.memoryUsage().rss;
		for (let i = 0; i < COUNT; i++) {
			b.send({
				type: "send",
				to: "slow",
				message: {
					id: `m${i}`,
					timestamp: Date.now(),
					senderSequence: i + 1,
					content: { text: "z".repeat(PAYLOAD) },
				},
			});
		}
		await new Promise<void>(resolve => {
			const deadline = Date.now() + 10_000;
			const poll = () => {
				if (a.closed || b.closed) return resolve();
				if (Date.now() > deadline) return resolve();
				setTimeout(poll, 50);
			};
			poll();
		});
		const rssDelta = ((process.memoryUsage().rss - before) / 1024 / 1024).toFixed(1);
		console.log(`[E2] a.closed=${a.closed} b.closed=${b.closed} | rss delta ${rssDelta} MiB`);
		// Either side may hit MAX_PENDING_WRITE_BYTES first (the sender's own
		// write buffer or the receiver's delivery buffer) — the point is the
		// unbounded buffering is cut off, not which peer trips it.
		expect(a.closed || b.closed).toBe(true);
		a.destroy();
		b.destroy();
	}, 20_000);

	test("E3: mailbox overflow — oldest queued messages evicted without notice (batched sends, under rate limit)", async () => {
		// MAX_MAILBOX_MESSAGES = 256. A leaves (unregister, stays as
		// disconnected session), B sends 260 queued messages with pacing below
		// the rate limit, then A reconnects with the same name+cwd. Expect:
		// exactly 256 delivered, no delivery_failed for the 4 evicted — B was
		// told "delivered" for all.
		const a = new RawClient(socketPath);
		const b = new RawClient(socketPath);
		await a.waitConnect();
		await b.waitConnect();
		a.send({ type: "register", session: registration("mailbox-alice") });
		b.send({ type: "register", session: registration("mailbox-bob") });
		const aReg = await a.waitFor("registered");
		await b.waitFor("registered");
		const aId = aReg.sessionId as string;

		a.send({ type: "unregister" });
		await Bun.sleep(100); // broker marks A disconnected

		// 260 queued messages, paced: 50 per 600ms burst (100 rps, under limit).
		const TOTAL = 260;
		for (let burst = 0; burst < TOTAL; burst += 50) {
			for (let i = burst; i < Math.min(burst + 50, TOTAL); i++) {
				b.send(sessionMsg(aId, `queued-${i}`));
			}
			await Bun.sleep(600);
		}
		const acks = b.received.filter(m => m.type === "delivered").length;
		const fails = b.received.filter(m => m.type === "delivery_failed").length;
		console.log(`[E3] B acks: ${acks}/${TOTAL}, delivery_failed: ${fails}, B closed: ${b.closed}`);

		// A reconnects with same name+cwd (new session id).
		const a2 = new RawClient(socketPath);
		await a2.waitConnect();
		a2.send({ type: "register", session: registration("mailbox-alice") });
		await a2.waitFor("registered");

		const deadline = Date.now() + 6_000;
		while (a2.received.filter(m => m.type === "message").length < 256 && Date.now() < deadline) {
			await Bun.sleep(20);
		}
		const got = a2.received.filter(m => m.type === "message").length;
		console.log(`[E3] A2 received: ${got} (expected 256; ${TOTAL - got} evicted)`);
		// Fixed: evicted entries now surface as delivery_failed to the sender —
		// 256 delivered + 4 delivery_failed covers all 260 sends.
		const deadline2 = Date.now() + 5_000;
		while (b.received.filter(m => m.type === "delivery_failed").length < 4 && Date.now() < deadline2) {
			await Bun.sleep(20);
		}
		// Fixed: every send is accounted for — 260 delivered (accepted into the
		// mailbox) plus 4 delivery_failed (evicted) instead of 260 delivered
		// with 4 silently vanished.
		expect(b.received.filter(m => m.type === "delivered").length).toBe(TOTAL);
		expect(b.received.filter(m => m.type === "delivery_failed").length).toBe(4);
		expect(a2.received.filter(m => m.type === "message").length).toBe(256);
		a.destroy();
		b.destroy();
		a2.destroy();
	}, 30_000);

	test("T3: protocol violation gets an explicit error frame on a healthy connection", async () => {
		// Before the fix, any reader error (protocol violation, oversized frame,
		// JSON parse failure) destroyed the sender's socket with no notification.
		// On a healthy connection the peer now receives the `error` frame first.
		const b = new RawClient(socketPath);
		await b.waitConnect();
		b.send({
			type: "send",
			to: "nobody",
			message: { id: "x", timestamp: 1, senderSequence: 1, content: { text: "hi" } },
		});
		const err = await b.waitFor("error");
		console.log("[T3] error frame received:", String(err.error).slice(0, 60));
		expect(String(err.error)).toContain("before register");
		b.destroy();
	}, 10_000);

	test("T2: frame overflowing only AFTER broker repackaging is rejected with delivery_failed, receiver survives", async () => {
		// text = 1 MiB - 150: the sender's own frame (payload + ~105 B send
		// wrapper) fits under the reader cap, but the broker's forwarding frame
		// (adds SessionInfo, ~250 B) exceeds 1 MiB. Old behavior: the recipient
		// was torn down by its own frame guard while the sender got a lying
		// delivered ack. Fixed: the broker pre-flights the forwarding frame and
		// rejects with delivery_failed; the recipient is never touched.
		const a = new RawClient(socketPath);
		const b = new RawClient(socketPath);
		await a.waitConnect();
		await b.waitConnect();
		a.send({ type: "register", session: registration("t2-alice") });
		b.send({ type: "register", session: registration("t2-bob") });
		await a.waitFor("registered");
		await b.waitFor("registered");

		const nearLimit = "y".repeat(1024 * 1024 - 200);
		b.send(sessionMsg("t2-alice", nearLimit));
		const failed = await b.waitFor("delivery_failed", m => String(m.reason).includes("frame limit"));
		await Bun.sleep(100);
		console.log(
			`[T2] reason: ${failed.reason} | receiver alive: ${!a.closed} | receiver got message frames: ${a.received.filter(m => m.type === "message").length}`,
		);
		expect(String(failed.reason)).toContain("frame limit");
		expect(a.closed).toBe(false); // recipient MUST NOT be torn down
		expect(a.received.filter(m => m.type === "message").length).toBe(0);
		a.destroy();
		b.destroy();
	}, 15_000);

	test("E7: rate limit — burst of 280 messages in one second disconnects the sender", async () => {
		// RATE_LIMIT_CAPACITY = 240, REFILL 120/s. A sender that bursts >240
		// frames is disconnected mid-burst (no queueing, no backoff info).
		// Legit batch sends (260+ notifications at once) trip this too.
		const a = new RawClient(socketPath);
		const b = new RawClient(socketPath);
		await a.waitConnect();
		await b.waitConnect();
		a.send({ type: "register", session: registration("rl-alice") });
		b.send({ type: "register", session: registration("rl-bob") });
		const aReg = await a.waitFor("registered");
		await b.waitFor("registered");
		const aId = aReg.sessionId as string;

		const TOTAL = 280; // > capacity(240) in a tight loop
		for (let i = 0; i < TOTAL; i++) {
			b.send({
				type: "send",
				to: aId,
				message: { id: `rl${i}`, timestamp: Date.now(), senderSequence: i + 1, content: { text: `rl-${i}` } },
			});
		}
		await Bun.sleep(500); // settle
		const got = a.received.filter(m => m.type === "message").length;
		const errors = b.received.filter(m => m.type === "error").length;
		console.log(`[E7] sender alive: ${!b.closed} | throttle acks: ${errors} | receiver got: ${got}/${TOTAL}`);
		// Fixed: a burst is throttled with per-frame error acks and the
		// connection SURVIVES — only a sustained flood (50 consecutive
		// rejections) earns a disconnect.
		expect(b.closed).toBe(false);
		expect(errors).toBeGreaterThan(0);
		// Allow one in-flight frame to settle before asserting the capacity
		// portion was delivered.
		if (got < 240) {
			await Bun.sleep(1_000);
		}
		expect(a.received.filter(m => m.type === "message").length).toBeGreaterThanOrEqual(238);
		a.destroy();
		b.destroy();
	});

	test("E5: send to session whose socket is destroyed — delivery result depends on write-path exceptions", async () => {
		// A's socket dies without unregister (broker state still has A).
		// B sends to A. Question: does B get "delivered" (silent drop) or is
		// B itself disconnected (exception unwinding through the reader)?
		const a = new RawClient(socketPath);
		const b = new RawClient(socketPath);
		await a.waitConnect();
		await b.waitConnect();
		a.send({ type: "register", session: registration("ghost") });
		b.send({ type: "register", session: registration("sender") });
		const aReg = await a.waitFor("registered");
		await b.waitFor("registered");
		const aId = aReg.sessionId as string;

		// Kill A's connection abruptly (no unregister, no FIN ceremony).
		a.socket.destroy();

		// Give the broker a tick to (not) notice.
		await Bun.sleep(50);
		b.send(sessionMsg(aId, "hello ghost"));
		await Bun.sleep(50);
		console.log("[E5] B received:", b.received.map(m => m.type).join(","), "| B closed:", b.closed);

		// Whatever the result, B must NOT be disconnected by A's death.
		expect(b.closed).toBe(false);
		b.destroy();
	});

	test("E6: id-shadows-name and prefix routing ambiguities", async () => {
		// findSessions resolution order: byId → byName → id-prefix.
		// A: name "target", id "x".  B: name "x", id "target".
		// Sending to "x" resolves byId to B — even though A is named "x".
		const a = new RawClient(socketPath);
		const b = new RawClient(socketPath);
		await a.waitConnect();
		await b.waitConnect();
		a.send({ type: "register", session: registration("target"), sessionId: "x" });
		b.send({ type: "register", session: registration("x"), sessionId: "target" });
		await a.waitFor("registered");
		await b.waitFor("registered");

		// B sends to "x" — byId hits B itself (self-send!), A (name "x") never sees it.
		b.send(sessionMsg("x", "who gets this?"));
		const delivered = await b.waitFor("delivered");
		await Bun.sleep(50);
		console.log(
			"[E6] B self-delivered:",
			delivered.messageId !== undefined,
			"| A got message:",
			a.received.some(m => m.type === "message"),
		);

		// Prefix: with a second session "x2", sending to "x" now matches 2 → rejected.
		const c = new RawClient(socketPath);
		await c.waitConnect();
		c.send({ type: "register", session: registration("c"), sessionId: "x2" });
		await c.waitFor("registered");
		b.send(sessionMsg("x", "prefix probe"));
		const result = await Promise.race([
			b.waitFor("delivered").then(() => "delivered"),
			b.waitFor("delivery_failed").then(m => `failed:${m.reason}`),
		]);
		console.log("[E6] first-message day: B->x delivered, A saw nothing | prefix round:", result);
		a.destroy();
		b.destroy();
		c.destroy();
	});
});
