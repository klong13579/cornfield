/**
 * The parent/child loop against a REAL broker and the REAL `cornfield` binary (E2E=1).
 *
 * `session-tree-manager.test.ts` proves the loop against real processes with a
 * stubbed broker. This file proves the part that only exists when both are real:
 *
 *   - **delegation** — the child the manager records is a real `cornfield`
 *     process, registered on the broker as a child of this session and answering
 *     the wire protocol,
 *   - **status back** — that child's own `started` report travels over the broker
 *     socket, through the intercom client, into the manager, and is accepted,
 *   - **recovery** — a manager built with nothing but the ledger file on disk and
 *     the broker roster settles a ledger written by a previous manager: children
 *     still on the roster are adopted, children that are gone are `failed`, and
 *     the result is written back to disk for the next restart.
 *
 * The intercom side is attached exactly the way a session wires it
 * (`attachChildSessionReports`), and the liveness probe reads the same roster the
 * child registered on. No LLM is ever called: a wire prompt is never sent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { IntercomBroker } from "@cornfield/gateway/src/intercom/broker-server";
import { getAgentDir, isEnoent } from "@cornfield/utils";
import { IntercomClient } from "../../src/intercom-extension/broker/client";
import { createIntercomRegistrationProbe } from "../../src/intercom-extension/child-session-edge";
import {
	attachChildSessionReports,
	createIntercomLivenessProbe,
} from "../../src/intercom-extension/child-session-tree";
import { formatChildSessionReport } from "../../src/session/child-session-report";
import { ChildSessionSupervisor } from "../../src/session/child-session-supervisor";
import { SessionManager } from "../../src/session/session-manager";
import { SessionTreeManager } from "../../src/session/session-tree-manager";
import { SessionLogTreeStore } from "../../src/session/session-tree-store";

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

const PARENT_SESSION = "e2e-tree-parent";
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

let runtimeDir: string;
let previousAgentDir: string | undefined;
let broker: IntercomBroker;
let parent: IntercomClient;
const supervisors: ChildSessionSupervisor[] = [];

async function waitFor(what: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(200);
	}
	throw new Error(`timed out waiting for: ${what}`);
}

async function liveChildPids(): Promise<number[]> {
	const sessions = await parent.listSessions({ timeoutMs: 5_000 });
	return sessions.filter(session => session.parentId === PARENT_SESSION).map(session => session.pid);
}

/**
 * The Agent home *this* process runs as.
 *
 * Read at call time, not from `getAgentDir()` alone: that is a module-load-time
 * cache, and this file points `CORNFIELD_AGENT_DIR` at a temp dir in `beforeAll`.
 * Handing the child the cached value would launch it as the developer's real
 * Agent — right settings, real intercom broker, and a `parentId` nobody in this
 * test is watching, so the child registers somewhere else entirely.
 */
function ownAgentDir(): string {
	return process.env.CORNFIELD_AGENT_DIR?.trim() || getAgentDir();
}

function makeSupervisor(): ChildSessionSupervisor {
	const supervisor = new ChildSessionSupervisor({
		maxConcurrent: 2,
		registration: createIntercomRegistrationProbe({
			roster: parent,
			parentId: PARENT_SESSION,
			timeoutMs: 120_000,
			pollMs: 250,
		}),
		// No restart: a child that dies here is meant to stay dead, so the ledger
		// and the broker tell the same story without a relaunch racing the assertions.
		restart: { maxRestarts: 0, baseBackoffMs: 10, maxBackoffMs: 10 },
		process: {
			readyTimeoutMs: 120_000,
			requestTimeoutMs: 60_000,
			abortTimeoutMs: 10_000,
			exitGraceMs: 20_000,
			termGraceMs: 5_000,
		},
	});
	supervisors.push(supervisor);
	return supervisor;
}

/** The ledger file of the parent session, reopened the way a restart would. */
async function reopenLedger(sessionFile: string): Promise<SessionLogTreeStore> {
	return new SessionLogTreeStore(await SessionManager.open(sessionFile));
}

describeE2E("Session tree end to end with a real broker and the real binary", () => {
	let sessionFile: string;

	beforeAll(async () => {
		runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-tree-"));
		previousAgentDir = process.env.CORNFIELD_AGENT_DIR;
		process.env.CORNFIELD_AGENT_DIR = path.join(runtimeDir, "agent");

		for (const name of ["config.yml", "models.yml", "auth.db"] as const) {
			try {
				await fs.cp(path.join(os.homedir(), ".cornfield/agent", name), path.join(runtimeDir, "agent", name));
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		await fs.mkdir(path.join(runtimeDir, "agent", "sessions"), { recursive: true });

		broker = new IntercomBroker({
			intercomDir: path.join(runtimeDir, "intercom"),
			listenTarget: path.join(runtimeDir, "intercom", "broker.sock"),
		});
		await broker.start();

		parent = new IntercomClient();
		await parent.connect(
			{
				name: PARENT_SESSION,
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

		const manager = await SessionManager.create(runtimeDir, path.join(runtimeDir, "parent-sessions"));
		// The session log is written lazily; the ledger store forces it, and every
		// "restart" in this file reopens this exact file.
		await manager.ensureOnDisk();
		sessionFile = manager.getSessionFile()!;
	}, 60_000);

	afterAll(async () => {
		for (const supervisor of supervisors.splice(0)) {
			try {
				await supervisor.stopAll();
			} catch {}
		}
		await parent?.disconnect().catch(() => {});
		broker?.stop();
		process.env.CORNFIELD_AGENT_DIR = previousAgentDir;
		await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
	});

	test("delegates a real child, takes its report back over the broker, and stops it", async () => {
		const manager = new SessionTreeManager({
			self: { sessionId: PARENT_SESSION, agentId: "default", intercomSessionId: PARENT_SESSION },
			supervisor: makeSupervisor(),
			store: await reopenLedger(sessionFile),
			liveness: createIntercomLivenessProbe({ roster: parent, parentId: PARENT_SESSION }),
		});
		// Observational decorator: it records what the real manager was asked, then
		// does exactly what the real manager would. Without it the transport could
		// break and the ledger would still look right, because a fresh child is
		// already `running`.
		const ingested: Array<{ applied: boolean; reason?: string; lifecycle: string }> = [];
		const detach = attachChildSessionReports(parent, {
			async applyReport(from, text) {
				const result = await manager.applyReport(from, text);
				ingested.push({
					applied: result.applied,
					...(result.applied ? {} : { reason: result.reason }),
					lifecycle: text.split("\n", 1)[0]?.slice(0, 200) ?? "",
				});
				return result;
			},
		});

		try {
			const { record, child } = await manager.delegate({
				agentDir: ownAgentDir(),
				cwd: repoRoot,
				command: { bin: binary!, args: ["--mode", "wire-stdio"] },
				delegationRole: "e2e",
				objective: "read-only survey",
			});
			const pid = child.transport.pid!;
			expect(pid).toBeGreaterThan(0);

			// 1. The child is on the broker as a child of THIS session.
			await waitFor(
				"the child to register under this parent",
				async () => (await liveChildPids()).includes(pid),
				60_000,
			);

			// 2. It is a real cornfield session, answering the wire protocol — and it is
			// running as the Agent home this delegation named, not the one this process
			// happens to have started from.
			const state = await child.request<{ sessionId?: string; sessionFile?: string | null }>(
				{ type: "get_state" },
				{ timeoutMs: 60_000 },
			);
			expect(typeof state.sessionId).toBe("string");
			expect(state.sessionFile?.startsWith(path.join(ownAgentDir(), "sessions"))).toBe(true);

			// 3. Its own `started` report came back over the broker and was accepted.
			const runId = record.runId;
			await waitFor(
				"the child's started report to reach the ledger ingest",
				() =>
					ingested.some(
						entry =>
							entry.applied &&
							entry.lifecycle.includes(`"runId":"${runId}"`) &&
							entry.lifecycle.includes("started"),
					),
				60_000,
			);
			const afterReport = await manager.record(record.node.sessionId);
			expect(afterReport).toMatchObject({ node: { status: "running" }, lastPid: pid });

			// 4. The ledger is on disk, not only in memory.
			const onDisk = await reopenLedger(sessionFile);
			expect((await onDisk.load()).map(entry => entry.node.sessionId)).toContain(record.node.sessionId);

			// 5. Stopping it is the parent's verdict, and the broker agrees.
			const stopped = await manager.stop(record.node.sessionId);
			expect(stopped.node.status).toBe("cancelled");
			await waitFor("the child to leave the roster", async () => !(await liveChildPids()).includes(pid), 60_000);
			expect(await manager.pendingEscalations()).toEqual([]);
		} finally {
			detach();
			await manager.reconcile().catch(() => undefined);
		}
	}, 300_000);

	test("a restarted parent settles the ledger from disk and the broker", async () => {
		const first = new SessionTreeManager({
			self: { sessionId: PARENT_SESSION, agentId: "default", intercomSessionId: PARENT_SESSION },
			supervisor: makeSupervisor(),
			store: await reopenLedger(sessionFile),
			liveness: createIntercomLivenessProbe({ roster: parent, parentId: PARENT_SESSION }),
		});

		const alive = await first.delegate({
			sessionId: "e2e-alive",
			agentDir: ownAgentDir(),
			cwd: repoRoot,
			command: { bin: binary!, args: ["--mode", "wire-stdio"] },
			delegationRole: "e2e",
		});
		const doomed = await first.delegate({
			sessionId: "e2e-doomed",
			agentDir: ownAgentDir(),
			cwd: repoRoot,
			command: { bin: binary!, args: ["--mode", "wire-stdio"] },
			delegationRole: "e2e",
		});
		await first.stop(doomed.record.node.sessionId);

		const alivePid = alive.child.transport.pid!;
		const doomedPid = doomed.child.transport.pid!;
		await waitFor(
			"both children to register",
			async () => {
				const pids = await liveChildPids();
				return pids.includes(alivePid) && !pids.includes(doomedPid);
			},
			60_000,
		);

		// The restart: nothing in memory, the ledger file, and the broker. This is
		// the whole state a restarted parent has.
		const reopened = new SessionTreeManager({
			self: { sessionId: PARENT_SESSION, agentId: "default", intercomSessionId: PARENT_SESSION },
			supervisor: makeSupervisor(),
			store: await reopenLedger(sessionFile),
			liveness: createIntercomLivenessProbe({ roster: parent, parentId: PARENT_SESSION }),
		});

		const adopted = await reopened.reconcile();
		const aliveDecision = adopted.plan.decisions.find(decision => decision.sessionId === "e2e-alive");
		const doomedDecision = adopted.plan.decisions.find(decision => decision.sessionId === "e2e-doomed");
		expect(aliveDecision).toMatchObject({ disposition: "adopted", status: "running", pid: alivePid });
		expect(doomedDecision).toMatchObject({ disposition: "terminal", status: "cancelled" });
		expect(adopted.applied).toEqual([]);

		// Now the survivor dies too. A third manager, built from disk alone, must reach
		// the same conclusion — and write it, so the next restart starts from truth.
		process.kill(alivePid, "SIGTERM");
		await waitFor(
			"the survivor to leave the roster",
			async () => !(await liveChildPids()).includes(alivePid),
			60_000,
		);

		const afterCrash = new SessionTreeManager({
			self: { sessionId: PARENT_SESSION, agentId: "default", intercomSessionId: PARENT_SESSION },
			supervisor: makeSupervisor(),
			store: await reopenLedger(sessionFile),
			liveness: createIntercomLivenessProbe({ roster: parent, parentId: PARENT_SESSION }),
		});
		const settled = await afterCrash.reconcile();

		expect(settled.applied.map(decision => decision.sessionId)).toEqual(["e2e-alive"]);
		const decision = settled.plan.decisions.find(entry => entry.sessionId === "e2e-alive");
		expect(decision).toMatchObject({ disposition: "orphaned", status: "failed" });
		expect(decision?.reason).toContain(`child process ${alivePid} is no longer registered`);

		// What the next restart will read.
		const finalLedger = await reopenLedger(sessionFile);
		const persisted = new Map((await finalLedger.load()).map(entry => [entry.node.sessionId, entry.node.status]));
		expect(persisted.get("e2e-alive")).toBe("failed");
		expect(persisted.get("e2e-doomed")).toBe("cancelled");
	}, 300_000);

	test("a report from a session this parent never delegated is refused, not matched to a child", async () => {
		const manager = new SessionTreeManager({
			self: { sessionId: PARENT_SESSION, agentId: "default", intercomSessionId: PARENT_SESSION },
			supervisor: makeSupervisor(),
			store: await reopenLedger(sessionFile),
			liveness: createIntercomLivenessProbe({ roster: parent, parentId: PARENT_SESSION }),
		});
		const { record, child } = await manager.delegate({
			sessionId: "e2e-refusal",
			agentDir: ownAgentDir(),
			cwd: repoRoot,
			command: { bin: binary!, args: ["--mode", "wire-stdio"] },
			delegationRole: "e2e",
		});

		const stranger = await manager.applyReport(
			{ pid: child.transport.pid! },
			formatChildSessionReport({ runId: "not-our-run", lifecycle: "completed", result: "/tmp/whatever" }),
		);
		expect(stranger).toEqual({ applied: false, reason: "unknown-run" });
		expect((await manager.record(record.node.sessionId))?.node.status).toBe("running");
		expect(await manager.bringBack(record.node.sessionId).catch(() => "not-ready")).toBe("not-ready");

		await manager.stop(record.node.sessionId);
	}, 300_000);
});
