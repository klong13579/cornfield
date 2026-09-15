/**
 * ChildSessionSupervisor — registration gate, global concurrency, crash restart,
 * pending requests, and the boundary against the in-process Task.
 *
 * The children are real OS processes (`./fake-child-session.ts`); only the
 * intercom roster is a stub, because the roster is the one thing the supervisor
 * deliberately does not own (see `intercom-extension/child-session-edge.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ChildSessionRegistrationProbe,
	type ChildSessionSpec,
	ChildSessionSupervisor,
	type ChildSessionSupervisorOptions,
} from "../../src/session/child-session-supervisor";
import { createFakeChildSession, type FakeChild, type FakeChildOptions } from "./fake-child-session";

const fixtures: FakeChild[] = [];
const supervisors: ChildSessionSupervisor[] = [];

/** Records what the supervisor asked of the broker, and can hold the edge back. */
function recordingProbe(options: { gate?: boolean; fail?: (input: { pid: number }) => Error | null } = {}) {
	const seen: Array<{ sessionId: string; pid: number; bootId: number }> = [];
	const pending: Array<() => void> = [];
	const probe: ChildSessionRegistrationProbe = {
		async awaitRegistration({ sessionId, pid, bootId, signal }): Promise<void> {
			seen.push({ sessionId, pid, bootId });
			const failure = options.fail?.({ pid });
			if (failure) throw failure;
			if (!options.gate) return;
			await new Promise<void>(resolve => {
				pending.push(resolve);
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			if (signal.aborted) throw new Error("registration cancelled");
		},
	};
	return {
		probe,
		seen,
		release: () => {
			for (const resolve of pending.splice(0)) resolve();
		},
	};
}

async function fakeChild(options: FakeChildOptions = {}): Promise<FakeChild> {
	const fixture = await createFakeChildSession(options);
	fixtures.push(fixture);
	return fixture;
}

function supervisorWith(options: Partial<ChildSessionSupervisorOptions> = {}): ChildSessionSupervisor {
	const supervisor = new ChildSessionSupervisor({
		maxConcurrent: 1,
		registration: { async awaitRegistration() {} },
		restart: { maxRestarts: 2, baseBackoffMs: 10, maxBackoffMs: 30 },
		process: {
			readyTimeoutMs: 10_000,
			requestTimeoutMs: 5_000,
			abortTimeoutMs: 300,
			exitGraceMs: 1_000,
			termGraceMs: 500,
		},
		...options,
	});
	supervisors.push(supervisor);
	return supervisor;
}

function specFor(fixture: FakeChild, overrides: Partial<ChildSessionSpec> = {}): ChildSessionSpec {
	return {
		sessionId: "child-1",
		parent: { sessionId: "parent-1", rootSessionId: "root-1", depth: 0 },
		agentId: "coding",
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

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(async () => {
	for (const supervisor of supervisors.splice(0)) await supervisor.stopAll();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe("ChildSessionSupervisor.start", () => {
	test("runs a formal Child Session as an isolated process and projects its tree node", async () => {
		const fixture = await fakeChild();
		const supervisor = supervisorWith();

		const child = await supervisor.start(specFor(fixture));

		expect(child.status()).toBe("running");
		expect(child.transport.pid).toBeGreaterThan(0);
		expect(child.transport.pid).not.toBe(process.pid);
		expect(child.toNode()).toEqual({
			sessionId: "child-1",
			agentId: "coding",
			parentSessionId: "parent-1",
			rootSessionId: "root-1",
			depth: 1,
			kind: "child",
			status: "running",
			executionPolicy: "isolated-process",
		});
	});

	test("carries the delegation labels onto the node when the caller supplies them", async () => {
		const fixture = await fakeChild();
		const supervisor = supervisorWith();

		const child = await supervisor.start(
			specFor(fixture, { delegationRole: "T6", objective: "supervise children", projectId: "cornfield" }),
		);

		expect(child.toNode()).toMatchObject({
			delegationRole: "T6",
			objective: "supervise children",
			projectId: "cornfield",
		});
	});

	test("does not report started before the parent edge is on the broker", async () => {
		const fixture = await fakeChild();
		const registration = recordingProbe({ gate: true });
		const supervisor = supervisorWith({ registration: registration.probe });

		let started = false;
		const pending = supervisor.start(specFor(fixture)).then(child => {
			started = true;
			return child;
		});

		await waitFor(() => registration.seen.length === 1);
		expect(started).toBe(false);
		expect(registration.seen[0]!.pid).toBeGreaterThan(0);
		expect(registration.seen[0]!.bootId).toBe(1);

		registration.release();
		const child = await pending;
		expect(started).toBe(true);
		expect(child.status()).toBe("running");
	});

	test("stops the spawned process and reports the failure when the child never registers", async () => {
		const fixture = await fakeChild();
		const registration = recordingProbe({
			fail: () => new Error('did not register as a child of "parent-1" within 60000ms'),
		});
		const supervisor = supervisorWith({ registration: registration.probe });

		const error = await supervisor.start(specFor(fixture)).then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		const pid = registration.seen[0]!.pid;

		// The child was really spawned, and the failure is reported as the failure it
		// is — not as a started child the parent will never be able to see.
		expect(pid).toBeGreaterThan(0);
		expect(error?.message).toContain("did not register as a child");
		await waitFor(() => !isAlive(pid));
		expect(supervisor.list()).toEqual([]);
	});

	test("rejects a duplicate session id", async () => {
		const fixture = await fakeChild();
		const supervisor = supervisorWith();
		await supervisor.start(specFor(fixture));

		const error = await supervisor.start(specFor(fixture)).then(
			() => null,
			(cause: unknown) => cause as Error,
		);

		expect(error?.message).toContain("already supervised");
	});

	test("refuses a child with no parent session id", async () => {
		const fixture = await fakeChild();
		const supervisor = supervisorWith();

		const error = await supervisor
			.start(specFor(fixture, { parent: { sessionId: "  ", rootSessionId: "root-1", depth: 0 } }))
			.then(
				() => null,
				(cause: unknown) => cause as Error,
			);

		expect(error?.message).toContain("needs a parent session id");
	});
});

describe("ChildSessionSupervisor concurrency", () => {
	test("caps the number of running children and queues the rest", async () => {
		const first = await fakeChild();
		const second = await fakeChild();
		const registration = recordingProbe({ gate: true });
		const supervisor = supervisorWith({ maxConcurrent: 1, registration: registration.probe });

		const firstStart = supervisor.start(specFor(first, { sessionId: "child-1" }));
		await waitFor(() => registration.seen.length === 1);

		let secondStarted = false;
		const secondStart = supervisor.start(specFor(second, { sessionId: "child-2" })).then(child => {
			secondStarted = true;
			return child;
		});
		await Bun.sleep(150);

		// The slot is taken, so the second child has not even been spawned yet.
		expect(secondStarted).toBe(false);
		expect(registration.seen).toHaveLength(1);
		expect(supervisor.concurrency()).toMatchObject({ active: 1, limit: 1, queued: 1 });
		expect(await second.recordedPid()).toBeNull();

		registration.release();
		const firstChild = await firstStart;

		// Only when the first child reaches a terminal state does the queued one run.
		await firstChild.stop();
		await waitFor(() => registration.seen.length === 2);
		registration.release();
		await secondStart;

		expect(secondStarted).toBe(true);
	});

	test("frees the slot when a child reaches a terminal state", async () => {
		const fixture = await fakeChild();
		const supervisor = supervisorWith({ maxConcurrent: 1 });

		const child = await supervisor.start(specFor(fixture));
		expect(supervisor.concurrency().active).toBe(1);

		await child.stop();

		expect(child.status()).toBe("cancelled");
		expect(supervisor.concurrency()).toMatchObject({ active: 0, queued: 0 });
	});

	test("never spawns a child whose start was cancelled while queued", async () => {
		const first = await fakeChild();
		const second = await fakeChild();
		const registration = recordingProbe({ gate: true });
		const supervisor = supervisorWith({ maxConcurrent: 1, registration: registration.probe });

		const firstStart = supervisor.start(specFor(first, { sessionId: "child-1" }));
		await waitFor(() => registration.seen.length === 1);

		registration.release();
		const firstChild = await firstStart;

		const controller = new AbortController();
		const cancelled = supervisor.start(specFor(second, { sessionId: "child-2" }), {
			signal: controller.signal,
		});
		controller.abort();
		// The queued start cannot observe the abort until the slot frees, so the
		// child must not be spawned by the slot release itself.
		await firstChild.stop();

		const error = await cancelled.then(
			() => null,
			(cause: unknown) => cause as Error,
		);
		expect(error?.message).toContain("cancelled before launch");
		expect(await second.recordedPid()).toBeNull();
	});
});

describe("ChildSessionSupervisor crash restart", () => {
	test("relaunches a crashed child on the same session identity", async () => {
		const fixture = await fakeChild({ behavior: "crash-after-ready", crashAfterMs: 100, crashCode: 5 });
		const registration = recordingProbe();
		const supervisor = supervisorWith({ registration: registration.probe, maxConcurrent: 2 });

		const child = await supervisor.start(specFor(fixture));
		const firstPid = child.transport.pid!;

		await waitFor(() => child.restarts() === 1);
		await waitFor(() => child.transport.state === "ready");

		expect(child.status()).toBe("running");
		expect(child.transport.bootId).toBe(2);
		expect(child.transport.pid).not.toBe(firstPid);
		expect(child.sessionId).toBe("child-1");
		expect(registration.seen.map(entry => entry.bootId)).toEqual([1, 2]);
	});

	test("gives up once the restart budget is exhausted and reports failure", async () => {
		const fixture = await fakeChild({ behavior: "crash-after-ready", crashAfterMs: 80, crashCode: 5 });
		const supervisor = supervisorWith({
			maxConcurrent: 2,
			restart: { maxRestarts: 1, baseBackoffMs: 10, maxBackoffMs: 20 },
		});

		const child = await supervisor.start(specFor(fixture));
		await waitFor(() => child.status() === "failed");

		expect(child.restarts()).toBe(1);
		expect(child.toNode().status).toBe("failed");
		expect(supervisor.concurrency().active).toBe(0);
	});
});

describe("ChildSessionSupervisor pending requests", () => {
	test("fails an in-flight request with the crash instead of replaying it", async () => {
		const fixture = await fakeChild({ behavior: "crash-first-boot", crashAfterMs: 150, crashCode: 6 });
		const supervisor = supervisorWith({ maxConcurrent: 2 });

		const child = await supervisor.start(specFor(fixture));
		const error = await child.request({ type: "compact" }, { timeoutMs: 10_000 }).then(
			() => null,
			(cause: unknown) => cause as Error,
		);

		expect(error?.name).toBe("ChildSessionExitedError");
		expect(error?.message).toContain("exited with code 6");
		// Nothing was silently replayed: the request ran once, on a process that died.
		expect(await fixture.receivedRequests()).toEqual(["compact"]);
	});

	test("retries once after the relaunch when the caller declares the command idempotent", async () => {
		const fixture = await fakeChild({ behavior: "crash-first-boot", crashAfterMs: 150, crashCode: 6 });
		const supervisor = supervisorWith({ maxConcurrent: 2 });

		const child = await supervisor.start(specFor(fixture));
		const result = await child.request<{ command: string; pid: number }>(
			{ type: "get_state" },
			{ timeoutMs: 10_000, retryOnRestart: true },
		);

		expect(result.command).toBe("get_state");
		expect(result.pid).toBe(child.transport.pid!);
		expect(child.restarts()).toBe(1);
		// Once on the doomed boot (unanswered) and once on the relaunch.
		expect(await fixture.receivedRequests()).toEqual(["get_state", "get_state"]);
	});
});

describe("ChildSessionSupervisor terminal states", () => {
	test("complete() marks the child completed and releases it", async () => {
		const fixture = await fakeChild();
		const supervisor = supervisorWith();

		const child = await supervisor.start(specFor(fixture));
		await child.complete("artifact://child-1");

		expect(child.status()).toBe("completed");
		expect(child.toNode()).toMatchObject({ status: "completed", resultRef: "artifact://child-1" });
		expect(supervisor.concurrency().active).toBe(0);
	});

	test("stopAll stops every supervised child", async () => {
		const first = await fakeChild();
		const second = await fakeChild();
		const supervisor = supervisorWith({ maxConcurrent: 2 });

		const one = await supervisor.start(specFor(first, { sessionId: "child-1" }));
		const two = await supervisor.start(specFor(second, { sessionId: "child-2" }));

		await supervisor.stopAll();

		expect(one.status()).toBe("cancelled");
		expect(two.status()).toBe("cancelled");
		expect(supervisor.concurrency().active).toBe(0);
	});
});

describe("in-process Task boundary", () => {
	test("the child session path never imports the in-process subagent Task", async () => {
		const sourceDir = fileURLToPath(new URL("../../src/", import.meta.url));
		const sources = await Promise.all(
			["session/child-session-process.ts", "session/child-session-supervisor.ts"].map(file =>
				fs.readFile(path.join(sourceDir, file), "utf8"),
			),
		);

		for (const source of sources) {
			const imports = source
				.split("\n")
				.filter(line => line.startsWith("import "))
				.join("\n");
			// §38: a formal Child Session is an isolated process. The in-process Task
			// (`task/executor.ts` `runSubprocess` over an in-heap AgentSession) stays
			// where it is and never becomes a session-tree node — so this path may
			// reuse the concurrency primitive but must not reach into the Task runtime.
			expect(imports).not.toMatch(/from\s+"[^"]*task\/(executor|index|agents)"/);
			expect(imports).not.toMatch(/createAgentSession/);
		}

		// The shared primitive is reused, not re-implemented.
		expect(sources[1]).toContain('from "../task/parallel"');
	});
});
