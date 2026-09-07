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
			this.write(socket, { type: "sessions", requestId: msg.requestId, sessions: [] });
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
function makeFakePi(): { pi: ExtensionAPI; emit: (event: string, ...args: unknown[]) => void } {
	const sessionName = "repro-session";
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const eventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
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
		registerTool: noop,
		appendEntry: noop,
		sendMessage: noop,
	} as unknown as ExtensionAPI;

	function emit(event: string, ...args: unknown[]): void {
		for (const cb of handlers.get(event) ?? []) cb(...args);
	}
	return { pi, emit };
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
const tmpRoots: string[] = [];

beforeEach(() => {
	savedAgentDir = process.env.CORNFIELD_AGENT_DIR;
	savedLivenessInterval = process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS;
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
	for (const root of tmpRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function setupIsolatedEnv(livenessIntervalMs?: number): void {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "intercom-repro-"));
	tmpRoots.push(tmpRoot);
	process.env.CORNFIELD_AGENT_DIR = path.join(tmpRoot, "agent");
	if (livenessIntervalMs !== undefined) {
		process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = String(livenessIntervalMs);
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
