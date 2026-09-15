/**
 * ChildSessionProcess — spawn, wire handshake, request correlation, stop ladder.
 *
 * The subject is the OS-process lifecycle of ONE formal Child Session, so the
 * tests spawn real child processes (see `./fake-child-session.ts`) and vary the
 * child's behaviour rather than mocking the process API. What is faked is the
 * child program's *behaviour*; the process, the pipes and the signals are real.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import {
	ChildSessionProcess,
	ChildSessionProcessError,
	type ChildSessionProcessEvent,
	ChildSessionRequestTimeoutError,
	ChildSessionUnavailableError,
} from "../../src/session/child-session-process";
import { createFakeChildSession, type FakeChild, type FakeChildOptions } from "./fake-child-session";

const fixtures: FakeChild[] = [];
const children: ChildSessionProcess[] = [];

async function fakeChild(options: FakeChildOptions = {}): Promise<FakeChild> {
	const fixture = await createFakeChildSession(options);
	fixtures.push(fixture);
	return fixture;
}

function childOn(fixture: FakeChild, overrides: Record<string, unknown> = {}): ChildSessionProcess {
	const child = new ChildSessionProcess({
		sessionId: "child-1",
		cwd: os.tmpdir(),
		command: { bin: fixture.path, args: [] },
		env: fixture.env,
		readyTimeoutMs: 10_000,
		requestTimeoutMs: 5_000,
		abortTimeoutMs: 500,
		exitGraceMs: 2_000,
		termGraceMs: 1_000,
		...overrides,
	});
	children.push(child);
	return child;
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	return promise.then(
		() => {
			throw new Error("expected the promise to reject, it resolved");
		},
		(cause: unknown) => cause as Error,
	);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error("timed out waiting for condition");
}

afterEach(async () => {
	// Cleanup never SIGKILLs. A child that walked away from the stop ladder is left
	// running by design, so the test asks it to exit through its own control channel
	// and waits, bounded, for it to go — the same "do not destroy, ask and report"
	// rule the product follows.
	for (const child of children.splice(0)) {
		try {
			await child.stop();
		} catch {}
	}
	for (const fixture of fixtures.splice(0)) {
		await fixture.requestExit();
		const gone = await fixture.awaitExit();
		if (!gone) {
			throw new Error(`fixture child ${await fixture.recordedPid()} outlived its control channel`);
		}
		await fixture.cleanup();
	}
});

describe("ChildSessionProcess.start", () => {
	test("completes the wire handshake against a real, separate OS process", async () => {
		const fixture = await fakeChild();
		const child = childOn(fixture);

		await child.start();

		expect(child.state).toBe("ready");
		expect(child.bootId).toBe(1);
		// Isolation is the point: the child is a different process, and the pid it
		// reports is the one we spawned.
		expect(child.pid).toBeGreaterThan(0);
		expect(child.pid).not.toBe(process.pid);
		expect(await fixture.recordedPid()).toBe(child.pid!);
	});

	test("rejects when the child never answers, naming the handshake budget", async () => {
		const fixture = await fakeChild({ behavior: "silent" });
		const child = childOn(fixture, { readyTimeoutMs: 400 });

		const error = await rejectionOf(child.start());

		expect(error).toBeInstanceOf(ChildSessionProcessError);
		expect(error.message).toContain("did not complete the wire handshake");
		expect(error.message).toContain("400ms");
		// The unusable child is not left running.
		expect(child.state).toBe("exited");
	});

	test("rejects with the child's own reason when the handshake is declined", async () => {
		const fixture = await fakeChild({ behavior: "hello-error" });
		const child = childOn(fixture);

		const error = await rejectionOf(child.start());

		expect(error.message).toContain("rejected the handshake");
		expect(error.message).toContain("legacy binary");
	});

	test("rejects an incompatible protocol version instead of accepting it", async () => {
		const fixture = await fakeChild({ behavior: "bad-version" });
		const child = childOn(fixture);

		const error = await rejectionOf(child.start());

		expect(error.message).toContain("incompatible protocol version");
	});

	test("rejects when the child dies before the handshake completes", async () => {
		const fixture = await fakeChild({ behavior: "exit-on-hello", crashCode: 9 });
		const child = childOn(fixture);

		const error = await rejectionOf(child.start());

		expect(error.message).toContain("before the handshake completed");
		expect(child.state).toBe("exited");
	});

	test("refuses a second start() without an intervening exit", async () => {
		const fixture = await fakeChild();
		const child = childOn(fixture);
		await child.start();

		const error = await rejectionOf(child.start());

		expect(error.message).toContain("already ready");
	});
});

describe("ChildSessionProcess.request", () => {
	test("correlates a response back to its request", async () => {
		const fixture = await fakeChild();
		const child = childOn(fixture);
		await child.start();

		const spawnedPid = child.pid;
		const result = await child.request<{ command: string; pid: number }>({ type: "get_state" });

		expect(result.command).toBe("get_state");
		expect(result.pid).toBe(spawnedPid ?? -1);
	});

	test("fails loudly instead of inventing a result when nothing is running", async () => {
		const fixture = await fakeChild({ behavior: "silent" });
		const child = childOn(fixture, { readyTimeoutMs: 5_000 });

		const error = await rejectionOf(child.request({ type: "get_state" }));

		expect(error).toBeInstanceOf(ChildSessionUnavailableError);
		expect(error.message).toContain("idle");
	});

	test("reports a timeout without claiming the child is dead", async () => {
		const fixture = await fakeChild({ behavior: "eof-blind" });
		const child = childOn(fixture);
		await child.start();

		const error = await rejectionOf(child.request({ type: "get_state" }, 300));

		expect(error).toBeInstanceOf(ChildSessionRequestTimeoutError);
		expect(error.message).toContain("300ms");
		// A timeout is not evidence of death.
		expect(child.state).toBe("ready");
	});

	test("fails an in-flight request with the crash, not with a plausible answer", async () => {
		const fixture = await fakeChild({ behavior: "crash-first-boot", crashAfterMs: 200, crashCode: 7 });
		const child = childOn(fixture);
		await child.start();

		const error = await rejectionOf(child.request({ type: "compact" }, 10_000));

		expect(error.name).toBe("ChildSessionExitedError");
		expect(error.message).toContain("exited with code 7");
		expect((error as { exit?: { code: number | null } }).exit?.code).toBe(7);
	});
});

describe("ChildSessionProcess.stop", () => {
	test("stops gracefully — abort first, then EOF — and reports the exit as expected", async () => {
		const fixture = await fakeChild();
		const child = childOn(fixture);
		const events: ChildSessionProcessEvent[] = [];
		child.subscribe(event => events.push(event));
		await child.start();

		await child.stop();

		expect(child.state).toBe("exited");
		// The in-flight turn is aborted before the pipe closes: nothing is cut mid-write.
		expect(await fixture.receivedRequests()).toEqual(["abort"]);
		expect(events.find(event => event.type === "exited")).toMatchObject({
			type: "exited",
			bootId: 1,
			expected: true,
			code: 0,
			signal: null,
		});
	});

	test("reports a failed stop instead of force-killing a child that ignores the ladder", async () => {
		const fixture = await fakeChild({ behavior: "eof-blind" });
		const child = childOn(fixture, { abortTimeoutMs: 300, exitGraceMs: 300, termGraceMs: 500 });
		await child.start();
		const pid = child.pid!;

		const error = await rejectionOf(child.stop());

		// The whole ladder ran — abort, stdin close, SIGTERM — and the child is still
		// there. SIGKILL would skip its shutdown path, so nothing sends it: the stop
		// is reported as the failure it is.
		expect(error.name).toBe("ChildSessionStopTimeoutError");
		expect(error.message).toContain(`pid ${pid}`);
		expect(error.message).toContain("was not force-killed");
		expect(await fixture.receivedRequests()).toEqual(["abort"]);
		expect(await fixture.survivedSigterm()).toBe(true);
		expect(child.state).toBe("stopping");
		expect(() => process.kill(pid, 0)).not.toThrow();

		// It leaves when it is asked to, through its own channel — not because
		// anything killed it (the supervisor declined to, and so does this test).
		await fixture.requestExit();
		expect(await fixture.awaitExit()).toBe(true);
		expect(await fixture.exitedViaControl()).toBe(true);
	});

	test("is idempotent on an already-exited process", async () => {
		const fixture = await fakeChild();
		const child = childOn(fixture);
		await child.start();
		await child.stop();

		await child.stop();

		expect(child.state).toBe("exited");
	});

	test("shares one ladder between concurrent stops instead of racing over the process", async () => {
		const fixture = await fakeChild({ behavior: "eof-blind" });
		const child = childOn(fixture, { abortTimeoutMs: 300, exitGraceMs: 200, termGraceMs: 200 });
		await child.start();
		const pid = child.pid!;

		const first = rejectionOf(child.stop());
		await Bun.sleep(50);
		const second = rejectionOf(child.stop());

		// Both callers learn the same truth; neither invents a separate failure.
		expect((await first).name).toBe("ChildSessionStopTimeoutError");
		expect((await second).name).toBe("ChildSessionStopTimeoutError");
		// One ladder ran, so the child saw the abort exactly once.
		expect(await fixture.receivedRequests()).toEqual(["abort"]);
		expect(() => process.kill(pid, 0)).not.toThrow();
		await fixture.requestExit();
		expect(await fixture.awaitExit()).toBe(true);
		expect(await fixture.exitedViaControl()).toBe(true);
	});

	test("is a no-op before the first start", async () => {
		const fixture = await fakeChild();
		const child = childOn(fixture);

		await child.stop();

		expect(child.state).toBe("exited");
	});
});

describe("ChildSessionProcess restarts", () => {
	test("relaunches on the same identity with a new bootId, and stamps each exit", async () => {
		const fixture = await fakeChild({ behavior: "crash-after-ready", crashAfterMs: 100, crashCode: 5 });
		const child = childOn(fixture);
		const exits: Array<{ bootId: number; pid: number; expected: boolean }> = [];
		child.subscribe(event => {
			if (event.type === "exited") exits.push({ bootId: event.bootId, pid: event.pid, expected: event.expected });
		});

		await child.start();
		const firstPid = child.pid!;
		await waitFor(() => exits.length === 1, 5_000);

		await child.start();

		expect(child.bootId).toBe(2);
		expect(child.state).toBe("ready");
		expect(child.pid).not.toBe(firstPid);
		expect(exits[0]).toEqual({ bootId: 1, pid: firstPid, expected: false });
	});
});
