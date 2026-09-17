import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import piIntercomExtension from "../src/intercom-extension";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal broker implementing just enough of the pi-intercom protocol:
// register → registered, list → sessions.
//
// `down()` simulates a broker outage the way the real world produces one:
// stop listening and unlink the socket file, so client connect attempts fail
// immediately (ENOENT) instead of hanging on Bun's unreliable destroy
// propagation. `up()` re-binds. The broker lives at
// `<tmpRoot>/intercom/broker.sock`, where tmpRoot is the parent of the
// isolated CORNFIELD_AGENT_DIR — same resolution the real client uses.
// ─────────────────────────────────────────────────────────────────────────────
class FakeBroker {
	private server: net.Server;
	private sockets = new Set<net.Socket>();
	rejecting = false;
	/** Number of completed registrations (register → registered round-trip). */
	registrations = 0;
	/** Number of TCP-level connection attempts that reached the broker. */
	connections = 0;
	/** Number of `list` requests answered. */
	listCalls = 0;
	/** Number of `list` requests deliberately left unanswered (a stalled broker). */
	ignoredListRequests = 0;
	/** Ignore this many upcoming `list` requests, then answer normally again. */
	stallNextLists = 0;
	/** Roster returned by `list`. */
	peers: Array<Record<string, unknown>> = [];
	/** Targets of accepted `send` requests. */
	sentTo: string[] = [];

	constructor(readonly socketPath: string) {
		this.server = net.createServer(socket => this.handleConnection(socket));
	}

	private handleConnection(socket: net.Socket): void {
		this.connections += 1;
		if (this.rejecting) {
			socket.destroy();
			return;
		}
		this.sockets.add(socket);
		let buf = Buffer.alloc(0);
		socket.on("data", (data: Buffer) => {
			buf = Buffer.concat([buf, data]);
			while (buf.length >= 4) {
				const len = buf.readUInt32BE(0);
				if (buf.length < 4 + len) break;
				const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
				buf = buf.subarray(4 + len);
				this.handle(socket, msg);
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => this.sockets.delete(socket));
	}

	private handle(socket: net.Socket, msg: Record<string, unknown>): void {
		if (msg.type === "register") {
			const id = typeof msg.sessionId === "string" ? msg.sessionId : "fake-session";
			this.registrations += 1;
			this.write(socket, { type: "registered", sessionId: id, features: ["extension-bus-v1"] });
			return;
		}
		if (msg.type === "list") {
			if (this.stallNextLists > 0) {
				this.stallNextLists -= 1;
				this.ignoredListRequests += 1;
				return;
			}
			this.listCalls += 1;
			this.write(socket, { type: "sessions", requestId: msg.requestId, sessions: this.peers });
			return;
		}
		if (msg.type === "send") {
			const sent = msg.message as { id?: unknown } | undefined;
			this.sentTo.push(String(msg.to));
			this.write(socket, { type: "delivered", messageId: typeof sent?.id === "string" ? sent.id : "unknown" });
			return;
		}
		// presence_update / unregister / extension_* — ignore.
	}

	private write(socket: net.Socket, msg: unknown): void {
		const json = JSON.stringify(msg);
		const frame = Buffer.allocUnsafe(4 + Buffer.byteLength(json));
		frame.writeUInt32BE(Buffer.byteLength(json), 0);
		frame.write(json, 4);
		socket.write(frame);
	}

	async listen(): Promise<void> {
		fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.socketPath, () => resolve());
		});
	}

	/** Stop accepting and remove the socket file: connects fail immediately. */
	down(): void {
		for (const socket of [...this.sockets]) socket.destroy();
		this.server.close();
		try {
			fs.unlinkSync(this.socketPath);
		} catch {
			// already gone
		}
	}

	close(): void {
		for (const socket of this.sockets) socket.destroy();
		this.server.close();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ExtensionAPI fake: only the surface piIntercomExtension touches.
// ─────────────────────────────────────────────────────────────────────────────
function makeFakePi(): {
	pi: ExtensionAPI;
	emit: (event: string, ...args: unknown[]) => void;
	tools: Map<string, (...args: unknown[]) => unknown>;
} {
	const sessionName = "repro-session";
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const eventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const tools = new Map<string, (...args: unknown[]) => unknown>();
	const noop = () => undefined;
	const pi = {
		on: (event: string, cb: (...args: unknown[]) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(cb);
			handlers.set(event, list);
			return () => undefined;
		},
		events: {
			on: (event: string, cb: (...args: unknown[]) => unknown) => {
				const list = eventHandlers.get(event) ?? [];
				list.push(cb);
				eventHandlers.set(event, list);
				return () => undefined;
			},
			emit: (event: string, payload?: unknown) => {
				for (const cb of eventHandlers.get(event) ?? []) cb(payload);
			},
		},
		getSessionName: () => sessionName,
		registerCommand: noop,
		registerMessageRenderer: noop,
		registerShortcut: noop,
		registerTool: (tool: { name?: string; execute?: (...args: unknown[]) => unknown }) => {
			if (typeof tool?.name === "string" && typeof tool.execute === "function") {
				tools.set(tool.name, tool.execute);
			}
		},
		appendEntry: noop,
		sendMessage: noop,
	} as unknown as ExtensionAPI;

	function emit(event: string, ...args: unknown[]): void {
		for (const cb of handlers.get(event) ?? []) cb(...args);
	}
	return { pi, emit, tools };
}

function makeCtx(sessionId: string): ExtensionContext {
	const noop = () => undefined;
	return {
		ui: {},
		mode: "tui",
		getContextUsage: () => undefined,
		compact: noop,
		hasUI: false,
		cwd: os.tmpdir(),
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {},
		model: { id: "test-model" },
		scopedModels: [],
		isIdle: () => true,
		signal: undefined,
		abort: noop,
		hasPendingMessages: () => false,
		shutdown: noop,
		getSystemPrompt: () => "",
		hasQueuedMessages: () => false,
	} as unknown as ExtensionContext;
}

// ─────────────────────────────────────────────────────────────────────────────

let savedAgentDir: string | undefined;
let savedLivenessInterval: string | undefined;
let savedLivenessTimeout: string | undefined;
const tmpRoots: string[] = [];

beforeEach(() => {
	savedAgentDir = process.env.CORNFIELD_AGENT_DIR;
	savedLivenessInterval = process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS;
	savedLivenessTimeout = process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS;
});

afterEach(() => {
	if (savedAgentDir === undefined) {
		delete process.env.CORNFIELD_AGENT_DIR;
	} else {
		process.env.CORNFIELD_AGENT_DIR = savedAgentDir;
	}
	if (savedLivenessInterval === undefined) {
		delete process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS;
	} else {
		process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = savedLivenessInterval;
	}
	if (savedLivenessTimeout === undefined) {
		delete process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS;
	} else {
		process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS = savedLivenessTimeout;
	}
	for (const root of tmpRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/**
 * `PI_INTERCOM_LIVENESS_TIMEOUT_MS` must be set explicitly to be bounded by the
 * interval — left unset it is a flat 5s, so a fast interval alone does not make
 * a probe time out quickly.
 */
function setupIsolatedEnv(livenessIntervalMs?: number, livenessTimeoutMs?: number): void {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-repro-"));
	tmpRoots.push(tmpRoot);
	process.env.CORNFIELD_AGENT_DIR = path.join(tmpRoot, "agent");
	if (livenessIntervalMs !== undefined) {
		process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = String(livenessIntervalMs);
	}
	if (livenessTimeoutMs !== undefined) {
		process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS = String(livenessTimeoutMs);
	}
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		const started = Date.now();
		const tick = () => {
			if (condition()) {
				resolve(true);
				return;
			}
			if (Date.now() - started > timeoutMs) {
				resolve(false);
				return;
			}
			setTimeout(tick, 100);
		};
		tick();
	});
}

describe("intercom extension reconnect", () => {
	test("registers when the broker is reachable at startup (sanity)", async () => {
		setupIsolatedEnv();
		const tmpRoot = path.dirname(process.env.CORNFIELD_AGENT_DIR!);
		const broker = new FakeBroker(path.join(tmpRoot, "intercom", "broker.sock"));
		await broker.listen();

		const sessionId = "sess-sanity-1";
		const { pi, emit } = makeFakePi();
		piIntercomExtension(pi);
		emit("session_start", {}, makeCtx(sessionId));

		const registered = await waitFor(() => broker.registrations >= 1, 5000);
		emit("session_shutdown", {});
		broker.close();
		expect(registered).toBe(true);
	}, 15_000);

	test("eventually registers after the broker recovers from a startup outage", async () => {
		setupIsolatedEnv();
		const tmpRoot = path.dirname(process.env.CORNFIELD_AGENT_DIR!);
		const broker = new FakeBroker(path.join(tmpRoot, "intercom", "broker.sock"));

		const sessionId = "sess-recovery-1";
		const { pi, emit } = makeFakePi();
		piIntercomExtension(pi);

		// Broker down when the session starts: the startup attempt and the first
		// scheduled retry (backoff 1s) both fail immediately (ENOENT). Backoff
		// for the next attempt would be 2s, so the broker comes back at 2.5s —
		// a working reconnect chain must then register at ~3s.
		await new Promise(resolve => setTimeout(resolve, 100));
		broker.down();
		emit("session_start", {}, makeCtx(sessionId));
		await new Promise(resolve => setTimeout(resolve, 2500));
		expect(broker.registrations).toBe(0);
		await broker.listen();

		const registered = await waitFor(() => broker.registrations >= 1, 12_000);
		emit("session_shutdown", {});
		broker.close();
		expect(registered).toBe(true);
	}, 30_000);

	test("re-registers after a live connection is dropped during a broker outage", async () => {
		// Speed up liveness detection so the drop is noticed within ~0.5s.
		setupIsolatedEnv(500);
		const tmpRoot = path.dirname(process.env.CORNFIELD_AGENT_DIR!);
		const broker = new FakeBroker(path.join(tmpRoot, "intercom", "broker.sock"));
		await broker.listen();

		const sessionId = "sess-drop-1";
		const { pi, emit } = makeFakePi();
		piIntercomExtension(pi);
		emit("session_start", {}, makeCtx(sessionId));
		expect(await waitFor(() => broker.registrations >= 1, 5000)).toBe(true);

		// Broker disappears (socket unlinked) while the session is live. The
		// liveness probe detects the dead connection, and the first reconnect
		// attempt (backoff 1s after detection) lands inside the outage. The
		// broker returns at 2.6s after the drop.
		broker.down();
		await new Promise(resolve => setTimeout(resolve, 2600));
		await broker.listen();

		const reregistered = await waitFor(() => broker.registrations >= 2, 15_000);
		emit("session_shutdown", {});
		broker.close();
		expect(reregistered).toBe(true);
	}, 40_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Broker-hosted target resolution.
//
// The broker lives inside cornfield-gateway, so a stalled gateway event loop
// makes `list` miss its 5s budget. If resolving a target needs that round-trip,
// a healthy `send` fails as "Failed to send: List sessions timeout". The roster
// the extension already keeps warm from list/join/leave/presence must answer
// the common case; only what it cannot settle may reach the broker.
// ─────────────────────────────────────────────────────────────────────────────

function peer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const now = 1_700_000_000_000;
	return {
		id: "peer-session-1",
		name: "peer",
		cwd: os.tmpdir(),
		model: "test-model",
		pid: 4321,
		startedAt: now,
		lastActivity: now,
		...overrides,
	};
}

describe("intercom target resolution", () => {
	test("resolves a send target from the warm roster while the broker stalls `list`", async () => {
		setupIsolatedEnv();
		const tmpRoot = path.dirname(process.env.CORNFIELD_AGENT_DIR!);
		const broker = new FakeBroker(path.join(tmpRoot, "intercom", "broker.sock"));
		broker.peers = [peer()];
		await broker.listen();

		const sessionId = "sess-warm-roster";
		const { pi, emit, tools } = makeFakePi();
		piIntercomExtension(pi);
		emit("session_start", {}, makeCtx(sessionId));
		expect(await waitFor(() => broker.registrations >= 1, 5000)).toBe(true);

		const intercom = tools.get("intercom");
		expect(typeof intercom).toBe("function");
		// `list` is the roster seed the send path relies on.
		await intercom!("call-1", { action: "list" }, undefined, undefined, makeCtx(sessionId));
		expect(broker.listCalls).toBeGreaterThanOrEqual(1);

		// From here every `list` goes unanswered, the way a stalled gateway
		// behaves. A send must not need one.
		broker.stallNextLists = 100;

		const result = (await intercom!(
			"call-2",
			{ action: "send", to: "peer", message: "hello" },
			undefined,
			undefined,
			makeCtx(sessionId),
		)) as { content: Array<{ text: string }> };

		expect(result.content[0]!.text).toContain("Message sent to");
		// Resolved locally: the peer's id, not the name it was addressed by.
		expect(broker.sentTo).toEqual(["peer-session-1"]);
		// The proof that no round-trip was needed: none was even attempted.
		expect(broker.ignoredListRequests).toBe(0);

		emit("session_shutdown", {});
		broker.close();
	}, 20_000);

	test("falls back to the broker for a target the warm roster does not know", async () => {
		setupIsolatedEnv();
		const tmpRoot = path.dirname(process.env.CORNFIELD_AGENT_DIR!);
		const broker = new FakeBroker(path.join(tmpRoot, "intercom", "broker.sock"));
		broker.peers = [peer()];
		await broker.listen();

		const sessionId = "sess-roster-miss";
		const { pi, emit, tools } = makeFakePi();
		piIntercomExtension(pi);
		emit("session_start", {}, makeCtx(sessionId));
		expect(await waitFor(() => broker.registrations >= 1, 5000)).toBe(true);

		const intercom = tools.get("intercom")!;
		await intercom("call-1", { action: "list" }, undefined, undefined, makeCtx(sessionId));
		const listCallsBefore = broker.listCalls;

		// "late-peer" is not in the warm table. A miss is not an answer — only the
		// broker can settle it, so this send must consult the broker.
		broker.peers = [peer(), peer({ id: "peer-session-2", name: "late-peer" })];
		await intercom(
			"call-2",
			{ action: "send", to: "late-peer", message: "hello" },
			undefined,
			undefined,
			makeCtx(sessionId),
		);

		expect(broker.listCalls).toBe(listCallsBefore + 1);
		expect(broker.sentTo).toEqual(["peer-session-2"]);

		emit("session_shutdown", {});
		broker.close();
	}, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Liveness tolerance.
//
// The probe exists to notice a peer that died without a close event. It is not
// proof that an unanswered probe means death: the broker shares the gateway's
// event loop, so unrelated gateway work holds the reply past the probe budget.
// ─────────────────────────────────────────────────────────────────────────────

describe("intercom liveness tolerance", () => {
	test("an unanswered probe does not tear down a healthy connection", async () => {
		setupIsolatedEnv(150, 150);
		const tmpRoot = path.dirname(process.env.CORNFIELD_AGENT_DIR!);
		const broker = new FakeBroker(path.join(tmpRoot, "intercom", "broker.sock"));
		await broker.listen();

		const sessionId = "sess-liveness-tolerance";
		const { pi, emit } = makeFakePi();
		piIntercomExtension(pi);
		emit("session_start", {}, makeCtx(sessionId));
		expect(await waitFor(() => broker.registrations >= 1, 5000)).toBe(true);
		// Let the connect-time roster refresh finish; the probe is the only list
		// issuer left, so the stall below is guaranteed to land on one.
		expect(await waitFor(() => broker.listCalls >= 1, 5000)).toBe(true);

		broker.stallNextLists = 1;
		expect(await waitFor(() => broker.ignoredListRequests >= 1, 5000)).toBe(true);
		// Well past the point where a single miss would have destroyed the socket.
		await new Promise(resolve => setTimeout(resolve, 1200));

		expect(broker.connections).toBe(1);
		expect(broker.registrations).toBe(1);

		emit("session_shutdown", {});
		broker.close();
	}, 20_000);

	test("consecutive unanswered probes still tear down and reconnect", async () => {
		setupIsolatedEnv(150, 150);
		const tmpRoot = path.dirname(process.env.CORNFIELD_AGENT_DIR!);
		const broker = new FakeBroker(path.join(tmpRoot, "intercom", "broker.sock"));
		await broker.listen();

		const sessionId = "sess-liveness-teardown";
		const { pi, emit } = makeFakePi();
		piIntercomExtension(pi);
		emit("session_start", {}, makeCtx(sessionId));
		expect(await waitFor(() => broker.registrations >= 1, 5000)).toBe(true);
		expect(await waitFor(() => broker.listCalls >= 1, 5000)).toBe(true);

		// The peer is gone for good: never answer a list again.
		broker.stallNextLists = 100_000;
		const reconnected = await waitFor(() => broker.registrations >= 2, 15_000);

		emit("session_shutdown", {});
		broker.close();
		expect(reconnected).toBe(true);
	}, 30_000);
});
