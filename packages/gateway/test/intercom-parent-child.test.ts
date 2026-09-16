/**
 * Intercom parent-child edge (cross-process orchestration).
 *
 * Registers a real IntercomBroker (bound to an isolated socket via the
 * injectable listenTarget — no global env mutation at module load) and drives
 * it with two real IntercomClients from the coding-agent extension — one
 * acting as the parent, one as a child that declares `parentId` at
 * registration. Covers the broker contract of the parent-child feature:
 *
 *   - child registration carries parentId; `list` returns it back
 *   - presence updates preserve parentId (it is not a presence field)
 *   - a session without parentId stays a plain peer
 *   - a blank parentId is rejected at registration
 *   - messages from the parent to the child carry the child's parentId in
 *     the `from` session info (so the child can verify the sender is its
 *     declared parent)
 *   - duplicate registration: a session id held by a live connection is not
 *     up for grabs (the second registration is refused), while sessions sharing
 *     a parentId — or a name — coexist without their message edges crossing
 *     (second describe block)
 *
 * The extension-side behaviours (auto completion report, ask→parent routing,
 * `intercom({action:"children"})` list) build on this broker contract and are
 * not exercised here — they live in the coding-agent extension and require a
 * full extension runtime. The two broker-facing adapters that need no extension
 * runtime — `createIntercomLivenessProbe` (what reconcile reads) and
 * `SessionTreeManager.reconcile` (the verdict it draws) — are driven against
 * the real broker in that second block.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { IntercomClient } from "../../coding-agent/src/intercom-extension/broker/client";
import { createIntercomLivenessProbe } from "../../coding-agent/src/intercom-extension/child-session-tree";
import type { SessionInfo } from "../../coding-agent/src/intercom-extension/types";
import { ChildSessionSupervisor } from "../../coding-agent/src/session/child-session-supervisor";
import type { ChildSessionRecord } from "../../coding-agent/src/session/session-tree";
import { SessionTreeManager } from "../../coding-agent/src/session/session-tree-manager";
import { MemorySessionTreeStore } from "../../coding-agent/src/session/session-tree-store";
import { IntercomBroker } from "../src/intercom/broker-server";

let runtimeDir: string;
let previousAgentDir: string | undefined;

function registration(name: string, extra?: Record<string, unknown>) {
	return {
		name,
		runtimeFallbackAlias: false,
		cwd: process.cwd(),
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		status: "idle",
		...extra,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("timed out waiting for condition");
		}
		await Bun.sleep(20);
	}
}

/**
 * One ledger entry as a restarted parent would find it: a running child whose
 * only surviving handle is the pid the parent recorded for it.
 */
function ledgerRecord(sessionId: string, parentId: string, lastPid?: number): ChildSessionRecord {
	const now = Date.now();
	return {
		node: {
			sessionId,
			agentId: "coding",
			parentSessionId: parentId,
			rootSessionId: parentId,
			depth: 1,
			kind: "child",
			status: "running",
			executionPolicy: "isolated-process",
		},
		runId: `run-${sessionId}`,
		...(lastPid === undefined ? {} : { lastPid }),
		createdAt: now,
		updatedAt: now,
	};
}

describe("intercom parent-child broker edge", () => {
	let broker: InstanceType<typeof IntercomBroker>;
	let parent: InstanceType<typeof IntercomClient>;
	let child: InstanceType<typeof IntercomClient>;

	beforeAll(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-intercom-parent-"));
		previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
		process.env.CORNFIELD_AGENT_DIR = path.join(runtimeDir, "agent");
		broker = new IntercomBroker({
			// Clients resolve the socket from CORNFIELD_AGENT_DIR: agentDir is
			// <tmp>/agent, so the intercom dir (dirname) is <tmp>/intercom — keep
			// the injected listener on the same path.
			intercomDir: path.join(runtimeDir, "intercom"),
			listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
		});
		await broker.start();
		await Bun.sleep(50);

		parent = new IntercomClient();
		await parent.connect(registration("parent-session"), "parent-stable-id");

		child = new IntercomClient();
		await child.connect(registration("child-session", { parentId: "parent-stable-id" }), "child-session-id");
	});

	afterAll(async () => {
		if (child) await child.disconnect();
		if (parent) await parent.disconnect();
		if (broker) {
			broker.stop();
		}
		process.env.CORNFIELD_AGENT_DIR = previousAgentDir;
		await fs.rm(runtimeDir, { recursive: true, force: true });
	});

	test("child registration carries parentId through list", async () => {
		const sessions = await parent.listSessions();
		const childRow = sessions.find(s => s.id === "child-session-id");
		expect(childRow).toBeDefined();
		expect(childRow?.parentId).toBe("parent-stable-id");
	});

	test("parent session itself has no parentId", async () => {
		const sessions = await child.listSessions();
		const parentRow = sessions.find(s => s.id === "parent-stable-id");
		expect(parentRow).toBeDefined();
		expect(parentRow?.parentId).toBeUndefined();
	});

	test("peer session without parentId stays a plain peer", async () => {
		const peer = new IntercomClient();
		try {
			await peer.connect(registration("peer-session"), "peer-session-id");
			const sessions = await parent.listSessions();
			const peerRow = sessions.find(s => s.id === "peer-session-id");
			expect(peerRow?.parentId).toBeUndefined();
		} finally {
			await peer.disconnect();
		}
	});

	test("presence updates preserve parentId", async () => {
		const seen = new Map<string, { status?: string; parentId?: string }>();
		const handler = (session: { id: string; status?: string; parentId?: string }) => {
			seen.set(session.id, { status: session.status, parentId: session.parentId });
		};
		parent.on("presence_update", handler);
		try {
			child.updatePresence({ status: "thinking" });
			await waitFor(() => seen.get("child-session-id")?.status === "thinking");
			// The presence event carries the full session info including parentId.
			expect(seen.get("child-session-id")?.parentId).toBe("parent-stable-id");
		} finally {
			parent.off("presence_update", handler);
		}
		const sessions = await parent.listSessions();
		expect(sessions.find(s => s.id === "child-session-id")?.parentId).toBe("parent-stable-id");
	});

	test("blank parentId is rejected at registration", async () => {
		const bad = new IntercomClient();
		try {
			await expect(bad.connect(registration("bad-session", { parentId: "  " }), "bad-session-id")).rejects.toThrow();
		} finally {
			await bad.disconnect().catch(() => undefined);
		}
	});

	test("message from parent to child carries no parentId on sender (peer-to-peer rather than parent-forced)", async () => {
		const received: Array<{ from: { id: string; parentId?: string }; text: string }> = [];
		const childOf = new IntercomClient();
		try {
			await childOf.connect(registration("child-2", { parentId: "parent-stable-id" }), "child-2-id");
			childOf.on("message", (from, message) => {
				received.push({ from, text: message.content.text });
			});
			await parent.send("child-2-id", { text: "hello child" });
			await waitFor(() => received.length >= 1);
			expect(received[0]?.from.id).toBe("parent-stable-id");
			// The sender is a parent session: its own parentId is undefined.
			expect(received[0]?.from.parentId).toBeUndefined();
			expect(received[0]?.text).toBe("hello child");
		} finally {
			await childOf.disconnect();
		}
	});

	test("a second broker on the same socket refuses instead of clobbering the live one", async () => {
		// Regression: the broker used to unlink its listen target unconditionally
		// at construction — a second broker instance (e.g. an isolated test)
		// could delete the PRODUCTION broker's socket file, orphaning its
		// listener. Now the socket is probed first: a live owner makes start()
		// reject with a clear error and the first broker keeps serving.
		const second = new IntercomBroker({
			intercomDir: path.join(runtimeDir, "intercom-copy"),
			listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
		});
		await expect(second.start()).rejects.toThrow(/already running/);
		// The live broker still serves new clients.
		const probeClient = new IntercomClient();
		try {
			await probeClient.connect(registration("probe-after-refusal"), "probe-after-refusal-id");
			expect(probeClient.sessionId).toBe("probe-after-refusal-id");
		} finally {
			await probeClient.disconnect();
		}
	});

	test("a stale socket left by a crashed broker is reclaimed", async () => {
		// A socket file with no live listener (crash without cleanup) must not
		// block start(): the probe finds nobody, unlinks the stale path, and
		// listens in its place.
		const staleDir = path.join(runtimeDir, "intercom-stale");
		await fs.mkdir(staleDir, { recursive: true });
		const stalePath = path.join(staleDir, "broker.sock");
		await Bun.write(stalePath, "");

		const reclaimed = new IntercomBroker({
			intercomDir: staleDir,
			listenTarget: stalePath,
		});
		await reclaimed.start();
		try {
			const stat = await fs.stat(stalePath);
			expect(stat.isSocket()).toBe(true);
		} finally {
			reclaimed.stop();
		}
	});

	test("socket file deleted under a live broker is rebound by the watchdog", async () => {
		// External deletion of the socket FILE orphanes the listener (new
		// clients get ENOENT) — the exact production incident. The broker's
		// socket watchdog must rebind the path and accept new clients again.
		// The client libs resolve the broker path from CORNFIELD_AGENT_DIR, so
		// this test probes the independent watchdog broker with a raw socket.
		const watchDir = path.join(runtimeDir, "intercom-watch");
		await fs.mkdir(watchDir, { recursive: true });
		const watchPath = path.join(watchDir, "broker.sock");
		const watched = new IntercomBroker({
			intercomDir: watchDir,
			listenTarget: watchPath,
			socketWatchIntervalMs: 200,
		});
		await watched.start();

		const rawConnect = () =>
			new Promise<string>(resolve => {
				const socket = net.connect(watchPath);
				socket.once("connect", () => resolve("ok"));
				socket.once("error", err => resolve((err as NodeJS.ErrnoException).code ?? "err"));
			});
		try {
			expect(await rawConnect()).toBe("ok");
			// External actor deletes the socket file while the broker lives.
			await fs.unlink(watchPath);
			expect(await rawConnect()).toBe("ENOENT");

			// The watchdog rebinds within a few intervals; the path serves again.
			const deadline = Date.now() + 5_000;
			let served = false;
			while (Date.now() < deadline) {
				if ((await rawConnect()) === "ok") {
					served = true;
					break;
				}
				await Bun.sleep(100);
			}
			expect(served).toBe(true);
		} finally {
			watched.stop();
		}
	});

	test("a broker refused by a live owner must not unlink the owner's socket on stop", async () => {
		// The 2026-08-18 production incident: a second broker whose start() was
		// refused (probe found a live owner) called stop() during teardown, and
		// its unconditional unlink deleted the owner's socket FILE. The owner's
		// listener kept running but every new client got ENOENT, and the owner's
		// watchdog rebind then wedged — outage until manual gateway restart.
		// stop() may only unlink the path this instance actually bound.
		const ownerDir = path.join(runtimeDir, "intercom-owner");
		await fs.mkdir(ownerDir, { recursive: true });
		const ownerPath = path.join(ownerDir, "broker.sock");
		const owner = new IntercomBroker({
			intercomDir: ownerDir,
			listenTarget: ownerPath,
		});
		await owner.start();

		const intruderDir = path.join(runtimeDir, "intercom-intruder");
		await fs.mkdir(intruderDir, { recursive: true });
		const intruder = new IntercomBroker({
			intercomDir: intruderDir,
			listenTarget: ownerPath, // same path — refused by the live owner
		});
		try {
			await expect(intruder.start()).rejects.toThrow(/already running/);
			intruder.stop();

			// The owner's socket FILE must survive the intruder's stop()...
			const stat = await fs.stat(ownerPath);
			expect(stat.isSocket()).toBe(true);
			// ...and the owner must still accept connections.
			await new Promise<void>((resolve, reject) => {
				const socket = net.connect(ownerPath);
				socket.once("connect", () => {
					socket.destroy();
					resolve();
				});
				socket.once("error", reject);
			});
		} finally {
			owner.stop();
		}
	});

	test("watchdog rebinds and re-serves while a client is still connected", async () => {
		// Regression for the 2026-08-18 wedge: Bun's server.close() callback
		// never fires while a connection is open, so the old rebind awaited
		// close() forever — silent watchdog death with no success/failure log
		// and no retry (the #rebuildingSocket guard stayed latched). The fix
		// destroys existing connections first (clients reconnect to the fresh
		// path) and bounds every rebind step with a timeout.
		const watchDir = path.join(runtimeDir, "intercom-watch-live");
		await fs.mkdir(watchDir, { recursive: true });
		const watchPath = path.join(watchDir, "broker.sock");
		const watched = new IntercomBroker({
			intercomDir: watchDir,
			listenTarget: watchPath,
			socketWatchIntervalMs: 200,
		});
		await watched.start();

		const rawConnect = () =>
			new Promise<string>(resolve => {
				const socket = net.connect(watchPath);
				socket.once("connect", () => resolve("ok"));
				socket.once("error", err => resolve((err as NodeJS.ErrnoException).code ?? "err"));
			});
		try {
			// Attach a long-lived client — this is what wedged the old rebind.
			const persistent = net.connect(watchPath);
			await new Promise<void>(resolve => persistent.once("connect", () => resolve()));
			expect(await rawConnect()).toBe("ok");

			// External actor deletes the socket file while the broker lives.
			await fs.unlink(watchPath);
			expect(await rawConnect()).toBe("ENOENT");

			// The watchdog must recover even though `persistent` is still open.
			const deadline = Date.now() + 5_000;
			let served = false;
			while (Date.now() < deadline) {
				if ((await rawConnect()) === "ok") {
					served = true;
					break;
				}
				await Bun.sleep(100);
			}
			expect(served).toBe(true);
			persistent.destroy();
		} finally {
			watched.stop();
		}
	});
});

/**
 * ── One identity, one live process ───────────────────────────────────────────
 *
 * The broker keys a session by its **session id** — the identity a session pins
 * with `sessionId`. Never by its name, never by its parent edge. And an id is a
 * claim held by a *process*: while the holder's socket is open, a second
 * registration under that id is refused. That refusal is the fix this block
 * pins — a process whose id came from a machine-global file (every session on
 * the machine reading the same one) would otherwise displace a live session,
 * end its socket and replace its whole `SessionInfo`, parent edge included,
 * without a word; the parent could then no longer find it and marked a child
 * that was still running `failed`.
 *
 *   1. **A live holder keeps its id.** The newcomer's registration is refused
 *      with an `error` frame naming the id and the holder's pid, and its socket
 *      is closed before it is ever registered: no `session_joined`, no
 *      `session_left`, no change to the holder's row, its edges or its
 *      connection.
 *   2. **A holder that is gone frees its id.** Its socket closes, its row is
 *      reaped, and the next process registers normally — the resume path every
 *      restarted child depends on.
 *   3. **A shared `parentId` — or a shared name — is not a collision.** The
 *      sessions coexist; an addressed send lands on exactly one edge, and an
 *      ambiguous *name* is refused rather than misrouted (`broker-server.ts`).
 *   4. **The parent edge is an opaque string.** Only a blank one is rejected
 *      (`protocol.ts`), so a self-parent or a dangling parent is stored as
 *      declared; keeping a foreign pid out of a parent's reconcile is the
 *      ledger's job, not the broker's — this block pins both sides of that.
 *
 * Division of labour with the layers above, deliberately not collapsed here: the
 * in-process supervisor **refuses** a second child with the same session id
 * (`child-session-supervisor.ts`, asserted in
 * `coding-agent/test/session/child-session-supervisor.test.ts`), and the ledger
 * refuses a second delegation of the same id (`session-tree-manager.ts`,
 * `session-tree-manager.test.ts`). Those are one-process ownership rules; the
 * broker enforces the cross-process one, which no other layer can see.
 */
describe("intercom broker duplicate registration", () => {
	const PARENT_ID = "dup-parent-id";
	const CHILD_ID = "dup-child-id";
	// Declared registration values, not OS processes: the broker stores whatever
	// pid a session declares, and reconcile matches on that number.
	const PARENT_PID = 1000;
	/** The live holder of CHILD_ID. */
	const HOLDER_PID = 1111;
	/** Declares HOLDER_PID's id while HOLDER_PID is still connected, and is refused. */
	const REFUSED_PID = 2222;
	const SIBLING_A_PID = 3333;
	const SIBLING_B_PID = 4444;
	const SELF_PID = 6001;
	const DANGLING_PID = 6002;
	const EDGE_FIRST_PID = 6666;
	const EDGE_SECOND_PID = 7777;
	const LIVE_PID = 8001;
	const DEAD_PID = 8002;
	const RESUME_FIRST_PID = 9001;
	const RESUME_SECOND_PID = 9002;
	/** A holder whose socket is already closed, and the process that takes its id. */
	const GHOST_PID = 9101;
	const GHOST_NEWCOMER_PID = 9102;
	/** The row shape the broker reads when it decides whether an id is held. */
	type ConnectedSessionShape = {
		socket: net.Socket;
		info: SessionInfo;
		lastPresenceBroadcastAt: number;
		ownerOrder: number;
	};

	let dupRuntimeDir: string;
	let previousAgentDir: string | undefined;
	let broker: InstanceType<typeof IntercomBroker>;
	let parent: InstanceType<typeof IntercomClient>;
	/** The live holder of CHILD_ID. */
	let holder: InstanceType<typeof IntercomClient>;
	/** Its refused challenger: one id, one live process. */
	let challenger: InstanceType<typeof IntercomClient>;
	/** What `challenger.connect()` rejected with. */
	let refusal: Error | null = null;
	/** Every client this block creates, torn down together in afterAll. */
	const clients: Array<InstanceType<typeof IntercomClient>> = [];
	const parentEvents: string[] = [];
	const holderEvents: string[] = [];

	function client(): InstanceType<typeof IntercomClient> {
		const instance = new IntercomClient();
		clients.push(instance);
		return instance;
	}

	/** What reconcile reads: the pids the broker shows under one parent id. */
	async function liveChildPids(parentId: string): Promise<number[]> {
		const probe = createIntercomLivenessProbe({ roster: parent, parentId });
		return [...(await probe.liveChildPids())];
	}

	beforeAll(async () => {
		dupRuntimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-intercom-dup-"));
		previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
		process.env.CORNFIELD_AGENT_DIR = path.join(dupRuntimeDir, "agent");
		broker = new IntercomBroker({
			intercomDir: path.join(dupRuntimeDir, "intercom"),
			listenTarget: path.join(dupRuntimeDir, "intercom", "broker.sock"),
		});
		await broker.start();
		await Bun.sleep(50);

		parent = client();
		parent.on("session_joined", session => parentEvents.push(`joined:${session.id}:${session.pid}`));
		parent.on("session_left", sessionId => parentEvents.push(`left:${sessionId}`));
		await parent.connect(registration("dup-parent", { pid: PARENT_PID }), PARENT_ID);

		holder = client();
		holder.on("disconnected", () => holderEvents.push("disconnected"));
		await holder.connect(registration("dup-child", { pid: HOLDER_PID, parentId: PARENT_ID }), CHILD_ID);

		// The same id, same declared name and same parent edge, declared by a
		// second process while the holder is still connected.
		challenger = client();
		refusal = await challenger
			.connect(registration("dup-child", { pid: REFUSED_PID, parentId: PARENT_ID }), CHILD_ID)
			.then(
				() => null,
				(cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
			);
	});

	afterAll(async () => {
		for (const instance of clients.splice(0)) {
			await instance.disconnect().catch(() => undefined);
		}
		if (broker) broker.stop();
		process.env.CORNFIELD_AGENT_DIR = previousAgentDir;
		await fs.rm(dupRuntimeDir, { recursive: true, force: true });
	});

	test("a live holder keeps its id: the second registration is refused, naming the id and the pid", async () => {
		expect(refusal?.message).toContain(CHILD_ID);
		expect(refusal?.message).toContain(String(HOLDER_PID));

		// One row, and it is still the holder's — a refusal is not a takeover.
		const rows = (await parent.listSessions()).filter(session => session.id === CHILD_ID);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.pid).toBe(HOLDER_PID);
		expect(rows[0]?.parentId).toBe(PARENT_ID);

		// The challenger never made it onto the roster, and the holder never
		// noticed: it was not disconnected, and it still holds its id.
		expect(challenger.sessionId).toBeNull();
		expect(challenger.isConnected()).toBe(false);
		expect(holder.sessionId).toBe(CHILD_ID);
		expect(holder.isConnected()).toBe(true);
		expect(holderEvents).toEqual([]);
	});

	test("a refusal announces nothing: one session_joined for the identity, never a session_left", async () => {
		// Scoped to this identity: later cases in this block register other ids.
		expect(parentEvents.filter(event => event.includes(CHILD_ID))).toEqual([`joined:${CHILD_ID}:${HOLDER_PID}`]);
	});

	test("the holder's message edge survives the refusal", async () => {
		const received: string[] = [];
		holder.on("message", (_from, message) => received.push(message.content.text));
		const delivered = await parent.send(CHILD_ID, { text: "still yours?" });
		expect(delivered.delivered).toBe(true);
		await waitFor(() => received.length === 1);
		expect(received).toEqual(["still yours?"]);
	});

	test("children sharing a parent id coexist and their edges do not cross", async () => {
		const siblingA = client();
		const siblingB = client();
		const receivedA: string[] = [];
		const receivedB: string[] = [];
		await siblingA.connect(registration("dup-sibling", { pid: SIBLING_A_PID, parentId: PARENT_ID }), "dup-sibling-a");
		await siblingB.connect(registration("dup-sibling", { pid: SIBLING_B_PID, parentId: PARENT_ID }), "dup-sibling-b");
		siblingA.on("message", (_from, message) => receivedA.push(message.content.text));
		siblingB.on("message", (_from, message) => receivedB.push(message.content.text));

		const underParent = (await parent.listSessions())
			.filter(session => session.parentId === PARENT_ID)
			.map(session => [session.id, session.pid])
			.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
		expect(underParent).toEqual([
			[CHILD_ID, HOLDER_PID],
			["dup-sibling-a", SIBLING_A_PID],
			["dup-sibling-b", SIBLING_B_PID],
		]);
		// One parentId, three distinct edges — and the parent itself is not in the set.
		expect((await liveChildPids(PARENT_ID)).sort((a, b) => a - b)).toEqual(
			[HOLDER_PID, SIBLING_A_PID, SIBLING_B_PID].sort((a, b) => a - b),
		);

		// Addressed by id: exactly one edge receives it.
		const addressed = await parent.send("dup-sibling-a", { text: "for-a-only" });
		expect(addressed.delivered).toBe(true);
		await waitFor(() => receivedA.length === 1);
		expect(receivedA).toEqual(["for-a-only"]);
		expect(receivedB).toEqual([]);

		// Addressed by the shared name: refused, never resolved to one of them.
		const ambiguous = await parent.send("dup-sibling", { text: "for-whoever" });
		expect(ambiguous.delivered).toBe(false);
		expect(ambiguous.reason).toMatch(/Multiple sessions named "dup-sibling"/);
		await Bun.sleep(50);
		expect(receivedA).toEqual(["for-a-only"]);
		expect(receivedB).toEqual([]);

		// Positive control: B's listener does fire when B's own edge is addressed,
		// so the empties above are about routing, not about a dead handler.
		const addressedB = await parent.send("dup-sibling-b", { text: "for-b-only" });
		expect(addressedB.delivered).toBe(true);
		await waitFor(() => receivedB.length === 1);
		expect(receivedB).toEqual(["for-b-only"]);
		expect(receivedA).toEqual(["for-a-only"]);
	});

	test("a refused re-registration does not rewrite the holder's parent edge", async () => {
		const declared = client();
		await declared.connect(registration("dup-edge", { pid: EDGE_FIRST_PID, parentId: PARENT_ID }), "dup-edge-id");
		expect(await liveChildPids(PARENT_ID)).toContain(EDGE_FIRST_PID);

		// The same identity registers again, this time parentless — the shape a
		// second process takes when it claims an id another process holds.
		const parentless = client();
		const refused = await parentless.connect(registration("dup-edge", { pid: EDGE_SECOND_PID }), "dup-edge-id").then(
			() => null,
			(cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
		);
		expect(refused?.message).toContain("dup-edge-id");
		expect(refused?.message).toContain(String(EDGE_FIRST_PID));

		// The edge the holder declared is the edge it keeps: a refused newcomer
		// cannot drop a live child out of its parent's roster.
		const row = (await parent.listSessions()).find(session => session.id === "dup-edge-id");
		expect(row?.pid).toBe(EDGE_FIRST_PID);
		expect(row?.parentId).toBe(PARENT_ID);
		const pids = await liveChildPids(PARENT_ID);
		expect(pids).toContain(EDGE_FIRST_PID);
		expect(pids).not.toContain(EDGE_SECOND_PID);
	});

	test("a holder that is gone frees its id: the next process registers normally", async () => {
		const first = client();
		await first.connect(registration("dup-resume", { pid: RESUME_FIRST_PID, parentId: PARENT_ID }), "dup-resume-id");
		expect(await liveChildPids(PARENT_ID)).toContain(RESUME_FIRST_PID);

		// The holder's process exited, so its socket is closed and the identity is
		// free. Refusing here would strand every restarted child.
		await first.disconnect();
		await waitFor(() => !first.isConnected());

		const resumed = client();
		await resumed.connect(
			registration("dup-resume", { pid: RESUME_SECOND_PID, parentId: PARENT_ID }),
			"dup-resume-id",
		);

		const row = (await parent.listSessions()).find(session => session.id === "dup-resume-id");
		expect(row?.pid).toBe(RESUME_SECOND_PID);
		expect(row?.parentId).toBe(PARENT_ID);
		const pids = await liveChildPids(PARENT_ID);
		expect(pids).toContain(RESUME_SECOND_PID);
		expect(pids).not.toContain(RESUME_FIRST_PID);

		// The resumed process is reachable under the id its predecessor used.
		const received: string[] = [];
		resumed.on("message", (_from, message) => received.push(message.content.text));
		const delivered = await parent.send("dup-resume-id", { text: "back?" });
		expect(delivered.delivered).toBe(true);
		await waitFor(() => received.length === 1);
		expect(received).toEqual(["back?"]);
	});

	test("the broker stores the parent edge as an opaque string", async () => {
		const selfParent = client();
		const danglingParent = client();
		await selfParent.connect(registration("dup-selfy", { pid: SELF_PID, parentId: "dup-selfy" }), "dup-selfy");
		await danglingParent.connect(
			registration("dup-dangling", { pid: DANGLING_PID, parentId: "dup-nobody" }),
			"dup-dangling",
		);

		// No rejection and no rewrite: only a blank parentId is refused
		// (protocol.ts:198). Whether the edge points at anything is not the
		// broker's judgement.
		const roster = await parent.listSessions();
		expect(roster.find(session => session.id === "dup-selfy")?.parentId).toBe("dup-selfy");
		expect(roster.find(session => session.id === "dup-dangling")?.parentId).toBe("dup-nobody");

		// Consequence, pinned on the side that has to contain it: a parentId nobody
		// owns still yields liveness pids, so a roster read alone can never adopt a
		// child — reconcile matches those pids against its own ledger.
		expect(await liveChildPids("dup-nobody")).toEqual([DANGLING_PID]);
	});

	test("reconcile decides from the roster: a live child is adopted, a gone one is failed", async () => {
		const live = client();
		await live.connect(registration("dup-live-child", { pid: LIVE_PID, parentId: PARENT_ID }), "dup-live-child");

		const supervisor = new ChildSessionSupervisor({
			maxConcurrent: 1,
			registration: {
				async awaitRegistration() {},
			},
			restart: { maxRestarts: 1, baseBackoffMs: 10, maxBackoffMs: 20 },
			process: {
				readyTimeoutMs: 10_000,
				requestTimeoutMs: 5_000,
				abortTimeoutMs: 300,
				exitGraceMs: 1_000,
				termGraceMs: 500,
			},
		});
		try {
			const store = new MemorySessionTreeStore([
				ledgerRecord("dup-live-child", PARENT_ID, LIVE_PID),
				ledgerRecord("dup-dead-child", PARENT_ID, DEAD_PID),
				ledgerRecord("dup-pidless-child", PARENT_ID),
			]);
			const manager = new SessionTreeManager({
				self: { sessionId: PARENT_ID, agentId: "coding", intercomSessionId: PARENT_ID },
				supervisor,
				store,
				liveness: createIntercomLivenessProbe({ roster: parent, parentId: PARENT_ID }),
			});

			const result = await manager.reconcile();

			// A restarted parent has no supervisor and no processes: the roster is the
			// only evidence it has, and the pid it recorded is what each entry is
			// matched against (session-tree.ts:261-271).
			expect(result.plan.decisions).toEqual([
				{
					sessionId: "dup-live-child",
					disposition: "adopted",
					status: "running",
					reason: `child process ${LIVE_PID} is still registered under this parent`,
					pid: LIVE_PID,
				},
				{
					sessionId: "dup-dead-child",
					disposition: "orphaned",
					status: "failed",
					reason: `child process ${DEAD_PID} is no longer registered under this parent and the session never reported a terminal status`,
				},
				{
					sessionId: "dup-pidless-child",
					disposition: "orphaned",
					status: "failed",
					reason: "no process was ever recorded for this child and it never reported a terminal status",
				},
			]);
			expect(result.applied.map(decision => decision.sessionId)).toEqual(["dup-dead-child", "dup-pidless-child"]);
			expect((await store.load()).map(record => [record.node.sessionId, record.node.status])).toEqual([
				["dup-live-child", "running"],
				["dup-dead-child", "failed"],
				["dup-pidless-child", "failed"],
			]);

			// The pids that verdict was drawn from — this parent's own edges only:
			// `dup-live-child` and the holder of the contested id are both under
			// PARENT_ID, while a child on another edge and a would-be successor that
			// was refused registration are not in the set at all.
			const pids = await liveChildPids(PARENT_ID);
			expect(pids).toContain(LIVE_PID);
			expect(pids).toContain(HOLDER_PID);
			// ...a child on another edge and one that never got registered are not.
			expect(pids).not.toContain(DANGLING_PID);
			expect(pids).not.toContain(EDGE_SECOND_PID);
		} finally {
			await supervisor.stopAll();
		}
	});

	/**
	 * 一行「socket 已经关掉、close 还没被 broker 处理掉」的会话。真实世界里那是持有者刚死、或
	 * 被 broker 自己掐掉（限流剔除、读帧失败），新进程立刻用同一个 id 上线的那一瞬 —— 宽度只有
	 * 一拍，从 socket 外面碰不到。这里直接把那一行做出来，是为了让「持有者没了 ⇒ 接管照旧」
	 * 这条分支真的被执行到，而不是靠时序碰运气。
	 */
	test("a holder whose socket is already closed is taken over, not refused", async () => {
		const ghostSocket = net.connect(path.join(dupRuntimeDir, "intercom", "broker.sock"));
		await new Promise<void>(resolve => ghostSocket.once("connect", () => resolve()));
		ghostSocket.destroy();
		await new Promise<void>(resolve => ghostSocket.once("close", () => resolve()));

		const sessions = (broker as unknown as { sessions: Map<string, ConnectedSessionShape> }).sessions;
		sessions.set("dup-ghost-id", {
			socket: ghostSocket,
			info: {
				id: "dup-ghost-id",
				name: "dup-ghost",
				cwd: process.cwd(),
				model: "test-model",
				pid: GHOST_PID,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				parentId: PARENT_ID,
			},
			lastPresenceBroadcastAt: Date.now(),
			ownerOrder: 0,
		});

		// Taking an id whose holder is gone is what resume is: it registers
		// normally, and the row becomes the newcomer's.
		const resumed = client();
		await resumed.connect(
			registration("dup-ghost", { pid: GHOST_NEWCOMER_PID, parentId: PARENT_ID }),
			"dup-ghost-id",
		);

		const row = (await parent.listSessions()).find(session => session.id === "dup-ghost-id");
		expect(row?.pid).toBe(GHOST_NEWCOMER_PID);
		expect(row?.parentId).toBe(PARENT_ID);
		expect(resumed.sessionId).toBe("dup-ghost-id");
	});
});
