/**
 * Child Session Process Supervisor against a REAL intercom broker (E2E=1).
 *
 * `child-session-real-process-e2e.test.ts` proves the supervisor's transport: it
 * spawns the real `cornfield` binary and drives it over the wire. It does not
 * prove the *parent edge* — the thing that makes a child session a child of
 * something. That needs a broker to register against and a roster to read back.
 *
 * So this file hosts a real `IntercomBroker` in-process (the same broker class
 * the gateway runs, on a temp socket — NOT the production gateway), connects a
 * real `IntercomClient` as the parent, and drives the supervisor through the
 * real registration probe. It asserts the four things review asked for:
 *
 *   1. **PID** — the roster row the parent can see is the process the supervisor
 *      spawned, matched by pid (siblings share a parentId, so pid is the handle).
 *   2. **parentId** — that row carries this session as its parent, produced by the
 *      `childSessionEnv()` contract rather than by a literal in the test.
 *   3. **restart registration** — after the child is killed (a crash from the
 *      supervisor's side), the relaunched incarnation re-registers with the SAME
 *      parent edge, and the dead one leaves the roster.
 *   4. **exit cleanup** — a graceful stop removes the child from the roster, so a
 *      finished child is not left cluttering its parent's view.
 *
 * No LLM is called: a wire prompt is never sent, so no model is ever invoked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { IntercomBroker } from "@cornfield/gateway/src/intercom/broker-server";
import { isEnoent } from "@cornfield/utils";
import { IntercomClient } from "../../src/intercom-extension/broker/client";
import { createIntercomRegistrationProbe } from "../../src/intercom-extension/child-session-edge";
import { childSessionEnv } from "../../src/intercom-extension/child-session-metadata";
import { type ChildSessionSpec, ChildSessionSupervisor } from "../../src/session/child-session-supervisor";

const isE2E = process.env.E2E === "1";

function resolveCornfieldBinary(): string | undefined {
	const explicit = process.env.CORNFIELD_BINARY?.trim();
	if (explicit) return explicit;
	const installed = path.join(os.homedir(), ".local", "bin", "cornfield");
	try {
		fsSync.accessSync(installed, fsSync.constants.X_OK);
		return installed;
	} catch {
		return Bun.which("cornfield") ?? undefined;
	}
}

const binary = isE2E ? resolveCornfieldBinary() : undefined;
const describeE2E = binary ? describe : describe.skip;

const PARENT_SESSION = "e2e-broker-parent";
const PARENT_NAME = "e2e-broker-parent";
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

let runtimeDir: string;
let previousAgentDir: string | undefined;
let broker: IntercomBroker;
let parent: IntercomClient;
let supervisor: ChildSessionSupervisor;

async function waitForAsync(what: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(200);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

async function rosterPids(): Promise<Array<{ pid: number; parentId: string | undefined }>> {
	const sessions = await parent.listSessions({ timeoutMs: 5_000 });
	return sessions.map(session => ({ pid: session.pid, parentId: session.parentId }));
}

describeE2E("ChildSessionSupervisor against a real intercom broker", () => {
	beforeAll(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-supervisor-broker-"));
		previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
		process.env.CORNFIELD_AGENT_DIR = path.join(runtimeDir, "agent");

		// The child is a real cornfield binary booting into a fresh agent dir; give
		// it the model/config files it expects (no LLM turn is ever run).
		for (const name of ["config.yml", "models.yml", "auth.db"] as const) {
			try {
				await fs.cp(path.join(os.homedir(), ".cornfield/agent", name), path.join(runtimeDir, "agent", name));
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		await fs.mkdir(path.join(runtimeDir, "agent", "sessions"), { recursive: true });

		// The broker socket the child resolves from CORNFIELD_AGENT_DIR is
		// <parent-of-agent-dir>/intercom/broker.sock.
		broker = new IntercomBroker({
			intercomDir: path.join(runtimeDir, "intercom"),
			listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
		});
		await broker.start();

		parent = new IntercomClient();
		await parent.connect(
			{
				name: PARENT_NAME,
				cwd: repoRoot,
				model: "e2e-driver",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				status: "idle",
				runtimeFallbackAlias: false,
			},
			PARENT_SESSION,
		);

		supervisor = new ChildSessionSupervisor({
			maxConcurrent: 1,
			registration: createIntercomRegistrationProbe({
				roster: parent,
				parentId: PARENT_SESSION,
				timeoutMs: 120_000,
				pollMs: 250,
			}),
			restart: { maxRestarts: 1, baseBackoffMs: 500, maxBackoffMs: 1_000 },
			process: {
				readyTimeoutMs: 120_000,
				requestTimeoutMs: 60_000,
				abortTimeoutMs: 10_000,
				exitGraceMs: 20_000,
				termGraceMs: 5_000,
			},
		});
	}, 60_000);

	afterAll(async () => {
		try {
			await supervisor?.stopAll();
		} catch {}
		await parent?.disconnect().catch(() => {});
		broker?.stop();
		process.env.CORNFIELD_AGENT_DIR = previousAgentDir;
		await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
	});

	test("registers a real child with its PID and parentId, re-registers after a crash, and cleans up on exit", async () => {
		const spec: ChildSessionSpec = {
			sessionId: "e2e-child",
			parent: { sessionId: PARENT_SESSION, rootSessionId: PARENT_SESSION, depth: 0 },
			agentId: "default",
			cwd: repoRoot,
			command: { bin: binary!, args: ["--mode", "wire-stdio"] },
			env: childSessionEnv({
				parentTarget: PARENT_NAME,
				parentSessionId: PARENT_SESSION,
				runId: "e2e-child-run",
				agent: "e2e-child",
				index: "0",
			}),
			delegationRole: "e2e",
		};

		// 1 + 2: the parent can see the child it spawned, under its own edge.
		const child = await supervisor.start(spec);
		const firstPid = child.transport.pid!;
		expect(firstPid).toBeGreaterThan(0);
		expect(child.toNode()).toMatchObject({
			sessionId: "e2e-child",
			parentSessionId: PARENT_SESSION,
			kind: "child",
			status: "running",
			executionPolicy: "isolated-process",
		});

		await waitForAsync(
			"child row on the roster under this parent",
			async () => (await rosterPids()).some(row => row.pid === firstPid && row.parentId === PARENT_SESSION),
			60_000,
		);

		// 3: the child dies without being asked to — a crash, so the supervisor
		// relaunches it, and the replacement must claim the SAME parent edge.
		process.kill(firstPid, "SIGTERM");
		await waitForAsync("child to be restarted", async () => child.restarts() === 1, 60_000);
		// Wait on the supervisor's own completion signal rather than on the process
		// having booted: "live" means registered, and polling the roster from outside
		// races the supervisor's own confirmation window by a poll interval.
		await child.awaitReady();
		const secondPid = child.transport.pid!;
		expect(secondPid).not.toBe(firstPid);

		// The relaunched incarnation re-claimed the SAME parent edge on the broker.
		const relaunched = (await rosterPids()).find(row => row.pid === secondPid);
		expect(relaunched?.parentId).toBe(PARENT_SESSION);
		// The crashed incarnation must be gone from the roster, not left as a ghost.
		await waitForAsync(
			"dead incarnation to leave the roster",
			async () => !(await rosterPids()).some(row => row.pid === firstPid),
			60_000,
		);

		// 4: stopping the child removes it from the roster entirely, so the parent
		// is not left looking at a session that no longer exists.
		await child.stop();
		expect(child.status()).toBe("cancelled");
		await waitForAsync(
			"child to leave the roster after the stop",
			async () => !(await rosterPids()).some(row => row.pid === secondPid || row.pid === firstPid),
			60_000,
		);
		expect(supervisor.concurrency().active).toBe(0);
	}, 300_000);
});
