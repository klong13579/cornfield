/**
 * The Session Tree Manager against real child processes.
 *
 * The children are the same real OS processes the supervisor suite uses
 * (`./fake-child-session`); what is real here is the loop this module owns —
 * delegation, the ledger entry, status back, the result, and the reconcile that
 * settles a ledger after everything in memory is gone.
 *
 * The broker is a stub in this file (the manager only needs a set of live pids).
 * The real broker, the real binary and a real restart live in
 * `./session-tree-e2e.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateSessionTree } from "../../src/agent-domain/relations";
import { CHILD_SESSION_ENV } from "../../src/intercom-extension/child-session-metadata";
import { formatChildSessionReport } from "../../src/session/child-session-report";
import {
	type ChildSessionSupervisor,
	ChildSessionSupervisor as Supervisor,
} from "../../src/session/child-session-supervisor";
import {
	type ChildSessionLivenessProbe,
	ChildSessionResultNotReadyError,
	type DelegationSpec,
	SessionTreeManager,
} from "../../src/session/session-tree-manager";
import { MemorySessionTreeStore } from "../../src/session/session-tree-store";
import { createFakeChildSession, type FakeChild } from "./fake-child-session";

const fixtures: FakeChild[] = [];
const supervisors: ChildSessionSupervisor[] = [];
const tempDirs: string[] = [];

async function fakeChild(options: Parameters<typeof createFakeChildSession>[0] = {}): Promise<FakeChild> {
	const fixture = await createFakeChildSession(options);
	fixtures.push(fixture);
	return fixture;
}

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-tree-manager-"));
	tempDirs.push(dir);
	return dir;
}

function supervisorWith(options: { registration?: { fail?: boolean } } = {}): ChildSessionSupervisor {
	const supervisor = new Supervisor({
		maxConcurrent: 2,
		registration: {
			async awaitRegistration() {
				if (options.registration?.fail) throw new Error("child never registered as a child of parent-1");
			},
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
	supervisors.push(supervisor);
	return supervisor;
}

function managerWith(
	options: {
		supervisor?: ChildSessionSupervisor;
		store?: MemorySessionTreeStore;
		liveness?: ChildSessionLivenessProbe;
		results?: { read(resultRef: string): Promise<string> };
	} = {},
) {
	const supervisor = options.supervisor ?? supervisorWith();
	const store = options.store ?? new MemorySessionTreeStore();
	const manager = new SessionTreeManager({
		self: { sessionId: "parent-1", agentId: "coding", intercomSessionId: "parent-1" },
		supervisor,
		store,
		...(options.liveness ? { liveness: options.liveness } : {}),
		...(options.results ? { results: options.results } : {}),
	});
	return { manager, store, supervisor };
}

function delegationFor(fixture: FakeChild, overrides: Partial<DelegationSpec> = {}): DelegationSpec {
	return {
		cwd: path.dirname(fixture.path),
		command: { bin: fixture.path, args: [] },
		env: fixture.env,
		...overrides,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error("timed out waiting for condition");
}

afterEach(async () => {
	for (const supervisor of supervisors.splice(0)) await supervisor.stopAll();
	for (const fixture of fixtures.splice(0)) {
		await fixture.requestExit();
		await fixture.awaitExit();
		await fixture.cleanup();
	}
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("SessionTreeManager.delegate", () => {
	test("runs a real child process and records a ledger node the domain relations accept", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();

		const { record, child } = await manager.delegate(
			delegationFor(fixture, { delegationRole: "T7", objective: "read only survey" }),
		);

		expect(child.transport.pid).toBeGreaterThan(0);
		expect(child.transport.pid).not.toBe(process.pid);
		expect(record.node).toEqual({
			sessionId: record.node.sessionId,
			agentId: "coding",
			parentSessionId: "parent-1",
			rootSessionId: "parent-1",
			depth: 1,
			kind: "child",
			status: "running",
			executionPolicy: "isolated-process",
			delegationRole: "T7",
			objective: "read only survey",
		});
		expect(record.lastPid).toBe(child.transport.pid);
		// The ledger node is built before the launch (see `buildChildSessionNode`), so
		// it is a second projection of the same facts the supervisor projects with
		// `toNode()`. Pinning them together here is what keeps the two from drifting
		// apart silently.
		expect(child.toNode()).toEqual({ ...record.node, status: child.status() });

		const parent = {
			sessionId: "parent-1",
			agentId: "coding",
			rootSessionId: "parent-1",
			depth: 0,
			kind: "root" as const,
			status: "running" as const,
			executionPolicy: "isolated-process" as const,
		};
		expect(
			validateSessionTree({
				agents: [{ agentId: "coding", agentDir: "/tmp/agents/coding", displayName: "coding", enabled: true }],
				projects: [],
				sessions: [parent, record.node],
			}),
		).toEqual([]);
	});

	test("puts the orchestrator edge and the run id in the child's environment", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();

		const { record, child } = await manager.delegate(delegationFor(fixture, { delegationRole: "scout" }));

		expect(child.spec.env?.[CHILD_SESSION_ENV.orchestratorTarget]).toBe("parent-1");
		expect(child.spec.env?.[CHILD_SESSION_ENV.orchestratorSessionId]).toBe("parent-1");
		expect(child.spec.env?.[CHILD_SESSION_ENV.runId]).toBe(record.runId);
		expect(child.spec.env?.[CHILD_SESSION_ENV.childAgent]).toBe("scout");
		// The child's own env still wins where the caller set it.
		expect(child.spec.env?.FAKE_CHILD_BEHAVIOR).toBe("ok");
	});

	test("refuses a session id that is already in the ledger", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();
		await manager.delegate(delegationFor(fixture, { sessionId: "child-1" }));

		const error = await manager.delegate(delegationFor(fixture, { sessionId: "child-1" })).then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error?.message).toContain("already in this session's ledger");
	});

	test("records a failed delegation rather than a phantom running one", async () => {
		const fixture = await fakeChild();
		const supervisor = supervisorWith({ registration: { fail: true } });
		const { manager } = managerWith({ supervisor });

		const error = await manager.delegate(delegationFor(fixture)).then(
			() => null,
			(cause: unknown) => cause as Error,
		);

		expect(error?.message).toContain("never registered");
		const records = await manager.records();
		expect(records).toHaveLength(1);
		expect(records[0]?.node.status).toBe("failed");
		expect(records[0]?.statusDetail).toContain("the child did not start");
	});
});

describe("SessionTreeManager.applyReport", () => {
	test("moves the ledger from the child's own reports", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();
		const { record, child } = await manager.delegate(delegationFor(fixture));
		const pid = child.transport.pid!;

		const started = await manager.applyReport(
			{ pid },
			formatChildSessionReport({ runId: record.runId, lifecycle: "started" }),
		);
		expect(started).toMatchObject({ applied: true, changed: false });

		const waiting = await manager.applyReport(
			{ pid },
			formatChildSessionReport({ runId: record.runId, lifecycle: "waiting", blocking: "ask" }, "which file?"),
		);
		expect(waiting.applied).toBe(true);

		const pending = await manager.pendingEscalations();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.node.status).toBe("waiting_user");
		expect(pending[0]?.escalation).toMatchObject({ blocking: "ask", question: "which file?" });
	});

	test("refuses a report for a run this session never delegated", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();
		const { child } = await manager.delegate(delegationFor(fixture));

		const result = await manager.applyReport(
			{ pid: child.transport.pid! },
			formatChildSessionReport({ runId: "someone-elses-run", lifecycle: "completed" }),
		);
		expect(result).toEqual({ applied: false, reason: "unknown-run" });
	});

	test("refuses a report from a process that does not serve the child", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();
		const { record, child } = await manager.delegate(delegationFor(fixture));

		const impostor = await manager.applyReport(
			{ pid: child.transport.pid! + 1 },
			formatChildSessionReport({ runId: record.runId, lifecycle: "completed" }),
		);
		expect(impostor).toEqual({ applied: false, reason: "sender-mismatch" });

		const genuine = await manager.applyReport(
			{ pid: child.transport.pid! },
			formatChildSessionReport({ runId: record.runId, lifecycle: "progress" }),
		);
		expect(genuine.applied).toBe(true);
	});

	test("says 'not a report' for ordinary prose, and 'malformed' for an envelope it cannot read", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();
		const { child } = await manager.delegate(delegationFor(fixture));
		const pid = child.transport.pid!;

		expect(await manager.applyReport({ pid }, "just chatting")).toEqual({ applied: false, reason: "not-a-report" });
		expect(await manager.applyReport({ pid }, "[child-session] {oops}")).toEqual({
			applied: false,
			reason: "malformed",
		});
	});

	test("refuses a late report once the parent has stopped the child", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();
		const { record, child } = await manager.delegate(delegationFor(fixture));
		const pid = child.transport.pid!;

		const stopped = await manager.stop(record.node.sessionId);
		expect(stopped.node.status).toBe("cancelled");

		const late = await manager.applyReport(
			{ pid },
			formatChildSessionReport({ runId: record.runId, lifecycle: "completed" }),
		);
		expect(late).toEqual({ applied: false, reason: "terminal" });
		expect((await manager.record(record.node.sessionId))?.node.status).toBe("cancelled");
	});

	test("records a crashed child as failed when the ledger is next read", async () => {
		const fixture = await fakeChild({ behavior: "crash-after-ready", crashAfterMs: 60, crashCode: 5 });
		const { manager } = managerWith();
		const { record, child } = await manager.delegate(delegationFor(fixture));

		await waitFor(() => child.status() === "failed");
		const records = await manager.records();

		expect(records[0]?.node.status).toBe("failed");
		expect(records[0]?.statusDetail).toContain("restart budget is exhausted");
		expect(record.node.status).toBe("running");
	});
});

describe("SessionTreeManager.bringBack", () => {
	async function delegatedWithResult() {
		const fixture = await fakeChild();
		const dir = await tempDir();
		const resultPath = path.join(dir, "child-result.jsonl");
		await fs.writeFile(resultPath, '{"role":"assistant","text":"the survey says: nothing to change"}\n');
		const { manager } = managerWith({
			results: {
				async read(resultRef: string) {
					return await Bun.file(resultRef).text();
				},
			},
		});
		const { record, child } = await manager.delegate(delegationFor(fixture));
		await manager.applyReport(
			{ pid: child.transport.pid! },
			formatChildSessionReport({ runId: record.runId, lifecycle: "completed", result: resultPath }, "done"),
		);
		return { manager, sessionId: record.node.sessionId, resultPath };
	}

	test("reads the result once and reports it as the first bring-back", async () => {
		const { manager, sessionId, resultPath } = await delegatedWithResult();

		const first = await manager.bringBack(sessionId);
		expect(first.firstTime).toBe(true);
		expect(first.resultRef).toBe(resultPath);
		expect(first.content).toContain("nothing to change");
		expect((await manager.record(sessionId))?.node.resultBroughtBackAt).toBe(first.broughtBackAt);
	});

	test("a repeat is not a second result: same content, firstTime false", async () => {
		const { manager, sessionId } = await delegatedWithResult();

		const first = await manager.bringBack(sessionId);
		const second = await manager.bringBack(sessionId);

		expect(second.firstTime).toBe(false);
		expect(second.content).toBe(first.content);
		expect(second.broughtBackAt).toBe(first.broughtBackAt);
	});

	test("concurrent bring-backs hand the injection right to exactly one caller", async () => {
		const { manager, sessionId } = await delegatedWithResult();

		const [a, b, c] = await Promise.all([
			manager.bringBack(sessionId),
			manager.bringBack(sessionId),
			manager.bringBack(sessionId),
		]);

		expect([a, b, c].filter(result => result.firstTime)).toHaveLength(1);
		expect(new Set([a.broughtBackAt, b.broughtBackAt, c.broughtBackAt]).size).toBe(1);
	});

	test("refuses to bring back a result that is not ready", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith();
		const { record } = await manager.delegate(delegationFor(fixture));

		const error = await manager.bringBack(record.node.sessionId).then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error).toBeInstanceOf(ChildSessionResultNotReadyError);
		expect(error?.message).toContain("session.result-not-ready");
	});

	test("does not stamp a bring-back when the result cannot be read", async () => {
		const fixture = await fakeChild();
		const { manager } = managerWith({
			results: {
				async read() {
					throw new Error("ENOENT: no such file");
				},
			},
		});
		const { record, child } = await manager.delegate(delegationFor(fixture));
		await manager.applyReport(
			{ pid: child.transport.pid! },
			formatChildSessionReport({ runId: record.runId, lifecycle: "completed", result: "/gone/result.jsonl" }),
		);

		await manager.bringBack(record.node.sessionId).catch(() => undefined);
		expect((await manager.record(record.node.sessionId))?.node.resultBroughtBackAt).toBeUndefined();
	});
});

describe("SessionTreeManager.reconcile", () => {
	async function ledgerWithOneRunningChild() {
		const fixture = await fakeChild();
		const supervisor = supervisorWith();
		const store = new MemorySessionTreeStore();
		const { manager } = managerWith({ supervisor, store });
		const { record, child } = await manager.delegate(delegationFor(fixture, { sessionId: "child-1" }));
		return { manager, store, record, child, pid: child.transport.pid! };
	}

	test("adopts a child whose process the broker still shows under this parent", async () => {
		const { manager, record, pid } = await ledgerWithOneRunningChild();
		// A restarted manager has no supervisor of its own; anything it still sees is
		// what the broker reports.
		const restarted = new SessionTreeManager({
			self: { sessionId: "parent-1", agentId: "coding", intercomSessionId: "parent-1" },
			supervisor: supervisorWith(),
			store: new MemorySessionTreeStore((await manager.records()) as never),
			liveness: {
				async liveChildPids() {
					return new Set([pid]);
				},
			},
		});

		const result = await restarted.reconcile();
		expect(result.applied).toEqual([]);
		expect(result.plan.decisions).toEqual([
			{
				sessionId: "child-1",
				disposition: "adopted",
				status: "running",
				reason: `child process ${pid} is still registered under this parent`,
				pid,
			},
		]);
		expect(await restarted.record(record.node.sessionId)).toMatchObject({ node: { status: "running" } });
	});

	test("fails a child that is gone, and says so in the ledger", async () => {
		const { manager, store, record } = await ledgerWithOneRunningChild();
		// Simulate the restart: the same ledger, a manager with no supervisor, and a
		// broker that no longer shows the child.
		const restarted = new SessionTreeManager({
			self: { sessionId: "parent-1", agentId: "coding", intercomSessionId: "parent-1" },
			supervisor: supervisorWith(),
			store,
			liveness: {
				async liveChildPids() {
					return new Set<number>();
				},
			},
		});

		const result = await restarted.reconcile();

		expect(result.applied.map(decision => decision.sessionId)).toEqual(["child-1"]);
		const settled = await restarted.record(record.node.sessionId);
		expect(settled?.node.status).toBe("failed");
		expect(settled?.statusDetail).toContain("no longer registered under this parent");
		// The write reached the store, not just the in-memory copy.
		expect((await store.load())[0]?.node.status).toBe("failed");
		expect(await manager.records()).toBeDefined();
	});

	test("leaves the ledger untouched when the roster cannot be read", async () => {
		const { store, record } = await ledgerWithOneRunningChild();
		const restarted = new SessionTreeManager({
			self: { sessionId: "parent-1", agentId: "coding", intercomSessionId: "parent-1" },
			supervisor: supervisorWith(),
			store,
			liveness: {
				async liveChildPids(): Promise<ReadonlySet<number>> {
					throw new Error("broker unreachable");
				},
			},
		});

		const error = await restarted.reconcile().then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error?.message).toContain("broker unreachable");
		// "Could not ask" must never be read as "nothing is alive": a failed roster
		// read would otherwise terminalize a whole tree of live children.
		expect((await store.load())[0]?.node.status).toBe("running");
		expect((await store.load())[0]?.node.sessionId).toBe(record.node.sessionId);
	});

	test("does not touch a child that already finished", async () => {
		const fixture = await fakeChild();
		const store = new MemorySessionTreeStore();
		const { manager } = managerWith({ store });
		const { record, child } = await manager.delegate(delegationFor(fixture));
		await manager.applyReport(
			{ pid: child.transport.pid! },
			formatChildSessionReport({ runId: record.runId, lifecycle: "completed", result: "/tmp/result.jsonl" }),
		);

		const restarted = new SessionTreeManager({
			self: { sessionId: "parent-1", agentId: "coding", intercomSessionId: "parent-1" },
			supervisor: supervisorWith(),
			store,
			liveness: {
				async liveChildPids() {
					return new Set<number>();
				},
			},
		});

		const result = await restarted.reconcile();
		expect(result.applied).toEqual([]);
		const settled = await restarted.record(record.node.sessionId);
		expect(settled?.node.status).toBe("completed");
		expect(settled?.node.resultRef).toBe("/tmp/result.jsonl");
	});
});
